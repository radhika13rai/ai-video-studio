import { z } from "zod";
import { invalidData } from "./errors";
import { newId, nowIso } from "./util";

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

const email = z.string().trim().toLowerCase().pipe(z.email()).pipe(z.string().max(320));

/**
 * Finds the user for a verified identity (e.g. a Cloudflare Access email), creating it on first
 * sight. Safe to call concurrently: the email is UNIQUE and the insert is a no-op on conflict.
 */
export async function upsertUserByEmail(
  db: D1Database,
  rawEmail: string,
  displayName?: string,
): Promise<User> {
  const parsed = email.safeParse(rawEmail);
  if (!parsed.success) throw invalidData("email is not valid");
  await db
    .prepare(
      "INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING",
    )
    .bind(newId(), parsed.data, displayName ?? null, nowIso())
    .run();
  const user = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(parsed.data)
    .first<User>();
  if (!user) throw new Error("user upsert failed");
  return user;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}
