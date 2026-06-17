import { describe, expect, it, vi } from "vitest";
import { toUserMessage } from "../../lib/errors";

vi.spyOn(console, "error").mockImplementation(() => {});

describe("toUserMessage", () => {
  it("maps known Rust error classes to actionable copy", () => {
    expect(toUserMessage("Failed to update note: database is locked")).toBe(
      "The database is busy. Try again in a moment.",
    );
    expect(toUserMessage("No such file or directory (os error 2)")).toContain("file was missing");
    expect(toUserMessage("selected template not found")).toContain("Settings → Templates");
    expect(toUserMessage("401 Unauthorized")).toContain("Settings → AI");
    expect(toUserMessage("error sending request for url (http://localhost:11434/)"))
      .toContain("Ollama");
  });

  it("passes through short unknown errors, trimmed of prefixes", () => {
    expect(toUserMessage("Error: the widget exploded")).toBe("the widget exploded");
  });

  it("bounds very long unknown errors", () => {
    const long = "x".repeat(400);
    const msg = toUserMessage(long);
    expect(msg.length).toBeLessThanOrEqual(140);
    expect(msg.endsWith("…")).toBe(true);
  });

  it("falls back for empty errors and accepts Error objects", () => {
    expect(toUserMessage("", "Couldn't save")).toBe("Couldn't save");
    expect(toUserMessage(new Error("database is locked"))).toContain("busy");
  });
});
