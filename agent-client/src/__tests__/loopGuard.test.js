import { describe, it, expect } from "vitest";
import { createLoopGuard } from "../loopGuard.js";

describe("loopGuard", () => {
  it("does not flag distinct actions", () => {
    const guard = createLoopGuard();
    expect(guard.check("click:a")).toBe(false);
    expect(guard.check("click:b")).toBe(false);
    expect(guard.check("click:c")).toBe(false);
  });

  it("flags an action once it repeats past the threshold", () => {
    const guard = createLoopGuard({ repeatThreshold: 3 });
    expect(guard.check("click:a")).toBe(false);
    expect(guard.check("click:a")).toBe(false);
    expect(guard.check("click:a")).toBe(true); // 3rd consecutive repeat
    expect(guard.check("click:a")).toBe(true);
  });

  it("resets the streak once a different action is seen", () => {
    const guard = createLoopGuard({ repeatThreshold: 3 });
    guard.check("click:a");
    guard.check("click:a");
    expect(guard.check("click:b")).toBe(false);
    expect(guard.check("click:a")).toBe(false); // streak restarted, not continued
  });

  it("reset() clears history", () => {
    const guard = createLoopGuard({ repeatThreshold: 2 });
    guard.check("x");
    expect(guard.check("x")).toBe(true);
    guard.reset();
    expect(guard.check("x")).toBe(false);
  });
});
