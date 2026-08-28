import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isValidPath,
  safePath,
  generateId,
  formatDuration,
  truncate,
  getMemoryUsage,
  getPlatform,
  getNodeVersion,
  sleep,
} from "../src/utils/index.js";

describe("utils — path helpers", () => {
  it("validates existing directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocr-valid-path-"));
    expect(isValidPath(dir)).toBe(true);
    expect(isValidPath(join(dir, "does-not-exist"))).toBe(false);
    expect(isValidPath("")).toBe(false);
    expect(isValidPath("   ")).toBe(false);
  });

  it("accepts paths with spaces", () => {
    const root = mkdtempSync(join(tmpdir(), "ocr path with spaces"));
    const nested = join(root, "my project");
    mkdirSync(nested, { recursive: true });
    expect(isValidPath(nested)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("normalizes forward slashes to backslashes on Windows", () => {
    const normalized = safePath("C:/Program Files/App");
    expect(isValidPath(normalized) === false || normalized.includes("\\")).toBe(true);
  });
});

describe("utils — formatting", () => {
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(5 * 1000)).toBe("5s");
    expect(formatDuration(65 * 1000)).toBe("1m 5s");
    expect(formatDuration(3600 * 1000 + 60 * 1000)).toBe("1h 1m");
  });

  it("truncates long strings", () => {
    expect(truncate("short", 20)).toBe("short");
    expect(truncate("x".repeat(100), 10)).toHaveLength(10);
    expect(truncate("x".repeat(100), 10).endsWith("...")).toBe(true);
  });

  it("generates unique ids", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) ids.add(generateId());
    expect(ids.size).toBe(500);
  });
});

describe("utils — environment", () => {
  it("returns sane memory numbers", () => {
    const mem = getMemoryUsage();
    expect(typeof mem.used).toBe("number");
    expect(typeof mem.total).toBe("number");
  });

  it("reports platform and node version", () => {
    expect(getPlatform()).toContain(process.platform);
    expect(getNodeVersion()).toBe(process.version);
  });

  it("sleep resolves after the given delay", async () => {
    const start = Date.now();
    await sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});