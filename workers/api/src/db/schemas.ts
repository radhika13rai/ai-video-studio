import { z } from "zod";

/** A JSON object stored in a TEXT column (production_config, input_json, metadata …). */
export const jsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof jsonObject>;

export const jsonArray = z.array(z.unknown());
