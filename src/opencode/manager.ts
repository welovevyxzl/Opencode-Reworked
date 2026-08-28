import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";
import { logInfo, logWarn, logError, logDebug } from "../utils/logger.js";
import { sleep } from "../utils/index.js";
import type { Config } from "../types/index.js";

let client: OpencodeClient | null = null;
let serverInstance: { url: string; close(): void } | null = null;
let serverOwned = false;
let unhealthy = false;
let host = "127.0.0.1";
let port = 4096;
let serverPassword = "";
let binaryPath: string | null = null;

const BASIC_PREFIX = "Basic ";

function basicAuthHeader(password: string): string {
  return BASIC_PREFIX + Buffer.from(`opencode:${password}`).toString("base64");
}

function effectivePassword(): string {
  if (serverPassword) return serverPassword;
  return process.env.OPENCODE_SERVER_PASSWORD || "";
}

export function configure(config: Config): void {
  host = config.opencode.host || "127.0.0.1";
  port = config.opencode.port || 4096;
  serverPassword = config.opencode.serverPassword || "";
}

export function getServerInfo(): { host: string; port: number; passwordSet: boolean } {
  return { host, port, passwordSet: effectivePassword().length > 0 };
}

export function isServerOwned(): boolean {
  return serverOwned;
}

export function getClient(): OpencodeClient | null {
  return client;
}

export function getBinaryPath(): string | null {
  return binaryPath;
}

async function detectOpenCodeBinary(): Promise<string | null> {
  if (binaryPath && existsSync(binaryPath)) return binaryPath;

  const candidates: string[] = [];
  if (process.platform === "win32") {
    const pathDirs = (process.env.PATH || "").split(";").filter((p) => p.length > 0);
    for (const dir of pathDirs) {
      for (const shim of [".exe", ".cmd", ""]) {
        candidates.push(resolve(dir, "opencode" + shim));
      }
    }
    const npmPrefix = spawnSync("npm", ["prefix", "-g"], { encoding: "utf-8", windowsHide: true });
    if (npmPrefix.status === 0) {
      const prefix = npmPrefix.stdout.trim();
      candidates.push(join(prefix, "opencode.cmd"));
      candidates.push(join(prefix, "opencode.exe"));
    }
  } else {
    const which = spawnSync("which", ["opencode"], { encoding: "utf-8" });
    if (which.status === 0) candidates.push(which.stdout.trim());
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const isShim = /\.(cmd|bat)$/i.test(candidate);
      const test = isShim
        ? spawnSync(`"${candidate}" --version`, { shell: true, encoding: "utf-8", timeout: 10000, windowsHide: true })
        : spawnSync(candidate, ["--version"], { encoding: "utf-8", timeout: 10000, windowsHide: true });
      if (test.status === 0) {
        binaryPath = candidate;
        logInfo("Found OpenCode binary", "opencode", { path: candidate });
        return candidate;
      }
    } catch {
      logDebug(`Binary candidate failed version check: ${candidate}`, "opencode");
    }
  }
  return null;
}

export async function findOpenCodeBinary(): Promise<string | null> {
  return detectOpenCodeBinary();
}

async function validateServerStartable(): Promise<{ ok: boolean; message: string }> {
  const bin = await detectOpenCodeBinary();
  if (!bin) {
    return { ok: false, message: "OpenCode executable not found. Install it (npm i -g opencode-ai) or add it to PATH." };
  }
  return { ok: true, message: bin };
}

export async function startServer(): Promise<{ ok: boolean; message: string }> {
  if (serverInstance) {
    return { ok: true, message: "OpenCode server already running (managed)" };
  }
  if (await isHealthy()) {
    serverOwned = false;
    return { ok: true, message: "OpenCode server already running on this port" };
  }

  const check = await validateServerStartable();
  if (!check.ok) return { ok: false, message: check.message };

  const pass = effectivePassword();
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  if (pass) process.env.OPENCODE_SERVER_PASSWORD = pass;

  try {
    const res = await createOpencodeServer({
      hostname: host,
      port,
      timeout: 20000,
    });
    serverInstance = res;
    serverOwned = true;
    unhealthy = false;
    logInfo(`OpenCode server started at ${res.url}`, "opencode");
    const ok = await waitForHealthy(15000);
    if (!ok) {
      logWarn("Started OpenCode server but it did not become healthy", "opencode");
    }
    return { ok: true, message: `OpenCode server running on ${host}:${port}` };
  } catch (err) {
    logError(`Failed to start OpenCode server: ${String(err)}`, "opencode");
    const diag = await diagnosePort(port);
    const base = friendlyStartError(err);
    return { ok: false, message: diag ? `${base} ${diag}` : base };
  } finally {
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
  }
}

