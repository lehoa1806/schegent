// FR-R3-104 — importing the canary must not spend a live turn.
//
// THE INCIDENT, on 2026-08-27: a `node -e "import('./scripts/backend-canary-run.mjs')"` written as
// a syntax check RAN THE WHOLE CANARY — three live turns against three real CLIs, on the operator's
// own subscription quota. Everything in the module was top-level, so importing it was executing it.
//
// WHY IT IS WORTH A TEST rather than a fixed guard and a note. The item this file belongs to exists
// because a live turn is expensive: expensive enough that the qualification cadence gates a RELEASE
// rather than a gate run, and expensive enough that its own acceptance was recorded as `unqualified`
// rather than spent. A module that spends three of them the moment anything touches it contradicts
// the item it implements — and the cost is invisible until the bill.
//
// This drives the real module in a child process and asserts that nothing was probed. A textual
// check for `import.meta.url` would pass on a guard that was written and then bypassed.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = 'scripts/backend-canary-run.mjs';

describe('the canary is free to import and expensive only to run', () => {
  it('runs no probe when the module is imported', () => {
    const output = execFileSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(resolve(REPO_ROOT, SCRIPT))})`],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
    );
    // The report header the run prints. Its absence is what says no probe happened.
    expect(output).not.toContain('[backend-canary] results');
    expect(output).not.toContain('live probe passed');
    expect(output).not.toContain('qualification record written');
  });

  it('says out loud that it did nothing, rather than looking like a silent success', () => {
    // A module that imports quietly is one somebody will believe ran. The line goes to stderr so
    // it cannot be mistaken for a report on stdout.
    const run = spawnSync(
      process.execPath,
      ['-e', `import(${JSON.stringify(resolve(REPO_ROOT, SCRIPT))})`],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000 }
    );
    expect(run.stderr).toContain('imported rather than executed');
    expect(run.stderr).toContain('npm run canary');
    expect(run.stdout, 'nothing may reach stdout, where a report would go').toBe('');
  });

  it('still exposes the guard in the source, so the mechanism is findable', () => {
    // The behavioural cases above are the load-bearing half. This one names WHERE the behaviour
    // comes from, because a future reader deleting the guard should find this test by grepping it.
    const source = readFileSync(resolve(REPO_ROOT, SCRIPT), 'utf8');
    expect(source).toContain('import.meta.url === pathToFileURL(process.argv[1]).href');
  });
});
