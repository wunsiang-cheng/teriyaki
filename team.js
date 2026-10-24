// The team: its agents, their tools and who may contact whom, as team.json describes them. check(), read() and roster() are pure (no database, no environment, no files), so tests import this file directly;
// load() reads the file and get() is the config the server runs with.
const fs = require('fs');

const ID = /^[a-z][a-z0-9_]{0,23}$/, RESERVED = ['shared', 'user', 'all'];   // shared: the hand-off folder workspace/shared/
const OWN = ['web_search', 'send_message'];   // the only tool names this file knows itself; every other one must be in the tool registry
const LIMITS = { max_agents: 10, max_depth: 3, max_direct_reports: 5, max_hops: 20, max_messages_per_request: 100, max_message_chars: 8000 };
const COMPACT = 500000, COMPACT_MIN = 20000;   // auto-compaction threshold in estimated tokens (the default assumes a large-context model: GPT-6 Luna Pro has 1.05M); below the minimum every model step would summarize the session first
const TOP = ['lead', 'defaults', 'limits', 'agents'], DEFAULTS = ['model', 'compact_at_tokens'];
const FIELDS = ['name', 'role', 'prompt', 'model', 'compact_at_tokens', 'tools', 'mcp', 'skills', 'reports_to', 'can_contact', 'user_facing'];

const obj = v => !!v && typeof v === 'object' && !Array.isArray(v), strs = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x), int = (v, min) => Number.isInteger(v) && v >= min;

