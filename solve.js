// solve.js — a fast static-site generator, byte-compatible with makefun-site 1.0.0.
//
// The reference semantics (front matter, Markdown dialect, template language,
// permalinks, collections, report lines) are re-implemented here from scratch
// for speed. Nothing is cached between cases: every call to run() is
// self-contained. Node 22+ stdlib only, no dependencies.
//
// Where the speed comes from:
//  - inline markup is scanned with one native regex over "special" characters
//    and plain runs are escaped in bulk (the reference escapes char by char).
//  - lexing and rendering of Markdown happen in a single fused pass; no
//    intermediate token objects are allocated per block.
//  - front matter is located with indexOf scans instead of splitting and
//    re-joining the whole file body.
//  - slugify uses one NFKD pass (non-ASCII only) and one regex run-collapse.
//  - word counting is a manual charCode scan on ASCII bodies.
//  - the template renderer walks the tree with a shared output array and
//    pre-allocated per-depth frame slots, so a for-loop iteration allocates
//    nothing.

export function run(input) {
  return build(input);
}

// ---------------------------------------------------------------- text ----

const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

// Escape the five HTML characters. Fast path: strings with no special
// character are returned untouched after a single native scan.
function escapeHtml(s) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(s);
  if (m === null) return s;
  const parts = [];
  let last = 0;
  do {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(ENT[m[0]]);
    last = m.index + 1;
    m = ESC_RE.exec(s);
  } while (m !== null);
  if (last < s.length) parts.push(s.slice(last));
  return parts.join('');
}

const NON_ASCII = /[^\x00-\x7F]/;
const NON_ALNUM_RUN = /[^a-z0-9]+/g;
const MARKS = /\p{M}/gu;

// Slug: NFKD + strip combining marks (only needed for non-ASCII text),
// lowercase, collapse each run of non [a-z0-9] into one '-', trim the ends,
// cut to 64 chars and trim a trailing '-' again, 'untitled' when empty.
// Equivalent to the reference's char loop: any character that survives
// NFKD+mark-strip and lowercases to a-z is an ASCII uppercase letter.
function slugify(text) {
  let s = text;
  if (NON_ASCII.test(s)) s = s.normalize('NFKD').replace(MARKS, '');
  s = s.toLowerCase().replace(NON_ALNUM_RUN, '-');
  if (s.charCodeAt(0) === 45) s = s.slice(1); // '-'
  if (s.length > 64) s = s.slice(0, 64);
  if (s.charCodeAt(s.length - 1) === 45) s = s.slice(0, -1);
  return s === '' ? 'untitled' : s;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

// Count whitespace-separated words with a manual scan over the full JS \s
// set (no regex fallback): \t\n\v\f\r, space, NBSP, U+1680, U+2000–U+200A,
// U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF. ASCII chars take the
// two-comparison path; the wider set is only tested past ASCII.
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c < 128
      ? (c === 32 || (c >= 9 && c <= 13))
      : (c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
        c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
    if (ws) inWord = false;
    else if (!inWord) { n++; inWord = true; }
  }
  return n;
}