export async function diagnosePort(port: number): Promise<string> {
  const baseUrl = `http://${host}:${port}`;
  const headers: Record<string, string> = {};
  const pass = effectivePassword();
  if (pass) headers.Authorization = basicAuthHeader(pass);
  try {
    const res = await fetch(`${baseUrl}/config`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 401) {
      return `A server is running on port ${port} but rejected the configured password. It was started separately (e.g. \`opencode\`). Stop it or start it with the same OPENCODE_SERVER_PASSWORD.`;
    }
    if (res.ok) {
      return `A compatible OpenCode server is already listening on port ${port}.`;
    }
    return `Something is listening on port ${port} (HTTP ${res.status}) but it is not an OpenCode server. Stop that process or set a different port in the config (\`${host}:${port}\`).`;
  } catch (err) {
    if (err instanceof Error && /ECONNREFUSED|fetch failed/i.test(err.message)) {
      return `The port seems free, but the OpenCode process exited immediately. See the error above.`;
    }
    return "";
  }
}

function friendlyStartError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/EADDRINUSE|address already in use|port.*in use/i.test(msg)) {
    return `OpenCode could not start because port ${port} is already in use. Find the process with: netstat -ano | findstr :${port}`;
  }
  if (/EINVAL|spawn EINVAL/i.test(msg)) {
    return `OpenCode executable could not be launched. Detected executable: ${binaryPath ?? "unknown"}. This is a Windows spawn issue (${msg}). Try reinstalling opencode: npm i -g opencode-ai`;
  }
  return `OpenCode could not start: ${msg}`;
}

export async function stopServer(): Promise<void> {
  if (serverInstance) {
    try {
      serverInstance.close();
    } catch (err) {
      logDebug(`Error closing OpenCode server: ${err}`, "opencode");
    }
    serverInstance = null;
  }
  if (serverOwned) {
    serverOwned = false;
    logInfo("OpenCode server stopped (owned by this app)", "opencode");
  }
  unhealthy = false;
}

async function connectClient(): Promise<{ ok: boolean; message: string }> {
  const baseUrl = `http://${host}:${port}`;
  const headers: Record<string, string> = {};
  const pass = effectivePassword();
  if (pass) {
    headers.Authorization = basicAuthHeader(pass);
  }
  try {
    client = createOpencodeClient({
      baseUrl,
      responseStyle: "data",
      throwOnError: true,
      headers,
    } as never);
    await isHealthy();
    return { ok: true, message: `Connected to OpenCode at ${baseUrl}` };
  } catch (err) {
    logError(`Failed to attach OpenCode client: ${String(err)}`, "opencode");
    return { ok: false, message: String(err) };
  }
}

export async function isHealthy(): Promise<boolean> {
  if (!client) {
    const res = await connectClient();
    if (!res.ok) return false;
  }
  try {
    await client!.config.get();
    return true;
  } catch {
    return false;
  }
}

export async function waitForHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHealthy()) return true;
    await sleep(500);
  }
  return false;
}

export function isUnhealthy(): boolean {
  return unhealthy;
}

export function resetHealth(): void {
  unhealthy = false;
}

function mustClient(): OpencodeClient {
  if (!client) throw new Error("OpenCode client is not connected. Run oc doctor or check the OpenCode server.");
  return client;
}

export async function createSession(title?: string, directory?: string): Promise<{ id: string } | null> {
  try {
    const body: { title?: string } = {};
    if (title) body.title = title;
    const res = await mustClient().session.create({
      body,
      query: { directory },
    });
    const session = res as unknown as { id?: string };
    if (session && session.id) return { id: session.id };
    return null;
  } catch (err) {
    logError(`Failed to create session: ${String(err)}`, "opencode");
    return null;
  }
}

export interface ManagedSession {
  id: string;
  title: string;
  directory?: string;
  created: number;
  updated: number;
}

