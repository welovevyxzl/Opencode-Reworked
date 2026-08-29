import { describe, it, expect } from "vitest";
import { runCommand, runPowerShell, resolveBinary } from "../src/utils/index.js";

describe("process launch safety", () => {
  it("passes args as separate argv entries, preserving spaces", async () => {
    // With `node -e`, Node keeps the eval code out of argv; argv[1] is the first
    // real argument passed after the script. Assert the full surviving list.
    const script = `console.log(JSON.stringify(process.argv.slice(1)));`;
    const res = await runCommand(process.execPath, ["-e", script, "C:\\Program Files\\My App\\file.txt", "hello world"]);
    expect(res.code).toBe(0);
    const args = JSON.parse(res.stdout);
    expect(args).toEqual(["C:\\Program Files\\My App\\file.txt", "hello world"]);
  });

  it("does not shell-join or interpret metacharacters in args", async () => {
    const script = `console.log(process.argv[1]);`;
    const res = await runCommand(process.execPath, ["-e", script, "a; rm -rf / && echo HACK"]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe("a; rm -rf / && echo HACK");
  });

  it("surfaces failures for missing executables as code 1", async () => {
    const res = await runCommand("definitely-not-a-real-binary-xyz", ["--version"]);
    expect(res.code).toBe(1);
  });

  it("captures stdout and stderr separately", async () => {
    const script = `console.log("to out"); console.error("to err");`;
    const res = await runCommand(process.execPath, ["-e", script]);
    expect(res.stdout).toBe("to out");
    expect(res.stderr).toBe("to err");
  });
});

describe("powershell launcher", () => {
  it("runs a powershell command and returns output", async () => {
    const res = await runPowerShell('Write-Output "ocr-test"', { timeout: 15000 });
    if (res.code !== 0) {
      // Do NOT weaken the assertion below; surface the failure for diagnosis.
      process.stderr.write(`[powershell diagnostic] code=${res.code} stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}\n`);
    }
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("ocr-test");
  });
});

describe("binary resolution", () => {
  it("resolves an installed executable from PATH", () => {
    // git must be present on a dev machine; resolution walks PATH directly
    // (no shell execution) and returns the candidate or null.
    const git = resolveBinary("git");
    expect(git).toBeTruthy();
  });

  it("returns null instead of throwing for a missing executable", () => {
    expect(resolveBinary("definitely-not-a-real-binary-xyz")).toBeNull();
  });
});