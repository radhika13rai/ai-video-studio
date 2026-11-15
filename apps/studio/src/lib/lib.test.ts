import { PROJECT_STATUSES } from "@avs/types";
import { describe, expect, it } from "vitest";
import { isActive, STATUS_DISPLAY, timeAgo } from "./format";
import { matchRoute } from "./router";

describe("matchRoute", () => {
  it.each([
    ["/", { name: "projects" }],
    ["/projects", { name: "projects" }],
    ["/projects/", { name: "projects" }],
    ["/projects/new", { name: "new" }],
    ["/projects/abc-123", { name: "project", id: "abc-123" }],
    ["/status", { name: "status" }],
    ["/projects/abc/edit", { name: "edit", id: "abc" }],
    ["/nope", { name: "not-found" }],
    ["/projects/a/b", { name: "not-found" }],
  ])("%s", (path, expected) => {
    expect(matchRoute(path)).toEqual(expected);
  });
});

describe("format", () => {
  it("has a label for every project status, and polls only in-production ones", () => {
    for (const s of PROJECT_STATUSES) expect(STATUS_DISPLAY[s].label).toBeTruthy();
    expect(PROJECT_STATUSES.filter(isActive)).toEqual([
      "planning",
      "generating",
      "rendering",
      "quality_check",
    ]);
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-11-13T12:00:00Z");
    expect(timeAgo("2026-11-13T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-11-13T11:55:00Z", now)).toBe("5 min ago");
    expect(timeAgo("2026-11-13T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-11-11T12:00:00Z", now)).toBe("2 days ago");
    expect(timeAgo("2026-10-01T12:00:00Z", now)).toMatch(/2026/);
  });
});
