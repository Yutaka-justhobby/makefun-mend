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
  | { type: 'jinsert'; path: string; line: number; text: string };

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
// Applying edits (SPEC sections 9 and 10)

function applyEdit(t: Tree, e: Edit, _strict: boolean): string | null {
  switch (e.type) {
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
    default:
      // The unified, search-replace and v4a readers are added in later stages.
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
