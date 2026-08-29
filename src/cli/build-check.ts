import { getBuildInfo } from "../utils/build-info.js";
import { resolveBinary, runCommand } from "../utils/index.js";

/**
 * Source-vs-dist guard. The runtime executes dist/, so restarts check whether
 * TypeScript sources are newer than the compiled output. With auto:true (the
 * default for `ocr restart`) a rebuild is attempted automatically; if the
 * build fails the restart is refused with a clear message.
 */

export interface BuildCheckResult {
  ok: boolean;
  rebuilt: boolean;
  message: string;
}

export async function ensureFreshBuild(opts: { auto: boolean }): Promise<boolean> {
  const info = getBuildInfo();

  // Development (tsx from src/) is always fresh; global installs have no src/.
  if (info.runningFrom !== "dist" || !info.sourceChangedSinceBuild) {
    return true;
  }

  if (!opts.auto) {
    console.log("  ✗ Source has changed since the last build. Run `npm run build`.");
    return false;
  }

  console.log("  Source has changed since the last build — rebuilding before restart…");
  const result = await runBuild(info.installRoot);
  if (!result.ok) {
    console.log("  ✗ Rebuild failed. Restart aborted so the old build keeps running.");
    console.log(result.output.split("\n").slice(-12).map((l) => `  | ${l}`).join("\n"));
    return false;
  }
  console.log("  ✓ Rebuilt successfully.");
  return true;
}

function runBuild(root: string | null): Promise<{ ok: boolean; output: string }> {
  const cwd = root ?? process.cwd();
  const npm = resolveBinary("npm");
  if (!npm) {
    return Promise.resolve({ ok: false, output: "npm binary not found." });
  }
  return runCommand(npm, ["run", "build"], { cwd, timeout: 0 }).then((res) => ({
    ok: res.code === 0,
    output: `${res.stdout}\n${res.stderr}`.trim(),
  }));
}
