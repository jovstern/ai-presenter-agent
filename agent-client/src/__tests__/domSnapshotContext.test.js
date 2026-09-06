import { describe, it, expect } from "vitest";
import { isFullRefresh, buildFullSnapshotText, buildIncrementalText } from "../domSnapshotContext.js";

const node = (selector, label, disabled = false) => ({ selector, role: "button", label, disabled });

describe("isFullRefresh", () => {
  it("is true on a page change, regardless of delta size", () => {
    expect(
      isFullRefresh({ page: "settings.html", previousPage: "index.html", changed: [], removed: [], full: [node("a", "A")] })
    ).toBe(true);
  });

  it("is true when there's nothing to diff against yet", () => {
    expect(
      isFullRefresh({ page: "index.html", previousPage: "index.html", changed: [], removed: [], full: [] })
    ).toBe(true);
  });

  it("is true when the delta covers most of the page", () => {
    const full = [node("a", "A"), node("b", "B"), node("c", "C")];
    expect(
      isFullRefresh({ page: "index.html", previousPage: "index.html", changed: [node("a", "A2"), node("b", "B2")], removed: [], full })
    ).toBe(true); // 2/3 changed >= 0.6
  });

  it("is false for a small same-page delta", () => {
    const full = [node("a", "A"), node("b", "B"), node("c", "C"), node("d", "D"), node("e", "E")];
    expect(
      isFullRefresh({ page: "index.html", previousPage: "index.html", changed: [node("a", "A2")], removed: [], full })
    ).toBe(false); // 1/5 changed
  });
});

describe("buildFullSnapshotText", () => {
  it("formats every node with its role, label, and disabled state", () => {
    const text = buildFullSnapshotText({
      page: "index.html",
      full: [node("[data-testid=\"btn\"]", "Deploy"), { ...node("[data-testid=\"x\"]", "X"), disabled: true }],
    });
    expect(text).toContain('Now on "index.html"');
    expect(text).toContain('[data-testid="btn"] (button): "Deploy"');
    expect(text).toContain('[data-testid="x"] (button): "X" [disabled]');
  });

  it("returns null when there's nothing on the page", () => {
    expect(buildFullSnapshotText({ page: "index.html", full: [] })).toBeNull();
  });
});

describe("buildIncrementalText", () => {
  it("describes changed and removed elements only", () => {
    const text = buildIncrementalText({
      page: "index.html",
      changed: [node("[data-testid=\"counter-label\"]", "Widgets deployed: 1")],
      removed: ["[data-testid=\"old-banner\"]"],
    });
    expect(text).toContain('On "index.html"');
    expect(text).toContain('is now: "Widgets deployed: 1"');
    expect(text).toContain('[data-testid="old-banner"] is no longer on the page');
  });

  it("returns null when nothing actually changed", () => {
    expect(buildIncrementalText({ page: "index.html", changed: [], removed: [] })).toBeNull();
  });
});
