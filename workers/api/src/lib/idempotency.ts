import { ApiError } from "./errors";

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Runs `work` at most once per (user, Idempotency-Key). A repeat with the same request replays
 * the stored response; a repeat with a different request is rejected; a repeat while the first
 * is still running gets a retryable 409. Server errors (5xx) are not stored, so they can be retried.
 */
export async function withIdempotency(
  db: D1Database,
  userId: string,
  key: string | null,
  request: Request,
  work: () => Promise<Response>,
): Promise<Response> {
  if (key === null) return work();
  if (!KEY_PATTERN.test(key))
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Idempotency-Key must be 1–255 visible ASCII characters.",
    );

  const url = new URL(request.url);
  const hash = await sha256(`${request.method} ${url.pathname}\n${await request.clone().text()}`);
  const cutoff = new Date(Date.now() - IDEMPOTENCY_TTL_MS).toISOString();
  const [, reserved] = await db.batch([
    db
      .prepare("DELETE FROM idempotency_keys WHERE user_id = ? AND created_at < ?")
      .bind(userId, cutoff),
    db
      .prepare(
        "INSERT INTO idempotency_keys (user_id, idem_key, request_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .bind(userId, key, hash, new Date().toISOString()),
  ]);

  if (reserved?.meta.changes === 1) {
    let response: Response;
    try {
      response = await work();
    } catch (err) {
      await release(db, userId, key);
      throw err;
    }
    if (response.status >= 500) {
      await release(db, userId, key);
      return response;
    }
    const body = await response.clone().text();
    await db
      .prepare(
        "UPDATE idempotency_keys SET status_code = ?, response_body = ? WHERE user_id = ? AND idem_key = ?",
      )
      .bind(response.status, body, userId, key)
      .run();
    return response;
  }

  const row = await db
    .prepare(
      "SELECT request_hash, status_code, response_body FROM idempotency_keys WHERE user_id = ? AND idem_key = ?",
    )
    .bind(userId, key)
    .first<{ request_hash: string; status_code: number | null; response_body: string | null }>();
  if (!row) throw new ApiError(409, "CONFLICT", "Idempotency key state changed; retry.", true);
  if (row.request_hash !== hash)
    throw new ApiError(
      422,
      "IDEMPOTENCY_KEY_REUSED",
      "This Idempotency-Key was already used for a different request.",
    );
  if (row.status_code === null)
    throw new ApiError(409, "CONFLICT", "The original request is still being processed.", true);
  return new Response(row.response_body, {
    status: row.status_code,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "idempotent-replayed": "true",
    },
  });
}

async function release(db: D1Database, userId: string, key: string): Promise<void> {
  await db
    .prepare("DELETE FROM idempotency_keys WHERE user_id = ? AND idem_key = ?")
    .bind(userId, key)
    .run();
}
