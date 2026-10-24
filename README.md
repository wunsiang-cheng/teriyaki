# teriyaki

A minimal AI agent team in a retro terminal-style web page, using [OpenRouter](https://openrouter.ai) models.

- **No npm dependencies:** one Node server, one HTML file, SQLite built into Node.
- **A team, not a single bot:** by default a lead plans, one worker does the work and another checks it.
- **Runs on your computer:** agents run shell commands, read documents, look at images, listen to audio, watch video, and search the web.
- **Speaks:** the lead ends each turn with a short spoken report that plays in the page.
- **Keeps working without the page:** turns, team messages and schedules run on the server, so you can close the tab.

## Contents

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Configuration (.env)](#configuration-env)
- [Models](#models)
- [Using the page](#using-the-page)
- [The default team](#the-default-team)
- [Tools](#tools)
- [team.json reference](#teamjson-reference)
- [MCP servers (mcp.json)](#mcp-servers-mcpjson)
- [Memory and skills](#memory-and-skills)
- [Files and folders](#files-and-folders)
- [Size and time limits](#size-and-time-limits)
- [HTTP API](#http-api)
- [Security](#security)
- [Source layout](#source-layout)

## Requirements

| Need | Version or detail |
|---|---|
| Node.js | 22.5 or newer (uses the built-in `node:sqlite`) |
| OpenRouter API key | from [openrouter.ai/keys](https://openrouter.ai/keys), with credits |
| Shell for the agents | PowerShell on Windows, bash on macOS and Linux |
| Browser | any modern browser; audio playback is needed for spoken reports |

## Quick start

1. Copy the example settings:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env`: set `OPENROUTER_API_KEY` and a `PIN`.
3. Start the server:
   ```bash
   node server.js
   ```
4. Open http://localhost:3000 and enter the PIN.
5. Type a request, or `/help` for the commands.

On the first start:

- `team.json` is created from `team.example.json`. Edit `team.json` to change the team; it is gitignored.
- `agent.db`, `uploads/` and `workspace/` are created.

## Configuration (.env)

A variable already set in the environment wins over `.env`. `.env` itself is optional.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | none | Your OpenRouter key. Without it every model call fails. |
| `PIN` | yes | none | The login PIN. The server refuses to start without one. |
| `PORT` | no | `3000` | HTTP port. |
| `HOST` | no | all interfaces | `127.0.0.1` allows this machine only; the default lets other devices on your LAN open `http://<this machine's IP>:3000`. |
| `MAX_FILE_MB` | no | `100` | Largest file you can attach or an agent can send. |

`.env` can also hold secrets for MCP servers, referenced as `${NAME}` in `mcp.json` (see [MCP servers](#mcp-servers-mcpjson)).

## Models

The models are constants at the top of `core.js`.

| Constant | Default | Used for | Must support |
|---|---|---|---|
| `MODEL` | `openai/gpt-6-luna-pro` | Chat: every agent's reasoning and tool calls | images and tool calls |
| `VISION_MODEL` | `openai/gpt-6-luna` | `view_image` | images |
| `TRANSCRIBE_MODEL` | `google/gemini-3.5-transcribe` | `transcribe` | speech-to-text (`/audio/transcriptions`) |
| `MEDIA_MODEL` | `google/gemini-3.8-flash` | `listen_audio`, `watch_video` | audio and video input |
| `SPEECH_MODEL` | `google/gemini-3.8-flash-lite-tts` | `speak` | text-to-speech (`/audio/speech`) |

- An agent's `model` in `team.json`, or `defaults.model`, replaces `MODEL` for that agent.
- Web search is OpenRouter's server tool (`openrouter:web_search`, 5 results) and is billed per search.

## Using the page

### Runs, agents and views

| Term | Meaning |
|---|---|
| Run | One team conversation. It holds one session per agent. |
| Session | One agent's conversation within a run. |
| View | What the page shows: one agent's session, or `messages` (the mail between agents). |
| User-facing agent | An agent you can write to. By default only the lead; the other views are read-only. |

### Commands

| Command | What it does |
|---|---|
| `/new [name]` | Start a new run (named `run-N` if no name is given). |
| `/ls` | List the runs; `*` marks the current one. |
| `/use N` | Switch to run N from `/ls`. |
| `/rm N` | Delete run N (its agents are stopped first). |
| `/rename NAME` | Rename the current run. |
| `/view [AGENT]` | Show an agent's session, or `messages`; with no argument, list the views. |
| `/team` | Show the team tree, held agents and warnings. |
| `/team reload` | Read `team.json` again without a restart. |
| `/stop [AGENT]` | Stop the whole run, or one agent of it. |
| `/schedules` | List all schedules. |
| `/schedules cancel ID` | Cancel a schedule. |
| `/mcp` | Show each MCP server's state. |
| `/mcp reload` | Read `mcp.json` again. |
| `/mcp restart NAME` | Restart one MCP server. |
| `/compact` | Summarize the older part of the current session. |
| `/clear` | Empty the current session. |
| `/sound` | Turn the keypress click on or off. |
| `/voice` | Turn autoplay of spoken reports on or off (a player is still shown). |
| `/help` | List the commands. |

### Keys and attachments

| Action | How |
|---|---|
| Send a message | Enter |
| Stop the run | Esc, or the stop button |
| Stop the spoken report | Esc |
| Close the agent menu | Esc |
| Attach files | the `+` button, drag and drop, or paste; up to 10 files per message |

- Attached files are given to the agent as paths only. It reads them with its tools.
- Files the agent sends appear as download chips. They are never shown inline.

## The default team

`team.example.json` sets up plan, do, check:

| Agent | Role | Tools | Talks to |
|---|---|---|---|
| `lead` | Planner. Sets acceptance criteria, delegates, answers the user. | shell, schedule, send_message, send_file, read_file, view_image, speak, all MCP tools | you, `worker_1`, `worker_2` |
| `worker_1` | Doer. Researches, builds, writes and runs things. | shell, web_search, send_message, read_file, view_image, transcribe, listen_audio, watch_video | `lead` |
| `worker_2` | Checker. Verifies the work independently. | shell, web_search, send_message, read_file, view_image, transcribe, listen_audio, watch_video | `lead` |

How a request flows:

1. You write to `lead`.
2. `lead` answers small talk and one-line facts itself. For real work it decides what done looks like: the deliverable, its form and place, and the checks it must pass.
3. `lead` sends `worker_1` one complete task: the goal, the plan, the acceptance criteria and every file path.
4. `worker_1` does the work, runs it on realistic input, and reports the result, file paths and evidence.
5. `lead` sends `worker_2` the original request, the criteria and `worker_1`'s report.
6. `worker_2` checks every criterion itself and reports **PASS** or **FAIL** with evidence. It never edits `worker_1`'s files.
7. On FAIL, `lead` sends `worker_1` the specific problems, then has `worker_2` check again. After two failed rounds it stops and tells you what is left.
8. On PASS, `lead` sends you any files, speaks a short report, and writes a brief answer.

Defaults: model `openai/gpt-6-luna-pro`, auto-compaction at 500,000 estimated tokens.

## Tools

| Tool | What it does | Model or service | Default holders |
|---|---|---|---|
| `shell` | Runs a command in the agent's workspace; timeout 1 to 600 s (default 120), or `run_in_background` with a log file and an exit notice | local PowerShell or bash | all |
| `web_search` | Searches the web; the agent names its sources | OpenRouter server tool | workers |
| `send_message` | Sends asynchronous mail to a teammate in `can_contact` | none | all |
| `schedule` | Wakes the agent later in the same session: once (`in_minutes`, `at`) or repeating (`every_minutes`); 20 per session | none | lead |
| `send_file` | Gives the user a file as a download chip (a copy, made when sent) | none | lead |
| `read_file` | Text of PDF, .docx, .xlsx, .pptx or any text file, in windows of up to 100,000 characters; `pages` and `find` | local parser, no model | all |
| `view_image` | Answers a question about a PNG, JPEG, GIF or WebP | `VISION_MODEL` | all |
| `transcribe` | Speech to text, optionally with `[m:ss]` timestamps and a language hint | `TRANSCRIBE_MODEL` | workers |
| `listen_audio` | Answers a question about a recording: summary, speakers, sounds, words | `MEDIA_MODEL` | workers |
| `watch_video` | Answers a question about a video file or a YouTube link | `MEDIA_MODEL` | workers |
| `speak` | Reads one to three sentences aloud in the page; 30 voices, default Kore, optional `style` | `SPEECH_MODEL` | lead |
| `<server>__<tool>` | A tool from an MCP server in `mcp.json` | the MCP server | lead (`mcp: "all"`) |

Notes:

- `send_file` and `speak` reach the user, so only user-facing agents should have them. `team.json` warns otherwise.
- Text from files, recordings, videos and MCP tools is marked as content, not instructions from the user.
- `read_file` cannot read scanned PDFs, old `.doc`/`.xls`/`.ppt` files, or images.
- `ffmpeg` is not bundled. Agents shrink or cut media with the shell if a tool's limit is hit.

### Spoken reports

| Item | Detail |
|---|---|
| When | Once per turn that answers you, as the lead's last tool call, also after a schedule or a teammate's report |
| Length | At most 600 characters; one or two short sentences in practice |
| Content | Outcome first, plain speech: no markdown, paths or URLs |
| Format | WAV (Gemini returns 24 kHz mono PCM; the server adds a WAV header) in `uploads/<uuid>.wav` |
| Playback | Autoplays in the run you are viewing; each new report stops the previous one |
| Controls | `/voice` toggles autoplay, Esc stops playback, every report also gets a player |

## team.json reference

`team.json` is checked at startup and at `/team reload`. An error stops the startup (or, on reload, keeps the old team) and every problem is named.

### Top level

| Field | Required | Meaning |
|---|---|---|
| `lead` | yes | Id of the agent you talk to. It must have `reports_to: null` and be user-facing. |
| `defaults` | no | `model`, and `compact_at_tokens` (default 500,000, minimum 20,000). |
| `limits` | no | Team-wide limits; see the next table. |
| `agents` | yes | Object of agents keyed by id. |

### Limits

| Limit | Default | Meaning |
|---|---|---|
| `max_agents` | 10 | Agents in the team. |
| `max_depth` | 3 | Levels of the reporting tree, lead included. |
| `max_direct_reports` | 5 | Agents reporting to one agent. |
| `max_hops` | 20 | Times one request may be passed on between agents in a row. |
| `max_messages_per_request` | 100 | Messages one request may cause in total. |
| `max_message_chars` | 8000 | Length of one message; longer content goes in a file in `workspace/shared/`. |

### Agent fields

| Field | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | none | Display name. |
| `role` | yes | none | One line, shown to teammates. |
| `prompt` | no | empty | Extra instructions added to the system prompt. |
| `model` | no | `defaults.model`, else `MODEL` | OpenRouter model id. |
| `compact_at_tokens` | no | `defaults.compact_at_tokens` | When to auto-compact this agent's session. |
| `tools` | yes | none | Built-in tool names; may be empty. |
| `mcp` | no | `[]` | `"all"`, or MCP server names, or tool names such as `github__create_issue`. |
| `skills` | no | `"all"` | `"all"` or a list of skill names. |
| `reports_to` | yes | none | Id of its boss, or `null` for the lead only. |
| `can_contact` | no | `[]` | Ids it may message; must include its boss. |
| `user_facing` | no | `true` for the lead | Whether you can write to it directly. |

### Rules that are checked

- Ids: a lowercase letter, then up to 23 lowercase letters, digits or `_`.
- Reserved ids: `shared`, `user`, `all`.
- Exactly one root, the lead; no reporting circles; depth and direct-report limits hold.
- `send_message` is listed exactly when `can_contact` is not empty.
- A key repeated in the file (such as a pasted agent block) is an error, since JSON would keep only the last.
- Warnings, not errors: one-way contacts, unknown fields, a non-lead user-facing agent, a user-delivering tool on a non-user-facing agent, an MCP name not in `mcp.json`.

### Changing the team while it runs

- New settings apply to turns that start after the reload; running turns finish with the old ones.
- A new agent gets a session in every existing run.
- A removed agent's sessions are **held**: hidden, not run, and kept with their mail and schedules until the agent is back.

## MCP servers (mcp.json)

Copy `mcp.example.json` to `mcp.json` (gitignored), or ask the lead to set one up: it can edit `mcp.json` and reload it itself.

| Field | Server type | Meaning |
|---|---|---|
| `command`, `args` | stdio | The program to start and its arguments. |
| `env` | stdio | Extra environment variables. |
| `shell` | stdio | Start through a shell. |
| `url` | HTTP | Streamable HTTP endpoint. |
| `headers` | HTTP | Fixed request headers (no OAuth). |
| `tools` | both | Optional list of the tools to keep; default all. |

- `${NAME}` in `command`, `args`, `env`, `url` and `headers` is filled from `.env`, then the environment, so secrets stay out of `mcp.json`.
- Tools appear as `<server>__<tool>`. Agents get them through their `mcp` field.
- A server is started at startup, restarted on the next call after it exits, and its tools are listed again when it says they changed.
- A tool call times out after 120 s. Text over 12,000 characters is cut, with the full text saved to a temp file.

## Memory and skills

| Feature | Where | How it works |
|---|---|---|
| Lead's memory | `MEMORY.md` | Facts and preferences about you, kept by the lead with the shell. |
| Other agents' memory | `memory/<id>.md` | Notes that help the agent with later tasks. |
| Skills | `skills/<name>/SKILL.md` | Reusable procedures: front matter (`name`, `description`) then steps. |

- Memory is not injected; each agent is told where its file is and reads it itself.
- Skill descriptions are listed in every agent's prompt, read fresh before each step, so a new skill works without a reload.
- Agents write skills when asked, or after a multi-step procedure you will likely want again.
- `skills` in `team.json` limits which skills an agent sees.
- No secrets in memory or skill files: they belong in `.env`.

## Files and folders

All of these are created at runtime and gitignored.

| Path | Contents |
|---|---|
| `.env` | Settings and secrets. |
| `team.json` | Your team, copied from `team.example.json`. |
| `mcp.json` | Your MCP servers. |
| `agent.db` | SQLite: runs, sessions, messages, schedules, team mail, running turns. |
| `uploads/<uuid>/<name>` | Files you attached and files agents sent. |
| `uploads/<uuid>.<ext>` | MCP tool images and spoken reports. |
| `workspace/` | The lead's workspace. |
| `workspace/<agent id>/` | Each other agent's workspace. |
| `workspace/shared/` | Hand-off folder between agents. |
| `MEMORY.md`, `memory/` | Agent memory. |
| `skills/` | Skills. |

- An agent's shell and relative paths start in its workspace, but nothing stops it from reaching other paths.
- Deleting a session does not delete its uploads.
- Background job logs and long MCP outputs go to the system temp folder and are not cleaned up.

## Size and time limits

| What | Limit |
|---|---|
| Attachment or sent file | `MAX_FILE_MB` (100 MB) |
| Files per message | 10 |
| `read_file` input | 50 MB |
| `read_file` window | 30,000 characters by default, 100,000 at most |
| `view_image` | 20 MB, 90 s |
| `transcribe` | 25 MB, 120 s; about 10 minutes of speech |
| `listen_audio`, `watch_video` | 50 MB, 10 min; about an hour of audio in tests |
| `speak` | 600 characters, 60 s |
| `shell` | 600 s, unless run in the background; output keeps the first and last 4 KB |
| Schedules | 20 per session |
| Same command repeated | the turn stops after 3 in a row |
| Login attempts | 5 per minute per address |

## HTTP API

Every route except `/` and `/api/login` needs the login cookie (`tk`) or `Authorization: Bearer <token>`. The agents' own shell gets a token as `TERIYAKI_TOKEN`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/login` | `{pin}`: sets the login cookie. |
| GET | `/api/events` | Server-sent events: a snapshot, then updates. |
| POST | `/api/sessions/:id/messages` | `{content, files}`: start a turn. |
| POST | `/api/sessions/:id/compact` | Compact a session. |
| POST | `/api/sessions/:id/clear` | Clear a session. |
| POST | `/api/runs` | `{name?}`: create a run. |
| PUT | `/api/runs/:id` | `{name}`: rename a run. |
| DELETE | `/api/runs/:id` | Stop and delete a run. |
| POST | `/api/runs/:id/abort[?agent=ID]` | Stop a run or one agent. |
| POST | `/api/runs/:id/use` | Mark the run as the one in use. |
| GET, POST | `/api/team` | The team; `{action: "reload"}` reads `team.json` again. |
| POST | `/api/schedules` | `{action: "list"}` or `{action: "cancel", id}`. |
| POST | `/api/uploads` | Raw file body with an `X-Name` header; returns its path. |
| GET, POST | `/api/mcp` | Server states; `{action: "reload"}` or `{action: "restart", name}`. |

## Security

- **Agents run unrestricted shell commands** on this computer as your user. Treat the PIN like a password.
- Use a PIN of 6 or more characters that you would not guess.
- The PIN travels over plain HTTP: fine at home, not on a shared network. Set `HOST=127.0.0.1` to keep it to this machine.
- Logins last until the server restarts; there is no logout.
- Requests from another origin are refused, which blocks cross-site and DNS-rebinding attacks.
- Downloaded files are served as attachments, sandboxed and never sniffed, so a stored HTML or SVG file cannot run on this origin.
- Each tool call that uses a model sends data to OpenRouter and the model's provider (for example Google for audio and video).

## Source layout

| File | Role |
|---|---|
| `server.js` | HTTP server, login, API routes, startup and recovery after a crash. |
| `core.js` | Settings, models, SQLite schema, runs, sessions, mail, event stream. |
| `agent.js` | Agent loop, system prompts, compaction, mail delivery, schedules, stopping; `view_image`, `listen_audio`, `watch_video`, `send_message`. |
| `tools.js` | Tool registry: `shell`, `schedule`, `send_file`, `read_file`, `transcribe`, `speak`. |
| `team.js` | Loads and checks `team.json`; tells each agent about its teammates. |
| `mcp.js` | MCP client over stdio and Streamable HTTP. |
| `docs.js` | Text of Word, Excel and PowerPoint files and plain text. |
| `pdf.js` | Text of PDF files, with no library. |
| `public/index.html` | The whole web page. |
| `team.example.json` | The default team. |
| `mcp.example.json` | Example MCP servers (GitHub over stdio, DeepWiki over HTTP). |
| `.env.example` | Example settings. |

To add a built-in tool, add one entry to `tools` in `tools.js` with its `spec` and `run`, then list it in an agent's `tools`.
