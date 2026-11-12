import { env } from "cloudflare:test";
import { createProject, upsertUserByEmail, type CreateProjectRequest } from "../src/db";

export const db = () => env.DB;

export async function makeUser(name = "alice") {
  return upsertUserByEmail(env.DB, `${name}-${crypto.randomUUID()}@example.com`, name);
}

export async function makeProject(userId: string, overrides: Partial<CreateProjectRequest> = {}) {
  return createProject(env.DB, userId, {
    title: "Ocean facts",
    prompt: "Five surprising facts about the deep ocean",
    video_type: "faceless",
    aspect_ratio: "9:16",
    duration_seconds: 30,
    target_platform: "youtube_shorts",
    ...overrides,
  });
}