// Checks a parsed team.json. tools: the names in the tool registry (MCP tools excluded: they are granted in mcp); toUser: those among them that deliver to the user; mcp: the servers in mcp.json, or null when unknown.
// Returns { team, errors, warnings }; team is null when there are errors, else the config with its defaults filled in, and for every agent its depth and the agents that report to it.
function check(cfg, { tools = [], toUser = [], mcp = null } = {}) {
  const errors = [], warnings = [], err = m => errors.push(m), warn = m => warnings.push(m);
  if (!obj(cfg)) return { team: null, errors: ['the file must hold one JSON object'], warnings };
  const unknown = (o, ok, where) => Object.keys(o).filter(k => !ok.includes(k)).forEach(k => warn(`${where}${k} is not a known field and is ignored`));
  unknown(cfg, TOP, '');

  const limits = { ...LIMITS }, defaults = { model: null, compact_at_tokens: COMPACT };
  if (cfg.limits !== undefined) {
    if (!obj(cfg.limits)) err('limits must be an object');
    else {
      unknown(cfg.limits, Object.keys(LIMITS), 'limits.');
      for (const k of Object.keys(LIMITS)) if (k in cfg.limits) { if (int(cfg.limits[k], 1)) limits[k] = cfg.limits[k]; else err(`limits.${k} must be a whole number of at least 1`); }
    }
  }
  if (cfg.defaults !== undefined) {
    if (!obj(cfg.defaults)) err('defaults must be an object');
    else {
      unknown(cfg.defaults, DEFAULTS, 'defaults.');
      const { model, compact_at_tokens: c } = cfg.defaults;
      if (model !== undefined) { if (typeof model === 'string' && model) defaults.model = model; else err('defaults.model must be a model name'); }
      if (c !== undefined) { if (int(c, COMPACT_MIN)) defaults.compact_at_tokens = c; else err(`defaults.compact_at_tokens must be a whole number of at least ${COMPACT_MIN}`); }
    }
  }
  if (!obj(cfg.agents) || !Object.keys(cfg.agents).length) { err('agents must list at least one agent'); return { team: null, errors, warnings }; }

  const ids = Object.keys(cfg.agents), lead = cfg.lead, known = [...new Set([...tools, ...OWN])], A = {};   // send_message is in the registry too, once agent.js has added it
  if (ids.length > limits.max_agents) err(`team has ${ids.length} agents (max ${limits.max_agents})`);
  if (typeof lead !== 'string' || !lead) err('lead is required: the id of the agent that leads the team');
  else if (!ids.includes(lead)) err(`lead "${lead}" is not one of the agents`);

  // Each agent on its own: its fields. Its relations to the others are checked below, once all of them are read.
  for (const id of ids) {
    const a = cfg.agents[id], at = `agent "${id}"`;
    if (!ID.test(id)) err(`${at}: the id must be a lowercase letter followed by up to 23 lowercase letters, digits or _`);
    else if (RESERVED.includes(id)) err(`${at}: the id is reserved (${RESERVED.join(', ')})`);
    if (!obj(a)) { err(`${at} must be an object`); continue; }
    unknown(a, FIELDS, `${at}: `);
    const n = A[id] = { id, name: '', role: '', prompt: '', model: defaults.model, compact_at_tokens: defaults.compact_at_tokens, tools: [], mcp: [], skills: 'all', reports_to: undefined, can_contact: [], user_facing: id === lead };
    const bad = m => err(`${at}: ${m}`);
    for (const k of ['name', 'role']) { if (typeof a[k] === 'string' && a[k].trim()) n[k] = a[k].trim(); else bad(`${k} is required (text)`); }
    if (a.prompt !== undefined) { if (typeof a.prompt === 'string') n.prompt = a.prompt.trim(); else bad('prompt must be text'); }
    if (a.model !== undefined) { if (typeof a.model === 'string' && a.model) n.model = a.model; else bad('model must be a model name'); }
    if (a.compact_at_tokens !== undefined) { if (int(a.compact_at_tokens, COMPACT_MIN)) n.compact_at_tokens = a.compact_at_tokens; else bad(`compact_at_tokens must be a whole number of at least ${COMPACT_MIN}`); }
    if (!strs(a.tools)) bad('tools is required: a list of tool names (it may be empty)');
    else {
      n.tools = [...new Set(a.tools)];
      for (const t of n.tools) if (!known.includes(t)) bad(`tools: unknown tool "${t}"` + (t.includes('__') ? ' (tools of MCP servers are granted in mcp)' : ` (known: ${known.join(', ')})`));
    }
    if (a.mcp !== undefined) { if (a.mcp === 'all') n.mcp = 'all'; else if (strs(a.mcp)) n.mcp = [...new Set(a.mcp)]; else bad('mcp must be "all" or a list of MCP server names or tool names such as "github__create_issue"'); }
    if (a.skills !== undefined) { if (a.skills === 'all' || strs(a.skills)) n.skills = a.skills; else bad('skills must be "all" or a list of skill names'); }
    if (!('reports_to' in a)) bad('reports_to is required: the id of the agent it reports to, or null for the lead');
    else if (a.reports_to === null || typeof a.reports_to === 'string' && a.reports_to) n.reports_to = a.reports_to;
    else bad('reports_to must be an agent id, or null for the lead');
    if (a.can_contact !== undefined) { if (strs(a.can_contact)) n.can_contact = [...new Set(a.can_contact)]; else bad('can_contact must be a list of agent ids'); }
    if (a.user_facing !== undefined) { if (typeof a.user_facing === 'boolean') n.user_facing = a.user_facing; else bad('user_facing must be true or false'); }
  }

  // The hierarchy: one root, the lead; every other agent reports to an agent, up to the lead without a circle, within the depth and direct-report limits.
  const all = Object.values(A);
  for (const n of all) {
    const at = `agent "${n.id}"`;
    if (typeof n.reports_to === 'string') { if (n.reports_to === n.id) err(`${at}: reports_to itself`); else if (!A[n.reports_to]) err(`${at}: reports_to "${n.reports_to}" is not an agent`); }
    for (const c of n.can_contact) { if (c === n.id) err(`${at}: can_contact lists itself`); else if (!A[c]) err(`${at}: can_contact "${c}" is not an agent`); }
    if (n.reports_to === null && n.id !== lead) err(`${at}: reports_to is null but it is not the lead; only the lead has no one to report to`);
    n.reports = all.filter(m => m.reports_to === n.id).map(m => m.id);
    if (n.reports.length > limits.max_direct_reports) err(`${at} has ${n.reports.length} direct reports (max ${limits.max_direct_reports})`);
  }
  if (A[lead] && A[lead].reports_to !== null && A[lead].reports_to !== undefined) err(`lead "${lead}" must have reports_to: null`);
  if (A[lead] && !A[lead].user_facing) err(`lead "${lead}" must be user_facing: it is the agent the user talks to`);
  for (const n of all) {
    const chain = [n.id]; let up = n;
    while (typeof up.reports_to === 'string' && A[up.reports_to]) {
      up = A[up.reports_to];
      if (chain.includes(up.id)) {   // a circle: reported once, by its smallest id
        const loop = chain.slice(chain.indexOf(up.id));
        if (n.id === [...loop].sort()[0]) err(`agents ${loop.join(', ')} report to each other in a circle`);
        break;
      }
      chain.push(up.id);
    }
    if (up.reports_to === null) { n.depth = chain.length; if (n.depth > limits.max_depth) err(`agent "${n.id}" is at depth ${n.depth} (max ${limits.max_depth})`); }
  }

  // Contact rules: a way back to the boss, send_message exactly where there is someone to contact.
  for (const n of all) {
    const at = `agent "${n.id}"`, boss = typeof n.reports_to === 'string' ? A[n.reports_to] : null, has = n.tools.includes('send_message');
    if (boss && boss !== n && !n.can_contact.includes(boss.id)) err(`${at}: can_contact must include "${boss.id}", the agent it reports to; otherwise it cannot report`);
    if (has && !n.can_contact.length) err(`${at}: tools lists send_message but can_contact is empty`);
    if (!has && n.can_contact.length) err(`${at}: can_contact is set but tools does not list send_message`);
    for (const c of n.can_contact) {
      const m = A[c];
      if (!m || m === n || m.can_contact.includes(n.id) || m.reports_to === n.id) continue;   // (a child without a way back to its boss is an error above)
      warn(n.reports_to === c ? `agent "${c}" cannot contact "${n.id}", which reports to it, so "${n.id}" is unreachable` : `agent "${n.id}" can contact "${c}", but "${c}" cannot contact "${n.id}" (one-way)`);
    }
    if (n.id !== lead && n.user_facing) warn(`${at} is user_facing: you chat with it directly, which changes the default of talking to the lead only`);
    if (!n.user_facing) for (const t of n.tools) if (toUser.includes(t)) warn(`${at} is not user_facing but lists ${t}: what it sends to the user would show only in its own read-only view; give the lead the path of the file instead`);
    if (mcp && n.mcp !== 'all') for (const m of n.mcp) if (!mcp.some(s => m === s || m.startsWith(s + '__'))) warn(`${at}: mcp "${m}" is not a server in mcp.json (fine if it starts later)`);
  }
  return { team: errors.length ? null : { lead, limits, defaults, agents: A }, errors, warnings };
}

