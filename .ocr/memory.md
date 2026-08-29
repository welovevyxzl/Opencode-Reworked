# Memory — OpenCode Remote

Durable project notes, appended here by /memory. These are loaded into the
prompt context on every job, so keep them short, factual, and current.

## 2026-08-30

- **Queue is SQLite-authoritative.** Queue state machine lives in
  `src/opencode/queue-service.ts`; never diverge the in-memory copy.
- **Windows spawn rule:** use `runCommand` from `src/utils/index.ts` for any
  `.cmd`/`.bat`/`npm` invocation. Direct `spawn` of a shim throws `EINVAL`.
  `resolveBinary` returns `string | null`.
- **Session event isolation:** OpenCode's event stream is directory-wide.
  `src/opencode/events.ts` filters events to the owning session so concurrent
  sessions in the same directory cannot cross-talk.
- **Failure policy:** when `continueOnFailure` is disabled, a failed job
  pauses the queue instead of moving on; `/queue resume` continues.
- **Tasks:** `/task start` records a persistent task row; autopilot modes run
  a verification loop (build/typecheck/test/lint from package.json) between
  iterations and require real passing commands before reporting completion.
- **The bot is NOT a fork** — this is the reworked design, keep it
  product-idiosyncratic and avoid generic AI-template output.
