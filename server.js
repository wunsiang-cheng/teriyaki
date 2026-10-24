// Zero-dep server: serves public/ and the HTTP API. The agent loop (agent.js) runs in here, so turns and schedules need no open page; the key stays server-side.
// Modules: core.js (settings, SQLite, events), tools.js (the model's tools), docs.js and pdf.js (the text of PDF, Office and text files, for read_file), mcp.js (tools from MCP servers in mcp.json, stdio or HTTP), team.js (the agents in team.json), agent.js (the loop and schedules).
const http = require('http'), fs = require('fs'), path = require('path'), { randomUUID, createHash, timingSafeEqual } = require('crypto'), { pipeline } = require('stream/promises');
const { env, PORT, db, OR, auth, UP, VOICE, MIME, FILE, MAX_FILE, safeName, newFileDir, loadSession, store, createRun, adopt, runSessions, renameRun, bump, touch, runRow, allRuns, mailLog, pages, emit } = require('./core');
const { schedules, tools } = require('./tools'), { running, start, ask, compact, repair, recover, resume, tick, stop, remove, paused } = require('./agent');
const mcp = require('./mcp'), team = require('./team');
const PIN = env.PIN, MAX_FILES = 10;   // files per message
if (!PIN) { console.error(`PIN is not set: put PIN=... in ${path.resolve('.env')} or the environment (this server listens on the LAN, and the agent runs shell commands)`); process.exit(1); }

// team.json: copied from team.example.json on the first start. A mistake in it stops the server here, with every problem named. /team reload reads it again; a mistake then leaves the team as it was.
let warnings = [];   // what the last reading of team.json warned about
function readTeam() {
  const builtin = Object.keys(tools).filter(n => !tools[n].server);   // MCP tools are not listed yet, and are granted in mcp anyway
  let servers = []; try { servers = Object.keys(JSON.parse(fs.readFileSync('mcp.json', 'utf8').replace(/^\uFEFF/, '')).mcpServers || {}); } catch {}
  const r = team.load('team.json', { example: path.join(__dirname, 'team.example.json'), tools: builtin, toUser: builtin.filter(n => tools[n].toUser), mcp: servers });
  r.warnings.forEach(w => console.warn('team.json: ' + w));
  team.set(r.team); warnings = r.warnings;
  return r;
}
try { if (readTeam().created) console.log('team.json created from team.example.json: edit it to change the team'); } catch (e) { console.error(e.message); process.exit(1); }
const talks = agent => !!team.agent(agent)?.user_facing;   // the user may write to this agent
// The sessions of agents that team.json does not list: kept, hidden and not run until the agent is back, with what waits for them.
const held = () => db.prepare('SELECT agent, COUNT(*) AS sessions FROM sessions GROUP BY agent').all().filter(r => !team.agent(r.agent)).map(r => ({
  agent: r.agent, sessions: r.sessions,
  mail: db.prepare("SELECT COUNT(*) n FROM inbox WHERE state = 'pending' AND to_session IN (SELECT id FROM sessions WHERE agent = ?)").get(r.agent).n,
  schedules: db.prepare('SELECT COUNT(*) n FROM schedules WHERE session_id IN (SELECT id FROM sessions WHERE agent = ?)').get(r.agent).n }));
const announceHeld = () => held().forEach(h => console.warn(`team.json: ${h.sessions} session(s) of agent "${h.agent}", which is not in team.json, are held: hidden, and not run until it is back`));
// The team as a page sees it (GET /api/team, and the page's start): the lead first, then the others as team.json lists them. The prompts stay on the server.
const teamInfo = () => {
  const T = team.get();
  return { lead: T.lead, limits: T.limits, warnings, held: held(), agents: [T.lead, ...Object.keys(T.agents).filter(id => id !== T.lead)].map(id => { const { prompt, skills, reports, ...a } = T.agents[id]; return a; }) };
};
const adopted = adopt(team.get().lead, Object.keys(team.get().agents));   // sessions from before runs become runs of the lead; new agents get their sessions
if (adopted) console.log(`${adopted} earlier session(s) are now runs of ${team.get().lead}`);
announceHeld();
// team.json read again: the new team applies to the turns that start from now on, the ones running finish with the old. An agent that is new to the team gets its session in every run; mail that waited for one that is back is taken up.
function reloadTeam() {
  if (!fs.existsSync('team.json')) throw new Error('team.json is missing');
  const before = new Set(Object.keys(team.get().agents)), r = readTeam();
  adopt(r.team.lead, Object.keys(r.team.agents)); announceHeld();
  emit(null, 'team', { team: teamInfo(), sessions: db.prepare('SELECT id, agent FROM sessions').all().filter(s => team.agent(s.agent) && !before.has(s.agent)).map(s => loadSession(s.id)) });
  resume();
}
// What a page starts with: all it draws from, sent in the same tick it joins the event stream, so no event can fall between the two. The sessions of held agents are not in it.
const snapshot = () => ({ type: 'init', team: teamInfo(), runs: allRuns(), mail: mailLog(), maxFile: MAX_FILE, busy: [...running.keys()],
  sessions: db.prepare('SELECT id, agent FROM sessions ORDER BY created, rowid').all().filter(s => team.agent(s.agent)).map(s => loadSession(s.id)),
  cur: db.prepare('SELECT id FROM runs ORDER BY used DESC, rowid DESC').get()?.id });   // the run to open: the one the user used last, not the one an agent was busy in last
