// Shared by the other modules: settings from .env, the SQLite store, upload paths, the OpenRouter client and the event stream to open pages.
const fs = require('fs'), { randomUUID } = require('crypto'), { DatabaseSync } = require('node:sqlite');
try { process.loadEnvFile('.env'); } catch (e) { if (e.code !== 'ENOENT') throw e; }   // .env is optional: settings can come from the environment alone
const env = process.env, PORT = env.PORT || 3000;   // a variable already set in the environment wins over .env
if (!env.OPENROUTER_API_KEY) console.warn('OPENROUTER_API_KEY is not set (put it in .env or the environment): calls to the model will fail');
const MODEL = 'openai/gpt-6-luna-pro';   // the chat model: it must accept images and tool calls
const VISION_MODEL = 'openai/gpt-6-luna';   // the view_image model: it must accept images
const TRANSCRIBE_MODEL = 'google/gemini-3.5-transcribe';   // the transcribe model: a speech-to-text model, which OpenRouter serves at /audio/transcriptions rather than /chat/completions
const MEDIA_MODEL = 'google/gemini-3.8-flash';   // the listen_audio and watch_video model: it must accept audio and video

const db = new DatabaseSync('agent.db');
db.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;   -- a write waits for a reader of agent.db (a backup, a viewer, a test) instead of failing at once
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_call_id TEXT, images TEXT, files TEXT);
  CREATE TABLE IF NOT EXISTS schedules (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, prompt TEXT NOT NULL, next_at INTEGER NOT NULL, every_min INTEGER);`);
if (!db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'files')) db.exec('ALTER TABLE messages ADD COLUMN files TEXT');   // a database made before attachments
const tx = f => { db.exec('BEGIN'); try { const r = f(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };   // f runs in one transaction; never nest one inside another
// Further schema changes are numbered in PRAGMA user_version. 1: runs (a team conversation: one session per agent), the inbox for messages between agents, and the run and agent of a session.
// 2: turns, the sessions with a turn running, which is how a restart knows the turns that the server's death cut short.
if (db.prepare('PRAGMA user_version').get().user_version < 1) tx(() => db.exec(`
  CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, name TEXT NOT NULL, created INTEGER NOT NULL, used INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, request_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_session TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL DEFAULT 'mail', content TEXT NOT NULL, hops INTEGER NOT NULL, created INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending');
  ALTER TABLE sessions ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE;
  ALTER TABLE sessions ADD COLUMN agent TEXT;
  PRAGMA user_version = 1`));
if (db.prepare('PRAGMA user_version').get().user_version < 2) tx(() => db.exec(`
  CREATE TABLE IF NOT EXISTS turns (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE);
  PRAGMA user_version = 2`));

const OR = env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1', auth = { Authorization: 'Bearer ' + env.OPENROUTER_API_KEY, 'Content-Type': 'application/json' };   // OPENROUTER_BASE is for the tests, which point it at a fake model service

// Images live in uploads/ (MCP tool images); messages only carry their paths and are turned into base64 parts per request.
const UP = /^uploads\/[\w-]+\.(webp|jpg|png|gif)$/, MIME = { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif' };
fs.mkdirSync('uploads', { recursive: true });
const dataUrl = p => `data:${MIME[p.split('.').pop()]};base64,${fs.readFileSync(p).toString('base64')}`;

// Files of any type go both ways (what the user attaches, what the agent sends with send_file): uploads/<uuid>/<name>, recorded as {path, size}.
// The model gets their paths only, never their contents, and the page only offers them as downloads.
const FILE = /^uploads\/[\w-]+\/[^/\\]+$/, MAX_FILE = (Number(env.MAX_FILE_MB) || 100) * 1048576;
// A name that is safe on disk and in the model's shell: letters (any language), digits and . _ - only, so spaces, brackets and quotes become _ (PowerShell reads [ ] as wildcards); no Windows device names.
const safeName = n => {
  const s = [...String(n ?? '').split(/[\\/]/).pop().replace(/[^\p{L}\p{M}\p{N}._-]/gu, '_').replace(/\.+$/, '')].slice(-100);   // by code point, keeping the end (the extension)
  while (Buffer.byteLength(s.join('')) > 200) s.shift();   // file names are limited in bytes, not characters
  const name = s.join('');
  return /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? '_' + name : name || 'file';
};
const newFileDir = () => { const d = 'uploads/' + randomUUID(); fs.mkdirSync(d, { recursive: true }); return d; };

// Sessions: SQLite is the copy of record and only the server writes messages; a page changes only a session's name.
const msgsOf = db.prepare('SELECT role, content, tool_calls, tool_call_id, images, files FROM messages WHERE session_id = ? ORDER BY id');
const msgRow = m => (m.tool_calls = m.tool_calls && JSON.parse(m.tool_calls), m.images = m.images && JSON.parse(m.images), m.files = m.files && JSON.parse(m.files), Object.fromEntries(Object.entries(m).filter(([, v]) => v !== null)));  // omit null fields: the model API rejects them
const loadSession = id => { const s = db.prepare('SELECT id, name, summary, run_id, agent FROM sessions WHERE id = ?').get(id); if (s) s.msgs = msgsOf.all(id).map(msgRow); return s; };
// extra, when given, runs inside the same transaction (the caller's own writes, such as the inbox rows it delivered): all of it is saved, or none.
const store = (s, extra) => tx(() => {
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, name, summary, created, updated, run_id, agent) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, summary = excluded.summary, updated = excluded.updated').run(s.id, s.name, s.summary, now, now, s.run_id ?? null, s.agent ?? null);
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(s.id);
  const ins = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, images, files) VALUES (?, ?, ?, ?, ?, ?, ?)');
  s.msgs.forEach(m => ins.run(s.id, m.role, m.content ?? '', m.tool_calls ? JSON.stringify(m.tool_calls) : null, m.tool_call_id ?? null, m.images?.length ? JSON.stringify(m.images) : null, m.files?.length ? JSON.stringify(m.files) : null));  // shortcut: uploads (images and files) stay on disk when their session is deleted, add cleanup if uploads/ grows
  extra?.();
});

// Runs: a team conversation is a run with one session per agent. A session made for a run has the id <run>-<agent>; one that was made before runs, or whose id the page chose, keeps its own id.
// The lead's session carries the run's name, the others "<run> · <agent>".
const sessionName = (name, agent, lead) => agent === lead ? name : `${name} · ${agent}`;
function addSessions(run, lead, agents, preset = {}) {   // inside a transaction: the sessions the run lacks, one per agent id (preset: ids to use instead); returns the new ids
  const have = new Set(db.prepare('SELECT agent FROM sessions WHERE run_id = ?').all(run.id).map(r => r.agent)), now = Date.now();
  return agents.filter(a => !have.has(a)).map(agent => {
    const id = preset[agent] || `${run.id}-${agent}`;
    db.prepare('INSERT INTO sessions (id, name, summary, created, updated, run_id, agent) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sessionName(run.name, agent, lead), '', now, now, run.id, agent);
    return id;
  });
}
function createRun({ id = randomUUID(), name, lead, agents, preset }) {
  const now = Date.now();
  return tx(() => {
    db.prepare('INSERT INTO runs (id, name, created, used) VALUES (?, ?, ?, ?)').run(id, name, now, now);
    return { id, name, sessions: addSessions({ id, name }, lead, agents, preset) };
  });
}
// At startup and at a team.json reload, once the team is known: a session made before runs becomes a run of its own with the lead as its agent, and every run gets the sessions it lacks (an agent added to team.json). Safe to repeat; returns how many sessions it adopted.
const adopt = (lead, agents) => tx(() => {
  const n = db.prepare('INSERT INTO runs (id, name, created, used) SELECT id, name, created, updated FROM sessions WHERE run_id IS NULL').run().changes;
  db.prepare('UPDATE sessions SET run_id = id, agent = ? WHERE run_id IS NULL').run(lead);
  for (const run of db.prepare('SELECT id, name FROM runs').all()) addSessions(run, lead, agents);
  return Number(n);
});
const runSessions = (run, agent) => db.prepare('SELECT id FROM sessions WHERE run_id = ? AND (? IS NULL OR agent = ?)').all(run, agent ?? null, agent ?? null).map(r => r.id);   // all of a run's, or the one of an agent
const sessionOf = (run, agent) => db.prepare('SELECT id FROM sessions WHERE run_id = ? AND agent = ?').get(run, agent)?.id;
const renameRun = (id, name, lead) => tx(() => {
  const now = Date.now();
  db.prepare('UPDATE runs SET name = ?, used = ? WHERE id = ?').run(name, now, id);
  for (const s of db.prepare('SELECT id, agent FROM sessions WHERE run_id = ?').all(id)) db.prepare('UPDATE sessions SET name = ?, updated = ? WHERE id = ?').run(sessionName(name, s.agent, lead), now, s.id);
});
const deleteRun = id => db.prepare('DELETE FROM runs WHERE id = ?').run(id);   // its sessions, their messages and schedules, and its inbox go with it
const bump = sid => db.prepare('UPDATE runs SET used = ? WHERE id = (SELECT run_id FROM sessions WHERE id = ?)').run(Date.now(), sid);   // the user was active in this session's run
const touch = id => db.prepare('UPDATE runs SET used = ? WHERE id = ?').run(Date.now(), id);   // the user moved to this run: a page that opens next starts there
const runRow = id => { const r = db.prepare('SELECT id, name, created, used FROM runs WHERE id = ?').get(id); return r && { ...r }; };
const allRuns = () => db.prepare('SELECT id, name, created, used FROM runs ORDER BY created, rowid').all().map(r => ({ ...r }));

// The inbox: what the agents of a run say to each other, addressed to a session. kind: mail (a send_message) or notice (the system, for a turn that ended without a report).
// state: pending, delivered (it is in the receiver's session now) or dropped (a stop cancelled it). request: the user message or schedule firing that set it off; hops: how many messages deep.
// A row as the pages get it, with the agent of the receiving session (to_agent) beside the session itself.
const MAIL = 'SELECT i.*, s.agent AS to_agent FROM inbox i JOIN sessions s ON s.id = i.to_session';
const post = ({ run, request, from, to, kind = 'mail', content, hops }) => {
  const id = db.prepare('INSERT INTO inbox (run_id, request_id, from_agent, to_session, kind, content, hops, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(run, request, from, to, kind, content, hops, Date.now()).lastInsertRowid;
  return { ...db.prepare(MAIL + ' WHERE i.id = ?').get(id) };
};
const mailLog = () => db.prepare(MAIL + ' ORDER BY i.id').all().map(r => ({ ...r }));   // every row of every run, for the page's view of the team's messages (shortcut: the inbox is never trimmed, so neither is this)
const mailFor = sid => db.prepare("SELECT * FROM inbox WHERE to_session = ? AND state = 'pending' ORDER BY id").all(sid).map(r => ({ ...r }));
const delivered = ids => db.prepare(`UPDATE inbox SET state = 'delivered' WHERE id IN (${ids.map(() => '?')})`).run(...ids);   // meant for store(s, extra): the messages and the rows change together
const mailIn = request => db.prepare('SELECT COUNT(*) n FROM inbox WHERE request_id = ?').get(request).n;   // every row of the request, whatever its state
const hasMail = (sid, after = 0) => !!db.prepare("SELECT 1 FROM inbox WHERE to_session = ? AND state = 'pending' AND id > ?").get(sid, after);   // after: only rows newer than this id (lastMail() at some earlier moment)
const lastMail = () => db.prepare('SELECT COALESCE(MAX(id), 0) n FROM inbox').get().n;
const waiting = () => db.prepare("SELECT DISTINCT to_session FROM inbox WHERE state = 'pending'").all().map(r => r.to_session);
const dropMail = (run, sids) => Number(db.prepare(`UPDATE inbox SET state = 'dropped' WHERE run_id = ? AND state = 'pending'${sids ? ` AND to_session IN (${sids.map(() => '?')})` : ''}`).run(run, ...sids ?? []).changes);   // the run's pending mail, or only what waits for these sessions

// Turns: a session is in `turns` for as long as one of its turns runs. The server's death leaves its running turns there, so the next start can tell which it cut short.
const turnBegan = sid => db.prepare('INSERT OR IGNORE INTO turns (session_id) VALUES (?)').run(sid);
const turnEnded = sid => db.prepare('DELETE FROM turns WHERE session_id = ?').run(sid);
// Takes the turns that were running when the server died (once: they are cleared) as { sid, run, agent }. tell runs for each in the same transaction, so that a crash in between loses neither the news nor what tell wrote;
// the results of tell that are not empty are returned.
const cutShort = tell => tx(() => {
  const rows = db.prepare('SELECT t.session_id AS sid, s.run_id AS run, s.agent FROM turns t JOIN sessions s ON s.id = t.session_id ORDER BY t.rowid').all().map(r => ({ ...r }));
  db.exec('DELETE FROM turns');
  return rows.map(tell).filter(Boolean);
});

// Events to every open page (GET /api/events): {sid, type, ...} with type msg, delta, line, busy, pop, session, mail (a row of the inbox, for a view of the team's messages),
// run (a run made or renamed: {run}; deleted: {gone: id}) or team (team.json was read again: {team, sessions: those of the agents that are new to it}).
const pages = new Set(), emit = (sid, type, o = {}) => { const d = `data: ${JSON.stringify({ sid, type, ...o })}\n\n`; pages.forEach(r => r.write(d)); };
// run: the line is about the whole run (a stop, a limit), so a page shows it in every view of the run, not only in the view of session sid.
const line = (sid, text, cls = 's', run = false) => { emit(sid, 'line', { text, cls, ...run && { run } }); if (cls === 'e') console.error(`[${sid}] ${text}`); };   // also logged: an unattended turn may have no page watching
const add = (s, m) => { s.msgs.push(m); store(s); emit(s.id, 'msg', { msg: m }); };   // saved per message, so a crash loses at most the running step

module.exports = { env, PORT, MODEL, VISION_MODEL, TRANSCRIBE_MODEL, MEDIA_MODEL, db, OR, auth, UP, MIME, dataUrl, FILE, MAX_FILE, safeName, newFileDir, loadSession, store, createRun, adopt, runSessions, sessionOf, renameRun, deleteRun, bump, touch, runRow, allRuns, post, mailLog, mailFor, delivered, mailIn, hasMail, lastMail, waiting, dropMail, turnBegan, turnEnded, cutShort, pages, emit, line, add };
