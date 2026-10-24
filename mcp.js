// MCP servers over stdio (newline-delimited JSON-RPC) or Streamable HTTP. Each entry of mcp.json's mcpServers is a server whose tools join the registry in tools.js
// as <server>__<tool>. A server is started (or its session opened) at startup to list its tools,
// again on the next call after it exits (or its session expires), and its tools are listed again when it says they changed.
const crypto = require('crypto'), fs = require('fs'), os = require('os'), path = require('path'), { spawn } = require('child_process'), { parseEnv } = require('util');
const { MIME } = require('./core'), { tools } = require('./tools');
const servers = new Map();   // name -> server, or a record of an mcp.json entry that could not be set up; status() reports them for /mcp

const TEXT_MAX = 12000, CALL_MS = 120e3, PAGES = 20, NAME = /^[A-Za-z0-9_-]{1,32}$/, PROTO = '2025-06-18';
const toolName = (srv, tool) => `${srv}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64);   // the model API takes [A-Za-z0-9_-], at most 64 characters

// A message from the server that is not an answer to one of our calls: true when it was one. Requests get an answer through send: ping is answered,
// and we offer no roots, sampling or elicitation.
const fromServer = (srv, j, send) => {
  if (j.method === 'notifications/tools/list_changed') srv.changed?.();
  if (j.method && j.id != null) send(j.method === 'ping' ? { id: j.id, result: {} } : { id: j.id, error: { code: -32601, message: 'not supported: ' + j.method } });
  return !!j.method;
};
const answer = j => { if (j.error) throw new Error(j.error.message); return j.result; };
const hello = rpc => rpc('initialize', { protocolVersion: PROTO, capabilities: {}, clientInfo: { name: 'teriyaki', version: '1' } });

// stdio: a call settles on its answer, the turn's abort, the timeout, or the server exiting; the first three also tell the server to cancel it (initialize excepted, as the spec asks).
function stdio(srv, { command, args = [], env: vars, shell = false }) {
  const p = srv.child = spawn(command, args, { stdio: 'pipe', shell, env: vars && { ...process.env, ...vars } });
  const wait = new Map(); let buf = '', err = '', n = 0;
  const send = o => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
  const fail = e => { wait.forEach(w => w.no(e)); if (srv.child === p) srv.ready = null; };   // the next call starts a new server
  const why = () => err.trim() ? '; last stderr: ' + err.trim().split('\n').at(-1).slice(0, 300) : '';
  // The next call starts a new server at once; the calls waiting on this one fail a moment later, once its last stderr has arrived.
  p.on('error', fail); p.on('exit', (code, sig) => { if (srv.child === p) srv.ready = null; setTimeout(() => fail(new Error(`MCP server ${srv.name} exited (${sig || 'code ' + code})${why()}`)), 100).unref(); });
  p.stdin.on('error', () => {});
  p.unref(); p.stdin.unref(); p.stdout.unref(); p.stderr.unref();   // an idle server must not keep the process alive; a pending call's timer does
  p.stderr.setEncoding('utf8').on('data', d => err = (err + d).slice(-2000));
  p.stdout.setEncoding('utf8').on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      let j; try { j = JSON.parse(buf.slice(0, i)); } catch {} buf = buf.slice(i + 1);
      if (!j || fromServer(srv, j, send)) continue;
      const w = wait.get(j.id); if (w) try { w.ok(answer(j)); } catch (e) { w.no(e); }
    }
  });
  const rpc = (method, params, signal) => new Promise((ok, no) => {
    if (signal?.aborted) return no(new Error('Aborted by the user.'));   // aborted while the server was starting: never sent
    const id = ++n, end = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); wait.delete(id); };
    const cancel = e => { if (!wait.has(id)) return; end(); if (method !== 'initialize') send({ method: 'notifications/cancelled', params: { requestId: id } }); no(e); };
    const abort = () => cancel(new Error('Aborted by the user.')), timer = setTimeout(() => cancel(new Error(`no answer from MCP server ${srv.name} after ${srv.ms / 1000}s`)), srv.ms);
    wait.set(id, { ok: r => (end(), ok(r)), no: e => (end(), no(e)) });
    signal?.addEventListener('abort', abort, { once: true });
    send({ id, method, params });
  });
  return hello(rpc).then(() => (send({ method: 'notifications/initialized' }), rpc), e => { p.kill(); throw e; });   // a server that never answered is stopped, so the next call starts a new one
}

// Server-sent events: yields each event's data as JSON.
async function* events(body) {
  let buf = '', data = [];
  for await (const d of body.pipeThrough(new TextDecoderStream())) {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      else if (!line && data.length) { let j; try { j = JSON.parse(data.join('\n')); } catch {} data = []; if (j) yield j; }
    }
  }
}

// Streamable HTTP: each message is a POST; the answer comes back as JSON or as an event stream that can carry the server's own messages first.
// Our notifications and answers get 202 and no body. stop() ends the session with a DELETE. A 404 to a request with our session id means the session expired: the call is retried once on a new session.
// shortcut: no GET stream, so a list_changed notice reaches us only inside the answer to one of our calls; no OAuth, only fixed headers.
function http(srv, { url, headers = {} }) {
  let session = null, version = PROTO, n = 0;
  const post = (o, signal) => fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', ...o }), signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': version, ...(session && { 'Mcp-Session-Id': session }), ...headers } });
  const send = o => post(o, AbortSignal.timeout(srv.ms)).then(r => r.body?.cancel(), () => {});
  const rpc = async (method, params, signal) => {
    if (signal?.aborted) throw new Error('Aborted by the user.');   // aborted while the session was opening: never sent
    const id = ++n, ac = new AbortController(), abort = () => ac.abort(new Error('Aborted by the user.'));
    const timer = setTimeout(() => ac.abort(new Error(`no answer from MCP server ${srv.name} after ${srv.ms / 1000}s`)), srv.ms);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const r = await post({ id, method, params }, ac.signal);
      if (r.status === 404 && session) { r.body?.cancel(); throw Object.assign(new Error(`MCP server ${srv.name}: session expired`), { expired: true }); }
      if (!r.ok) throw new Error(`MCP server ${srv.name}: HTTP ${r.status} ${(await r.text()).trim().slice(0, 300)}`.trim());
      if (method === 'initialize') session = r.headers.get('mcp-session-id');
      if (!(r.headers.get('content-type') || '').includes('text/event-stream')) return answer(await r.json());
      for await (const j of events(r.body)) if (!fromServer(srv, j, send) && j.id === id) return answer(j);   // leaving the loop closes the stream
      throw new Error(`MCP server ${srv.name}: the stream ended without an answer`);
    } catch (e) {
      if (!ac.signal.aborted) throw e;
      if (method !== 'initialize') send({ method: 'notifications/cancelled', params: { requestId: id } });
      throw ac.signal.reason;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  };
  // Ends the session, as the spec asks, so reloads do not pile up sessions on the server.
  rpc.close = () => session && fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(5000), headers: { 'MCP-Protocol-Version': version, 'Mcp-Session-Id': session, ...headers } }).then(r => r.body?.cancel(), () => {});
  // initialized must reach the server before our first request, which may go over another connection.
  return hello(rpc).then(async r => { version = r.protocolVersion || PROTO; await send({ method: 'notifications/initialized' }); return rpc; });
}

// One server: rpc(method, params, signal) starts it (or opens its session) when needed. opts: url and headers for HTTP, or command, args, env and shell for stdio; timeout_s (tests only).
// The last error (not an abort) is kept for /mcp. stop() ends the process or the session; the next call starts again.
// srv.ready is cleared only by the start it belongs to, so a late failure of an old one cannot drop a newer one (and leave its process running).
function server(name, opts) {
  const srv = { name, type: opts.url ? 'http' : 'stdio', state: 'starting', names: [], child: null, ready: null, ms: opts.timeout_s > 0 ? opts.timeout_s * 1000 : CALL_MS };
  const drop = r => { if (srv.ready === r) srv.ready = null; };
  const ready = () => { if (!srv.ready) { const r = srv.ready = (opts.url ? http : stdio)(srv, opts).catch(e => { drop(r); throw e; }); } return srv.ready; };   // a failed start is tried again on the next call
  const go = async (method, params, signal) => { const r = ready(); try { return await (await r)(method, params, signal); } catch (e) { if (e.expired) drop(r); throw e; } };
  srv.rpc = (method, params, signal) => go(method, params, signal).catch(e => { if (!e.expired) throw e; return go(method, params, signal); })
    .catch(e => { if (!signal?.aborted) Object.assign(srv, { error: e.message, error_at: Date.now() }); throw e; });
  srv.stop = () => { const r = srv.ready; srv.ready = null; srv.child?.kill(); r?.then(f => f.close?.(), () => {}); };
  servers.set(name, srv);
  return srv;
}

// One tool call as a text-only tool result. Long text is cut and kept whole in a temp file; images go to uploads/ and to the model in a message after the step.
async function call(srv, name, a, t) {
  const r = await srv.rpc('tools/call', { name, arguments: a }, t.signal), content = r.content || [];
  let text = content.map(c => c.type === 'text' ? c.text : c.type === 'resource' && c.resource?.text != null ? c.resource.text : c.type === 'resource_link' ? `[resource ${c.uri}]` : null).filter(s => s != null).join('\n');
  if (!text && r.structuredContent) text = JSON.stringify(r.structuredContent);
  if (r.isError) return { error: text || 'the tool failed' };
  let out = { text };
  if (text.length > TEXT_MAX) {
    const f = path.join(os.tmpdir(), `teriyaki-mcp-${crypto.randomUUID()}.txt`); fs.writeFileSync(f, text);   // shortcut: never deleted, like background job logs
    out = { text: text.slice(0, TEXT_MAX), full_text_file: f, note: `Cut at ${TEXT_MAX} of ${text.length} characters. The whole text is in full_text_file: search it with the shell (grep / Select-String) for the part you need.` };
  }
  for (const c of content) {
    if (c.type !== 'image') continue;
    const ext = Object.keys(MIME).find(k => MIME[k] === c.mimeType);
    if (!ext) { out.text += `\n[an image of type ${c.mimeType} is not shown]`; continue; }
    const p = `uploads/${crypto.randomUUID()}.${ext}`; fs.writeFileSync(p, Buffer.from(c.data, 'base64'));
    t.viewed.push(p); out = { ...out, path: p, note: 'The image is in the next message.' };
  }
  return out;
}

// Lists a server's tools into the registry, replacing the ones it listed before. only: the tool names to keep.
async function list(srv, { only } = {}) {
  srv.listing = { only };
  const got = []; let cursor, i = 0;
  try { do { const r = await srv.rpc('tools/list', cursor && { cursor }); got.push(...r.tools); cursor = r.nextCursor; } while (cursor && ++i < PAGES); }
  catch (e) { if (srv.state === 'starting') srv.state = 'failed'; throw e; }
  if (srv.closed) return 0;   // closed by /mcp while listing
  srv.state = 'ready';
  srv.names.forEach(n => delete tools[n]); srv.names = [];
  for (const m of got) {
    if (only && !only.includes(m.name)) continue;
    const name = toolName(srv.name, m.name);
    if (tools[name]) { console.error(`mcp ${srv.name}: tool ${name} skipped, the name is taken`); continue; }
    tools[name] = { server: srv.name, run: (a, t) => call(srv, m.name, a, t),
      spec: () => ({ description: m.description || '', parameters: m.inputSchema || { type: 'object', properties: {} } }) };
    srv.names.push(name);
  }
  srv.changed = () => srv.closed || list(srv, srv.listing).then(k => console.log(`mcp ${srv.name}: ${k} tools`), e => console.error(`mcp ${srv.name}: listing tools failed: ${e.message}`));
  return srv.names.length;
}

// ${NAME} in command, args, env, url and headers is taken from .env (read again on every reload), then the environment, so secrets stay out of mcp.json.
const fill = (s, where) => String(s).replace(/\$\{(\w+)\}/g, (_, k) => { const v = dot[k] ?? process.env[k]; if (v == null) throw new Error(`\${${k}} in ${where} is not set in .env or the environment`); return v; });

// Without a leading BOM, which Windows PowerShell 5.1 writes with -Encoding utf8.
let file = 'mcp.json', dot = {};
const text = f => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
const read = () => { try { dot = parseEnv(text('.env')); } catch { dot = {}; } try { return JSON.parse(text(file)).mcpServers || {}; } catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`${file}: ${e.message}`); } };

// Sets up one mcp.json entry and lists its tools. One that fails to start or list is left out with a message.
async function open(name, c) {
  let srv;
  try {
    if (!c || typeof c !== 'object') throw new Error('the entry must be an object');
    if (!NAME.test(name)) throw new Error('the name must be 1-32 letters, digits, _ or -');
    const all = (o, where) => o && Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fill(v, `${where}.${k}`)]));
    let opts;
    if (c.url) {
      const url = fill(c.url, 'url');
      if (!/^https?:\/\//.test(url)) throw new Error('url must start with http:// or https://');
      opts = { url, headers: all(c.headers, 'headers') };
    } else {
      if (typeof c.command !== 'string' || !c.command) throw new Error('command or url is required');
      const command = fill(c.command, 'command');
      opts = { command, args: (c.args || []).map(a => fill(a, 'args')), env: all(c.env, 'env'), shell: process.platform === 'win32' && !/[\\/]/.test(command) };   // shell for a bare name: npx, uvx... are .cmd files on Windows. shortcut: the shell splits args with spaces there
    }
    srv = server(name, opts);
    console.log(`mcp ${name}: ${await list(srv, { only: Array.isArray(c.tools) ? c.tools : undefined })} tools`);
  } catch (e) {
    srv?.stop(); console.error(`mcp ${name}: unavailable: ${e.message}`);
    if (!srv?.closed) servers.set(name, { name, type: c?.url ? 'http' : 'stdio', state: 'failed', error: e.message, error_at: Date.now(), names: [] });
  }
}
// Stops an mcp.json server for good and takes its tools out of the registry.
const close = name => { const s = servers.get(name); if (!s) return; s.closed = true; s.stop?.(); s.names.forEach(n => delete tools[n]); servers.delete(name); };

// Called once by server.js.
async function start(f = 'mcp.json') {
  file = f; let cfg; try { cfg = read(); } catch (e) { return console.error(e.message); }
  await Promise.all(Object.entries(cfg).map(([name, c]) => open(name, c)));
}

// /mcp reload (no name): reads mcp.json again and sets up every entry from scratch, also dropping removed ones. /mcp restart NAME: the same for one entry.
async function reload(name) {
  const s = name != null && servers.get(name);
  let cfg; try { cfg = read(); } catch (e) { return { error: e.message }; }
  if (name != null && !s && !Object.hasOwn(cfg, name)) return { error: `no MCP server ${name} in ${file}` };
  const names = name != null ? [name] : [...new Set([...[...servers.keys()], ...Object.keys(cfg)])];
  names.forEach(close);
  await Promise.all(names.filter(n => Object.hasOwn(cfg, n)).map(n => open(n, cfg[n])));
  return { servers: status() };
}

const status = () => [...servers.values()].map(s => ({ name: s.name, type: s.type, state: s.state, tools: s.names.length, ...(s.error && { error: s.error, error_at: s.error_at }) }));

module.exports = { server, call, list, start, reload, status, toolName };
