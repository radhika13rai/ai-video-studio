# Public SaaS implementation plan

## Product boundary
The existing application is a single-user-per-account video production system. Public SaaS will preserve the current Cloudflare control plane and per-user project ownership model. It will not introduce a second database, Redis, a permanent server, or a GPU dependency.
- Frontend: existing React/Vite app, same-origin API.
- API: existing Cloudflare Worker.
- Data: D1, with every tenant-owned query scoped by authenticated user ID.
- Media: private R2, accessed only through authenticated Worker routes.
- Long-running production: existing Cloudflare Workflows.
- Rendering: existing browser renderer; hosted GPU rendering remains an optional paid-provider capability.
- Email: provider adapter called server-side with a Worker secret.
- Billing: provider adapter; **Razorpay is the initial payment provider**. Keep the internal subscription and entitlement model provider-neutral.

## Current repository state
The project already has project CRUD, per-user SQL ownership checks, Cloudflare Access JWT authentication, durable production workflows, provider budgets, browser rendering, a timeline editor, and quality checks. It is not a public account system: the current production identity path is Cloudflare Access and there is no self-service password registration, verified email flow, or customer billing portal.

## Foundation added on this branch
- Migration 0006 adds password/account lifecycle fields, opaque server-side session storage, single-use email verification token storage, rate-limit buckets, plan catalog, subscriptions, idempotent tenant usage events, and billing webhook event deduplication.
- Migration 0007 adds password reset tokens, account deletion scheduling, and a partial unique index that prevents multiple live subscriptions per user.
- Existing Cloudflare Access users are backfilled as verified and active, preserving the current private beta during staged rollout.
- Seed plans are configuration examples, not promises of actual commercial entitlements or live prices. Product limits, currency, billing cadence and tax treatment must be reviewed before public launch.

## Required implementation sequence
### P0 — Authentication and account lifecycle
1. Implement registration with normalized email, password policy, duplicate-account-safe responses, and a pending-verification account state.
2. Hash passwords using Web Crypto PBKDF2-HMAC-SHA-256 with per-user random salt, high iteration count, versioned encoding, and constant-time verification. Never store or log plaintext passwords.
3. Send short-lived, single-use email verification links through a server-side email adapter. Store only SHA-256 token hashes. Never return verification tokens from production API responses.
4. Implement login, logout, logout-all, current-session, password reset request/consume, and account deletion request/cancel.
5. Use opaque random session tokens; store only token hashes in D1. Cookie must be Secure, HttpOnly, SameSite=Lax or Strict, Path=/, with a __Host- prefix and bounded expiry. Rotate on login and privilege changes.
6. Enforce email verification before production jobs can be started. Keep health public. Do not allow client-supplied user IDs to establish identity.
7. Add origin checks for cookie-authenticated state-changing routes, rate limiting on register/login/verification/reset, and generic responses that do not reveal whether an email exists.
8. Keep Cloudflare Access as an explicitly selected owner/admin authentication mode during migration; never silently trust Access headers when the account-password mode is selected.

### P1 — Entitlements and metering
1. Resolve each user's effective plan from the active subscription, falling back to Free.
2. Enforce quotas server-side before project creation, generation start, scene regeneration, render reservation and storage upload.
3. Meter with idempotency keys and UTC billing periods. Concurrent requests must reserve usage atomically; do not perform read-then-write quota checks.
4. Track usage separately from provider estimated cost. User plan quotas are not the same as provider cost budgets.
5. Expose `/me/entitlements` and `/me/usage`; UI must render server-returned limits, never hard-code plan entitlements.
6. Add cleanup for expired auth tokens/sessions and retention policy for usage and billing events.

