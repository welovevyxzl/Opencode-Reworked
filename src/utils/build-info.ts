import { existsSync, statSync, readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * Build/version information + source-vs-dist staleness detection. The runtime
 * executes dist/, so `ocr restart` refuses (or rebuilds) when TypeScript
 * sources are newer than the compiled output.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface BuildInfo {
  version: string;
  runningFrom: "dist" | "src" | "unknown";
  builtAt: number | null;
  sourceChangedSinceBuild: boolean;
  installRoot: string | null;
}

function findInstallRoot(): string | null {
  // dist/cli/... or src/cli/... → package root is two levels up.
  let dir = __dirname;
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "src"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function newestMtime(dir: string, filter: (name: string) => boolean, maxDepth = 4): number {
  let newest = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        if (maxDepth > 0) {
          newest = Math.max(newest, newestMtime(full, filter, maxDepth - 1));
        }
      } else if (filter(entry.name)) {
        try {
          newest = Math.max(newest, statSync(full).mtimeMs);
        } catch {
          // unreadable file; skip
        }
      }
    }
  } catch {
    // unreadable dir; skip
  }
  return newest;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  const root = findInstallRoot();
  let runningFrom: BuildInfo["runningFrom"] = "unknown";
  let builtAt: number | null = null;
  let sourceChanged = false;
  let version = "0.0.0";

  if (root) {
    try {
      version = (JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { version?: string }).version ?? "0.0.0";
    } catch {
      // keep default
    }

    const distDir = join(root, "dist");
    const srcDir = join(root, "src");
    if (__dirname.startsWith(distDir) && existsSync(distDir)) {
      runningFrom = "dist";
      builtAt = newestMtime(distDir, (n) => n.endsWith(".js") || n.endsWith(".js.map"));
      if (existsSync(srcDir)) {
        const srcNewest = newestMtime(srcDir, (n) => n.endsWith(".ts"));
        sourceChanged = srcNewest > builtAt;
      }
    } else if (__dirname.startsWith(srcDir) && existsSync(srcDir)) {
      runningFrom = "src";
    }
  }

  cached = {
    version,
    runningFrom,
    builtAt,
    sourceChangedSinceBuild: sourceChanged,
    installRoot: root,
  };
  return cached;
}

export function formatBuildSummary(): string {
  const info = getBuildInfo();
  const built = info.builtAt ? new Date(info.builtAt).toISOString().replace("T", " ").slice(0, 16) : "unknown";
  const stale = info.sourceChangedSinceBuild ? " · ⚠ SOURCE CHANGED SINCE BUILD — run `npm run build`" : "";
  return `v${info.version} (running from ${info.runningFrom}, built ${built} UTC${stale})`;
}
