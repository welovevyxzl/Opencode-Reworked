import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveBinary, runCommand } from "../utils/index.js";
import { logDebug } from "../utils/logger.js";

/**
 * Remote-access detection for established tools (RustDesk, Tailscale).
 * Read-only: reports availability + connection info. Credentials are never
 * returned in full — passwords are redacted entirely, IDs shown partially.
 */

export interface RustDeskInfo {
  installed: boolean;
  id?: string;
  configPath?: string;
}

export interface TailscaleInfo {
  installed: boolean;
  running?: boolean;
  hostname?: string;
  dnsName?: string;
  ips?: string[];
  deviceOs?: string;
}

export interface RemoteAccessReport {
  rustdesk: RustDeskInfo;
  tailscale: TailscaleInfo;
}

function readRustDeskConfig(): RustDeskInfo {
  const candidates = [
    join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "RustDesk", "config"),
    join(homedir(), "AppData", "Roaming", "RustDesk", "config"),
  ];
  for (const dir of candidates) {
    for (const file of ["RustDesk2.toml", "RustDesk.toml"]) {
      const p = join(dir, file);
      if (!existsSync(p)) continue;
      try {
        const content = readFileSync(p, "utf-8");
        // Public ID lines are safe-ish; never read/return password fields.
        const idMatch =
          content.match(/^\s*enc_id\s*=\s*"([^"]+)"/m) ??
          content.match(/^\s*id\s*=\s*"(\d+)"/m);
        return {
          installed: true,
          id: idMatch ? idMatch[1] : undefined,
          configPath: dir,
        };
      } catch (err) {
        logDebug(`RustDesk config read failed: ${err}`, "remote-access");
        return { installed: true, configPath: dir };
      }
    }
    if (existsSync(dir)) return { installed: true, configPath: dir };
  }
  return { installed: false };
}

function redactId(id: string): string {
  if (id.length <= 4) return "•".repeat(id.length);
  return `${id.slice(0, 3)}••••${id.slice(-3)}`;
}

async function readTailscale(): Promise<TailscaleInfo> {
  const bin = resolveBinary("tailscale");
  if (!bin) return { installed: false };
  const res = await runCommand(bin, ["status", "--json", "--self"], { timeout: 10000 });
  if (res.code !== 0) {
    return { installed: true, running: false };
  }
  try {
    const data = JSON.parse(res.stdout) as Record<string, unknown>;
    const self = (data.Self ?? {}) as Record<string, unknown>;
    return {
      installed: true,
      running: self.Online !== false,
      hostname: typeof self.HostName === "string" ? self.HostName : undefined,
      dnsName: typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : undefined,
      ips: Array.isArray(self.TailscaleIPs) ? (self.TailscaleIPs as string[]).slice(0, 2) : undefined,
      deviceOs: typeof self.OS === "string" ? self.OS : undefined,
    };
  } catch {
    return { installed: true, running: true };
  }
}

export async function getRemoteAccessReport(): Promise<RemoteAccessReport> {
  const rustdesk = readRustDeskConfig();
  const tailscale = await readTailscale();
  return { rustdesk, tailscale };
}

/** Owner-facing summary lines; sensitive values truncated/redacted. */
export function formatRemoteAccess(report: RemoteAccessReport): string[] {
  const lines: string[] = [];
  if (report.rustdesk.installed) {
    lines.push(
      `**RustDesk** — installed${report.rustdesk.id ? ` · ID \`${redactId(report.rustdesk.id)}\` (full ID on the PC; passwords never leave the machine)` : " · ID not parsed (open RustDesk on the PC)"}`
    );
  } else {
    lines.push("**RustDesk** — not installed (https://rustdesk.com)");
  }
  if (report.tailscale.installed) {
    if (report.tailscale.running === false) {
      lines.push("**Tailscale** — installed but not running (start it on the PC)");
    } else {
      const parts = [
        report.tailscale.hostname ? `host \`${report.tailscale.hostname}\`` : null,
        report.tailscale.dnsName ? `dns \`${report.tailscale.dnsName}\`` : null,
        report.tailscale.ips?.length ? `ip \`${report.tailscale.ips.join(" · ")}\`` : null,
      ].filter(Boolean);
      lines.push(`**Tailscale** — ${parts.length > 0 ? parts.join(" · ") : "running"}`);
    }
  } else {
    lines.push("**Tailscale** — not installed (https://tailscale.com)");
  }
  return lines;
}

export { redactId };
