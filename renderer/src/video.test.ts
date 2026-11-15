import { describe, expect, it } from "vitest";
import { clipTime, sfxCues } from "./video";

describe("stock footage timing", () => {
  it("plays a long enough clip at normal speed from the start", () => {
    expect(clipTime(0, 5, 8)).toBe(0);
    expect(clipTime(2.5, 5, 8)).toBe(2.5);
  });

  it("slows a short clip to fill its scene instead of looping", () => {
    expect(clipTime(2.5, 5, 2)).toBeCloseTo(1, 5);
    expect(clipTime(5, 5, 2)).toBeCloseTo(1.95, 5); // never past the last frame
  });

  it("never seeks before the start or into an empty clip", () => {
    expect(clipTime(-1, 5, 8)).toBe(0);
    expect(clipTime(3, 5, 0)).toBe(0);
  });
});

describe("transition sound effects", () => {
  it("whooshes just before whip, slide and zoom; hits on flash; silent otherwise", () => {
    expect(
      sfxCues([
        { seconds: 5, transition: "whip" },
        { seconds: 10, transition: "crossfade" },
        { seconds: 15, transition: "flash" },
        { seconds: 20, transition: "cut" },
        { seconds: 25, transition: undefined },
        { seconds: 30, transition: "zoom" },
      ]),
    ).toEqual([
      { at: 4.75, kind: "whoosh" },
      { at: 15, kind: "hit" },
      { at: 29.75, kind: "whoosh" },
    ]);
  });
});
