# OpenClaw Task Monitor

**English** · [Français](README.fr.md)

Real-time dashboard for an [OpenClaw](https://github.com/openclaw/openclaw) install:
agents, sessions, subagents, tasks and the CPU/RAM footprint of every unit, in a single tree.

**No model call, no token spent.** The tool only reads information OpenClaw already
produces: the SQLite state database, session files, transcripts and `/proc`.

![Dashboard screenshot](docs/screenshot.png)

## What it shows

- **Tree** `agent → session → subagent → task`, collapsed on idle units
- **State** of every unit: running · idle · paused · finished · failed · killed · scheduled
- **CPU and RAM per unit** — CPU is a percentage of one core (like `top`), RAM is the
  cumulative RSS of the whole process subtree attached to the unit
- **Short task title**, extracted from the last user message of the transcript, to tell
  at a glance what the work in progress is about
- **Machine health**: CPU, memory, swap, load, gateway uptime
- Live detail panel, text filter, raw process tab
- **Interface in English or French**, switchable from the `EN / FR` toggle in the top-right
  corner (English by default, choice remembered in the browser)

## Requirements

| | |
|---|---|
| OS | Linux — the tool reads `/proc` |
| Node.js | **≥ 22.5**, required by the built-in `node:sqlite` module (`node --version` to check) |
| OpenClaw | a local install, readable by the user running the monitor |
| Port | `3200` free by default (configurable) |

Nothing else to install: no database, no external service, no API key.

## Install and run

### Option A — as a systemd user service (recommended)

Starts on boot, restarts on failure, memory-capped. One command:

```bash
git clone https://github.com/proxydis/openclaw-task-monitor.git
cd openclaw-task-monitor
./install.sh
```

`install.sh` does everything: installs dependencies, builds the production bundle,
generates the `~/.config/systemd/user/openclaw-monitor.service` unit, enables it and
starts it. Once it prints `✓ http://127.0.0.1:3200`, open that URL.

To use another port:

```bash
./install.sh 3300
```

To keep the service alive after logout (otherwise systemd stops user services at the end
of the session):

```bash
sudo loginctl enable-linger "$USER"
```

### Option B — run it by hand, no systemd

Useful to try it out or on a machine without systemd:

```bash
git clone https://github.com/proxydis/openclaw-task-monitor.git
cd openclaw-task-monitor

npm install                                     # dependencies
npx next build                                  # production build
cp -r .next/static .next/standalone/.next/static # static assets of the standalone bundle

PORT=3200 node .next/standalone/server.js       # start
```

Then open <http://127.0.0.1:3200>. Stop it with `Ctrl+C`.

### Option C — development mode

Hot reload, no build step:

```bash
npm install
npm run dev     # http://127.0.0.1:3200
```

### Check it works

```bash
curl -s http://127.0.0.1:3200/api/state | head -c 200   # JSON snapshot
```

An empty tree usually means the monitor is not looking at the right install: see
`OPENCLAW_HOME` below.

## Configuration

Every setting goes through environment variables.

| Variable | Default | Role |
|---|---|---|
| `PORT` | `3200` | listening port |
| `HOSTNAME` | `127.0.0.1` | listening interface |
| `OPENCLAW_HOME` | `~/.openclaw` | root of the supervised install |
| `MONITOR_REDACT` | — | `1` masks all business content (see below) |
| `MONITOR_PLAN_USAGE` | — | `0` disables the Anthropic plan-usage card (no network call) |
| `MONITOR_PLAN_TTL_MS` | `600000` | polling interval of the usage endpoint; the API grants about one call every 5 min, going lower gets the account rate-limited |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | where the Claude Code OAuth token is read from (read-only) |

With systemd, edit the generated unit then reload:

```bash
systemctl --user edit --full openclaw-monitor.service
systemctl --user restart openclaw-monitor.service
```

## Security — read before exposing the service

The dashboard displays **the content of the requests sent to the agents**, channel names
and session identifiers. It has **no authentication**.

- It listens on `127.0.0.1` by default. Only bind it to `0.0.0.0` on a trusted network,
  or put it behind an authenticated reverse proxy.
- For a screenshot, a demo or a public talk, run it with `MONITOR_REDACT=1`: the tree
  structure and the CPU/RAM measurements stay intact, but task prompts, channel names,
  paths and hostname are replaced by neutral labels.

## Data sources (read-only)

| Data | Source |
|---|---|
| Agents, workspace, model | `openclaw.json` + `agents/*/` |
| Sessions, channel, last activity | `agents/<id>/sessions/sessions.json` |
| Title of the running task | last user message of the `.jsonl` transcript (tail of the file, 512 KB max) |
| Tasks, subagents, flows, cron | `state/openclaw.sqlite`, opened `readOnly` |
| CPU / RAM | `/proc/<pid>/stat`, `/proc/meminfo`, `/proc/stat` |

### Attaching a process to a session

The gateway starts every CLI runtime (`claude`, `codex`, `gemini`) with
`--append-system-prompt-file`. That file contains a
`Runtime: agent=… | session=… | model=…` line, which gives an **exact** process → session
mapping. The whole process subtree — MCP servers, shells, tools — is accounted for on that
session. Failing that, the process `cwd` is compared to the declared workspaces to at least
attach the agent. The rest of the gateway subtree is accounted as “gateway”, Chrome as
“browser”.

### Running tasks

Agent CLI turns are only written to `task_runs` once they end. A “running” task is
therefore either an unfinished `task_runs` row, or a **synthesized turn** built from a live
process, titled with the last user message of the session.

## Cost of a snapshot

One `/proc` scan, four SQLite queries and a few file-tail reads: 20 to 300 ms, ~60 MB of
RSS. The snapshot is shared across every client — at most one scan every 1.5 s — and pushed
over SSE every 2 s. The service is capped at `MemoryMax=600M`.

## API

- `GET /api/state` — full JSON snapshot
- `GET /api/stream` — SSE stream, one frame every 2 s

Snapshots carry no interface text: any label produced by the tool is emitted as a
translation key (see `lib/i18n.ts`) and rendered by the browser in the selected language.

## Operating the service

```bash
systemctl --user status  openclaw-monitor      # state
systemctl --user restart openclaw-monitor      # restart
journalctl --user -u openclaw-monitor -n 50    # last 50 log lines
```

Update to the latest version:

```bash
git pull
./install.sh          # rebuilds and restarts the service
```

Uninstall:

```bash
systemctl --user disable --now openclaw-monitor.service
rm ~/.config/systemd/user/openclaw-monitor.service
systemctl --user daemon-reload
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Cannot find module 'node:sqlite'` | Node.js older than 22.5 — upgrade Node |
| `EADDRINUSE` on startup | port already taken — `./install.sh <other-port>` |
| Plan card shows “Anthropic is rate-limiting…” | normal: the usage endpoint grants ~1 call every 5 min and the Claude CLI shares that quota. The gauges keep their last reading and polling resumes on its own; only raise `MONITOR_PLAN_TTL_MS` if it persists |
| Empty tree, no agent | wrong install root — set `OPENCLAW_HOME` to the folder that holds `openclaw.json` |
| `sqlite: …` warning in the banner | `state/openclaw.sqlite` unreadable (permissions, or gateway never started) |
| Page stuck on “connecting to stream…” | server down or unreachable — check `journalctl --user -u openclaw-monitor` |
| CPU shown as 0 % everywhere | the monitor only sees the processes of the user it runs as; run it as the user that owns the gateway |

## License

MIT — see [LICENSE](LICENSE).
