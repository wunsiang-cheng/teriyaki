# teriyaki

A minimal AI agent in a retro terminal-style web page, using [OpenRouter](https://openrouter.ai) models. No npm dependencies: one Node server, one HTML file.

## Setup

Node.js 22.5+ and an [OpenRouter API key](https://openrouter.ai/keys).

```
cp .env.example .env     # put your key and a PIN in .env
node server.js
```

Open http://localhost:3000 and enter the PIN. `/help` lists the commands. Models are set in `core.js`: `MODEL` for chat (the default: an agent's `model` in `team.json` replaces it), `VISION_MODEL` for `view_image`, `TRANSCRIBE_MODEL` for `transcribe`, `MEDIA_MODEL` for `listen_audio` and `watch_video`, and `SPEECH_MODEL` for `speak`, with which the lead ends each turn with a short spoken report that plays in the page (`/voice` turns the playing off, Esc stops it).

- `OPENROUTER_API_KEY`: required.
- `PIN`: required. The page asks for it once per browser, and again after a server restart. The agent runs shell commands, so use 6+ characters you would not guess. It travels over plain HTTP: fine at home, not on a shared network.
- `PORT`: default `3000`.
- `HOST`: default all interfaces, so other devices on your LAN can open `http://<this machine's IP>:3000`. Set `127.0.0.1` to allow this machine only.
- `MAX_FILE_MB`: the largest file you can attach or the agent can send, default `100`.
