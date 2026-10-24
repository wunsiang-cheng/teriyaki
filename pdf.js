// PDF text for the read_file tool, with no PDF library. Objects are found by scanning the file for "N G obj", so damaged files, incremental updates and object streams all work.
// Then each wanted page is read the way a viewer draws it: which font, where each glyph lands, and what Unicode each code stands for.
const zlib = require('zlib');
const MAX_STREAM = 64 << 20, MAX_INFLATED = 512 << 20;   // inflated bytes of one stream, and of all the streams of one file

const bad = m => { throw Object.assign(new Error(m), { bad: true }); };   // a refusal with a message fit for the model; any other error means a damaged file
const tick = signal => { signal?.throwIfAborted(); return new Promise(r => setImmediate(r)); };   // lets the server serve others during a big file, and is where an abort lands

// PDF objects: numbers, booleans and null are themselves, a name is '/Name', a dictionary has no prototype, and a keyword (an operator, in a content stream) is a plain string.
class Str { constructor(v) { this.v = v; } }   // a string, as its bytes in a latin1 string
class Ref { constructor(n) { this.n = n; } }   // N G R
const isDict = v => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === null;
const SP = c => c === 32 || c === 10 || c === 13 || c === 9 || c === 0 || c === 12;
const DL = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
// Reads the objects of s one at a time from i, undefined at the end; refs says whether "12 0 R" is a reference (not in content streams).
function parser(s, i = 0, refs = true) {
  const n = s.length;
  const skip = () => { while (i < n) { const c = s.charCodeAt(i); if (SP(c)) i++; else if (c === 37) { while (i < n && s.charCodeAt(i) !== 10 && s.charCodeAt(i) !== 13) i++; } else return; } };
  const next = () => {
    skip(); if (i >= n) return;
    const c = s.charCodeAt(i);
    if (c === 47) {
      let j = ++i; while (j < n && !SP(s.charCodeAt(j)) && !DL(s.charCodeAt(j))) j++;
      const name = s.slice(i, j); i = j;
      return '/' + (name.includes('#') ? name.replace(/#([\da-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))) : name);
    }
    if (c === 40) {
      let depth = 1, o = ''; i++;
      while (i < n && depth) {
        const ch = s[i++];
        if (ch === '\\') {
          const e = s[i++];
          if (e === 'n') o += '\n'; else if (e === 'r') o += '\r'; else if (e === 't') o += '\t'; else if (e === 'b') o += '\b'; else if (e === 'f') o += '\f';
          else if (e >= '0' && e <= '7') { let v = +e; for (let k = 0; k < 2 && s[i] >= '0' && s[i] <= '7'; k++) v = v * 8 + +s[i++]; o += String.fromCharCode(v & 255); }
          else if (e === '\r') { if (s[i] === '\n') i++; } else if (e !== '\n') o += e ?? '';
        } else if (ch === '(') { depth++; o += ch; } else if (ch === ')') { if (--depth) o += ch; } else o += ch;
      }
      return new Str(o);
    }
    if (c === 60) {
      if (s.charCodeAt(i + 1) === 60) {
        i += 2; const d = Object.create(null);
        for (;;) {
          const k = next();
          if (k === undefined || k === '>>') return d;
          if (k === 'endobj' || k === 'stream') { i -= k.length; return d; }   // a dictionary left open
          if (typeof k === 'string' && k[0] === '/') { const v = next(); if (v === undefined || v === '>>') return d; d[k.slice(1)] = v; }
        }
      }
      let j = s.indexOf('>', i); if (j < 0) j = n;
      const hex = s.slice(i + 1, j).replace(/[^\da-f]/gi, ''); i = j + 1;
      let o = ''; for (let k = 0; k < hex.length; k += 2) o += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      return new Str(o);
    }
    if (c === 91) { i++; const a = []; for (;;) { const v = next(); if (v === undefined || v === ']') return a; a.push(v); } }
    if (c === 62) { if (s.charCodeAt(i + 1) === 62) { i += 2; return '>>'; } i++; return '>'; }
    if (c === 93 || c === 41 || c === 123 || c === 125) { i++; return String.fromCharCode(c); }
    let j = i; while (j < n && !SP(s.charCodeAt(j)) && !DL(s.charCodeAt(j))) j++;
    const w = s.slice(i, j); i = j;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) {
      const v = parseFloat(w);
      if (refs && /^\d+$/.test(w)) {
        const m = /^[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+R(?![^\0\t\n\f\r ()<>[\]{}/%])/.exec(s.slice(i, i + 30));
        if (m) { i += m[0].length; return new Ref(v); }
      }
      return v;
    }
    return w === 'true' ? true : w === 'false' ? false : w === 'null' ? null : w;
  };
  return { next, get pos() { return i; }, set pos(v) { i = v; } };
}

// Stream filters: Flate (what is there when it is cut short), ASCII85 and ASCIIHex, and the PNG predictors that go with Flate. Pictures use others; they hold no text.
const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
const predict = (b, p) => {
  if (!isDict(p) || !(p.Predictor >= 10)) return b;
  const colors = p.Colors || 1, bpc = p.BitsPerComponent || 8, cols = p.Columns || 1, bpp = Math.max(1, colors * bpc >> 3), row = colors * bpc * cols + 7 >> 3, rows = Math.floor(b.length / (row + 1)), out = Buffer.alloc(rows * row);
  for (let r = 0; r < rows; r++) {
    const f = b[r * (row + 1)], o = r * row, src = r * (row + 1) + 1;
    for (let x = 0; x < row; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, up = r ? out[o - row + x] : 0, c = r && x >= bpp ? out[o - row + x - bpp] : 0, v = b[src + x];
      out[o + x] = (f === 1 ? v + a : f === 2 ? v + up : f === 3 ? v + ((a + up) >> 1) : f === 4 ? v + paeth(a, up, c) : v) & 255;
    }
  }
  return out;
};
const a85 = b => {
  const s = b.toString('latin1').replace(/^\s*<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s+/g, ''), out = []; let g = [];
  const put = (n, k) => out.push(...[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, k));
  for (const ch of s) {
    if (ch === 'z' && !g.length) { out.push(0, 0, 0, 0); continue; }
    const v = ch.charCodeAt(0) - 33; if (v < 0 || v > 84) continue;
    g.push(v); if (g.length === 5) { put(g.reduce((n, d) => n * 85 + d, 0), 4); g = []; }
  }
  if (g.length > 1) { const k = g.length; while (g.length < 5) g.push(84); put(g.reduce((n, d) => n * 85 + d, 0), k - 1); }
  return Buffer.from(out);
};

// ToUnicode CMaps: which text each font code stands for, and (codespace) how many bytes a code takes.
const u16 = (h, k = 0) => { if (!h) return ''; const u = h.length <= 2 ? [parseInt(h, 16)] : h.match(/.{1,4}/g).map(x => parseInt(x, 16)); u[u.length - 1] += k; return String.fromCharCode(...u); };
function cmap(text) {
  const map = new Map(), lens = new Set();
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const r of m[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>/gi)) lens.add(r[1].length >> 1);
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const r of m[1].matchAll(/<([\da-f]+)>\s*<([\da-f]*)>/gi)) map.set(parseInt(r[1], 16), u16(r[2]));
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const r of m[1].matchAll(/<([\da-f]+)>\s*<([\da-f]+)>\s*(?:<([\da-f]*)>|\[([^\]]*)\])/gi)) {
    const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16);
    if (r[4] !== undefined) [...r[4].matchAll(/<([\da-f]*)>/gi)].forEach((x, k) => map.set(lo + k, u16(x[1])));
    else for (let c = lo; c <= hi && c - lo < 65536; c++) map.set(c, u16(r[3], c - lo));
  }
  return { map, lens };
}

