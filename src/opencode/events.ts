import { logDebug } from "../utils/logger.js";

/**
 * Session-scoped event filtering layer.
 *
 * OpenCode's event stream is directory-wide: sessions in the same project
 * feed each other events unless filtered. Every event that carries a session
 * id is matched against the session that owns the prompt; events belonging
 * to other sessions are dropped before they can alter output, tool-call
 * status, completion detection, or Discord live status.
 */

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

interface RawEventEnvelope {
  directory?: string;
  payload?: {
    type?: string;
    properties?: unknown;
  };
}

/** Best-effort extraction of the owning session id from any event payload shape. */
export function extractSessionId(properties: unknown): string | undefined {
  if (!properties || typeof properties !== "object") return undefined;
  const p = properties as Record<string, unknown>;
  const candidates: unknown[] = [
    p.sessionID,
    p.sessionId,
    (p.info as Record<string, unknown> | undefined)?.sessionID,
    (p.part as Record<string, unknown> | undefined)?.sessionID,
    (p.message as Record<string, unknown> | undefined)?.sessionID,
    (p.diff as Record<string, unknown> | undefined)?.sessionID,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

/**
 * An event passes when it carries no session id (cannot be scoped) or when
 * its session id matches the prompt's session exactly.
 */
export function eventMatchesSession(properties: unknown, sessionId: string | undefined): boolean {
  if (!sessionId) return true; // no session context to enforce
  const eventSession = extractSessionId(properties);
  if (eventSession === undefined) return true; // payload makes scoping impossible
  return eventSession === sessionId;
}

/** Normalize a raw stream event into the engine PromptEvent shape. */
export function normalizeEvent(raw: unknown): { event: PromptEvent; sessionId?: string } | null {
  const envelope = raw as RawEventEnvelope;
  const payload = envelope?.payload;
  if (!payload?.type) return null;
  const props = (payload.properties ?? {}) as Record<string, unknown>;
  const sessionId = extractSessionId(props);

  switch (payload.type) {
    case "message.part.updated": {
      const part = props.part as
        | {
            type?: string;
            text?: string;
            delta?: string;
            tool?: string;
            callID?: string;
            state?: {
              status?: string;
              input?: Record<string, unknown>;
              output?: string;
              error?: string;
              title?: string;
            };
          }
        | undefined;
      if (!part) return null;
      if (part.type === "text") {
        const text = part.delta ?? undefined;
        return text ? { event: { type: "token", text }, sessionId } : null;
      }
      if (part.type === "tool" && part.state) {
        const status = part.state.status;
        const base = { tool: part.tool, toolCallId: part.callID };
        if (status === "pending" || status === "running") {
          return { event: { type: "tool_start", ...base, toolInput: part.state.input }, sessionId };
        }
        if (status === "completed") {
          return { event: { type: "tool_complete", ...base, toolOutput: part.state.output }, sessionId };
        }
        if (status === "error") {
          return { event: { type: "tool_error", ...base, toolError: part.state.error }, sessionId };
        }
        return null;
      }
      return null;
    }
    case "session.diff": {
      const path = props.path as string | undefined;
      const diff = props.diff as string | undefined;
      if (!path || !diff) return null;
      return { event: { type: "diff", file: path, diff: { path, diff } }, sessionId };
    }
    case "session.status": {
      const statusType = (props.status as { type?: string } | undefined)?.type;
      if (statusType === "idle" || statusType === "busy" || statusType === "retry") {
        return { event: { type: "status", status: statusType }, sessionId };
      }
      return null;
    }
    case "session.idle":
    case "session.error": {
      const message = typeof props.message === "string" ? props.message : payload.type;
      return { event: { type: payload.type === "session.error" ? "error" : "finish", message }, sessionId };
    }
    default:
      return null;
  }
}

/**
 * Subscribe to the OpenCode event stream for a directory, forwarding only
 * events that belong to `sessionId` (or that cannot be scoped at all).
 */
export async function subscribeSessionEvents(
  subscribe: (query: { directory?: string }) => Promise<AsyncGenerator<unknown>>,
  directory: string | undefined,
  sessionId: string,
  onEvent: (event: PromptEvent) => void
): Promise<() => Promise<void>> {
  const stream = (await subscribe({ directory })) as AsyncGenerator<unknown> & {
    return?: (value?: unknown) => Promise<IteratorResult<unknown>>;
  };

  void (async () => {
    try {
      for await (const raw of stream) {
        const normalized = normalizeEvent(raw);
        if (!normalized) continue;
        if (!eventMatchesSession((raw as RawEventEnvelope).payload?.properties, sessionId)) {
          logDebug("Dropped cross-session event", "opencode", { sessionId: sessionId.slice(0, 8) });
          continue;
        }
        onEvent(normalized.event);
      }
    } catch {
      // stream ended or errored; the prompt call itself reports failures
    }
  })();

  return async () => {
    try {
      await stream.return?.(undefined);
    } catch {
      // ignore
    }
  };
}
