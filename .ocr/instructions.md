# Instructions — OpenCode Remote

OpenCode Remote is a Discord bot that lets you drive the OpenCode CLI from
Discord. When you are asked to work on this repository, follow these rules.

## Architecture invariants

- **SQLite is the single source of truth.** Queue state, tasks, project
  bindings, allowlists, and pending confirmations all live in
  `%USERPROFILE%\.opencode-remote\data.db`. Never make the bot's behavior
  depend on in-memory values that could be rebuilt differently after a crash.
- **Never inline secrets or token-shaped data.** Logs are redacted by
  `src/utils/logger.ts` (tokens, keys, passwords, PEM, `sk-`, `xox-`, `AKIA`).
  Configuration secrets are stored only in the local data dir.
- **Processes must be cross-platform safe.** Never spawn `.cmd`/`.bat` shims
  directly with `child_process.spawn` (throws `EINVAL` on Windows). Use
  `runCommand` from `src/utils/index.ts`, which routes `.cmd` through
  `cmd.exe` with escaped arguments, and use `resolveBinary` (returns
  `string | null`, never throws) to find executables.
- **espoused output must be real.** Verify actual commands before claiming a
  task or build is done. Completion messages come from real exit codes.

## Where things live

- `src/opencode/queue-service.ts` — the authoritative queue state machine:
  claim (atomic, single-slot), markRunning/completed/failed/cancelled,
  clear, remove, pause/resume, heartbeat, recovery, stats.
- `src/opencode/engine.ts` — executes claimed jobs: session resolution,
  watchdog (stall / disconnect / max-timeout), live Discord status, and the
  failure policy (continueOnFailure pauses the queue when disabled).
- `src/opencode/events.ts` — session-scoped event filtering. Events are
  matched to the owning session id and cross-session events are dropped.
- `src/opencode/task-runner.ts` + `task-logic.ts` — autopilot tasks that
  iterate until done with a real verification loop between iterations.
- `src/storage/index.ts` — schema, migrations, and all row accessors.
- `src/discord/` — bot login, command registration, channels resolve helpers,
  UI embeds.
- `src/commands/` — one file per slash command plus `components.ts`
  (buttons/menus) and `confirmations.ts` (durable pending actions).
- `src/utils/index.ts` (spawning/process safety), `src/utils/logger.ts`
  (structured redacted logging), `src/utils/build-info.ts` (src vs dist).

## Coding style

- No comments unless they explain non-obvious non-local decisions; prefer a
  short doc comment at the top of a file explaining why it exists.
- Match the existing style: TypeScript, `discord.js`, `better-sqlite3`,
  `vitest`. Error paths are explicit; async failures are caught and logged.
- `npm run build`, `npm run typecheck`, `npm test`, `npm run lint` are the
  gates. A change is only "done" when these pass and `git diff` is reviewed.

## Do not

- Do not bypass the queue to call OpenCode directly from a command; always
  go through `queuePrompt`/`enqueue`.
- Do not add a shortcut that reads secrets into logs or messages.
- Do not rely on `autoStart` being the only way a server can exist; a foreign
  OpenCode on the port must be detected and reported, not clobbered.
