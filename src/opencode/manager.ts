import { existsSync } from "fs";
import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";
import { logInfo, logWarn, logError, logDebug } from "../utils/logger.js";
import { sleep } from "../utils/index.js";
import { listResolvedBinaries, runCommand } from "../utils/index.js";
import type { Config } from "../types/index.js";
import { subscribeSessionEvents, type PromptEvent } from "./events.js";

export type { PromptEvent } from "./events.js";

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

async function verifyBinary(path: string): Promise<boolean> {
  try {
    // .cmd/.bat shims are routed through cmd.exe inside runCommand, so this is
    // also a real spawn test of the shim (handles broken/empty .cmd files).
    const test = await runCommand(path, ["--version"], { timeout: 15000 });
    if (test.code !== 0) {
      logDebug(`OpenCode candidate failed --version: ${path}`, "opencode", { stderr: test.stderr.slice(0, 200) });
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function detectOpenCodeBinary(): Promise<string | null> {
  // Cache only a previously-verified binary, and re-verify it: if the cached
  // path stopped working (e.g. an npm-global shim was replaced), invalidate it
  // and resolve from scratch instead of handing back a dead path.
  if (binaryPath) {
    if (existsSync(binaryPath) && (await verifyBinary(binaryPath))) {
      return binaryPath;
    }
    logWarn("Cached OpenCode binary no longer responds to --version; re-resolving", "opencode", { path: binaryPath });
    binaryPath = null;
  }

  // Try every PATH candidate (including .cmd/.bat npm shims and npm-global
  // locations) and return the FIRST one that actually runs — not merely the
  // first existing file, which may be a broken shim.
  for (const candidate of listResolvedBinaries("opencode")) {
    if (!existsSync(candidate)) continue;
    if (await verifyBinary(candidate)) {
      binaryPath = candidate;
      logInfo("Found OpenCode binary", "opencode", { path: candidate });
      return candidate;
    }
  }

  return null;
}

export async function findOpenCodeBinary(): Promise<string | null> {
  return detectOpenCodeBinary();
}

/** Test hook: clear the cached, verified binary so resolution runs from scratch. */
export function resetOpenCodeBinaryCache(): void {
  binaryPath = null;
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

export async function diagnosePort(portNumber: number): Promise<string> {
  const baseUrl = `http://${host}:${portNumber}`;
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
      return `A server is running on port ${portNumber} but rejected the configured password. It was started separately (e.g. \`opencode\`). Stop it or start it with the same OPENCODE_SERVER_PASSWORD.`;
    }
    if (res.ok) {
      return `A compatible OpenCode server is already listening on port ${portNumber}.`;
    }
    return `Something is listening on port ${portNumber} (HTTP ${res.status}) but it is not an OpenCode server. Stop that process or set a different port in the config (\`${host}:${portNumber}\`).`;
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
  } catch (err) {
    // A 401 from /config means the password does not match the running server.
    const msg = String(err);
    if (/401|Unauthorized/i.test(msg)) {
      logWarn("OpenCode API returned 401 — the configured server password does not match the running OpenCode server.", "opencode");
    }
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

/** Whether a session id still exists on the OpenCode server. */
export async function isSessionAlive(sessionId: string | undefined): Promise<boolean> {
  if (!sessionId) return false;
  try {
    const sessions = await getSessions();
    return sessions.some((s) => s.id === sessionId);
  } catch {
    return false;
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

export async function cancelSession(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await mustClient().session.abort({ path: { id: sessionId } });
    return { ok: true };
  } catch (err) {
    const error = String(err);
    logWarn(`Failed to abort session ${sessionId}: ${error}`, "opencode");
    return { ok: false, error };
  }
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
): Promise<PromptResult> {
  const { sessionId, prompt, directory, model } = options;
  const output: string[] = [];

  // Session-scoped event stream: events from other sessions in the same
  // directory are filtered out before they can touch output or UI state.
  const stopEvents = await subscribeSessionEvents(
    (query) => mustClient().event.subscribe({ query: { directory: query.directory } }) as never,
    directory,
    sessionId,
    (event) => {
      if (event.type === "token" && event.text) output.push(event.text);
      options.onEvent?.(event);
    }
  );

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
    await stopEvents();
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
