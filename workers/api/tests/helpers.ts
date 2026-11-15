import { env } from "cloudflare:test";
import { setTextModelOverride as setRawTextModelOverride } from "../src/ai/factory";
import type { TextModel, TextRequest } from "../src/ai/text-model";
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

// --- Fake text models -------------------------------------------------------------------------

/** A valid Creative Director interpretation, returned by test models for that one request. */
export const INTERPRETATION = {
  subject: "The deep ocean",
  audience: "curious viewers",
  key_message: "The deep sea is stranger than you think",
  call_to_action: null,
  tone_words: ["curious", "vivid"],
  setting: "the dark deep sea",
  characters: [
    {
      name: "Diver",
      role: "explorer",
      appearance: "a diver in a yellow dive suit with a round brass helmet",
      wardrobe: "yellow dive suit",
    },
  ],
  style_keywords: ["bioluminescent"],
  must_include: [],
  must_avoid: ["text overlays"],
  language: "en",
  ambiguities: [],
};

const isCreativeDirector = (req: TextRequest) =>
  req.system.startsWith("You are the creative director");

/**
 * Wraps a test model so the Creative Director's interpretation request gets INTERPRETATION and
 * every other request (script, storyboard) reaches the wrapped model in its original order.
 */
export function withCreativeDirector(model: TextModel): TextModel {
  return {
    name: model.name,
    async generate(req) {
      if (isCreativeDirector(req))
        return {
          text: JSON.stringify(INTERPRETATION),
          usage: { input_tokens: 40, output_tokens: 60 },
        };
      return model.generate(req);
    },
  };
}

/** Installs a fake model for the workflow (Creative Director requests answered as above). */
export function setTextModelOverride(model: TextModel | null) {
  setRawTextModelOverride(model ? withCreativeDirector(model) : null);
}

/** The provider facts a test fake doesn't care about: a free, sync, keyless provider. */
export function fakeFacts() {
  return {
    mode: "sync" as const,
    tier: "free" as const,
    cost: { unit: "request" as const, usd_per_unit: 0, source: "test" },
    limits: {},
    timeoutMs: 5_000,
    credential: null,
    commercialUse: true,
  };
}
