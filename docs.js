// Text out of files, for the read_file tool: Word, Excel and PowerPoint documents (zip archives of XML, read directly), PDF (pdf.js) and plain text. No dependencies: zlib does the inflating.
const zlib = require('zlib'), path = require('path'), { pdfText } = require('./pdf');
const MAX_ENTRY = 64 << 20, MAX_TOTAL = 256 << 20, MAX_TEXT = 20e6, ROWS = 20000;   // inflated bytes of one zip entry, and of all entries read from one file; characters of one sheet; spreadsheet rows between two yields to the event loop

const bad = m => { throw Object.assign(new Error(m), { bad: true }); };   // a refusal with a message fit for the model; any other error means a damaged file
const tick = signal => { signal?.throwIfAborted(); return new Promise(r => setImmediate(r)); };   // lets the server serve others during a big file, and is where an abort lands

// A zip archive: the central directory at its end lists the entries, and each is inflated when asked for, within a size budget (zip bombs).
function zip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && e >= buf.length - 65557 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0 || buf.readUInt32LE(e) !== 0x06054b50) bad('not a readable zip archive');
  const n = buf.readUInt16LE(e + 10), files = new Map(); let p = buf.readUInt32LE(e + 16), left = MAX_TOTAL;
  if (n === 0xffff || p === 0xffffffff) bad('zip64 archives are not supported');
  for (let i = 0; i < n && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const nl = buf.readUInt16LE(p + 28);
    files.set(buf.toString('utf8', p + 46, p + 46 + nl), { flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), at: buf.readUInt32LE(p + 42) });
    p += 46 + nl + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { has: name => files.has(name), names: () => [...files.keys()], text(name) {   // an entry's text, or undefined
    const f = files.get(name); if (!f) return;
    if (f.flags & 1) bad(`${name} is encrypted`);
    if (f.size > MAX_ENTRY) bad(`${name} is over ${MAX_ENTRY >> 20} MB inflated`);
    if (f.method !== 0 && f.method !== 8) bad(`${name} uses an unsupported zip compression`);
    const s = f.at + 30 + buf.readUInt16LE(f.at + 26) + buf.readUInt16LE(f.at + 28), raw = buf.subarray(s, s + f.csize);
    let out; try { out = f.method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: MAX_ENTRY }); } catch { bad(`${name} is damaged or over ${MAX_ENTRY >> 20} MB inflated`); }
    if ((left -= out.length) < 0) bad(`the file inflates to over ${MAX_TOTAL >> 20} MB`);
    return out.toString('utf8');
  } };
}

