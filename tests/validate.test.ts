import { describe, it, expect } from "vitest";
import { validateDiscordTokenFormat } from "../src/security/auth.js";
import { validateDiscordToken } from "../src/setup/validate.js";

describe("config validation", () => {
  it("accepts well-formed bot tokens", () => {
    const token = "MzQxMjg4NDU2NzE4Njg0MzUzOQ.GDQyYS.abcdefghijklmnopqrstuvwxyzABCD";
    expect(validateDiscordToken(token)).toBeNull();
    expect(validateDiscordTokenFormat(token)).toBe(true);
  });

  it("rejects short tokens", () => {
    expect(validateDiscordToken("short")).not.toBeNull();
  });

  it("rejects tokens with invalid characters", () => {
    expect(validateDiscordToken("123456789012345678901234567890>{bad}")).not.toBeNull();
  });

  it("rejects empty tokens", () => {
    expect(validateDiscordToken("   ")).not.toBeNull();
    expect(validateDiscordToken("")).not.toBeNull();
  });

  it("trims surrounding whitespace", () => {
    const token = "MzQxMjg4NDU2NzE4Njg0MzUzOQ.GDQyYS.abcdefghijklmnopqrstuvwxyzABCD";
    expect(validateDiscordToken(`  ${token}  `)).toBeNull();
  });

  it("rejects whitespace-only tokens for format check", () => {
    expect(validateDiscordTokenFormat("\t\n")).toBe(false);
  });
});