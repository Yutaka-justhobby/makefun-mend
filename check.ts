// The practice set, run on my own machine: `node check.ts <practice.json>
// [<family or key prefix>...]`.
//
// Each practice check names its arguments, its standard input (or none), the
// files it starts with and what the house reference did: the exit code, the
// standard output and the changes (a path's new bytes, or null for a file
// that is gone). This runs `node main.ts` on each check in a fresh directory
// holding exactly the check's files, compares all three, prints every check
// that differs with what differed, and ends with the practice score:
// round(1000 * passed / checks).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PracticeCheck {
  key: string;
  group: string;
  family: string;
  argv: string[];
  stdin: string | null;
  files: Record<string, string>;
  expect: {
    exit: number;
    stdout: string;
    changes: Record<string, string | null>;
  };
}

const mainTs = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

const [file, ...only] = process.argv.slice(2);
if (file === undefined) {
  process.stderr.write('usage: node check.ts <practice.json> [<family or key prefix>...]\n');
  process.exit(2);
}
const { checks } = JSON.parse(readFileSync(file, 'utf8')) as { checks: PracticeCheck[] };
const picked =
  only.length === 0 ? checks : checks.filter((c) => only.some((o) => c.family === o || c.key.startsWith(o)));

function readTree(dir: string, base: string, out: Record<string, string>): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = base === '' ? name : `${base}/${name}`;
    if (statSync(full).isDirectory()) readTree(full, rel, out);
    else out[rel] = readFileSync(full, 'utf8');
  }
}

function runOne(c: PracticeCheck): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'mend-check-'));
  try {
    for (const [p, content] of Object.entries(c.files)) {
      const full = join(dir, p);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, 'utf8');
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== 'MAKEFUN_ENV_URL' && v !== undefined) env[k] = v;
    }
    const res = spawnSync('node', [mainTs, ...c.argv], {
      cwd: dir,
      input: c.stdin ?? '',
      env,
      timeout: 10_000,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const want: Record<string, string> = { ...c.files };
    for (const [p, v] of Object.entries(c.expect.changes)) {
      if (v === null) delete want[p];
      else want[p] = v;
    }
    const got: Record<string, string> = {};
    readTree(dir, '', got);
    const why: string[] = [];
    const gotExit = res.status;
    if (gotExit !== c.expect.exit) why.push(`exit ${gotExit}, expected ${c.expect.exit}`);
    const gotStdout = res.stdout ?? '';
    if (gotStdout !== c.expect.stdout)
      why.push(`stdout ${JSON.stringify(gotStdout)}, expected ${JSON.stringify(c.expect.stdout)}`);
    for (const p of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (want[p] === undefined) why.push(`${p} should not exist`);
      else if (got[p] === undefined) why.push(`${p} is missing, expected ${JSON.stringify(want[p])}`);
      else if (got[p] !== want[p])
        why.push(`${p} is ${JSON.stringify(got[p])}, expected ${JSON.stringify(want[p])}`);
    }
    if (res.error) why.push(`runner error: ${res.error.message}`);
    return why;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let passed = 0;
for (const c of picked) {
  const why = runOne(c);
  if (why.length === 0) {
    passed++;
  } else {
    process.stdout.write(`FAIL ${c.family} ${c.key}\n`);
    for (const w of why) process.stdout.write(`  ${w}\n`);
  }
}
process.stdout.write(`score: ${Math.round((1000 * passed) / picked.length)} (${passed}/${picked.length})\n`);
