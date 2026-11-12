import { z } from "zod";

/**
 * Verifies a Cloudflare Access JWT (the `Cf-Access-Jwt-Assertion` header) with WebCrypto:
 * RS256 signature against the team's published keys, plus issuer, audience and expiry.
 */

const jwkSchema = z.object({
  kid: z.string(),
  kty: z.literal("RSA"),
  alg: z.string().optional(),
  n: z.string(),
  e: z.string(),
});
const certsSchema = z.object({ keys: z.array(z.looseObject({ kid: z.string() })) });
export type AccessJwk = z.infer<typeof jwkSchema>;

const headerSchema = z.object({ alg: z.literal("RS256"), kid: z.string() });
const claimsSchema = z.object({
  aud: z.union([z.string(), z.array(z.string())]),
  iss: z.string(),
  exp: z.number(),
  nbf: z.number().optional(),
  email: z.string().optional(),
  sub: z.string().optional(),
});
export interface AccessIdentity {
  email: string;
  sub: string | null;
}

export class AccessError extends Error {}

export function normalizeTeamDomain(domain: string): string {
  const host = domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  return `https://${host}`;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodePart(part: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
  } catch {
    throw new AccessError("token is malformed");
  }
}

export type KeyFetcher = (teamDomain: string, forceRefresh: boolean) => Promise<AccessJwk[]>;

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { keys: AccessJwk[]; at: number }>();

/** Fetches (and caches for 10 minutes) the team's signing keys. The response is validated. */
export const fetchAccessKeys: KeyFetcher = async (teamDomain, forceRefresh) => {
  const hit = cache.get(teamDomain);
  if (hit && !forceRefresh && Date.now() - hit.at < CACHE_TTL_MS) return hit.keys;
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new AccessError(`could not fetch Access keys (HTTP ${res.status})`);
  const body = certsSchema.safeParse(await res.json().catch(() => null));
  if (!body.success) throw new AccessError("Access keys response has an unexpected shape");
  const keys = body.data.keys.flatMap((k) => {
    const parsed = jwkSchema.safeParse(k);
    return parsed.success ? [parsed.data] : [];
  });
  cache.set(teamDomain, { keys, at: Date.now() });
  return keys;
};

export async function verifyAccessJwt(
  token: string,
  opts: { teamDomain: string; audience: string; getKeys?: KeyFetcher; now?: number },
): Promise<AccessIdentity> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessError("token is malformed");
  const [h = "", p = "", s = ""] = parts;
  const header = headerSchema.safeParse(decodePart(h));
  if (!header.success) throw new AccessError("token header is not valid (RS256 with kid required)");
  const claims = claimsSchema.safeParse(decodePart(p));
  if (!claims.success) throw new AccessError("token claims are not valid");

  const issuer = normalizeTeamDomain(opts.teamDomain);
  const getKeys = opts.getKeys ?? fetchAccessKeys;
  let jwk = (await getKeys(issuer, false)).find((k) => k.kid === header.data.kid);
  if (!jwk) jwk = (await getKeys(issuer, true)).find((k) => k.kid === header.data.kid);
  if (!jwk) throw new AccessError("token was signed by an unknown key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) throw new AccessError("token signature is not valid");

  const c = claims.data;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const SKEW = 60;
  if (c.exp < now - SKEW) throw new AccessError("token has expired");
  if (c.nbf !== undefined && c.nbf > now + SKEW) throw new AccessError("token is not valid yet");
  if (normalizeTeamDomain(c.iss) !== issuer) throw new AccessError("token issuer does not match");
  const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!auds.includes(opts.audience)) throw new AccessError("token audience does not match");
  if (!c.email) throw new AccessError("token has no email (service tokens are not supported)");
  return { email: c.email, sub: c.sub ?? null };
}