// XML is read with regular expressions: no parser is needed to pull the text out of these formats.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }, cp = n => n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
const unesc = s => s.includes('&') ? s.replace(/&(?:#(\d+)|#x([\da-f]+)|(\w+));/gi, (m, d, h, w) => d ? cp(+d) : h ? cp(parseInt(h, 16)) : Object.hasOwn(ENT, w) ? ENT[w] : m) : s;
const attrs = new Map(), attr = (tag, name) => { let r = attrs.get(name); if (!r) attrs.set(name, r = new RegExp(`(?:^|\\s)${name}="([^"]*)"`)); return r.exec(tag)?.[1]; };
// The <tag ...>...</tag> blocks of an XML text (self-closing ones too) as [attributes, inner, position]. One pass with indexOf, so a damaged or hostile file with unclosed tags cannot cost a rescan per tag.
function* blocks(xml, tag) {
  const open = '<' + tag, close = `</${tag}>`; let i = 0;
  for (;;) {
    i = xml.indexOf(open, i); if (i < 0) return;
    const s = i + open.length, c = xml[s];
    if (c !== ' ' && c !== '>' && c !== '/' && c !== '\n' && c !== '\r' && c !== '\t') { i = s; continue; }   // <row, but not <rowBreaks
    const e = xml.indexOf('>', s); if (e < 0) return;
    if (xml[e - 1] === '/') { yield [xml.slice(s, e - 1), '', i]; i = e + 1; continue; }
    const end = xml.indexOf(close, e); if (end < 0) return;
    yield [xml.slice(s, e), xml.slice(e + 1, end), i]; i = end + close.length;
  }
}
const strip = (s, a, b) => { let o = '', i = 0; for (;;) { const x = s.indexOf(a, i), y = x < 0 ? -1 : s.indexOf(b, x); if (y < 0) return o + s.slice(i); o += s.slice(i, x); i = y + b.length; } };   // s without the stretches from a to b
// Office files name their parts through relationships: where a part's target is, counted from the part that names it.
const abs = (from, to) => to.startsWith('/') ? to.slice(1) : path.posix.join(path.posix.dirname(from), to);
const relations = (z, file) => [...(z.text(path.posix.join(path.posix.dirname(file), '_rels', path.posix.basename(file) + '.rels')) || '').matchAll(/<Relationship\b[^>]*>/g)]
  .map(m => ({ id: attr(m[0], 'Id'), type: attr(m[0], 'Type') || '', to: attr(m[0], 'Target') || '' }));

// Word: paragraphs, lists and tables as lines. Headings get #, list items "- ", table rows "a | b" (a nested table is flattened into its cell). Deleted text is not in <w:t>, so it stays out.
function wordLines(xml) {
  xml = strip(xml, '<mc:Fallback>', '</mc:Fallback>');   // a text box is written twice, as DrawingML and as a VML fallback
  const out = [], stack = []; let p = '', head = '', lvl = 0, list = false, depth = 0, cell = [], row = [];
  const para = () => {
    const s = p.replace(/[ \t\n]+$/, ''), line = s && (head ? head + ' ' : list ? '  '.repeat(lvl) + '- ' : '') + s;
    if (depth) { if (line) cell.push(line.replace(/\s*\n\s*/g, ' ')); } else if (line || out.at(-1)) out.push(line);   // at most one blank line in a row
  };
  const re = /<w:p(?: [^>]*)?>|<w:p\/>|<\/w:p>|<w:pStyle [^>]*?w:val="([^"]*)"|<w:ilvl [^>]*?w:val="(\d+)"|<w:numId [^>]*?w:val="(\d+)"|<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>|<w:noBreakHyphen\/>|<w:tbl>|<\/w:tbl>|<\/w:tc>|<\/w:tr>/g;
  for (let m; (m = re.exec(xml));) {
    const [t, style, il, num, txt] = m;
    if (txt !== undefined) p += unesc(txt);
    else if (style !== undefined) { const h = /^heading ?([1-9])$/i.exec(style)?.[1]; head = h ? '#'.repeat(+h) : /^title$/i.test(style) ? '#' : ''; }
    else if (il !== undefined) lvl = +il;
    else if (num !== undefined) list = num !== '0';   // numId 0 switches numbering off
    else if (t === '<w:tab/>') p += '\t';
    else if (t === '<w:noBreakHyphen/>') p += '-';
    else if (t.startsWith('<w:br') || t === '<w:cr/>') p += '\n';
    else if (t === '<w:tbl>') depth++;
    else if (t === '</w:tbl>') depth = Math.max(0, depth - 1);
    else if (t === '</w:tc>') { if (depth === 1) { row.push(cell.join(' ')); cell = []; } }
    else if (t === '</w:tr>') { if (depth === 1) { if (row.some(Boolean)) out.push(row.join(' | ')); row = []; } }
    else if (t === '</w:p>') { para(); [p, head, lvl, list] = stack.pop() || ['', '', 0, false]; }   // a text box holds paragraphs inside a paragraph
    else if (t.endsWith('/>')) { if (!depth && out.at(-1)) out.push(''); }   // an empty paragraph
    else { stack.push([p, head, lvl, list]); p = ''; head = ''; lvl = 0; list = false; }
  }
  return out.join('\n').trim();
}
// Footnotes, endnotes and comments are paragraphs too: "[id] text" or "[author] text".
const noteList = (xml, tag, author) => [...blocks(xml, 'w:' + tag)].map(([a, b]) => { const t = wordLines(b).replace(/\s*\n\s*/g, ' '); return t && `[${author ? unesc(attr(a, 'w:author') || '?') : attr(a, 'w:id')}] ${t}`; }).filter(Boolean);
function docx(z) {
  let text = wordLines(z.text('word/document.xml'));
  for (const [file, tag, author, title] of [['footnotes', 'footnote', 0, 'Footnotes'], ['endnotes', 'endnote', 0, 'Endnotes'], ['comments', 'comment', 1, 'Comments']]) {
    const xml = z.text(`word/${file}.xml`), l = xml ? noteList(xml, tag, author) : [];
    if (l.length) text += `\n\n${title}:\n` + l.join('\n');
  }
  return { type: 'docx', parts: [{ label: '', text }] };
}

