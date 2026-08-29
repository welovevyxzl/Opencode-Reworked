import { describe, it, expect } from "vitest";
import { normalizeEvent, eventMatchesSession, extractSessionId } from "../src/opencode/events.js";

describe("extractSessionId", () => {
  it("reads sessionID from several known property shapes", () => {
    const props = { sessionID: "sess-1", part: { sessionID: "sess-2" } };
    expect(extractSessionId(props)).toBe("sess-1");
    expect(extractSessionId({ info: { sessionID: "s-a" } })).toBe("s-a");
    expect(extractSessionId({ diff: { sessionID: "s-d" } })).toBe("s-d");
    expect(extractSessionId({ message: { sessionID: "s-m" } })).toBe("s-m");
  });
  it("returns undefined for non-object or empty", () => {
    expect(extractSessionId(null)).toBeUndefined();
    expect(extractSessionId("x")).toBeUndefined();
    expect(extractSessionId({ foo: "bar" })).toBeUndefined();
  });
});

describe("eventMatchesSession", () => {
  const own = { sessionID: "sess-own" };
  const other = { sessionID: "sess-other" };

  it("allows an event from the owning session", () => {
    expect(eventMatchesSession(own, "sess-own")).toBe(true);
  });
  it("drops an event from another session", () => {
    expect(eventMatchesSession(other, "sess-own")).toBe(false);
  });
  it("allows unscoped events when a session is enforced", () => {
    expect(eventMatchesSession({ foo: 1 }, "sess-own")).toBe(true);
  });
  it("allows everything when no session context is set", () => {
    expect(eventMatchesSession(other, undefined)).toBe(true);
  });
});

describe("normalizeEvent", () => {
  it("normalizes a token event", () => {
    const out = normalizeEvent({ payload: { type: "message.part.updated", properties: { sessionID: "s", part: { type: "text", delta: "hi" } } } });
    expect(out).toEqual({ event: { type: "token", text: "hi" }, sessionId: "s" });
  });
  it("normalizes tool start / complete / error", () => {
    const base = { sessionID: "s" };
    expect(normalizeEvent({ payload: { type: "message.part.updated", properties: { ...base, part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running" } } } } })?.event).toMatchObject({ type: "tool_start", tool: "bash", toolCallId: "c1" });
    expect(normalizeEvent({ payload: { type: "message.part.updated", properties: { ...base, part: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "out" } } } } })?.event).toMatchObject({ type: "tool_complete", toolOutput: "out" });
    expect(normalizeEvent({ payload: { type: "message.part.updated", properties: { ...base, part: { type: "tool", tool: "bash", callID: "c1", state: { status: "error", error: "e" } } } } })?.event).toMatchObject({ type: "tool_error", toolError: "e" });
  });
  it("normalizes a diff", () => {
    const out = normalizeEvent({ payload: { type: "session.diff", properties: { sessionID: "s", path: "a.ts", diff: "+x" } } });
    expect(out?.event.type).toBe("diff");
    expect(out?.event.diff).toEqual({ path: "a.ts", diff: "+x" });
  });
  it("normalizes a finish", () => {
    const out = normalizeEvent({ payload: { type: "session.idle", properties: { sessionID: "s" } } });
    expect(out?.event.type).toBe("finish");
  });
  it("returns null for unknown payloads", () => {
    expect(normalizeEvent({ payload: { type: "session.other" } })).toBeNull();
    expect(normalizeEvent({})).toBeNull();
  });
});
