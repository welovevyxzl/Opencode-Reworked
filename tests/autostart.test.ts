import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  enableBootAutostart,
  disableBootAutostart,
  isBootAutostartEnabled,
  getStartupFilePath,
  hasBootAutostartSupport,
} from "../src/platform/autostart.js";

const origPlatform = process.platform;
const origAppData = process.env.APPDATA;

function withPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p });
}

describe("autostart — Windows", () => {
  let fakeAppData = "";

  beforeEach(() => {
    fakeAppData = mkdtempSync(join(tmpdir(), "ocr-ast-home-"));
    process.env.APPDATA = fakeAppData;
    withPlatform("win32");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform });
    process.env.APPDATA = origAppData;
  });

  it("detects Windows support", () => {
    expect(hasBootAutostartSupport()).toBe(true);
  });

  it("writes a launcher into the Startup folder on enable", () => {
    const r = enableBootAutostart();
    expect(r.ok).toBe(true);
    const target = join(fakeAppData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "opencode-remote.cmd");
    expect(existsSync(target)).toBe(true);
    const content = readFileSync(target, "utf-8");
    expect(content).toContain("ocr start");
    expect(content).toContain("OpenCode Remote");
  });

  it("reports enabled after enable and disabled after disable", async () => {
    expect(await isBootAutostartEnabled()).toBe(false);
    enableBootAutostart();
    expect(await isBootAutostartEnabled()).toBe(true);
    const d = disableBootAutostart();
    expect(d.ok).toBe(true);
    expect(await isBootAutostartEnabled()).toBe(false);
  });

  it("returns the startup file path", () => {
    const p = getStartupFilePath();
    expect(p).toBe(join(fakeAppData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "opencode-remote.cmd"));
  });
});

describe("autostart — non-Windows", () => {
  let fakeAppData = "";

  beforeEach(() => {
    fakeAppData = mkdtempSync(join(tmpdir(), "ocr-unix-home-"));
    process.env.APPDATA = fakeAppData;
    withPlatform("linux");
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform });
    process.env.APPDATA = origAppData;
  });

  it("does not support boot autostart off Windows", async () => {
    expect(hasBootAutostartSupport()).toBe(false);
    const r = enableBootAutostart();
    expect(r.ok).toBe(false);
    expect(await isBootAutostartEnabled()).toBe(false);
  });
});
