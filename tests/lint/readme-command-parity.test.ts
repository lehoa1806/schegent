// Feature 056 Track 5 (FR-028, T040) — Doc-drift guard.
//
// Every command in `package.json` `contributes.commands[*].command` that
// starts with `schegent.` and is user-facing must appear at least once
// in README.md so the README reference table stays a complete index.
//
// Allowlist: a small set of commands that are intentionally internal
// (registered by code paths but not user-runnable) — those skip the
// README check via the `INTERNAL_COMMAND_ALLOWLIST` set.

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface ContribCmd {
  command: string;
  title?: string;
  category?: string;
}

const INTERNAL_COMMAND_ALLOWLIST = new Set<string>([
  // Internal redetection helper — surfaced only from the dashboard,
  // never the command palette directly.
  'schegent.redetectClaudeTransport'
]);

describe('Feature 056 Track 5 — README command table covers every contributed command', () => {
  it('README.md contains every schegent.* command from package.json (modulo internal allowlist)', () => {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const cmds: ContribCmd[] = pkgJson.contributes?.commands ?? [];
    const schegentCmds = cmds
      .map((c) => c.command)
      .filter((c) => typeof c === 'string' && c.startsWith('schegent.'));
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const missing: string[] = [];
    for (const cmd of schegentCmds) {
      if (INTERNAL_COMMAND_ALLOWLIST.has(cmd)) continue;
      if (!readme.includes(cmd)) {
        missing.push(cmd);
      }
    }
    expect(missing).toEqual([]);
  });
});