if (!process.env.NODE_TEST_CONTEXT) mcp.start();   // in the background: MCP tools appear once each server has listed them. Not under node --test, which keeps the tests offline


// Logins: a correct PIN earns a random token, kept in a cookie. TERIYAKI_TOKEN is the agent's own, for the calls its shell makes to this server. shortcut: tokens live until a restart, no logout.
const tokens = new Set([env.TERIYAKI_TOKEN = randomUUID()]), fails = new Map(), sha = s => createHash('sha256').update(s).digest();
const authed = req => tokens.has((req.headers.cookie?.match(/(?:^|; )tk=([\w-]+)/) || req.headers.authorization?.match(/^Bearer ([\w-]+)$/))?.[1]);   // Bearer too: Windows PowerShell 5.1 drops a Cookie header set by hand, and the agent's own calls go through it
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit());   // so tools.js can kill running commands on exit
repair();
recover();   // the bosses of the turns the server's death cut short get their notices
resume();   // after the repair and the notices: agents with mail that was waiting when the server stopped carry on with it
setInterval(tick, 2000);

const handle = async (req, res) => {
  const T = team.get(), json = (o, code = 200) => (res.writeHead(code, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(o)));
  const read = async (max = Infinity) => { let b = ''; for await (const c of req) if ((b += c).length > max) throw new Error('body too large'); return b; };
  const [, asid, act] = req.url.match(/^\/api\/sessions\/([\w-]+)\/(messages|compact|clear)$/) || [];

  // Any POST here can make the agent run shell commands: refuse an Origin that is not this host (either scheme: a tunnel such as ngrok serves https), and everything but the page itself without a login (a DNS-rebinding page is on another host, so the cookie never reaches it). Commands themselves are unrestricted by design.
  if (req.method !== 'GET' && req.headers.origin && req.headers.origin.replace(/^https?:\/\//, '') !== req.headers.host) return (res.writeHead(403), res.end('forbidden'));
  // Login: 5 tries a minute per address, counted before the body is read so parallel guesses cannot slip past the check; the body is capped (the only write before a login).
  if (req.method === 'POST' && req.url === '/api/login') {
    const ip = req.socket.remoteAddress, f = fails.get(ip) || { n: 0, t: 0 };
    if (f.n >= 5 && Date.now() - f.t < 6e4) return json({ error: 'locked' }, 429);
    fails.set(ip, { n: f.n + 1, t: Date.now() });
    let a; try { a = JSON.parse(await read(1024)); } catch { return json({ error: 'invalid JSON' }, 400); }
    if (typeof a?.pin !== 'string' || !timingSafeEqual(sha(a.pin), sha(PIN))) return json({ error: 'wrong PIN' }, 401);
    fails.delete(ip); const t = randomUUID(); tokens.add(t);
    res.setHeader('Set-Cookie', `tk=${t}; HttpOnly; SameSite=Strict; Path=/`); return json({ ok: true });
  }
  if (req.url !== '/' && !authed(req)) return json({ error: 'login' }, 401);

  if (req.method === 'GET' && req.url === '/api/events') {
    const first = `data: ${JSON.stringify(snapshot())}\n\n`;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write(first);
    pages.add(res); req.on('close', () => pages.delete(res)); return;
  }

  // A message starts a turn that runs on here with or without the page; a busy session refuses it.
  if (req.method === 'POST' && act) {
    // Only an agent the user talks to takes messages, files, /clear and /compact; checked before the body is read, so a message with files gets the same answer.
    const row = db.prepare('SELECT agent, run_id FROM sessions WHERE id = ?').get(asid);
    if (!row) return json({ error: 'no such session' }, 404);
    if (!team.agent(row.agent)) return json({ error: `agent "${row.agent}" is not in team.json, so its session is held` }, 409);
    if (!talks(row.agent)) return json({ error: `agent "${row.agent}" does not take messages from the user` }, 403);
    let job = { compact: (s, signal) => compact(s, false, signal), clear: async s => { s.msgs = []; s.summary = ''; store(s); emit(s.id, 'session', { session: s }); } }[act];
    if (act === 'messages') {
      let a; try { a = JSON.parse(await read()); } catch { return json({ error: 'invalid JSON' }, 400); }
      // Attached files are paths that /api/uploads gave out: checked again here, and their sizes come from the disk, not from the page.
      const files = [], paths = Array.isArray(a.files) ? a.files : [];
      if (paths.length > MAX_FILES) return json({ error: `at most ${MAX_FILES} files per message` }, 400);
      for (const p of paths) {
        const st = typeof p === 'string' && FILE.test(p) ? fs.statSync(p, { throwIfNoEntry: false }) : null;
        if (!st?.isFile()) return json({ error: 'no such uploaded file: ' + p }, 400);
        files.push({ path: p, size: st.size });
      }
      if (typeof a.content !== 'string' || !a.content.trim() && !files.length) return json({ error: 'content is required' }, 400);
      const u = { role: 'user', content: a.content, ...(files.length && { files }) };
      job = (s, signal) => ask(s, u, signal);
      bump(asid);
    }
    const ok = start(asid, job);
    return ok ? json({ ok: true }, 202) : ok === null ? json({ error: 'no such session' }, 404) : json({ error: paused(row.run_id, asid) ? 'busy: the run is being stopped' : 'busy: a turn is running in this session' }, 409);
  }

  // One run: stopped (every agent of it, and the mail waiting for them; with ?agent=<id> that agent only; answers when they have stopped), renamed, marked as the one in use (a page that opens next starts there), or deleted.
  // Deleting a run stops it first and waits, so no session of it is left behind.
  const ru = req.url.match(/^\/api\/runs\/([\w-]+)(\/abort|\/use)?(\?agent=(\w+))?$/);
  if (ru && (!ru[3] || ru[2] === '/abort') && { POST: ru[2], PUT: !ru[2], DELETE: !ru[2] }[req.method]) {
    const [, rid, sub, , agent] = ru, body = req.method === 'PUT' && await read();   // the body first: nothing is checked and then changed across a wait
    if (!runRow(rid)) return json({ error: 'no such run' }, 404);
    if (req.method === 'PUT') {
      let a; try { a = JSON.parse(body); } catch { return json({ error: 'invalid JSON' }, 400); }
      const name = typeof a?.name === 'string' && a.name.trim(); if (!name) return json({ error: 'name (text) is required' }, 400);
      // The sessions are renamed too, and a turn that is running would save its session back under the old name.
      if (runSessions(rid).some(id => running.has(id)) || paused(rid)) return json({ error: 'busy: the team is working on this run; stop it first (Esc)' }, 409);
      renameRun(rid, name, T.lead); emit(null, 'run', { run: runRow(rid) });
      return json({ ok: true });
    }
    if (sub === '/use') { touch(rid); return json({ ok: true }); }
    if (agent && !runSessions(rid, agent).length) return json({ error: `no agent "${agent}" in this run` }, 404);
    if (req.method === 'POST') return json({ ok: true, ...await stop(rid, agent) });
    (await remove(rid)).forEach(id => emit(id, 'session', { session: null })); emit(null, 'run', { gone: rid });
    return json({ ok: true });
  }

  // A run is a team conversation: a session for every agent of the team.
  if (req.method === 'POST' && req.url === '/api/runs') {
    let a; try { const b = await read(); a = b.trim() ? JSON.parse(b) : {}; } catch { return json({ error: 'invalid JSON' }, 400); }
    if (!a || typeof a !== 'object' || a.name !== undefined && (typeof a.name !== 'string' || !a.name.trim())) return json({ error: 'name must be text' }, 400);
    const name = a.name?.trim() ?? `run-${db.prepare('SELECT COUNT(*) n FROM runs').get().n + 1}`, run = createRun({ name, lead: T.lead, agents: Object.keys(T.agents) });
    const made = run.sessions.map(loadSession);
    emit(null, 'run', { run: runRow(run.id) });
    made.forEach(s => emit(s.id, 'session', { session: s }));
    return json({ run: runRow(run.id), sessions: made.map(s => ({ id: s.id, agent: s.agent, user_facing: talks(s.agent) })) }, 201);
  }

  // team.json: the team as the page sees it; reload reads the file again (a mistake in it is refused with every problem named, and the team stays as it was).
  if (req.url === '/api/team' && req.method === 'GET') return json(teamInfo());
  if (req.url === '/api/team' && req.method === 'POST') {
    let a; try { a = JSON.parse(await read()); } catch { return json({ error: 'invalid JSON' }, 400); }
    if (a?.action !== 'reload') return json({ error: 'action must be reload' }, 400);
    try { reloadTeam(); } catch (e) { return json({ error: e.message }, 400); }
    return json(teamInfo());
  }

  if (req.method === 'POST' && req.url === '/api/schedules') {
    let a; try { a = JSON.parse(await read()); } catch { return json({ error: 'invalid JSON' }, 400); }
    const r = schedules(a); return json(r, r.error ? 400 : 200);
  }

  // A file the user attaches: the raw request body, streamed to uploads/<uuid>/<name> (X-Name, percent-encoded). It joins a message later, by its path.
  if (req.method === 'POST' && req.url === '/api/uploads') {
    const tooBig = () => json({ error: `file too large (at most ${MAX_FILE / 1048576} MB)` }, 413);
    if (Number(req.headers['content-length']) > MAX_FILE) return tooBig();
    let name; try { name = safeName(decodeURIComponent(req.headers['x-name'] || '')); } catch { return json({ error: 'invalid X-Name' }, 400); }
    const dir = newFileDir(); let n = 0;
    try {
      await pipeline(req, async function* (body) { for await (const c of body) { if ((n += c.length) > MAX_FILE) throw Object.assign(new Error('too large'), { big: true }); yield c; } }, fs.createWriteStream(`${dir}/${name}`));
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });   // no partial file is kept
      return e.big ? tooBig() : json({ error: 'upload failed: ' + e.message }, 400);
    }
    return json({ path: `${dir}/${name}`, size: n });
  }

  // /mcp: the MCP servers' state; reload or restart one after editing mcp.json. Answers once their tools are listed again.
  if (req.url === '/api/mcp' && req.method === 'GET') return json({ servers: mcp.status() });
  if (req.url === '/api/mcp' && req.method === 'POST') {
    let a; try { a = JSON.parse(await read()); } catch { return json({ error: 'invalid JSON' }, 400); }
    if (a?.action !== 'reload' && !(a?.action === 'restart' && typeof a.name === 'string' && a.name)) return json({ error: 'action must be reload, or restart with a name' }, 400);
    const r = await mcp.reload(a.action === 'restart' ? a.name : undefined); return json(r, r.error ? 400 : 200);
  }

  // uploads/<uuid>.<ext> holds MCP tool images and what the agent said with speak, served inline.
  if (req.method === 'GET' && (UP.test(req.url.slice(1)) || VOICE.test(req.url.slice(1)))) {
    const p = req.url.slice(1);
    return fs.readFile(p, (err, data) => err ? (res.writeHead(404), res.end()) : (res.writeHead(200, { 'Content-Type': MIME[p.split('.').pop()], 'X-Content-Type-Options': 'nosniff' }), res.end(data)));
  }
  // uploads/<uuid>/<name> holds files of any type, only ever served as a download: never inline, never sniffed, and sandboxed, so a stored .html or .svg cannot run on this origin (where the login cookie works).
  let fp; try { fp = decodeURIComponent(req.url.slice(1)); } catch {}
  if (req.method === 'GET' && fp && FILE.test(fp)) {
    const name = fp.split('/').pop();
    return fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) return (res.writeHead(404), res.end());
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox',
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
      fs.createReadStream(fp).on('error', () => res.destroy()).pipe(res);
    });
  }

  const f = path.join('public', req.url === '/' ? 'index.html' : path.normalize(req.url).replace(/^(\.\.[\\/])+/, ''));
  fs.readFile(f, (err, data) => err ? (res.writeHead(404), res.end()) : (res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' }), res.end(data)));
};
// A request that throws (e.g. a JSON body of null) gets a 500 instead of crashing the server and every running turn with it.
http.createServer({ requestTimeout: 30 * 60e3 }, (req, res) => handle(req, res).catch(e => { console.error(e); if (!res.headersSent) res.writeHead(500); res.end(); })).listen(PORT, env.HOST, () => console.log('http://localhost:' + PORT));  // all interfaces unless HOST says otherwise (127.0.0.1: this machine only); the PIN is what keeps the shell-running agent private
