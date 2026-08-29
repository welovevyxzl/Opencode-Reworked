import { getProjectState, loadConfig } from "../storage/index.js";
import { buildPromptContext } from "./project-context.js";
import type { VerificationReport } from "./verify.js";

/**
 * Autopilot task-state management. Instead of spamming "continue", each
 * iteration asks the agent to evaluate remaining work against the original
 * request and produce a concrete continuation, with a real verification
 * loop (build/typecheck/test/lint) between iterations.
 */

export interface TaskState {
  objective: string;
  remainingWork: string[];
  lastVerification?: {
    at: number;
    summary: string;
    failed: string[];
  };
  lastOutput?: string;
  failureFingerprint?: string;
  consecutiveIdenticalFailures: number;
  acceptanceMet: boolean;
}

export const DEFAULT_MAX_ITERATIONS = 10;
const IDENTICAL_FAILURE_LIMIT = 3;

export function parseTaskState(json: string | undefined): TaskState {
  const empty: TaskState = {
    objective: "",
    remainingWork: [],
    consecutiveIdenticalFailures: 0,
    acceptanceMet: false,
  };
  if (!json) return empty;
  try {
    return { ...empty, ...(JSON.parse(json) as Partial<TaskState>) };
  } catch {
    return empty;
  }
}

export function serializeTaskState(state: TaskState): string {
  return JSON.stringify(state);
}

export function resolveProjectDirectory(projectAlias: string): string | undefined {
  const state = getProjectState(projectAlias);
  if (state?.path?.trim()) return state.path.trim();
  const registered = loadConfig()?.projects?.registered?.find((p) => p.alias === projectAlias);
  return registered?.path?.trim() || undefined;
}

export function buildInitialAutopilotPrompt(taskPrompt: string, projectDir: string | undefined): string {
  const context = buildPromptContext(projectDir);
  return `${taskPrompt}${context}

You are running in AUTOPILOT mode. Work autonomously until the task is genuinely complete:
1. Analyze what was requested and what already exists in this project.
2. Implement the remaining work in coherent, complete increments.
3. After each increment, verify: build, typecheck, tests, and lint when the project has those scripts (run them; do not assume they pass).
4. If verification fails, diagnose and fix before continuing.
5. When you believe the task is done, end your reply with a line exactly: TASK_COMPLETE
   Otherwise end with a line exactly: TASK_REMAINING: <one-line summary of what still needs to be done>
Do not stop after a single small change if more work clearly remains.`;
}

export function buildContinuationPrompt(state: TaskState, iteration: number, maxIterations: number, previousOutput: string, verification: VerificationReport | null): string {
  const remaining = state.remainingWork.length > 0
    ? state.remainingWork.map((r, i) => `${i + 1}. ${r}`).join("\n")
    : "Assess the project state and determine what still needs doing.";
const verifyTime = new Date(Date.now()).toLocaleTimeString();
  const verifyBlock = verification
    ? `\nLast verification (${verifyTime}): ${verification.summary}\n${verification.results
        .map((r) => `- ${r.label}: ${r.ok ? "PASS" : `FAIL${r.output ? ` — ${r.output.split("\n").slice(-4).join(" | ").slice(0, 300)}` : ""}`}`)
        .join("\n")}`
    : "";
  return `AUTOPILOT iteration ${iteration}/${maxIterations}. Continue the task.

Objective: ${state.objective || "(see original request)"}

Remaining work as currently understood:
${remaining}
${verifyBlock}

Previous iteration output (tail):
${previousOutput.slice(-1200)}

Continue implementing. Verify your work actually builds/tests. When the acceptance criteria are satisfied, end with: TASK_COMPLETE
If meaningful work remains, end with: TASK_REMAINING: <one-line summary>`;
}

export function extractTaskSignal(output: string): { complete: boolean; remainingLine?: string } {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const line = lines[i].trim();
    if (/^TASK_COMPLETE\s*$/i.test(line)) return { complete: true };
    const m = line.match(/^TASK_REMAINING\s*:\s*(.+)$/i);
    if (m) return { complete: false, remainingLine: m[1].trim() };
  }
  // Fallback heuristics: treat explicit completion phrasing as complete only
  // when no TASK_ markers appeared at all and verification passed upstream.
  return { complete: false };
}

export function fingerprintFailure(error: string): string {
  // Normalize whitespace/timings so the same root cause hashes identically.
  const normalized = error
    .replace(/\d+(\.\d+)?(ms|s)\b/g, "<time>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<date>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return normalized;
}

export function shouldAbortForRepeatedFailure(state: TaskState, newError: string): boolean {
  const fp = fingerprintFailure(newError);
  if (state.failureFingerprint === fp) {
    return state.consecutiveIdenticalFailures + 1 >= IDENTICAL_FAILURE_LIMIT;
  }
  return false;
}

export function nextFailureState(state: TaskState, newError: string): TaskState {
  const fp = fingerprintFailure(newError);
  if (state.failureFingerprint === fp) {
    return { ...state, consecutiveIdenticalFailures: state.consecutiveIdenticalFailures + 1, failureFingerprint: fp };
  }
  return { ...state, failureFingerprint: fp, consecutiveIdenticalFailures: 1 };
}

export { runVerification, detectVerificationCommands } from "./verify.js";
export type { VerificationReport, VerificationResult } from "./verify.js";