export async function getSessions(): Promise<ManagedSession[]> {
  try {
    const res = await mustClient().session.list();
    const list = Array.isArray(res) ? res : [];
    return list.map((s) => ({
      id: s.id,
      title: s.title || s.id.slice(0, 8),
      directory: s.directory,
      created: s.time?.created ?? 0,
      updated: s.time?.updated ?? 0,
    }));
  } catch (err) {
    logError(`Failed to list sessions: ${String(err)}`, "opencode");
    return [];
  }
}

export async function renameSession(sessionId: string, title: string): Promise<boolean> {
  try {
    await mustClient().session.update({ path: { id: sessionId }, body: { title } });
    return true;
  } catch (err) {
    logError(`Failed to rename session ${sessionId}: ${String(err)}`, "opencode");
    return false;
  }
}

export async function deleteSession(sessionId: string): Promise<boolean> {
  try {
    await mustClient().session.delete({ path: { id: sessionId } });
    return true;
  } catch (err) {
    logError(`Failed to delete session ${sessionId}: ${String(err)}`, "opencode");
    return false;
  }
}

export async function cancelSession(sessionId: string): Promise<void> {
  try {
    await mustClient().session.abort({ path: { id: sessionId } });
  } catch (err) {
    logWarn(`Failed to abort session ${sessionId}: ${String(err)}`, "opencode");
  }
}

export interface PromptEvent {
  type: "token" | "tool_start" | "tool_complete" | "tool_error" | "diff" | "finish" | "error" | "status";
  text?: string;
  tool?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  file?: string;
  diff?: { path: string; diff: string };
  status?: "idle" | "busy" | "retry";
  message?: string;
}

export interface PromptResult {
  ok: boolean;
  output: string;
  error?: string;
}

let modelIndex: Map<string, { providerID: string }> | null = null;

async function resolveModelRef(
  id: string | undefined
): Promise<{ providerID: string; modelID: string } | undefined> {
  if (!id) return undefined;
  try {
    if (!modelIndex) {
      modelIndex = new Map();
      for (const p of await getModelCatalog()) {
        for (const md of p.models) {
          if (!modelIndex.has(md.id)) modelIndex.set(md.id, { providerID: p.id });
        }
      }
    }
    const hit = modelIndex.get(id);
    if (hit) return { providerID: hit.providerID, modelID: id };
  } catch {
    // fall through to legacy split
  }
  const [providerID, ...rest] = id.split("/");
  const modelID = rest.join("/");
  if (providerID && modelID) return { providerID, modelID };
  return undefined;
}

