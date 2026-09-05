import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  addFile,
  listFiles,
  removeFile,
  buildContextText,
  totalBytes,
  isAcceptedFile,
  MAX_TOTAL_BYTES,
} from "../knowledgeStore.js";

function makeFile(name, content) {
  return new File([content], name, { type: "text/plain" });
}

beforeEach(() => {
  localStorage.clear();
});

describe("knowledgeStore", () => {
  it("stores an accepted file and lists it back", async () => {
    const result = await addFile(makeFile("about-us.txt", "We build widgets."));
    expect(result.ok).toBe(true);
    expect(listFiles()).toHaveLength(1);
    expect(listFiles()[0].name).toBe("about-us.txt");
  });

  it("rejects a file type outside the allowlist", async () => {
    const result = await addFile(makeFile("about-us.pdf", "binary-ish content"));
    expect(result.ok).toBe(false);
    expect(listFiles()).toHaveLength(0);
    expect(isAcceptedFile(makeFile("notes.md", "x"))).toBe(true);
    expect(isAcceptedFile(makeFile("notes.pdf", "x"))).toBe(false);
  });

  it("refuses a file that would exceed the total storage cap", async () => {
    const big = "x".repeat(MAX_TOTAL_BYTES + 1);
    const result = await addFile(makeFile("huge.txt", big));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/storage limit/);
    expect(listFiles()).toHaveLength(0);
  });

  it("removes a file by id", async () => {
    const { entry } = await addFile(makeFile("a.txt", "one"));
    await addFile(makeFile("b.txt", "two"));
    removeFile(entry.id);
    const remaining = listFiles();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("b.txt");
  });

  it("builds one concatenated context blob from all stored files", async () => {
    await addFile(makeFile("a.txt", "alpha"));
    await addFile(makeFile("b.txt", "beta"));
    const text = buildContextText();
    expect(text).toContain("--- a.txt ---\nalpha");
    expect(text).toContain("--- b.txt ---\nbeta");
  });

  it("returns an empty string when there is nothing stored", () => {
    expect(buildContextText()).toBe("");
  });

  it("reports total bytes across stored files", async () => {
    await addFile(makeFile("a.txt", "12345")); // 5 bytes
    await addFile(makeFile("b.txt", "1234567890")); // 10 bytes
    expect(totalBytes(listFiles())).toBe(15);
  });

  it("notifies listeners whenever the store changes", async () => {
    const onChanged = vi.fn();
    window.addEventListener("ds-knowledge-changed", onChanged);
    await addFile(makeFile("a.txt", "hi"));
    removeFile(listFiles()[0].id);
    window.removeEventListener("ds-knowledge-changed", onChanged);
    expect(onChanged).toHaveBeenCalledTimes(2); // once for add, once for remove
  });
});
