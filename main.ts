// mend: apply an edit that an AI model wrote to a tree of text files.
//
// The contract is SPEC.md: four edit formats (unified diffs, SEARCH/REPLACE
// blocks, V4A patches and JSON tool calls), line matching at three tiers of
// exactness, and all-or-nothing writes: every file changes, or none does.

import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Small pieces

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse error at patch line ${line}`);
    this.line = line;
  }
}

// A path is safe when it is not empty, does not start with '/', holds no
// backslash, and none of its '/'-separated segments is empty, '.' or '..'.
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

// A patch's lines: its text split at '\n', each with one trailing '\r'
// removed, and without the empty piece after a final '\n'.
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// A file seen as lines. The break is CRLF when the file's first line feed
// follows a carriage return, LF otherwise. `end` says the text ends with the
// break; that last, empty piece is not a line. An empty file has no lines.
interface FileLines {
  lines: string[];
  brk: '\n' | '\r\n';
  end: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], brk: '\n', end: false };
  const firstNl = text.indexOf('\n');
  const brk: '\n' | '\r\n' = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let end = false;
  if (text.endsWith(brk)) {
    end = true;
    parts.pop();
  }
  return { lines: parts, brk, end };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.end ? f.brk : '');
}

// ---------------------------------------------------------------------------
// The tree: the working directory as the patch leaves it, in memory. Nothing
// reaches the disk unless every edit succeeds and --check is absent.

interface Tree {
  state: Map<string, string | null>; // current bytes of each touched path (null: absent)
  before: Map<string, string | null>; // bytes before the patch, same keys
  moves: Array<[string, string]>; // successful move edits, in order
}

function newTree(): Tree {
  return { state: new Map(), before: new Map(), moves: [] };
}

function diskRead(p: string): string | null {
  try {
    if (!statSync(p).isFile()) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// The current content of a path, loading and remembering its pre-patch state
// the first time the patch touches it.
function treeGet(t: Tree, p: string): string | null {
  if (!t.state.has(p)) {
    const cur = diskRead(p);
    t.state.set(p, cur);
    t.before.set(p, cur);
  }
  return t.state.get(p) ?? null;
}

function treeSet(t: Tree, p: string, content: string | null): void {
  treeGet(t, p);
  t.state.set(p, content);
}

function treeWrite(t: Tree): void {
  for (const [p, content] of t.state) {
    if (content === null && t.before.get(p) !== null) {
      try {
        rmSync(p, { force: true });
      } catch {
        // already gone
      }
    }
  }
  for (const [p, content] of t.state) {
    if (content !== null && content !== t.before.get(p)) {
      const d = dirname(p);
      if (d !== '.') mkdirSync(d, { recursive: true });
      writeFileSync(p, content, 'utf8');
    }
  }
}

// The exit-0 listing: one line per path whose state changed, in byte order
// of the paths (UTF-8); a successful move's D and A lines are replaced by
// one R line that sorts by the new path.
function changeLines(t: Tree): string[] {
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  for (const [p, b] of t.before) {
    const a = t.state.get(p) ?? null;
    if (b === null && a !== null) added.push(p);
    else if (b !== null && a === null) deleted.push(p);
    else if (b !== null && a !== null && b !== a) modified.push(p);
  }
  const lines: Array<{ key: string; text: string }> = [];
  const usedAdd = new Set<string>();
  const usedDel = new Set<string>();
  for (const [oldP, newP] of t.moves) {
    if (deleted.includes(oldP) && added.includes(newP) && !usedDel.has(oldP) && !usedAdd.has(newP)) {
      lines.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedDel.add(oldP);
      usedAdd.add(newP);
    }
  }
  for (const p of deleted) if (!usedDel.has(p)) lines.push({ key: p, text: `D ${p}` });
  for (const p of added) if (!usedAdd.has(p)) lines.push({ key: p, text: `A ${p}` });
  for (const p of modified) lines.push({ key: p, text: `M ${p}` });
  lines.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  return lines.map((l) => l.text);
}

// ---------------------------------------------------------------------------
// Edits. Each parser turns patch lines into edits; each edit knows how to
// apply itself to the tree. An apply returns an error line's tail
// ("<code> <path>") on failure, or null on success; a failed edit has
// changed nothing.

type Edit =
  | { type: 'jcreate'; path: string; text: string }
  | { type: 'jreplace'; path: string; oldStr: string; newStr: string }
  | { type: 'jinsert'; path: string; line: number; text: string }
  | UnifiedEdit
  | SREdit
  | VEdit;

// One line of a hunk or chunk body: ' ' context, '-' old, '+' new, '\\' the
// no-line-break marker. `blank` remembers that the patch line itself was
// empty (an empty context line), which matters at the end of a body.
interface BodyLine {
  t: ' ' | '-' | '+' | '\\';
  text: string;
  blank: boolean;
}

interface Hunk {
  a: number; // the A of @@ -A[,B] +C[,D] @@; B, C and D are not used
  body: BodyLine[];
}

interface UnifiedEdit {
  type: 'unified';
  mode: 'create' | 'delete' | 'move' | 'change';
  oldPath: string | null; // null: /dev/null
  newPath: string | null;
  hunks: Hunk[];
}

interface SREdit {
  type: 'sr';
  path: string;
  oldLines: string[];
  newLines: string[];
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type VEdit =
  | { type: 'vadd'; path: string; lines: string[] }
  | { type: 'vdelete'; path: string }
  | { type: 'vupdate'; path: string; moveTo: string | null; chunks: VChunk[] };

// ---------------------------------------------------------------------------
// The command line (SPEC section 1)

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null; // null or '-': standard input
}

const FORMAT_NAMES = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function parseArgs(argv: string[]): Options | null {
  const opts: Options = { format: 'auto', check: false, strict: false, patch: null };
  const seen = new Set<string>();
  let optionsEnded = false;
  let positionalSeen = false;
  for (const arg of argv) {
    if (!optionsEnded) {
      if (arg === '--') {
        optionsEnded = true;
        continue;
      }
      if (arg === '--check' || arg === '--strict') {
        if (seen.has(arg)) return null;
        seen.add(arg);
        if (arg === '--check') opts.check = true;
        else opts.strict = true;
        continue;
      }
      if (arg.startsWith('--format=')) {
        if (seen.has('--format')) return null;
        seen.add('--format');
        const value = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(value)) return null;
        opts.format = value;
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') return null; // an unknown option
    }
    // A positional argument: the patch path.
    if (positionalSeen) return null;
    positionalSeen = true;
    opts.patch = arg;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC section 4). `lines` are the patch's lines.

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function detectFormat(lines: string[]): string | null {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx >= 0) {
    const first = lines[firstIdx];
    if (first.trim() === '*** Begin Patch') return 'v4a';
    const ch = first.trimStart().charAt(0);
    if (ch === '[' || ch === '{') return 'json';
  }
  if (lines.some((l) => l.replace(/\s+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Validate one edit object; null when it is not a valid edit object.
function jsonEdit(obj: unknown): Edit | null {
  if (!isPlainObject(obj)) return null;
  const path = obj.path;
  const command = obj.command;
  if (typeof path !== 'string' || typeof command !== 'string') return null;
  if (command === 'create') {
    if (typeof obj.file_text !== 'string') return null;
    return { type: 'jcreate', path, text: obj.file_text };
  }
  if (command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') return null;
    if (obj.new_str !== undefined && typeof obj.new_str !== 'string') return null;
    return { type: 'jreplace', path, oldStr: obj.old_str, newStr: (obj.new_str as string) ?? '' };
  }
  if (command === 'insert') {
    if (typeof obj.insert_line !== 'number' || !Number.isInteger(obj.insert_line)) return null;
    if (typeof obj.new_str !== 'string') return null;
    return { type: 'jinsert', path, line: obj.insert_line, text: obj.new_str };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const firstChar = text.trimStart().charAt(0);
  const edits: Edit[] = [];
  if (firstChar === '[') {
    // One JSON array of edit objects. Any fault is reported at the line
    // where the array starts: the first line holding a non-whitespace char.
    const startLine = lines.findIndex((l) => l.trim() !== '') + 1;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseError(startLine);
    }
    if (!Array.isArray(value)) throw new ParseError(startLine);
    for (const item of value) {
      const edit = jsonEdit(item);
      if (edit === null) throw new ParseError(startLine);
      edits.push(edit);
    }
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(lines[i]);
    } catch {
      throw new ParseError(i + 1);
    }
    const edit = jsonEdit(value);
    if (edit === null) throw new ParseError(i + 1);
    edits.push(edit);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5). O, the old lines an edit names, is found
// at the first tier at which it occurs at least once; occurrences may
// overlap. Tier 0 is byte-equal, tier 1 ignores trailing spaces and tabs,
// tier 2 ignores leading ones as well. --strict tries tier 0 only.

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return a.replace(/[ \t]+$/, '') === b.replace(/[ \t]+$/, '');
  return a.replace(/^[ \t]+|[ \t]+$/g, '') === b.replace(/^[ \t]+|[ \t]+$/g, '');
}

function findOccurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(lines[i + j], O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findTier(
  lines: string[],
  O: string[],
  strict: boolean,
  from = 0,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = findOccurrences(lines, O, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// One item of a replacement: a context line (written as the file's own
// matched line, never the patch's) or an added line.
interface NItem {
  kind: 'ctx' | 'add';
  oIndex: number; // for 'ctx': the line's index within O
  text: string; // for 'add': the line to write
}

function buildNew(lines: string[], pos: number, O: string[], items: NItem[], tier: number): string[] {
  // At tier 2 every added line is re-indented: F is the leading spaces and
  // tabs of the file's first matched line and P those of O's first line; a
  // line that is not empty and not only whitespace, and starts with P, has
  // that P replaced by F. Any other line is written as it is. Context lines
  // are always the file's own matched lines.
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = /^[ \t]*/.exec(lines[pos])?.[0] ?? '';
    P = /^[ \t]*/.exec(O[0])?.[0] ?? '';
  }
  return items.map((it) => {
    if (it.kind === 'ctx') return lines[pos + it.oIndex];
    const s = it.text;
    if (tier === 2 && s !== '' && !/^[ \t]+$/.test(s) && s.startsWith(P)) return F + s.slice(P.length);
    return s;
  });
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)

// The path of a --- or +++ line: the text after the four characters, up to
// the first tab, with surrounding spaces removed and a leading a/ or b/
// taken off.
function headerPath(line: string): string {
  let text = line.slice(4);
  const tab = text.indexOf('\t');
  if (tab >= 0) text = text.slice(0, tab);
  text = text.replace(/^ +| +$/g, '');
  if (text.startsWith('a/') || text.startsWith('b/')) text = text.slice(2);
  return text;
}

// The two paths of a `diff --git a/<X> b/<Y>` line, or null when the line
// is not of that form.
function diffGitPaths(line: string): [string, string] | null {
  if (!line.startsWith('diff --git ')) return null;
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0) return null;
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

interface SectionAcc {
  diffOld?: string;
  diffNew?: string;
  dashOld?: string;
  dashNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  pairSeen: boolean;
  inHeader: boolean;
  hunks: Hunk[];
}

function finalizeSection(sec: SectionAcc): UnifiedEdit {
  const oldRaw = sec.dashOld !== undefined ? sec.dashOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newRaw = sec.dashNew !== undefined ? sec.dashNew : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const oldPath = oldRaw === '/dev/null' ? null : oldRaw ?? null;
  const newPath = newRaw === '/dev/null' ? null : newRaw ?? null;
  let mode: UnifiedEdit['mode'];
  if (sec.newFile || oldPath === null) mode = 'create';
  else if (sec.delFile || newPath === null) mode = 'delete';
  else if (oldPath !== newPath) mode = 'move';
  else mode = 'change';
  return { type: 'unified', mode, oldPath, newPath, hunks: sec.hunks };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: SectionAcc | null = null;
  let hunk: Hunk | null = null;

  const closeHunk = (): void => {
    if (hunk !== null && sec !== null) {
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1].blank) hunk.body.pop();
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const closeSection = (): void => {
    closeHunk();
    if (sec !== null) edits.push(finalizeSection(sec));
    sec = null;
  };
  const newSection = (): SectionAcc => {
    closeSection();
    sec = { newFile: false, delFile: false, pairSeen: false, inHeader: true, hunks: [] };
    return sec;
  };
  const startPairSection = (i: number): void => {
    const s = newSection();
    s.dashOld = headerPath(lines[i]);
    s.dashNew = headerPath(lines[i + 1]);
    s.pairSeen = true;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const n = i + 1;

    if (hunk !== null) {
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        startPairSection(i);
        i += 2;
        continue;
      }
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push({
          t: line === '' ? ' ' : (line[0] as BodyLine['t']),
          text: line === '' ? '' : line.slice(1),
          blank: line === '',
        });
        i++;
        continue;
      }
      closeHunk(); // the body ended; the line is read again below
    }

    if (line === 'diff --git' || line.startsWith('diff --git ')) {
      const paths = diffGitPaths(line);
      if (paths === null) throw new ParseError(n);
      const s = newSection();
      s.diffOld = paths[0];
      s.diffNew = paths[1];
      i++;
      continue;
    }

    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseError(n); // a hunk before any section
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseError(n);
      sec.inHeader = false;
      hunk = { a: parseInt(m[1], 10), body: [] };
      i++;
      continue;
    }

    if (line.startsWith('--- ')) {
      const followed = i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
      if (sec !== null && sec.inHeader) {
        if (!followed) throw new ParseError(n + 1);
        if (sec.pairSeen) {
          startPairSection(i);
        } else {
          sec.dashOld = headerPath(line);
          sec.dashNew = headerPath(lines[i + 1]);
          sec.pairSeen = true;
        }
        i += 2;
        continue;
      }
      if (followed) {
        startPairSection(i);
        i += 2;
        continue;
      }
      i++; // a --- line outside a header, not followed by +++: prose
      continue;
    }

    if (sec !== null && sec.inHeader) {
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.delFile = true;
      else if (line.startsWith('+++ ') && !sec.pairSeen) sec.dashNew = headerPath(line);
      // index, mode and every other header line is ignored
    }
    i++;
  }
  closeSection();
  return edits;
}

// Apply one section's hunks, in order, each to the result of the ones
// before it. Returns the new lines and final-break flag, or an error code.
function applyHunks(
  f: FileLines,
  hunks: Hunk[],
  strict: boolean,
): { lines: string[]; end: boolean } | string {
  let lines = [...f.lines];
  let end = f.end;
  let d = 0; // the sum over this section's hunks so far of (N - O) lengths
  for (const h of hunks) {
    const O: string[] = [];
    const items: NItem[] = [];
    for (const bl of h.body) {
      if (bl.t === ' ') {
        items.push({ kind: 'ctx', oIndex: O.length, text: bl.text });
        O.push(bl.text);
      } else if (bl.t === '-') {
        O.push(bl.text);
      } else if (bl.t === '+') {
        items.push({ kind: 'add', oIndex: -1, text: bl.text });
      }
    }
    // A '\' line after the hunk's last context or '+' line takes the final
    // line break away when the hunk runs to the end of the file.
    let noBreak = false;
    for (let k = h.body.length - 1; k >= 0; k--) {
      if (h.body[k].t === ' ' || h.body[k].t === '+') {
        noBreak = h.body[k + 1]?.t === '\\';
        break;
      }
    }
    if (O.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = pos === lines.length;
      const texts = items.map((it) => it.text);
      lines.splice(pos, 0, ...texts);
      if (atEnd) end = !noBreak;
      d += texts.length;
      continue;
    }
    const found = findTier(lines, O, strict);
    if (found === null) return 'no-match';
    // The occurrence whose position is nearest to A - 1 + d; ties go early.
    const target = h.a - 1 + d;
    let pos = found.positions[0];
    for (const p of found.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const newLines = buildNew(lines, pos, O, items, found.tier);
    const reachesEnd = pos + O.length === lines.length;
    lines.splice(pos, O.length, ...newLines);
    if (reachesEnd) end = !noBreak;
    d += newLines.length - O.length;
  }
  return { lines, end };
}

function applyUnified(t: Tree, e: UnifiedEdit, strict: boolean): string | null {
  if (e.oldPath !== null && !isSafePath(e.oldPath)) return `unsafe ${e.oldPath}`;
  if (e.newPath !== null && !isSafePath(e.newPath)) return `unsafe ${e.newPath}`;
  if (e.mode === 'create') {
    const target = e.newPath ?? '';
    if (!isSafePath(target)) return `unsafe ${target}`;
    if (treeGet(t, target) !== null) return `exists ${target}`;
    // The file is the '+' lines of all its hunks, in order; it ends with a
    // line break unless a '\' line follows its last '+' line.
    const content: string[] = [];
    let noBreak = false;
    for (const h of e.hunks) {
      h.body.forEach((bl, idx) => {
        if (bl.t === '+') {
          content.push(bl.text);
          noBreak = h.body[idx + 1]?.t === '\\';
        }
      });
    }
    const text = content.length === 0 ? '' : content.join('\n') + (noBreak ? '' : '\n');
    treeSet(t, target, text);
    return null;
  }
  if (e.mode === 'delete') {
    const target = e.oldPath ?? '';
    if (!isSafePath(target)) return `unsafe ${target}`;
    if (treeGet(t, target) === null) return `missing ${target}`;
    treeSet(t, target, null);
    return null;
  }
  const from = e.oldPath ?? '';
  const to = e.newPath ?? '';
  const content = treeGet(t, from);
  if (content === null) return `missing ${from}`;
  if (e.mode === 'move' && treeGet(t, to) !== null) return `exists ${to}`;
  const f = splitFile(content);
  const applied = applyHunks(f, e.hunks, strict);
  if (typeof applied === 'string') return `${applied} ${from}`;
  const text = joinFile({ lines: applied.lines, brk: f.brk, end: applied.end });
  if (e.mode === 'move') {
    treeSet(t, to, text);
    treeSet(t, from, null);
    t.moves.push([from, to]);
  } else {
    treeSet(t, from, text);
  }
  return null;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const marker = (l: string): string => l.replace(/\s+$/, '');
  let prevPath: string | null = null;
  let searchFrom = 0; // lines before this index belong to earlier blocks
  let i = 0;
  while (i < lines.length) {
    if (marker(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, after the
    // previous block, that is not blank and does not open a code fence.
    let path: string | null = null;
    for (let j = i - 1; j >= searchFrom; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseError(searchLine);
    let j = i + 1;
    while (j < lines.length && marker(lines[j]) !== '=======') {
      if (marker(lines[j]) === '>>>>>>> REPLACE') throw new ParseError(searchLine);
      j++;
    }
    if (j >= lines.length) throw new ParseError(searchLine);
    const oldLines = lines.slice(i + 1, j);
    let k = j + 1;
    while (k < lines.length && marker(lines[k]) !== '>>>>>>> REPLACE') k++;
    if (k >= lines.length) throw new ParseError(searchLine);
    const newLines = lines.slice(j + 1, k);
    edits.push({ type: 'sr', path, oldLines, newLines });
    prevPath = path;
    searchFrom = k + 1;
    i = k + 1;
  }
  return edits;
}

function applySR(t: Tree, e: SREdit, strict: boolean): string | null {
  if (!isSafePath(e.path)) return `unsafe ${e.path}`;
  if (e.oldLines.length === 0) {
    // An empty old side creates the file with the new lines.
    if (treeGet(t, e.path) !== null) return `exists ${e.path}`;
    const text = e.newLines.length === 0 ? '' : e.newLines.join('\n') + '\n';
    treeSet(t, e.path, text);
    return null;
  }
  const content = treeGet(t, e.path);
  if (content === null) return `missing ${e.path}`;
  const f = splitFile(content);
  const found = findTier(f.lines, e.oldLines, strict);
  if (found === null) return `no-match ${e.path}`;
  if (found.positions.length > 1) return `ambiguous ${e.path}`;
  const pos = found.positions[0];
  const items: NItem[] = e.newLines.map((text) => ({ kind: 'add', oIndex: -1, text }));
  const newLines = buildNew(f.lines, pos, e.oldLines, items, found.tier);
  f.lines.splice(pos, e.oldLines.length, ...newLines);
  treeSet(t, e.path, joinFile(f));
  return null;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'delete';
    if (l.startsWith('*** Update File:')) return 'update';
    return null;
  };

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new ParseError(i + 1);
    const startLine = i + 1;
    // The section's lines run until the next section or the End Patch;
    // blank lines at its end are not part of it.
    let j = i + 1;
    while (j < last && sectionStart(lines[j]) === null) j++;
    const range = lines.slice(i + 1, j);
    let rangeEnd = range.length;
    while (rangeEnd > 0 && range[rangeEnd - 1].trim() === '') rangeEnd--;
    const body = range.slice(0, rangeEnd);

    if (kind === 'add') {
      const path = line.slice('*** Add File:'.length).trim();
      const content: string[] = [];
      body.forEach((l, k) => {
        if (l.startsWith('+')) content.push(l.slice(1));
        else if (l === '') content.push('');
        else throw new ParseError(i + 2 + k);
      });
      edits.push({ type: 'vadd', path, lines: content });
    } else if (kind === 'delete') {
      const path = line.slice('*** Delete File:'.length).trim();
      body.forEach((l, k) => {
        if (l.trim() !== '') throw new ParseError(i + 2 + k);
      });
      edits.push({ type: 'vdelete', path });
    } else {
      const path = line.slice('*** Update File:'.length).trim();
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let m = 0;
      if (m < body.length && body[m].startsWith('*** Move to:')) {
        moveTo = body[m].slice('*** Move to:'.length).trim();
        m++;
      }
      for (; m < body.length; m++) {
        const l = body[m];
        const lineNo = i + 2 + m;
        if (l.startsWith('@@')) {
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(cur);
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new ParseError(lineNo);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            // Only the first chunk may start at a body line.
            if (chunks.length > 0) throw new ParseError(lineNo);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          cur.body.push({
            t: l === '' ? ' ' : (l[0] as BodyLine['t']),
            text: l === '' ? '' : l.slice(1),
            blank: l === '',
          });
          continue;
        }
        throw new ParseError(lineNo);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(startLine);
      edits.push({ type: 'vupdate', path, moveTo, chunks });
    }
    i = j;
  }
  return edits;
}

function applyVUpdate(t: Tree, e: Extract<VEdit, { type: 'vupdate' }>, strict: boolean): string | null {
  if (!isSafePath(e.path)) return `unsafe ${e.path}`;
  if (e.moveTo !== null && !isSafePath(e.moveTo)) return `unsafe ${e.moveTo}`;
  const content = treeGet(t, e.path);
  if (content === null) return `missing ${e.path}`;
  if (e.moveTo !== null && treeGet(t, e.moveTo) !== null) return `exists ${e.moveTo}`;
  const f = splitFile(content);
  const lines = f.lines;
  let cursor = 0;
  for (const chunk of e.chunks) {
    if (chunk.anchor !== null) {
      // The first line at or after the cursor equal to the anchor, at the
      // first tier where one is.
      const tiers = strict ? [0] : [0, 1, 2];
      let anchorAt = -1;
      for (const tier of tiers) {
        for (let k = cursor; k < lines.length; k++) {
          if (lineEq(lines[k], chunk.anchor, tier)) {
            anchorAt = k;
            break;
          }
        }
        if (anchorAt >= 0) break;
      }
      if (anchorAt < 0) return `no-match ${e.path}`;
      cursor = anchorAt + 1;
    }
    const O: string[] = [];
    const items: NItem[] = [];
    for (const bl of chunk.body) {
      if (bl.t === ' ') {
        items.push({ kind: 'ctx', oIndex: O.length, text: bl.text });
        O.push(bl.text);
      } else if (bl.t === '-') {
        O.push(bl.text);
      } else if (bl.t === '+') {
        items.push({ kind: 'add', oIndex: -1, text: bl.text });
      }
    }
    if (O.length === 0) {
      const pos = chunk.eof ? lines.length : cursor;
      const texts = items.map((it) => it.text);
      lines.splice(pos, 0, ...texts);
      cursor = pos + texts.length;
      continue;
    }
    const found = findTier(lines, O, strict, cursor);
    if (found === null) return `no-match ${e.path}`;
    let positions = found.positions;
    if (chunk.eof) positions = positions.filter((p) => p + O.length === lines.length);
    if (positions.length === 0) return `no-match ${e.path}`;
    const pos = positions[0];
    const newLines = buildNew(lines, pos, O, items, found.tier);
    lines.splice(pos, O.length, ...newLines);
    cursor = pos + newLines.length;
  }
  const text = joinFile({ lines, brk: f.brk, end: f.end });
  if (e.moveTo !== null) {
    treeSet(t, e.moveTo, text);
    treeSet(t, e.path, null);
    t.moves.push([e.path, e.moveTo]);
  } else {
    treeSet(t, e.path, text);
  }
  return null;
}

function applyV(t: Tree, e: VEdit, strict: boolean): string | null {
  switch (e.type) {
    case 'vadd': {
      if (!isSafePath(e.path)) return `unsafe ${e.path}`;
      if (treeGet(t, e.path) !== null) return `exists ${e.path}`;
      const text = e.lines.length === 0 ? '' : e.lines.join('\n') + '\n';
      treeSet(t, e.path, text);
      return null;
    }
    case 'vdelete': {
      if (!isSafePath(e.path)) return `unsafe ${e.path}`;
      if (treeGet(t, e.path) === null) return `missing ${e.path}`;
      treeSet(t, e.path, null);
      return null;
    }
    case 'vupdate':
      return applyVUpdate(t, e, strict);
  }
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC sections 6 to 10)

function applyEdit(t: Tree, e: Edit, strict: boolean): string | null {
  switch (e.type) {
    case 'unified':
      return applyUnified(t, e, strict);
    case 'sr':
      return applySR(t, e, strict);
    case 'vadd':
    case 'vdelete':
    case 'vupdate':
      return applyV(t, e, strict);
    case 'jcreate': {
      if (!isSafePath(e.path)) return `unsafe ${e.path}`;
      if (treeGet(t, e.path) !== null) return `exists ${e.path}`;
      treeSet(t, e.path, e.text);
      return null;
    }
    case 'jreplace': {
      if (!isSafePath(e.path)) return `unsafe ${e.path}`;
      const content = treeGet(t, e.path);
      if (content === null) return `missing ${e.path}`;
      // In a CRLF file the text and both strings are read with every CRLF
      // as LF, and the result is written back with CRLF.
      const crlf = splitFile(content).brk === '\r\n';
      const text = crlf ? content.split('\r\n').join('\n') : content;
      const oldStr = crlf ? e.oldStr.split('\r\n').join('\n') : e.oldStr;
      const newStr = crlf ? e.newStr.split('\r\n').join('\n') : e.newStr;
      let count = 0;
      let at = text.indexOf(oldStr);
      while (at >= 0) {
        count++;
        at = text.indexOf(oldStr, at + 1);
      }
      if (count === 0) return `no-match ${e.path}`;
      if (count > 1) return `ambiguous ${e.path}`;
      const replaced = text.replace(oldStr, newStr);
      treeSet(t, e.path, crlf ? replaced.split('\n').join('\r\n') : replaced);
      return null;
    }
    case 'jinsert': {
      if (!isSafePath(e.path)) return `unsafe ${e.path}`;
      const content = treeGet(t, e.path);
      if (content === null) return `missing ${e.path}`;
      const f = splitFile(content);
      if (e.line < 0 || e.line > f.lines.length) return `no-match ${e.path}`;
      const newLines = splitPatch(e.text);
      f.lines.splice(e.line, 0, ...newLines);
      treeSet(t, e.path, joinFile(f));
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// The run itself (SPEC sections 2 and 10)

function run(argv: string[]): { code: number; out: string } {
  const opts = parseArgs(argv);
  if (opts === null) return { code: 2, out: 'error: usage\n' };

  let patchText: string;
  if (opts.patch === null || opts.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(opts.patch, 'utf8');
    } catch {
      return { code: 2, out: 'error: no-patch\n' };
    }
  }
  const patchLines = splitPatch(patchText);

  let format = opts.format;
  if (format === 'auto') {
    const detected = detectFormat(patchLines);
    if (detected === null) return { code: 2, out: 'error: format\n' };
    format = detected;
  }

  let edits: Edit[];
  try {
    edits = parsePatch(format, patchText, patchLines);
  } catch (err) {
    if (err instanceof ParseError) return { code: 2, out: `error: parse ${err.line}\n` };
    throw err;
  }
  if (edits.length === 0) return { code: 2, out: 'error: parse 1\n' };

  const tree = newTree();
  const failures: string[] = [];
  for (const edit of edits) {
    const failure = applyEdit(tree, edit, opts.strict);
    if (failure !== null) failures.push(failure);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f}\n`).join('') + `failed: ${failures.length} of ${edits.length} edits\n`;
    return { code: 1, out };
  }

  const lines = changeLines(tree);
  if (!opts.check) treeWrite(tree);
  const summary = lines.length === 1 ? 'ok: 1 file' : `ok: ${lines.length} files`;
  return { code: 0, out: lines.map((l) => `${l}\n`).join('') + `${summary}\n` };
}

function parsePatch(format: string, text: string, lines: string[]): Edit[] {
  switch (format) {
    case 'json':
      return parseJson(text, lines);
    case 'unified':
      return parseUnified(lines);
    case 'search-replace':
      return parseSearchReplace(lines);
    case 'v4a':
      return parseV4A(lines);
    default:
      throw new ParseError(1);
  }
}

// ---------------------------------------------------------------------------
// Entry point. When the make.fun harness runs this file as a trial it sets
// MAKEFUN_ENV_URL; then the kit's runner drives the checks and the command
// line never runs.

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const { code, out } = run(process.argv.slice(2));
  if (out !== '') writeSync(1, out);
  process.exit(code);
}