// JSON.parse keeps the last of two equal keys without a word, so an agent block that was pasted and not renamed would silently replace the first one: find the repeated keys in the text (valid JSON), as paths such as agents.engineer.
function dupKeys(text) {
  const dups = [], stack = [], colon = /\s*:/y; let key = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1); colon.lastIndex = j + 1;
      if (top?.keys && colon.test(text)) { key = JSON.parse(text.slice(i, j + 1)); if (top.keys.has(key)) dups.push([...top.path, key].join('.')); else top.keys.add(key); }
      i = j;
    } else if (c === '{' || c === '[') { const top = stack.at(-1); stack.push({ keys: c === '{' ? new Set() : null, path: top ? [...top.path, ...(top.keys ? [key] : [])] : [] }); }
    else if (c === '}' || c === ']') stack.pop();
  }
  return dups;
}

// The text of a team.json: check() plus what only the text shows (JSON syntax, repeated keys).
function read(text, ctx) {
  text = text.replace(/^\uFEFF/, '');   // without a BOM, which Windows PowerShell 5.1 writes with -Encoding utf8
  let cfg; try { cfg = JSON.parse(text); } catch (e) { return { team: null, errors: ['not valid JSON: ' + e.message], warnings: [] }; }
  const r = check(cfg, ctx), dups = dupKeys(text);
  if (dups.length) { r.errors.unshift(...dups.map(k => `${k} appears twice: JSON would silently keep only the last one`)); r.team = null; }
  return r;
}

// Reads the team file; on the first start (no file) it is copied from the example, so editing it never dirties the working tree. Throws one error naming every problem.
function load(file, { example, ...ctx }) {
  let created = false;
  if (!fs.existsSync(file)) {
    try { fs.copyFileSync(example, file, fs.constants.COPYFILE_EXCL); created = true; }
    catch (e) { if (e.code !== 'EEXIST') throw new Error(`${file} is missing and could not be created from ${example}: ${e.message}`); }
  }
  const r = read(fs.readFileSync(file, 'utf8'), ctx);
  if (!r.team) throw new Error(`${file} is not valid:\n` + r.errors.map(e => '  - ' + e).join('\n'));
  return { team: r.team, warnings: r.warnings, created };
}

const canContact = (team, from, to) => !!team.agents[from]?.can_contact.includes(to);

// What an agent is told about the team around it (nothing for a team of one). Whom it can contact, and how, only if it has the send_message tool (messaging). The rules of reporting come with it, because they are the same for every team
// and a new agent should not need a prompt to follow them: a teammate sends one report when its task is done and stops, and whoever delegates waits for all its reports before it answers.
function roster(team, id, { messaging = false } = {}) {
  const me = team.agents[id];
  if (!me || Object.keys(team.agents).length < 2) return '';
  const boss = me.reports_to, ref = x => { const a = team.agents[x]; return `${x} (${a.name}: ${a.role.replace(/\.$/, '')})`; };
  const delegates = me.can_contact.some(x => team.agents[x].reports_to === id);
  return [boss ? `You report to ${ref(boss)}.` : 'You lead the team.',
    messaging && me.can_contact.length && `You can contact: ${me.can_contact.map(x => x === boss ? `${x} (your boss)` : ref(x)).join(', ')}. Contact them with send_message. It is asynchronous: end your turn instead of waiting, and the reply arrives later as an automatic message.`,
    messaging && boss && me.can_contact.includes(boss) && `When your task is done, report to ${boss} with one send_message: the result first, then the evidence, then the absolute path of any file you made. Then stop, without checking again or adding anything: your final reply in this conversation is not a report. Do not message to acknowledge a task or to tell how it is going.`,
    messaging && delegates && `Each teammate who reports to you sends one report when its task is done. ${boss ? `Report to ${boss}` : 'Answer the user'} only when all the reports you wait for are in; until then say, in a few words, only what you still wait for (not the results so far), and end your turn. Do not ask a teammate how it is going, and never guess a result. A report that comes after you have ${boss ? 'reported' : 'answered'} and changes nothing needs no reply: end your turn without a word.`,
  ].filter(Boolean).join(' ');
}

// The config the server runs with; set once at startup.
let current = null;
const get = () => current, set = team => (current = team), agent = id => current?.agents[id] ?? null;

module.exports = { check, read, load, canContact, roster, get, set, agent, LIMITS, COMPACT, COMPACT_MIN, RESERVED, FIELDS };
