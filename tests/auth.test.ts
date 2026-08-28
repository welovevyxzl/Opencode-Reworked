import { describe, it, expect } from "vitest";
import {
  generateServerPassword,
  sanitizeToken,
  validateDiscordTokenFormat,
  containsSecret,
} from "../src/security/auth.js";

describe("auth helpers", () => {
  it("generates a strong random server password", () => {
    const a = generateServerPassword();
    const b = generateServerPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(a).toHaveLength(32);
    expect(a).not.toBe(b);
  });

  it("redacts tokens for display", () => {
    const token = "MzQxMjg4NDU2NzE4Njg0MzUzOQ.GDQyYS.abcdefghijklmnopqrstuvwxyzABCD";
    const masked = sanitizeToken(token);
    expect(masked).not.toContain(token.slice(7, -4));
    expect(masked).toContain("···");
    expect(masked.length).toBeLessThan(token.length);
  });

  it("rejects invalid token formats", () => {
    expect(validateDiscordTokenFormat("nope")).toBe(false);
    expect(validateDiscordTokenFormat("")).toBe(false);
  });

  it("detects secrets in output", () => {
    expect(containsSecret("my discord_token is abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
    expect(containsSecret("OPENAI_API_KEY=sk-1234567890abcdef")).toBe(true);
    expect(containsSecret("ghp_".padEnd(48, "a"))).toBe(true);
    expect(containsSecret("This is just regular text output")).toBe(false);
  });
});