### P2 — Razorpay subscriptions and billing
1. Use Razorpay Subscriptions for recurring Creator/Studio plans. Create and maintain Razorpay Plan records as controlled merchant configuration; persist the resulting Razorpay plan IDs against internal plan versions. Do not create a new Razorpay plan on every customer checkout.
2. Create Razorpay subscriptions only from the Cloudflare Worker using server-held API credentials. Associate the internal user and plan version through server-controlled notes/reference metadata; never trust a user ID, amount, plan ID or entitlement sent by the browser.
3. Return only the hosted checkout/subscription details required by the frontend. Never expose the Razorpay key secret or webhook secret.
4. Implement a dedicated public webhook endpoint. Verify `X-Razorpay-Signature` with HMAC-SHA256 over the **exact raw request body bytes** and the configured webhook secret before parsing JSON or changing records.
5. Persist the provider event ID in `billing_webhook_events` before acknowledging; deduplicate retries and make event handling safe when deliveries are duplicated or arrive out of order. Acknowledge only after durable receipt; process state transitions idempotently.
6. Map Razorpay subscription lifecycle and payment events to internal states. Never grant or revoke access solely from a browser redirect or checkout callback; use verified server-side webhook state and, where necessary, fetch the current subscription from Razorpay to reconcile ambiguous/out-of-order events.
7. Handle activation, successful charges, payment failures/pending, halted/cancelled subscriptions, plan changes, refunds/disputes where relevant, and a documented grace-period policy. Preserve event history for support and reconciliation.
8. Keep Razorpay customer/subscription/plan identifiers and raw payloads out of public user responses. Never store card or UPI mandate credentials.
9. Before production, confirm Razorpay merchant onboarding/KYC, subscription product enablement, supported payment methods, recurring mandate rules, international-payment eligibility, settlement and tax/receipt requirements for the merchant account.
10. Keep internal prices configurable by plan version. Razorpay Plan amounts use the currency's smallest unit (for INR, paise); never infer a commercial price from the current seed data.

### P3 — Public launch security
- Add per-IP and per-account throttles, abuse detection, signup verification and configurable signup controls.
- Add tenant isolation tests for every new endpoint, including assets, timelines, exports, webhooks and account settings.
- Add security headers, CSP, CSRF/origin checks, secure cookie tests, dependency scanning, secret scanning and audit logs for account/billing changes.
- Add data export and deletion workflows covering D1 rows, R2 objects, sessions, provider jobs and workflow instances.
- Verify D1 backup/restore and migration rollback strategy. D1 schema rollback is not equivalent to restoring user data.
- Run production smoke tests using two separate accounts and verify no cross-tenant reads, writes, asset access or quota consumption.

## Launch gates
Public registration must remain disabled until P0 is complete. Paid checkout must remain disabled until P2 is complete. The deployment pipeline must not auto-enable either feature merely because a migration has landed.
Required end-to-end tests:
- Register → receive email → verify → login → create project → generate → render → download.
- Login from two devices; logout one session and logout all sessions.
- Expired, reused and tampered verification/reset tokens are rejected.
- Account A cannot enumerate or access Account B's projects, jobs, assets, timelines, renders or usage.
- Simultaneous requests cannot exceed quota; retries with the same idempotency key do not double-charge usage.
- Duplicate, invalid-signature, out-of-order and replayed Razorpay webhooks do not corrupt subscriptions or entitlements.
- Deletion request cancels safely and eventually removes user data and R2 objects under the published retention policy.

## Operational configuration still required
No credentials are added by this branch. Before enabling public registration, configure an email delivery provider, verified sender domain, app base URL, Cloudflare rate limiting or equivalent durable limiter, and alerting. Before enabling Razorpay billing, configure merchant onboarding/KYC, Razorpay API key ID and key secret as Worker secrets, a separate webhook secret as a Worker secret, webhook URL/event subscriptions in the Razorpay Dashboard, test-mode plans and product/price IDs, then complete test-mode end-to-end and reconciliation checks. Never put credentials in GitHub files, frontend variables, chat, or D1.

## Important launch warning
This branch is a database and architecture foundation, not a completed public authentication or billing implementation. Razorpay has been selected, but its API adapter, webhook receiver, pricing configuration and live credentials are not yet implemented. Do not deploy it to public production or announce self-service signup or paid checkout until the launch gates above pass.
