import { describe, it, expect } from "vitest";
import {
  extractTaskSignal,
  fingerprintFailure,
  nextFailureState,
  shouldAbortForRepeatedFailure,
  parseTaskState,
  serializeTaskState,
  buildInitialAutopilotPrompt,
} from "../src/opencode/task-logic.js";

describe("task-logic", () => {
  it("detects TASK_COMPLETE in the tail", () => {
    expect(extractTaskSignal("lots of work\nTASK_COMPLETE").complete).toBe(true);
    expect(extractTaskSignal("no markers").complete).toBe(false);
  });

  it("detects TASK_REMAINING and returns the remaining line", () => {
    const out = extractTaskSignal("worked\nTASK_REMAINING: need to finish the UI");
    expect(out.complete).toBe(false);
    expect(out.remainingLine).toBe("need to finish the UI");
  });

  it("fingerprintFailure normalizes timings", () => {
    expect(fingerprintFailure("failed in 123ms at 2024-01-01T00:00:00.000Z")).toBe(
      fingerprintFailure("failed in 456ms at 2025-06-01T00:00:00.000Z")
    );
  });

  it("aborts after repeated identical failures", () => {
    let state = parseTaskState(undefined);
    const error = "error: cannot find module 'x' in 302ms";
    for (let i = 0; i < 3; i++) {
      const abort = shouldAbortForRepeatedFailure(state, error);
      state = nextFailureState(state, error);
      expect(abort).toBe(i >= 2);
    }
    expect(state.consecutiveIdenticalFailures).toBe(3);
  });

  it("resets the identical-failure counter when the error changes", () => {
    let state = parseTaskState(undefined);
    state = nextFailureState(state, "err A");
    state = nextFailureState(state, "err A");
    const before = state.consecutiveIdenticalFailures;
    state = nextFailureState(state, "err B");
    expect(state.consecutiveIdenticalFailures).toBe(1);
    expect(before).toBe(2);
  });

  it("round-trips state via JSON", () => {
    const s = { objective: "a", remainingWork: ["b"], consecutiveIdenticalFailures: 0, acceptanceMet: false };
    expect(parseTaskState(serializeTaskState(s))).toEqual(s);
  });

  it("builds an autopilot prompt that injects project context", () => {
    const p = buildInitialAutopilotPrompt("do the thing", "C:/proj");
    expect(p).toContain("AUTOPILOT");
    expect(p).toContain("TASK_COMPLETE");
  });
});
