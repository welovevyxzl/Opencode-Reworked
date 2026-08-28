# OpenCode Remote

A reliable Discord remote-control system for [OpenCode](https://opencode.ai). Run the OpenCode agent on your Windows PC and drive it from Discord: send prompts, review diffs, commit and push work, and control the machine — all through slash commands.

## Features

- **Remote OpenCode control** — `/opencode` creates a dedicated thread, runs your prompt through a managed OpenCode server, streams live status, and posts the result.
- **Thread & session model** — every prompt runs in its own Discord thread tied to an OpenCode session. Continue, diff, or reset the context per thread.
- **Passthrough / voice mode** — `/code` turns a thread into a plain-message pipe to OpenCode; `/autocode` sets it for whole projects; optional voice-message transcription (Whisper).
- **Queue** — prompts queue when OpenCode is busy; `/queue` lets you inspect, pause, resume, clear, or cancel items.
- **Git & GitHub** — `/diff`, `/git` (status/commit/push/pull/branches/worktrees), `/github` (PR list/create, repo create/view). Uses `gh` when available.
- **PC control** — owner-only `/pc` (sleep, restart, shutdown) with a 30-second in-Discord confirmation.
- **Reliability** — automatic OpenCode server start, health checks, restart with back-off, queue persistence (SQLite), and graceful shutdown.
- **Security** — Discord allowlist (owner always authorized), HTTP-Basic auth to the OpenCode server with a generated password, secret redaction in logs, owner-only destructive commands.

## Requirements

- Windows (primary target) or macOS/Linux
- Node.js 22+
- Git (for `/diff`, `/git`)
- [OpenCode](https://opencode.ai) installed and on `PATH` (e.g. `npm i -g opencode-ai`)
- A Discord bot token with these privileges in the Developer Portal:
  - **Server Members Intent**
  - **Message Content Intent**
  - Bot invited to your server with `Send Messages`, `Create Public Threads`, `Send Messages in Threads`, `Manage Threads`, `Read Message History`, `Add Reactions`, and `Use Slash Commands` permissions.

## Install

```powershell
npm install -g .        # from the project directory
ocr setup               # interactive setup wizard
ocr start
```

Development:

```powershell
npm install
npm run build
npm run dev             # tsx: hot start of `ocr start`
```

## Setup

`ocr setup` walks through:

1. **Discord bot token** — validated against the Discord API (bot must be invited to your server).
2. **Server (guild) ID** — verified the bot can see the guild.
3. **Owner** — the account that will own the machine (gets full rights).
4. **Default project directory** — used by `/setpath` and project discovery.
5. **OpenCode port & host** — defaults `127.0.0.1:4096`, generated server password.
6. **GitHub & voice options** — optional.

Everything is stored in `%USERPROFILE%\.opencode-remote\config.json`; runtime state lives in `data.db` (SQLite). Secrets are never displayed again (`ocr config` redacts them).

## Commands

| Command | Description |
| --- | --- |
| `/opencode <prompt> [project]` | Send a prompt to OpenCode in a new thread. |
| `/code` | Toggle passthrough mode for the current thread. |
| `/autocode <enabled>` | Toggle passthrough for a whole project. |
| `/setpath` | Register a local project by alias (path autocomplete). |
| `/projects` | List registered projects. |
| `/use` | Bind this channel to a project. |
| `/session` | list / new / attach / detach / info / delete / rename sessions. |
| `/model <model>` | Set the model for the current project (autocomplete from the server). |
| `/queue` | status / list / clear / remove / pause / resume / settings. |
| `/diff [type]` | Show a git diff of the project. |
| `/work` | Create a worktree + branch for focused OpenCode work. |
| `/allow` | Manage the Discord allowlist (owner only). |
| `/setports <min> <max>` | Restrict the OpenCode port range. |
| `/voice` | status / enable / disable voice transcription. |
| `/status` | Overall status (OpenCode, queue, git, memory). |
| `/doctor` | On-demand diagnostics. |
| `/git` | status / diff / commit / push / pull / branches / log / worktrees. |
| `/github` | create-repo / pr / check / auth. |
| `/files` | Browse files in the bound project. |
| `/logs [lines]` | Recent bot logs (redacted). |
| `/stop` | Cancel the running OpenCode task. |
| `/help` | Command reference. |
| `/pc` | sleep / restart / shutdown (owner only, confirmed in Discord). |

## CLI

| Command | Description |
| --- | --- |
| `ocr setup` | Interactive setup wizard. |
| `ocr start` | Start the bot (default command). |
| `ocr stop` | Graceful stop. |
| `ocr restart` | Restart. |
| `ocr status` | Show bot, OpenCode, project, and queue status. |
| `ocr doctor` | Run diagnostics. |
| `ocr deploy` / `ocr undeploy` | Register / remove slash commands on the guild. |
| `ocr config` | Show configuration (values redacted). |
| `ocr update` | Check for updates. |

## Security model

- **Allowlist**: only users in the allowlist can control the machine. `/allow` and `/pc` are owner-only, as are destructive PC actions.
- **Server auth**: the app sets `OPENCODE_SERVER_PASSWORD` and authenticates to the OpenCode API with HTTP Basic (`opencode:<password>`). The password is auto-generated during setup.
- **Log redaction**: Discord tokens, API keys, GitHub tokens, Bearer tokens, and passwords are scrubbed from every log line.
- **Windows safety**: commands are launched as argument arrays (never shell-joined); paths with spaces are supported; `.cmd` shims are avoided via full-path resolution.

## Persistence & logs

- Config: `%USERPROFILE%\.opencode-remote\config.json`
- Database: `%USERPROFILE%\.opencode-remote\data.db`
- State/diff files: `%USERPROFILE%\.opencode-remote\state\`
- Logs: `%USERPROFILE%\.opencode-remote\logs\` (rotated, redacted)

## Troubleshooting

- **"You are not authorized"** — add the user with `/allow add user`.
- **OpenCode not reachable** — run `/doctor` or `ocr doctor`; confirm the server starts with `ocr start`.
- **Port already in use** — `netstat -ano | findstr :4096`, then change the port or use `/setports`.
- **Commands missing in Discord** — run `ocr deploy` (bot needs `applications.commands` scope).
- **Voice transcription** — `/voice enable` with an OpenAI API key.

## Development

```powershell
npm install
npm run build     # tsc
npm run test      # vitest (config, auth, storage, process-arg safety, git, confirmations)
npm run lint      # eslint
```

## License

MIT