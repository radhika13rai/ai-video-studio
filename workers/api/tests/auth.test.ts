import { API_PATHS } from "@avs/contracts";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccessJwt, type AccessJwk, type KeyFetcher } from "../src/auth/access";
import { createWorker } from "../src/index";

const TEAM = "https://team.cloudflareaccess.com";
const AUD = "aud-tag-123";
let privateKey: CryptoKey;
let jwk: AccessJwk;
let otherPrivate: CryptoKey;

const b64url = (bytes: Uint8Array | string) =>
  btoa(typeof bytes === "string" ? bytes : String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

async function sign(claims: Record<string, unknown>, key = privateKey, kid = "k1", alg = "RS256") {
  const h = b64url(JSON.stringify({ alg, kid, typ: "JWT" }));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${h}.${p}`),
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

const now = () => Math.floor(Date.now() / 1000);
const good = (over: Record<string, unknown> = {}) => ({
  aud: [AUD],
  iss: TEAM,
  email: "carol@example.com",
  sub: "user-1",
  iat: now(),
  exp: now() + 300,
  ...over,
});

const keys: KeyFetcher = async () => [jwk];

beforeAll(async () => {
  const gen = async () =>
    (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
  const pair = await gen();
  privateKey = pair.privateKey;
  const pub = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  jwk = { kid: "k1", kty: "RSA", n: pub.n ?? "", e: pub.e ?? "" };
  otherPrivate = (await gen()).privateKey;
});

describe("verifyAccessJwt", () => {
  const verify = (token: string) =>
    verifyAccessJwt(token, {
      teamDomain: "team.cloudflareaccess.com",
      audience: AUD,
      getKeys: keys,
    });

  it("accepts a valid token and returns the email", async () => {
    await expect(verify(await sign(good()))).resolves.toEqual({
      email: "carol@example.com",
      sub: "user-1",
    });
  });

  it.each([
    ["expired", good({ exp: now() - 3600 })],
    ["not yet valid", good({ nbf: now() + 3600 })],
    ["wrong audience", good({ aud: ["someone-else"] })],
    ["wrong issuer", good({ iss: "https://evil.cloudflareaccess.com" })],
    ["no email", good({ email: undefined })],
  ])("rejects a token that is %s", async (_label, claims) => {
    await expect(verify(await sign(claims))).rejects.toThrow();
  });

  it("rejects a bad signature, unknown key, wrong alg and garbage", async () => {
    await expect(verify(await sign(good(), otherPrivate))).rejects.toThrow(/signature/);
    await expect(verify(await sign(good(), privateKey, "k2"))).rejects.toThrow(/unknown key/);
    await expect(verify(await sign(good(), privateKey, "k1", "HS256"))).rejects.toThrow(/header/);
    await expect(verify("not.a.jwt")).rejects.toThrow();
    await expect(verify("abc")).rejects.toThrow();
  });

  it("refetches keys once when the kid is unknown (key rotation)", async () => {
    let calls = 0;
    const rotating: KeyFetcher = async (_d, force) => {
      calls++;
      return force ? [jwk] : [];
    };
    await expect(
      verifyAccessJwt(await sign(good()), { teamDomain: TEAM, audience: AUD, getKeys: rotating }),
    ).resolves.toMatchObject({ email: "carol@example.com" });
    expect(calls).toBe(2);
  });
});

describe("authentication middleware", () => {
  const worker = createWorker({ getKeys: keys });
  const req = (headers: Record<string, string> = {}) =>
    new Request(`https://example.test${API_PATHS.me}`, { headers });
  const accessEnv = { ...env, APP_ENV: "production", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

  it("with Access configured: requires and verifies the JWT, ignores X-Dev-User", async () => {
    const none = await worker.fetch(req({ "x-dev-user": "dev@example.com" }), accessEnv);
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");

    const bad = await worker.fetch(
      req({ "cf-access-jwt-assertion": await sign(good(), otherPrivate) }),
      accessEnv,
    );
    expect(bad.status).toBe(401);

    const ok = await worker.fetch(
      req({ "cf-access-jwt-assertion": await sign(good()) }),
      accessEnv,
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { data: { email: string } }).data.email).toBe("carol@example.com");

    const cookie = await worker.fetch(
      req({ cookie: `a=b; CF_Authorization=${await sign(good())}` }),
      accessEnv,
    );
    expect(cookie.status).toBe(200);
  });

  it("in production without Access settings: rejects everything except /health", async () => {
    const prod = { ...env, APP_ENV: "production", ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" };
    const res = await worker.fetch(req({ "x-dev-user": "dev@example.com" }), prod);
    expect(res.status).toBe(401);
    const health = await worker.fetch(new Request(`https://example.test${API_PATHS.health}`), prod);
    expect(health.status).toBe(200);
  });

  it("in development: uses X-Dev-User or a default developer identity", async () => {
    const dev = { ...env, APP_ENV: "development" };
    const def = await worker.fetch(req(), dev);
    expect(((await def.json()) as { data: { email: string } }).data.email).toBe(
      "developer@example.com",
    );
    const bad = await worker.fetch(req({ "x-dev-user": "not-an-email" }), dev);
    expect(bad.status).toBe(400);
  });
});
