import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, chmodSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listResolvedBinaries, resolveBinary } from "../src/utils/index.js";
import { findOpenCodeBinary, resetOpenCodeBinaryCache } from "../src/opencode/manager.js";

// ---------------------------------------------------------------------------
// Helpers: build fake "installed" executables in temp dirs we control, and
// rewire PATH (and the npm-global APPDATA/USERPROFILE vars) to isolate them.
// ---------------------------------------------------------------------------

let originalPath: string | undefined;
let originalAppData: string | undefined;
let originalUserProfile: string | undefined;
const roots: string[] = [];
const isWin = process.platform === "win32";

function tempRoot(label: string, spaced = false): string {
  const base = spaced ? `${tmpdir()}\\opencode spaced ${label}` : join(tmpdir(), `opencode-${label}`);
  roots.push(base);
  return base;
}

function shimName(): string {
  return isWin ? "opencode.cmd" : "opencode";
}

function goodBody(): string {
  return isWin ? "@echo off\r\necho opencode 99.0.0\r\nexit /b 0\r\n" : '#!/bin/sh\necho "opencode 99.0.0"\nexit 0\n';
}

function brokenBody(): string {
  return isWin ? "@echo off\r\necho broken\r\nexit /b 1\r\n" : '#!/bin/sh\necho "broken"\nexit 1\n';
}

/** Create a fake opencode shim in `dir`. `good=false` makes --version exit non-zero. */
function installShader(dir: string, good: boolean): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, shimName());
  writeFileSync(path, good ? goodBody() : brokenBody());
  if (!isWin) chmodSync(path, 0o755);
  return path;
}

function setPath(...dirs: string[]) {
  process.env.PATH = dirs.join(isWin ? ";" : ":");
}

function isolateNpmGlobal() {
  // Point APPDATA/USERPROFILE at throwaway dirs so the built-in npm-global
  // fallback never accidentally finds a real opencode on the host machine.
  process.env.APPDATA = tempRoot("appdata");
  process.env.USERPROFILE = tempRoot("userprofile");
}

beforeEach(() => {
  originalPath = process.env.PATH;
  originalAppData = process.env.APPDATA;
  originalUserProfile = process.env.USERPROFILE;
  resetOpenCodeBinaryCache();
});

afterEach(() => {
  if (originalPath !== undefined) process.env.PATH = originalPath;
  if (originalAppData !== undefined) process.env.APPDATA = originalAppData;
  if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
  roots.length = 0;
});

describe("opencode binary resolution", () => {
  it("detects opencode.cmd shim found on PATH", () => {
    const dir = tempRoot("pathshim");
    installShader(dir, true);
    setPath(dir);
    const candidates = listResolvedBinaries("opencode");
    expect(candidates.length).toBeGreaterThan(0);
    expect(resolveBinary("opencode")).toBe(join(dir, shimName()));
    expect(candidates[0]).toBe(join(dir, shimName()));
  });

  it("finds the shim via the npm-global install location (APPDATA\\npm)", () => {
    const appdata = tempRoot("npmglobal");
    const npmDir = join(appdata, "npm");
    installShader(npmDir, true);
    // PATH contains nothing relevant; only the npm-global fallback can find it.
    setPath(tempRoot("empty-path"));
    isolateNpmGlobal();
    process.env.APPDATA = appdata;
    const candidates = listResolvedBinaries("opencode");
    expect(candidates).toContain(join(npmDir, shimName()));
  });

  it("handles paths containing spaces", async () => {
    const dir = tempRoot("space", true);
    installShader(dir, true);
    setPath(dir);
    const resolved = resolveBinary("opencode");
    expect(resolved).toBe(join(dir, shimName()));
    // And the shim actually runs from the spaced directory via the Windows
    // cmd.exe launch path (which proves the quoting/escaping works).
    const found = await findOpenCodeBinary();
    expect(found).toBe(join(dir, shimName()));
  });

  it("returns null for a missing executable", async () => {
    setPath(tempRoot("empty-path"));
    isolateNpmGlobal();
    expect(resolveBinary("opencode")).toBeNull();
    expect(await findOpenCodeBinary()).toBeNull();
  });
});

describe("opencode binary selection & caching", () => {
  it("skips a broken candidate and selects the next working one", async () => {
    const brokenDir = tempRoot("broken");
    const goodDir = tempRoot("good");
    const broken = installShader(brokenDir, false);
    const good = installShader(goodDir, true);
    setPath(brokenDir, goodDir);

    // Both candidates are enumerated in PATH order...
    expect(listResolvedBinaries("opencode")[0]).toBe(broken);
    // ...but findOpenCodeBinary verifies each with --version and picks the good one.
    const found = await findOpenCodeBinary();
    expect(found).toBe(good);
  });

  it("invalidates a cached binary that stopped working and re-resolves", async () => {
    const firstDir = tempRoot("first");
    const secondDir = tempRoot("second");
    const first = installShader(firstDir, true);
    setPath(firstDir);

    // First resolution caches the working shim in firstDir.
    expect(await findOpenCodeBinary()).toBe(first);

    // The shim "breaks" and a replacement is installed in a location that now
    // takes precedence on PATH. The stale cached path must be invalidated.
    installShader(firstDir, false);
    const second = installShader(secondDir, true);
    setPath(secondDir);

    const found = await findOpenCodeBinary();
    expect(found).toBe(second);
  });

  it("does not return a cached binary that no longer exists", async () => {
    const dir = tempRoot("gone");
    const path = installShader(dir, true);
    setPath(dir);
    expect(await findOpenCodeBinary()).toBe(path);
    // Remove the binary; the cached path fails validation and resolution is null.
    rmSync(path, { force: true });
    isolateNpmGlobal();
    setPath(tempRoot("empty-path"));
    expect(await findOpenCodeBinary()).toBeNull();
  });
});
