import { describe, expect, it } from "vitest";
import { KNOWN_MODELS, resolveModelInput } from "../server/runtime-config.js";

describe("claude model resolution", () => {
  it("registers claude-sonnet-5 as a known model", () => {
    expect(KNOWN_MODELS.has("claude-sonnet-5")).toBe(true);
    expect(resolveModelInput("claude-sonnet-5")).toBe("claude-sonnet-5");
  });

  it("maps the 'sonnet' alias to Sonnet 5", () => {
    expect(resolveModelInput("sonnet")).toBe("claude-sonnet-5");
    expect(resolveModelInput("Sonnet 5")).toBe("claude-sonnet-5");
  });

  it("maps the 'opus' alias to Opus 4.8", () => {
    expect(resolveModelInput("opus")).toBe("claude-opus-4-8");
    expect(KNOWN_MODELS.has("claude-opus-4-8")).toBe(true);
  });

  it("still resolves prior-generation aliases (backward compat)", () => {
    expect(resolveModelInput("sonnet 4.6")).toBe("claude-sonnet-4-6");
    expect(resolveModelInput("opus 4.7")).toBe("claude-opus-4-7");
  });
});
