import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as vscode from 'vscode';

// FR-014 (US3) contract test. Verifies that the repository's `.gitignore`
// excludes audit-log artifacts under `.schegent/audit.log*` so operator-local
// runtime data cannot enter version control by accident. This test writes
// a placeholder `.schegent/audit.log` (and a rotated archive variant) into
// the active workspace and asserts that `git status --porcelain` does not
// list either path. The fixtures are removed at the end regardless of
// outcome.
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'test workspace has no folder open');
  const workspaceRoot = folder.uri.fsPath;

  // Sanity: this test only makes sense inside a real git checkout; the
  // host suite is run from the project root, so this should always hold.
  let isGitRepo = false;
  try {
    execSync('git rev-parse --git-dir', {
      cwd: workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }
  assert.ok(isGitRepo, `${workspaceRoot} is not inside a git repository`);

  const specifyDir = path.join(workspaceRoot, '.schegent');
  const liveLog = path.join(specifyDir, 'audit.log');
  const rotatedLog = path.join(specifyDir, 'audit.log.20990101T000000Z');

  const created: string[] = [];
  let dirCreated = false;
  try {
    if (!fs.existsSync(specifyDir)) {
      fs.mkdirSync(specifyDir, { recursive: true });
      dirCreated = true;
    }
    if (!fs.existsSync(liveLog)) {
      fs.writeFileSync(liveLog, 'placeholder audit-log content\n');
      created.push(liveLog);
    }
    if (!fs.existsSync(rotatedLog)) {
      fs.writeFileSync(rotatedLog, 'placeholder rotated content\n');
      created.push(rotatedLog);
    }

    const out = execSync('git status --porcelain', {
      cwd: workspaceRoot,
      encoding: 'utf8'
    });
    const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);

    // FR-014: neither audit.log nor any rotated archive shape may appear.
    const offenders = lines.filter((l) =>
      /\.schegent\/audit\.log(\.[^\s]+)?$/.test(l)
    );
    assert.equal(
      offenders.length,
      0,
      `git status lists audit-log artifacts (must be gitignored): ${JSON.stringify(offenders)}`
    );
  } finally {
    for (const p of created) {
      try { fs.unlinkSync(p); } catch { /* best effort */ }
    }
    if (dirCreated) {
      try { fs.rmdirSync(specifyDir); } catch { /* dir may have other contents */ }
    }
  }
}