// -------------------------------------------------------- front matter ----

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return DAYS[m - 1];
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = stringOf(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (m === null || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',').map((t) => t.trim());
    if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    return { value: tags };
  }
  if (key === 'draft') {
    return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

// Parse front matter without splitting the whole file: locate the closing
// '---' line with indexOf scans, split only the (short) front-matter region.
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  let lineStart = nl0 === -1 ? text.length : nl0 + 1;
  let lineNo = 1; // 0-based index of the line starting at lineStart
  let closeLineStart = -1;
  let bodyStart = -1;
  while (lineStart <= text.length) {
    const end = text.indexOf('\n', lineStart);
    const lineEnd = end === -1 ? text.length : end;
    if (text.slice(lineStart, lineEnd) === '---') {
      closeLineStart = lineStart;
      bodyStart = end === -1 ? text.length : end + 1;
      break;
    }
    if (end === -1) break;
    lineStart = end + 1;
    lineNo++;
  }
  if (closeLineStart === -1) return { error: 'the front matter is not closed' };
  const region = text.slice(nl0 + 1, closeLineStart);
  // region ends with '\n' (or is empty): split gives [...lines, ''].
  const fmLines = region === '' ? [] : region.split('\n').slice(0, -1);
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    const lineNum = j + 2; // split-index j+1, reported 1-based
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${lineNum} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return { error: v.error };
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------ markdown ----

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const WS_RE = /\s/;

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
// Markdown specials plus the five HTML characters, in one scan: a run
// between matches holds neither, so it is pushed raw and no escapeHtml call
// is needed for it. Only code-span content and link hrefs still escape.
const SPECIAL_RE = /[\\`*[&<>"']/g;

function trimLine(line) {
  const n = line.length;
  if (n === 0) return line;
  let a = 0;
  let b = n;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === n ? line : line.slice(a, b);
}

function isBlank(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let i = 1; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

function isFenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  return FENCE_OPEN.exec(line);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  return FENCE_CLOSE.test(line);
}

function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null; // '#'
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false; // '-' '*'
  return HR_RE.test(line);
}

// Ordered-list marker: 1-9 digits, '.', ' '. Returns { num, text } or null.
function orderedOf(line) {
  let i = 0;
  while (i < 9 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // '.' ' '
  return { num: line.slice(0, i), text: line.slice(i + 2) };
}

function isBullet(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32; // '-' '*' then ' '
}

// Continuation line: /^ {2,}\S/ — two or more spaces, then a non-whitespace.
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  if (c <= 127) return !(c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32);
  return !WS_RE.test(line[i]);
}

function endsParagraph(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlank(line);
  if (c === 96) return isFenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  return false;
}

// Find `what` at or after `from`, skipping backslash-escaped occurrences.
function findUnescaped(s, what, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

// Find a single '*' (not part of a '**' pair), skipping escaped stars.
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

// Inline markup. One regex scan finds the next special character (markdown
// or HTML); the plain runs between matches are pushed raw, and each HTML
// character is replaced by its entity on the spot. `link` resolves a link
// target to a URL (or records a broken link).
function inline(s, link) {
  const out = [];
  const n = s.length;
  let lit = 0; // start of the pending literal run (holds no specials)
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const j = m.index;
    const c = s[j];
    if (c === '&' || c === '<' || c === '>' || c === '"' || c === "'") {
      if (j > lit) out.push(s.slice(lit, j));
      out.push(ENT[c]);
      lit = j + 1;
      continue;
    }
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        if (j > lit) out.push(s.slice(lit, j));
        const e = s[j + 1];
        out.push(e === '>' ? '&gt;' : e); // '>' is the only escapable HTML char
        lit = j + 2;
        SPECIAL_RE.lastIndex = lit;
      }
      // otherwise the backslash stays in the literal run; keep scanning
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > lit) out.push(s.slice(lit, j));
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        lit = k + 1;
        SPECIAL_RE.lastIndex = lit;
      }
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > lit) out.push(s.slice(lit, j));
          out.push('<strong>', inline(s.slice(j + 2, k), link), '</strong>');
          lit = k + 2;
          SPECIAL_RE.lastIndex = lit;
        } else {
          // no closer: both stars stay in the run, skip past them
          SPECIAL_RE.lastIndex = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (j > lit) out.push(s.slice(lit, j));
          out.push('<em>', inline(s.slice(j + 1, k), link), '</em>');
          lit = k + 1;
          SPECIAL_RE.lastIndex = lit;
        }
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', j + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !WS_RE.test(target)) {
      if (j > lit) out.push(s.slice(lit, j));
      out.push(`<a href="${escapeHtml(link(target))}">`, inline(s.slice(j + 1, k), link), '</a>');
      lit = mm + 1;
      SPECIAL_RE.lastIndex = lit;
    }
    continue;
  }
  if (lit < n) out.push(s.slice(lit));
  return out.join('');
}

// Lex and render in one fused pass. Returns { html, toc, excerpt }.
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fence = isFenceOpen(line);
    if (fence !== null) {
      const lang = fence[1];
      i++;
      const parts = [lang === '' ? '<pre><code>' : `<pre><code class="language-${escapeHtml(lang)}">`];
      while (i < n && !isFenceClose(lines[i])) {
        parts.push(escapeHtml(lines[i]), '\n');
        i++;
      }
      i++; // consume the close line, or step past the end
      parts.push('</code></pre>\n');
      out.push(parts.join(''));
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inline(h.text, link);
      out.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>\n`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const qlines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let l = lines[i];
        l = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        l = trimLine(l);
        if (l !== '') qlines.push(l);
        i++;
      }
      out.push(qlines.length === 0
        ? '<blockquote>\n</blockquote>\n'
        : `<blockquote>\n<p>${inline(qlines.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    let isOrdered = false;
    let startNum = 1;
    let firstItem = null;
    if (isBullet(line)) {
      firstItem = trimLine(line.slice(2));
    } else {
      const o = orderedOf(line);
      if (o !== null) {
        firstItem = trimLine(o.text);
        isOrdered = true;
        startNum = Number(o.num);
      }
    }
    if (firstItem !== null) {
      const items = [[firstItem]];
      i++;
      while (i < n) {
        const l = lines[i];
        if (isOrdered) {
          const o = orderedOf(l);
          if (o !== null) { items.push([trimLine(o.text)]); i++; continue; }
        } else if (isBullet(l)) {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (isContinued(l)) { items[items.length - 1].push(trimLine(l)); i++; continue; }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const parts = [isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`, '\n'];
      for (const parts2 of items) parts.push('<li>', inline(parts2.join('\n'), link), '</li>\n');
      parts.push(`</${tag}>\n`);
      out.push(parts.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>\n`);
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------ templates ----

class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ kind: 'text', text });
      text = '';
      tokens.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
    tokens.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ kind: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.kind === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.kind === 'var' || tok.kind === 'raw') body.push({ kind: tok.kind, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Resolve a path against the for-frames (innermost first) then the root
// vars. A frame binds its element name and `loop`; `loop` always wins over
// an element of the same name (the reference builds { [name]: x, loop: … },
// where the later key overwrites).
function lookup(frames, fdepth, root, path) {
  const first = path[0];
  let v;
  let d = fdepth - 1;
  for (; d >= 0; d--) {
    const f = frames[d];
    if (first === 'loop') { v = f.l; break; }
    if (f.n === first) { v = f.v; break; }
  }
  if (d < 0) {
    if (!Object.hasOwn(root, first)) return undefined;
    v = root[first];
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function renderNodes(nodes, frames, fdepth, root, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') { out.push(n.text); continue; }
    if (n.kind === 'var') { out.push(escapeHtml(textOf(lookup(frames, fdepth, root, n.path)))); continue; }
    if (n.kind === 'raw') { out.push(textOf(lookup(frames, fdepth, root, n.path))); continue; }
    if (n.kind === 'if') {
      const v = truthy(lookup(frames, fdepth, root, n.path));
      const branch = v !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, frames, fdepth, root, templates, depth, out);
      continue;
    }
    if (n.kind === 'for') {
      const xs = lookup(frames, fdepth, root, n.path);
      if (!Array.isArray(xs)) continue;
      let slot = frames[fdepth];
      if (slot === undefined) {
        slot = { n: n.name, v: null, l: { index: 0, first: false, last: false, length: 0 } };
        frames[fdepth] = slot;
      }
      slot.n = n.name;
      const loop = slot.l;
      loop.length = xs.length;
      for (let k = 0; k < xs.length; k++) {
        slot.v = xs[k];
        loop.index = k + 1;
        loop.first = k === 0;
        loop.last = k === xs.length - 1;
        renderNodes(n.body, frames, fdepth + 1, root, templates, depth, out);
      }
      continue;
    }
    const t = templates.get(n.name);
    if (t !== undefined && depth < 8) renderNodes(t, frames, fdepth, root, templates, depth + 1, out);
  }
}

// ------------------------------------------------------------- pipeline ----

const RESERVED = ['posts', 'tags', 'page'];
const REPORT_FILE = 'build-report.txt';
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const CR_RE = /\r\n?/g;
const TRAILING_SLASH = /\/+$/;

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function resolvePath(dirParts, rel) {
  const parts = [...dirParts];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function build(input) {
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }
  const base = input.site.base_url.replace(TRAILING_SLASH, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(CR_RE, '\n');
      sources.push({ path: f.path, text });
    } else statics.push({ path: f.path, content: f.content });
  }
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }
  const staticPaths = new Set(statics.map(f => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      // Single-segment relative targets (no '/', not '.' or '..') resolve
      // against the source's directory without splitting anything.
      const path = rel === '' ? null
        : (rel.indexOf('/') === -1 && rel !== '.' && rel !== '..')
          ? (dir === '' ? rel : `${dir}/${rel}`)
          : resolvePath(dirParts, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    // Reading time is counted once per source here; cardOf reuses it (the
    // reference counts it twice per post, once per card build).
    s.readingMinutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
  }
  const posts = kept
    .filter(s => s.post)
    .sort((a, b) => byCodeUnits(b.data.date, a.data.date) || byCodeUnits(a.slug, b.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }
  const pages = kept.filter(s => !s.post).length;
  const allTags = collectTags(posts, kept, base);
  const cards = new Map(posts.map(p => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTagsView = allTags.map(t => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map(p => cards.get(p));
  const frames = [];
  const render = (name, root) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, frames, 0, root, templates, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of kept) {
    const out = render(s.layout, { site, tags: allTagsView, recent, page: pageOf(s) });
    if (out !== null) output[`${s.outDir}/index.html`] = out;
  }
  const per = input.site.per_page;
  const indexPages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= indexPages; k++) {
    const out = render('index', {
      site,
      tags: allTagsView,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map(p => cards.get(p)),
      pager: { number: k, total: indexPages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === indexPages ? '' : indexUrl(k + 1) },
    });
    if (out !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = out;
  }
  for (const t of allTags) {
    const out = render('tag', { site, tags: allTagsView, recent, tag: tagOf(t, cards) });
    if (out !== null) output[`tags/${t.slug}/index.html`] = out;
  }
  const tagsOut = render('tags', { site, tags: allTagsView, recent });
  if (tagsOut !== null) output['tags/index.html'] = tagsOut;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pages} pages, ${posts.length} posts, ${allTags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

function ownTags(s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugify(name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out;
}

function collectTags(posts, sources, base) {
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let t = bySlug.get(slug);
      if (t === undefined) {
        t = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, t);
      }
      t.posts.push(p);
      p.tagRefs.push(t);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing
  // (url "") where no post has it.
  for (const s of sources) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  return [...bySlug.values()].sort((a, b) => b.posts.length - a.posts.length || byCodeUnits(a.slug, b.slug));
}

function linkOf(s) {
  return s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: s.readingMinutes,
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

function tagOf(t, cards) {
  return {
    name: t.name,
    slug: t.slug,
    url: t.url,
    count: t.posts.length,
    posts: t.posts.map(p => cards.get(p)),
  };
}