export async function sendPrompt(
  options: {
    sessionId: string;
    prompt: string;
    directory?: string;
    model?: string;
    onEvent?: (event: PromptEvent) => void;
  }
): Promise<{ ok: boolean; output: string; error?: string }> {
  const { sessionId, prompt, directory, model } = options;
  const output: string[] = [];

  let evtStream: (AsyncGenerator<unknown> & { return?: (value?: unknown) => Promise<IteratorResult<unknown>> }) | null = null;
  void (async () => {
    try {
      const evt = await mustClient().event.subscribe({ query: { directory } });
      evtStream = evt as unknown as (AsyncGenerator<unknown> & { return?: (value?: unknown) => Promise<IteratorResult<unknown>> });
      for await (const rawEvent of evtStream) {
        const ge = rawEvent as { directory: string; payload: unknown };
        const payload = ge.payload as { type: string; properties?: unknown };
        if (!payload?.type) continue;

        switch (payload.type) {
          case "message.part.updated": {
            const p = payload as { properties: { part: { type: string; text?: string; delta?: string; tool?: string; callID?: string; state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string }; id?: string } } };
            const part = p.properties.part;
            if (part.type === "text" && part.delta) {
              output.push(part.delta);
              options.onEvent?.({ type: "token", text: part.delta });
            } else if (part.type === "tool") {
              const state = part.state as { status: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string };
              if (state.status === "pending" || state.status === "running") {
                options.onEvent?.({
                  type: "tool_start",
                  tool: part.tool,
                  toolCallId: part.callID,
                  toolInput: state.input,
                });
              } else if (state.status === "completed") {
                options.onEvent?.({
                  type: "tool_complete",
                  tool: part.tool,
                  toolCallId: part.callID,
                  toolOutput: state.output,
                });
              } else if (state.status === "error") {
                options.onEvent?.({
                  type: "tool_error",
                  tool: part.tool,
                  toolCallId: part.callID,
                  toolError: state.error,
                });
              }
            }
            break;
          }
          case "session.diff": {
            const p = payload as { properties: { path: string; diff: string } };
            options.onEvent?.({ type: "diff", diff: { path: p.properties.path, diff: p.properties.diff } });
            break;
          }
          case "session.status": {
            const p = payload as { properties: { status: { type: string } } };
            const statusType = p.properties.status.type;
            if (statusType === "idle" || statusType === "busy" || statusType === "retry") {
              options.onEvent?.({ type: "status", status: statusType });
            }
            break;
          }
          case "permission.updated": {
            break;
          }
        }
      }
    } catch {
      // event stream ended or error
    }
  })();

  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: prompt }],
  };
  const modelRef = await resolveModelRef(model);
  if (modelRef) body.model = modelRef;

  try {
    const res = await mustClient().session.prompt({
      path: { id: sessionId },
      body: body as never,
      query: { directory },
    });

    const promptRes = res as unknown as {
      info?: { finish?: string };
      parts?: Array<{ type?: string; text?: string }>;
    };

    if (promptRes && promptRes.parts) {
      for (const part of promptRes.parts) {
        if (part && part.type === "text" && part.text) {
          const fullText = part.text;
          const alreadyStreamed = output.join("");
          if (!alreadyStreamed.endsWith(fullText)) {
            const remaining = fullText.slice(alreadyStreamed.length);
            if (remaining) output.push(remaining);
          }
        }
      }
    }

    if (promptRes.info && typeof promptRes.info.finish === "string") {
      options.onEvent?.({ type: "finish", message: promptRes.info.finish });
    }

    const nestedError = (promptRes as unknown as {
      error?: { data?: { message?: string } };
    })?.error;
    if (nestedError && typeof nestedError.data?.message === "string") {
      const reason = `OpenCode could not complete the request: ${nestedError.data.message}`;
      logError(`Prompt failed in session ${sessionId}: ${reason}`, "opencode");
      options.onEvent?.({ type: "error", message: reason });
      return { ok: false, output: output.join("\n"), error: reason };
    }

    if (!promptRes || !promptRes.parts) {
      return { ok: false, output: output.join("\n"), error: "No response received from OpenCode." };
    }

    return { ok: true, output: output.join("\n") };
  } catch (err) {
    const errMsg = String(err);
    logError(`Prompt failed in session ${sessionId}: ${errMsg}`, "opencode");
    options.onEvent?.({ type: "error", message: errMsg });
    return { ok: false, output: output.join("\n"), error: errMsg };
  } finally {
    const stream = evtStream as
      | (AsyncGenerator<unknown> & { return?: (value?: unknown) => Promise<IteratorResult<unknown>> })
      | null;
    if (stream && typeof stream.return === "function") {
      try {
        await stream.return(undefined);
      } catch {
        // ignore
      }
    }
  }
}

export async function getModels(): Promise<string[]> {
  const catalog = await getModelCatalog();
  const out: string[] = [];
  for (const provider of catalog) {
    for (const model of provider.models) out.push(model.id);
  }
  return out.sort();
}

export interface CatalogModel {
  id: string;
  name: string;
}

export interface ModelProvider {
  id: string;
  name: string;
  models: CatalogModel[];
}

export async function getModelCatalog(): Promise<ModelProvider[]> {
  try {
    const res = await mustClient().config.providers();
    const data = res as unknown as {
      providers?: Array<{
        id?: string;
        name?: string;
        models?: Record<string, { id?: string; name?: string }>;
      }>;
    };
    const list = data?.providers ?? [];
    const out: ModelProvider[] = [];
    for (const provider of list) {
      const models: CatalogModel[] = [];
      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (!model?.id) continue;
          models.push({ id: model.id, name: model.name || model.id });
        }
      }
      if (models.length === 0) continue;
      models.sort((a, b) => a.id.localeCompare(b.id));
      out.push({
        id: provider.id || "unknown",
        name: provider.name || provider.id || "unknown",
        models,
      });
    }
    return out;
  } catch (err) {
    logError(`Failed to list models: ${String(err)}`, "opencode");
    return [];
  }
}

export async function getConfigInfo(): Promise<string | Record<string, unknown>> {
  try {
    const res = await mustClient().config.get();
    return res as unknown as Record<string, unknown>;
  } catch {
    return "unavailable";
  }
}