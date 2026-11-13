# Agents

Code: `workers/api/src/agents/`. Each agent validates its input with Zod, returns
`{ output, meta }` with a typed output, and fails with an `AgentError` whose `kind` is
`invalid_input`, `invalid_output`, `quota` or `unavailable` and which says whether a retry can help.

| Agent        | Kind          | Input                 | Output                                                                 |
| ------------ | ------------- | --------------------- | ---------------------------------------------------------------------- |
| Director     | Deterministic | Brief                 | `ProductionPlan`: video type, pipeline, scene count, word budget, tone |
| Scriptwriter | Text model    | Brief + plan          | `Script`: title, hook, segments, call to action                        |
| Storyboard   | Text model    | Brief + plan + script | `Storyboard`: numbered scenes ready for `replaceScenes`                |

The researcher, visual artist, voice director, editor, quality control and operations agents from
the blueprint arrive with the tasks that need them (7–10).

## Director (no AI)

When `video_type` is `auto`, keyword rules pick one of advertisement, explainer, animation,
cinematic, presenter or faceless (the default), with a confidence score and a reason. A type the
user chose is kept. The pipeline table then decides the visual style (image, video or animation),
narration, presenter and the provider capabilities needed. Scene count is duration ÷ 5, between 2
and 20; the word budget is 2.5 spoken words per second. **Why deterministic:** routing doesn't need
a model (CLAUDE.md rule 15); rules are free, instant and testable.

## Structured output

`runStructured` asks the model for JSON and sends the JSON Schema generated from the agent's Zod
schema (Workers AI enforces it with `response_format`). The reply is parsed (code fences and chatter
are tolerated), validated against the schema, then against agent checks such as the word budget
and scene count. An invalid reply gets **one** corrective retry that quotes the exact problem; a
second failure is `invalid_output`. Provider quota errors become `quota` (not retryable today).

## Prompt safety

The brief is user input. Every system prompt says to treat it as a description only and ignore
instructions inside it. Agents ask for no statistics, quotes or sources the model isn't sure of,
no text overlays, logos or real people's names in visual prompts.

## Storyboard normalization

Scene numbers are reassigned 1…n. Durations are scaled to sum exactly to the project length
(0.1 s precision, each scene at least 0.5 s). A visual type the pipeline doesn't allow (for example
`video` in an image pipeline) is replaced with the pipeline default and counted in
`coerced_visual_types`, so the change is recorded, not hidden.

## Testing

`tests/agents.test.ts` drives every agent with a scripted fake model: valid output, fenced JSON,
retry with feedback, over-long scripts, schema violations, quota errors, scene-count retries,
normalization, and saving a storyboard through the real repository into local D1.