// Glyph names to text, for simple fonts that list their own encoding (/Differences): the standard Latin names, ligatures, uniXXXX and uXXXX.
const NAMES = new Map(), cp = n => n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
{
  const win = new TextDecoder('windows-1252'), put = (list, from) => list.split(' ').forEach((n, k) => { if (n !== '.' && !NAMES.has(n)) NAMES.set(n, from + k < 128 ? String.fromCharCode(from + k) : win.decode(Uint8Array.of(from + k))); });
  put('space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at', 32);
  put('bracketleft backslash bracketright asciicircum underscore grave', 91);
  put('braceleft bar braceright asciitilde', 123);
  put('Euro . quotesinglbase florin quotedblbase ellipsis dagger daggerdbl circumflex perthousand Scaron guilsinglleft OE . Zcaron . . quoteleft quoteright quotedblleft quotedblright bullet endash emdash tilde trademark scaron guilsinglright oe . zcaron Ydieresis', 128);
  put('space exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot hyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown'
    + ' Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls'
    + ' agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis', 160);
  for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz') NAMES.set(c, c);
  for (const [k, v] of Object.entries({ fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', minus: '−', fraction: '⁄', dotlessi: 'ı', Lslash: 'Ł', lslash: 'ł', nbspace: ' ', nonbreakingspace: ' ', emspace: ' ', enspace: ' ', thinspace: ' ', softhyphen: '' })) NAMES.set(k, v);
}
const glyph = name => name.split('.')[0].split('_').map(p => NAMES.get(p) ?? (/^uni(?:[\da-f]{4})+$/i.test(p) ? p.slice(3).match(/..../g).map(h => String.fromCharCode(parseInt(h, 16))).join('') : /^u[\da-f]{4,6}$/i.test(p) ? cp(parseInt(p.slice(1), 16)) : '')).join('');
const LIG = ['ff', 'fi', 'fl', 'ffi', 'ffl', 'st', 'st'];   // U+FB00 to U+FB06
let CODES;   // the 256 codes of WinAnsi, which MacRoman and the unnamed standard encodings are close enough to for plain text
const codes = mac => { if (!CODES) { const w = new TextDecoder('windows-1252'); CODES = Array.from({ length: 256 }, (_, c) => c < 32 || c === 127 ? '' : c < 127 ? String.fromCharCode(c) : w.decode(Uint8Array.of(c))); } if (mac) try { const m = new TextDecoder('macintosh'); return Array.from({ length: 256 }, (_, c) => c < 128 ? CODES[c] : m.decode(Uint8Array.of(c))); } catch {} return CODES.slice(); };

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const num = x => typeof x === 'number' && isFinite(x) ? x : 0;

// A PDF file, indexed: its pages in order, and the text of any one of them.
function open(buf) {
  const s = buf.toString('latin1'), objs = new Map(), roots = []; let inflated = 0;   // number -> {v, from?, to?}: the value, and where its stream is
  const res = x => { for (let k = 0; x instanceof Ref && k < 8; k++) x = objs.get(x.n)?.v; return x instanceof Ref ? undefined : x; };
  const rec = x => x instanceof Ref ? objs.get(x.n) : x === undefined ? undefined : { v: x };
  const inflate = b => { try { const o = zlib.inflateSync(b, { maxOutputLength: MAX_STREAM, finishFlush: zlib.constants.Z_SYNC_FLUSH }); if ((inflated += o.length) > MAX_INFLATED) bad(`the file inflates to over ${MAX_INFLATED >> 20} MB`); return o; } catch (e) { if (e.bad) throw e; return Buffer.alloc(0); } };
  const bytes = o => {   // the decoded stream of a record
    if (o?.from === undefined) return Buffer.alloc(0);
    let b = buf.subarray(o.from, o.to);
    const f = res(o.v.Filter), p = res(o.v.DecodeParms ?? o.v.DP), fl = f === undefined ? [] : Array.isArray(f) ? f.map(res) : [f], pl = Array.isArray(p) ? p.map(res) : [p];
    for (const [k, name] of fl.entries()) {
      if (name === '/FlateDecode' || name === '/Fl') b = predict(inflate(b), res(pl[k]));
      else if (name === '/ASCII85Decode' || name === '/A85') b = a85(b);
      else if (name === '/ASCIIHexDecode' || name === '/AHx') b = Buffer.from(b.toString('latin1').replace(/>[\s\S]*$/, '').replace(/[^\da-f]/gi, ''), 'hex');
      else return Buffer.alloc(0);
    }
    return b;
  };
  const expand = o => {   // the objects packed in an object stream
    const b = bytes(o).toString('latin1'), n = Math.min(num(res(o.v.N)), 100000), first = num(res(o.v.First)), h = parser(b, 0, false), pairs = [];
    for (let k = 0; k < n; k++) { const a = h.next(), c = h.next(); if (typeof a !== 'number' || typeof c !== 'number') break; pairs.push([a, c]); }
    for (const [a, c] of pairs) objs.set(a, { v: parser(b, first + c).next() });
  };

  const re = /(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj\b/g;   // a later definition of a number replaces an earlier one, as in an incremental update
  for (let m; (m = re.exec(s));) {
    const p = parser(s, re.lastIndex), v = p.next(); let o = { v };
    if (isDict(v) && p.next() === 'stream') {
      let from = p.pos; if (s[from] === '\r' && s[from + 1] === '\n') from += 2; else if (s[from] === '\n' || s[from] === '\r') from++;
      let to = typeof v.Length === 'number' && v.Length >= 0 && /^[\r\n ]*endstream/.test(s.slice(from + v.Length, from + v.Length + 12)) ? from + v.Length : -1;
      if (to < 0) { to = s.indexOf('endstream', from); if (to < 0) to = s.length; else { if (s[to - 1] === '\n') to--; if (s[to - 1] === '\r') to--; } }
      o = { v, from, to }; re.lastIndex = to;   // the bytes of a stream are not scanned for objects
    }
    objs.set(+m[1], o);
    if (isDict(v)) { if (v.Type === '/ObjStm' && o.from !== undefined) expand(o); else if (v.Type === '/XRef') roots.push({ at: m.index, root: v.Root, enc: v.Encrypt }); }
  }
  for (const m of s.matchAll(/\btrailer\b/g)) { const d = parser(s, m.index + 7).next(); if (isDict(d)) roots.push({ at: m.index, root: d.Root, enc: d.Encrypt }); }
  if (roots.some(r => r.enc !== undefined)) bad('this PDF is encrypted (password protected), which read_file cannot open');

  let cat = res(roots.filter(r => r.root).sort((a, b) => a.at - b.at).at(-1)?.root);   // the catalog the last trailer names, else the last one found
  if (!isDict(cat) || !cat.Pages) { cat = undefined; for (const o of objs.values()) if (isDict(o.v) && o.v.Type === '/Catalog') cat = o.v; }
  const pages = [], seen = new Set();
  const walk = (x, inherited, depth = 0) => {   // the page tree, in order; Resources are inherited
    const d = res(x); if (!isDict(d) || seen.has(d) || depth > 64) return; seen.add(d);
    const rs = d.Resources ?? inherited, kids = res(d.Kids);
    if (Array.isArray(kids)) for (const k of kids) walk(k, rs, depth + 1); else pages.push({ d, rs });
  };
  if (cat) walk(cat.Pages);
  if (!pages.length) for (const o of objs.values()) if (isDict(o.v) && o.v.Type === '/Page') pages.push({ d: o.v, rs: o.v.Resources });   // a broken page tree
  if (!pages.length) bad('no pages found: this does not look like a readable PDF');

  // A font as the interpreter needs it: how many bytes a code takes, and for a code its text (undefined when it cannot be known) and advance width in 1/1000 em.
  const fonts = new Map();
  const loadFont = fd => {
    const comp = fd.Subtype === '/Type0', df = comp ? res(res(fd.DescendantFonts)?.[0]) : null, tu = rec(fd.ToUnicode), uni = tu?.from !== undefined ? cmap(bytes(tu).toString('latin1')) : null;
    const e = res(fd.Encoding), memo = new Map(); let len = 1, ucs = false, widths, dw = 1000, first = 0, missing = 0, scale = 1, table, guess = false;
    if (comp) {
      const ec = typeof e === 'string' ? null : rec(fd.Encoding), lens = ec?.from !== undefined ? cmap(bytes(ec).toString('latin1')).lens : uni?.lens;
      len = typeof e === 'string' || !lens || lens.size !== 1 ? 2 : [...lens][0];
      ucs = typeof e === 'string' && /^\/Uni.*-(UCS2|UTF16)-[HV]$/.test(e);   // codes that are UCS-2 themselves
      dw = num(res(df?.DW) ?? 1000); widths = new Map();
      const W = res(df?.W) || [];
      for (let k = 0; k < W.length;) {
        const c = num(res(W[k])), x = res(W[k + 1]);
        if (Array.isArray(x)) { x.forEach((w, j) => widths.set(c + j, num(res(w)))); k += 2; } else { const w = num(res(W[k + 2])); for (let g = c; g <= num(x) && g - c < 65536; g++) widths.set(g, w); k += 3; }
      }
    } else {
      const wa = res(fd.Widths); widths = Array.isArray(wa) ? wa.map(x => num(res(x))) : null; guess = !widths;
      first = num(res(fd.FirstChar)); missing = num(res(res(fd.FontDescriptor)?.MissingWidth));
      if (fd.Subtype === '/Type3') scale = num(res(fd.FontMatrix)?.[0] ?? 0.001) * 1000;
      const base = typeof e === 'string' ? e : res(e?.BaseEncoding); table = codes(base === '/MacRomanEncoding');
      const diff = isDict(e) ? res(e.Differences) : null;
      if (Array.isArray(diff)) { let c = 0; for (const x of diff) { const v = res(x); if (typeof v === 'number') c = v; else if (typeof v === 'string') table[c++] = glyph(v.slice(1)); } }
    }
    return { len, guess, glyph(code) {
      let g = memo.get(code); if (g) return g;
      const t = uni?.map.get(code) ?? (comp ? ucs ? String.fromCharCode(code) : undefined : table[code]);
      const w = comp ? widths.get(code) ?? dw : widths && code >= first && code - first < widths.length ? widths[code - first] * scale : missing || 500;
      memo.set(code, g = [t, w]); return g;
    } };
  };

  // One page: the content stream is run as a viewer would, and each glyph is placed by where it lands (in device space, after the text matrix and the CTM).
  // A glyph that starts on a new line (its baseline moved by over half a font size) begins a new line, one a bit to the right of where the last ended is a word, a wide gap is a column.
  // Chrome puts every glyph in its own Td and the spaces in as glyphs, so gaps are judged against the real widths. A font with no widths (the standard 14) cannot be judged: a string to the right of the last one is a new word.
  const text = ({ d, rs }) => {
    const lines = [], L = { on: false, x: 0, y: 0, sz: 0, sx: 0, guess: false }, stack = [], active = new Set(); let cur = '', pitch = 0, lost = 0, pics = 0, R = rs;
    const st = { ctm: [1, 0, 0, 1, 0, 0], f: null, size: 0, tc: 0, tw: 0, th: 1, tl: 0, tm: [1, 0, 0, 1, 0, 0], tlm: [1, 0, 0, 1, 0, 0] };
    const flush = () => { const t = cur.trimEnd(); if (t) lines.push(t); cur = ''; };
    const put = (t, x, y, sz, guess) => {   // the first glyph of a string
      if (L.on) {
        const big = Math.max(sz, L.sz), dy = Math.abs(y - L.y), dx = x - L.x;
        if (dy > 0.55 * big) { flush(); if (pitch && dy > 1.6 * pitch) lines.push(''); pitch = dy; }
        else if (dx < -big) flush();
        else if (L.guess || guess ? x > L.sx + 0.05 * big : dx > 0.15 * big) { const c = cur.at(-1); if (c && c !== ' ' && c !== '\t' && t[0] !== ' ') cur += dx > 1.2 * big && !L.guess && !guess ? '\t' : ' '; }
      }
      cur += t;
    };
    const show = str => {
      const f = st.f; if (!f || !(str instanceof Str) || !st.size) return;
      const s = str.v; let first = true;
      for (let k = 0; k < s.length; k += f.len) {
        const code = f.len === 2 ? s.charCodeAt(k) << 8 | (s.charCodeAt(k + 1) || 0) : s.charCodeAt(k), [t, w] = f.glyph(code), m = st.tm, c = st.ctm;
        const x = m[4] * c[0] + m[5] * c[2] + c[4], y = m[4] * c[1] + m[5] * c[3] + c[5], sz = Math.abs(st.size) * Math.hypot(m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3]);
        if (t === undefined) lost++;
        if (first) { put(t ?? '', x, y, sz, f.guess); L.sx = x; first = false; } else cur += t ?? '';
        const adv = (w / 1000 * st.size + st.tc + (f.len === 1 && code === 32 ? st.tw : 0)) * st.th;
        m[4] += adv * m[0]; m[5] += adv * m[1];
        L.on = true; L.x = m[4] * c[0] + m[5] * c[2] + c[4]; L.y = y; L.sz = sz; L.guess = f.guess;
      }
    };
    const move = (tx, ty) => { st.tlm = mul([1, 0, 0, 1, tx, ty], st.tlm); st.tm = st.tlm.slice(); };
    const mat = m => { const a = res(m); return Array.isArray(a) && a.length >= 6 ? a.slice(0, 6).map(x => num(res(x))) : [1, 0, 0, 1, 0, 0]; };
    const xobj = (name, depth) => {
      const o = rec(res(res(R)?.XObject)?.[name.slice(1)]), x = o?.v;
      if (!isDict(x)) return;
      if (x.Subtype === '/Image') pics++;
      else if (x.Subtype === '/Form' && o.from !== undefined && depth < 8 && !active.has(o)) {   // a form is run like q ... Q with its own matrix and resources
        active.add(o); const saved = { ...st, ctm: st.ctm.slice() }, saveR = R;
        st.ctm = mul(mat(x.Matrix), st.ctm); R = x.Resources ?? R;
        run(bytes(o).toString('latin1'), depth + 1);
        Object.assign(st, saved); R = saveR; active.delete(o);
      }
    };
    const run = (cs, depth) => {
      const p = parser(cs, 0, false); let a = [];
      for (let t; (t = p.next()) !== undefined;) {
        if (typeof t !== 'string' || t[0] === '/') { if (a.length < 4096) a.push(t); continue; }
        switch (t) {
          case 'q': stack.push({ ...st, ctm: st.ctm.slice() }); break;
          case 'Q': if (stack.length) Object.assign(st, stack.pop()); break;
          case 'cm': st.ctm = mul(a.slice(0, 6).map(num), st.ctm); break;
          case 'BT': st.tm = [1, 0, 0, 1, 0, 0]; st.tlm = st.tm.slice(); break;
          case 'Tf': { const fd = res(res(res(R)?.Font)?.[String(a[0]).slice(1)]); st.f = isDict(fd) ? (fonts.get(fd) || fonts.set(fd, loadFont(fd)).get(fd)) : null; st.size = num(a[1]); break; }
          case 'Tc': st.tc = num(a[0]); break;
          case 'Tw': st.tw = num(a[0]); break;
          case 'Tz': st.th = num(a[0]) / 100; break;
          case 'TL': st.tl = num(a[0]); break;
          case 'Td': move(num(a[0]), num(a[1])); break;
          case 'TD': st.tl = -num(a[1]); move(num(a[0]), num(a[1])); break;
          case 'Tm': st.tm = a.slice(0, 6).map(num); st.tlm = st.tm.slice(); break;
          case 'T*': move(0, -st.tl); break;
          case 'Tj': show(a[0]); break;
          case "'": move(0, -st.tl); show(a[0]); break;
          case '"': st.tw = num(a[0]); st.tc = num(a[1]); move(0, -st.tl); show(a[2]); break;
          case 'TJ': for (const x of Array.isArray(a[0]) ? a[0] : []) if (typeof x === 'number') { const adv = -x / 1000 * st.size * st.th; st.tm[4] += adv * st.tm[0]; st.tm[5] += adv * st.tm[1]; } else show(x); break;
          case 'Do': xobj(String(a[0]), depth); break;
          case 'ID': { const e = /[\0\t\n\f\r ]EI(?![^\0\t\n\f\r ])/g; e.lastIndex = p.pos + 1; const r = e.exec(cs); p.pos = r ? r.index + r[0].length : cs.length; pics++; break; }   // an inline image: skip its bytes
        }
        a = [];
      }
    };
    const c = res(d.Contents);
    run((Array.isArray(c) ? c : [d.Contents]).map(x => bytes(rec(x)).toString('latin1')).join('\n'), 0); flush();
    const out = lines.join('\n').replace(/[ﬀ-ﬆ]/g, ch => LIG[ch.charCodeAt(0) - 0xfb00]).replace(/ /g, ' ').replace(/­/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return { text: out, pics, lost };
  };
  return { pages, text };
}

// {count, parts} for the wanted pages (want(n), counted from 1), one part per page; why says it when none of them has text.
async function pdfText(buf, { want = () => true, signal } = {}) {
  const pdf = open(buf), parts = []; let pics = 0, lost = 0;
  const per = [];
  for (const [i, pg] of pdf.pages.entries()) {
    if (!want(i + 1)) continue;
    await tick(signal);
    let r; try { r = pdf.text(pg); } catch (e) { if (e.bad || signal?.aborted) throw e; r = { text: '', pics: 0, lost: 0 }; }   // one damaged page should not lose the others
    parts.push({ label: `page ${i + 1}`, text: r.text }); per.push(r); pics += r.pics; lost += r.lost;
  }
  const count = pdf.pages.length;
  if (parts.some(p => p.text)) { for (const [k, p] of parts.entries()) if (!p.text) p.text = per[k].lost ? '(the text on this page uses a font that cannot be decoded)' : per[k].pics ? `(no text on this page; it has ${per[k].pics} picture${per[k].pics > 1 ? 's' : ''})` : '(no text on this page)'; return { count, parts }; }
  return { count, parts, why: !parts.length ? undefined : lost ? 'the text in this PDF uses embedded fonts without a Unicode table, so it cannot be decoded' : pics ? `no text on the page(s) read, only ${pics} picture${pics > 1 ? 's' : ''}: this looks like a scan, which read_file cannot read` : 'no text found on the page(s) read' };
}

module.exports = { pdfText };