// Excel: each wanted sheet as lines "row<TAB>cell<TAB>cell...", empty cells and rows left out. Strings come from the shared table, dates are told by their number format, and a formula nobody calculated shows as =formula.
const DATE_FMT = id => id >= 14 && id <= 22 || id >= 27 && id <= 36 || id >= 45 && id <= 47 || id >= 50 && id <= 58;   // Excel's built-in date and time formats
const column = ref => { let n = 0; for (const c of /^[A-Za-z]*/.exec(ref)[0].toUpperCase()) n = n * 26 + c.charCodeAt(0) - 64; return n - 1; };
const when = (v, d1904) => {   // a date serial as 2026-10-23, 2026-10-23 14:05:00 or 14:05:00
  const n = Number(v); if (!(n >= 0 && n < 2958466)) return v;
  const iso = new Date(Math.round((n - (d1904 ? 24107 : 25569)) * 86400) * 1000).toISOString();
  return Math.abs(n - Math.round(n)) < 1e-9 ? iso.slice(0, 10) : n < 1 ? iso.slice(11, 19) : iso.slice(0, 10) + ' ' + iso.slice(11, 19);
};
async function xlsx(z, want, signal) {
  const book = 'xl/workbook.xml', wb = z.text(book), rels = new Map(relations(z, book).map(r => [r.id, abs(book, r.to)])), d1904 = /<workbookPr\b[^>]*date1904="(?:1|true)"/.test(wb);
  const sheets = [...wb.matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: unesc(attr(m[0], 'name') || ''), hidden: /hidden/i.test(attr(m[0], 'state') || ''), file: rels.get(attr(m[0], 'r:id')) }));
  const ss = []; for (const [, b] of blocks(z.text('xl/sharedStrings.xml') || '', 'si')) ss.push(unesc([...b.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map(t => t[1]).join('')));
  const sx = z.text('xl/styles.xml') || '', fmts = new Map([...sx.matchAll(/<numFmt\b[^>]*>/g)].map(m => [+attr(m[0], 'numFmtId'), attr(m[0], 'formatCode') || '']));
  const isDate = (sx.match(/<cellXfs\b[\s\S]*?<\/cellXfs>/)?.[0].match(/<xf\b[^>]*>/g) || []).map(t => { const id = +(attr(t, 'numFmtId') || 0); return DATE_FMT(id) || fmts.has(id) && /[dmyhs]/i.test(unesc(fmts.get(id)).replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')); });   // by cell style index
  const parts = [];
  for (const [i, sh] of sheets.entries()) {
    if (!want(i + 1)) continue;
    await tick(signal);
    const xml = sh.file && z.text(sh.file) || '', lines = []; let r = 0, chars = 0, n = 0;
    for (const [ra, rb] of blocks(xml, 'row')) {
      r = +(attr(ra, 'r') || r + 1);
      const cells = []; let c = -1;
      for (const [ca, cb] of blocks(rb, 'c')) {
        const ref = attr(ca, 'r'), t = attr(ca, 't'), v = /<v>([^<]*)<\/v>/.exec(cb)?.[1];
        c = ref ? column(ref) : c + 1;
        const s = t === 's' ? ss[+v] ?? '' : t === 'inlineStr' ? unesc([...cb.matchAll(/<t(?: [^>]*)?>([^<]*)<\/t>/g)].map(x => x[1]).join(''))
          : v === undefined ? (f => f ? '=' + unesc(f) : '')(/<f(?: [^>]*)?>([^<]+)<\/f>/.exec(cb)?.[1])
          : t === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : t === 'str' || t === 'e' ? unesc(v)
          : isDate[+(attr(ca, 's') || 0)] && (!t || t === 'n') ? when(v, d1904) : v;
        if (s) cells[c] = s.replace(/[\t\r\n]+/g, ' ');
      }
      if (cells.length) {
        const line = r + '\t' + cells.join('\t'); lines.push(line);
        if ((chars += line.length) > MAX_TEXT) { lines.push(`[sheet cut after ${MAX_TEXT / 1e6}M characters]`); break; }
      }
      if (++n % ROWS === 0) await tick(signal);
    }
    parts.push({ label: `sheet ${i + 1}: ${sh.name}${sh.hidden ? ' (hidden)' : ''}`, text: lines.join('\n') });
  }
  return { type: 'xlsx', unit: 'sheets', count: sheets.length, sheets: sheets.map(s => s.name), parts };
}

// PowerPoint: each wanted slide's shapes and tables in order as lines, titles as #, then its speaker notes. Slides come in presentation order, which is not their file order.
const runs = xml => [...xml.matchAll(/<a:t(?: [^>]*)?>([^<]*)<\/a:t>|<a:br\b[^>]*\/>/g)].map(m => m[1] === undefined ? '\n' : unesc(m[1])).join('');
function slideLines(xml, notes) {
  xml = strip(xml, '<mc:Fallback>', '</mc:Fallback>');
  const out = [];
  for (const [, b] of [...blocks(xml, 'p:sp'), ...blocks(xml, 'p:graphicFrame')].sort((x, y) => x[2] - y[2])) {
    const ph = /<p:ph\b[^>]*>/.exec(b)?.[0], type = ph ? attr(ph, 'type') || 'body' : '';
    if (notes ? type !== 'body' : /^(sldNum|ftr|dt|hdr)$/.test(type)) continue;   // footers, dates and slide numbers are not content; in the notes page only the notes
    if (b.includes('<a:tbl>')) for (const [, tr] of blocks(b, 'a:tr')) out.push([...blocks(tr, 'a:tc')].map(([, tc]) => runs(tc).replace(/\s+/g, ' ').trim()).join(' | '));
    else for (const [, pb] of blocks(b, 'a:p')) {
      const t = runs(pb).trim(), lvl = +(/<a:pPr\b[^>]*? lvl="(\d)"/.exec(pb)?.[1] || 0);
      if (t) out.push((/title/i.test(type) ? '# ' : '  '.repeat(lvl)) + t);
    }
  }
  return out.join('\n');
}
async function pptx(z, want, signal) {
  const pres = 'ppt/presentation.xml', byId = new Map(relations(z, pres).map(r => [r.id, abs(pres, r.to)]));
  let slides = [...z.text(pres).matchAll(/<p:sldId\b[^>]*>/g)].map(m => byId.get(attr(m[0], 'r:id'))).filter(Boolean);
  if (!slides.length) slides = z.names().filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.slice(16)) - parseInt(b.slice(16)));
  const parts = [];
  for (const [i, f] of slides.entries()) {
    if (!want(i + 1)) continue;
    await tick(signal);
    const note = relations(z, f).find(r => /\/notesSlide$/.test(r.type)), nx = note && z.text(abs(f, note.to)), nt = nx ? slideLines(nx, true) : '';
    parts.push({ label: `slide ${i + 1}`, text: slideLines(z.text(f) || '') + (nt ? '\n\nNotes:\n' + nt : '') });
  }
  return { type: 'pptx', unit: 'slides', count: slides.length, parts };
}

// A text file: decoded by its BOM, else as UTF-8, else as Windows-1252 (what Notepad and Excel call ANSI; PowerShell 5.1 writes UTF-16 with a BOM). A file with NUL bytes is not text.
function plain(buf) {
  let enc = 'utf-8', b = buf;
  if (buf[0] === 0xff && buf[1] === 0xfe) enc = 'utf-16le';
  else if (buf[0] === 0xfe && buf[1] === 0xff) (enc = 'utf-16le', b = Buffer.from(buf.subarray(2, buf.length - buf.length % 2)).swap16());   // big-endian: swapped into little-endian
  else if (buf.subarray(0, 8192).includes(0)) bad('this looks like a binary file, not text; use the shell if you need it');
  let text; try { text = new TextDecoder(enc, { fatal: enc === 'utf-8' }).decode(b); } catch { enc = 'windows-1252'; text = new TextDecoder(enc).decode(b); }   // a decoder drops a leading BOM by itself
  return { type: 'text', encoding: enc, parts: [{ label: '', text: text.replace(/\r\n?/g, '\n') }] };
}

// A recording's format, named as the transcription service wants it, from its first bytes; null for anything else.
const audio = b => {
  const h = b.toString('latin1', 0, 12), f = b[0] === 0xff ? b[1] : 0;   // f: the second byte of a bare MPEG or ADTS frame header
  return /^RIFF[^]{4}WAVE/.test(h) ? 'wav' : h.startsWith('fLaC') ? 'flac' : h.startsWith('OggS') ? 'ogg' : h.startsWith('\x1a\x45\xdf\xa3') ? 'webm' : h.startsWith('ID3') ? 'mp3' : h.slice(4, 8) === 'ftyp' ? 'm4a'
    : (f & 0xf6) === 0xf0 ? 'aac' : (f & 0xe0) === 0xe0 && (f >> 1 & 3) % 3 ? 'mp3' : null;   // sync 0xFFF with layer bits 00 is AAC (ADTS); layer III or II is MP3; FF FE, a UTF-16 text mark, is neither
};

// A video's container, named as OpenRouter's video types are, from its first bytes; null for anything else. An MP4 or WebM may hold only sound, so audio() takes these too.
const video = b => {
  const h = b.toString('latin1', 0, 12);
  return h.slice(4, 8) === 'ftyp' ? (h.slice(8, 12) === 'qt  ' ? 'mov' : 'mp4') : h.startsWith('\x1a\x45\xdf\xa3') ? 'webm' : /^\0\0\x01[\xba\xb3]/.test(h) ? 'mpeg' : null;
};

// What a file is, from its first bytes: its name may lie or be missing.
const kind = buf => {
  const h = buf.toString('latin1', 0, 16);
  return h.includes('%PDF-') ? 'pdf' : /^PK[\x03\x05]/.test(h) ? 'zip' : h.startsWith('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1') ? 'ole'
    : /^(\x89PNG|\xff\xd8\xff|GIF8|BM|II\*\0|MM\0\*|RIFF[^]{4}WEBP)/.test(h) ? 'image' : audio(buf) || video(buf) ? 'media' : 'text';
};

// The file's text as parts: {label, text} for a page, slide or sheet, or one part with label '' for the whole file. want(n) says whether page, slide or sheet n is wanted.
// Returns {type, parts, unit?, count?}; a refusal throws an error with .bad set, and an abort throws as it came.
async function read(buf, { pages, signal } = {}) {
  const want = pages || (() => true), k = kind(buf);
  try {
    if (k === 'pdf') return { type: 'pdf', unit: 'pages', ...await pdfText(buf, { want, signal }) };
    if (k === 'text') return plain(buf);
    if (k === 'image') bad('this is a picture, not a document: look at it with view_image');
    if (k === 'media') bad('this is a recording or a video, not a document: hear it with listen_audio (the plain words of speech: transcribe) or watch a video with watch_video');
    if (k === 'ole') bad('this is an old binary Office file (.doc, .xls or .ppt) or a password-protected one: re-save it as .docx, .xlsx or .pptx, or export it as PDF');
    const z = zip(buf);
    if (z.has('word/document.xml')) return docx(z);
    if (z.has('xl/workbook.xml')) return await xlsx(z, want, signal);
    if (z.has('ppt/presentation.xml')) return await pptx(z, want, signal);
    bad(z.has('content.xml') ? 'OpenDocument files are not supported: export it as .docx, .xlsx, .pptx or PDF' : 'this is a zip archive, not a Word, Excel or PowerPoint file: unzip it with the shell');
  } catch (e) {
    if (e.bad || signal?.aborted) throw e;
    throw new Error(`could not read this ${k === 'zip' ? 'Office' : k} file, it may be damaged (${e.message})`);
  }
}

module.exports = { read, audio, video };
