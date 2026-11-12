# Security

## Identity

| `APP_ENV`              | Access settings set? | Behaviour                                                                |
| ---------------------- | -------------------- | ------------------------------------------------------------------------ |
| any                    | yes                  | Requires a valid Cloudflare Access JWT                                   |
| `development` / `test` | no                   | Local developer identity: `X-Dev-User: <email>` or developer@example.com |
| `production` (default) | no                   | **Every API call except `/health` is rejected (401)**                    |

`wrangler.jsonc` sets `APP_ENV` to `production`, so a deploy without sign-in configured fails
closed. `pnpm dev` passes `--var APP_ENV:development`; tests use `test`. `X-Dev-User` is ignored
whenever Access is configured.

### Cloudflare Access (private beta)

The JWT comes from the `Cf-Access-Jwt-Assertion` header (or the `CF_Authorization` cookie). The
Worker verifies it with WebCrypto: RS256 signature against
`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` (cached 10 minutes, refetched once on an
unknown key ID), issuer, audience, expiry and not-before (60 s skew), and an email claim. The email
is mapped to a row in `users`.

To set it up (free for up to 50 users; check Cloudflare's current terms):

1. Zero Trust dashboard → Access → Applications → add a self-hosted application for the Worker's
   domain, with a policy allowing your email.
2. Copy the **Application Audience (AUD) tag** and your team domain.
3. Put them in `wrangler.jsonc` `vars` as `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`. They are not
   secrets.

## Authorization

Every project query checks ownership inside the SQL (see `DATABASE.md`). Another user's project
answers 404.

## Input and output

- Bodies must be `application/json`, at most 64 KB, and pass Zod validation before any database work.
- Errors use the shared envelope and never include stack traces or SQL.
- API responses send `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

## Secrets

- No credentials in source control, `.env.example`, D1 or the frontend.
- Provider keys will be Worker secrets (`wrangler secret put`), added only for providers actually
  integrated.
- The R2 bucket is private; media will be served through authenticated endpoints (Task 9).

## Not yet done

- Rate limiting (`RATE_LIMITED` is reserved).
- Self-service registration and sessions, needed before opening beyond a private beta.
