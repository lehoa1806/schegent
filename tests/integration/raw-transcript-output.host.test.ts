import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import * as vscode from 'vscode';
import { RawTranscriptWriter } from '../../src/audit/raw-transcript-writer';
import { SanitizedLogger } from '../../src/lib/logger';

// T014 / SC-001 / SC-005 contract test. Host-environment smoke that:
//   1. Exercises `RawTranscriptWriter` against the real workspace root, asserting
//      that `<workspaceRoot>/.schegent/sessions/raw-<runId>.log` exists with the
//      documented `SESSION START` divider and an `[EXIT_CODE]:` line after a
//      single appendStart/appendEnd cycle (covers SC-001 — file present after
//      run, well-formed).
//   2. Verifies that the produced file does NOT appear in `git status --porcelain`
//      (covers SC-005 — `.schegent/` is gitignored). The artefact is removed at
//      the end regardless of outcome.
export async function run(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'test workspace has no folder open');
  const workspaceRoot = folder.uri.fsPath;

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

  const runId = `host-smoke-${Date.now()}`;
  const targetPath = path.join(workspaceRoot, '.schegent', 'sessions', `raw-${runId}.log`);
  const sessionsDir = path.join(workspaceRoot, '.schegent', 'sessions');
  const schegentDir = path.join(workspaceRoot, '.schegent');

  const created = { sessionsDir: false, schegentDir: false, file: false };
  try {
    if (!fs.existsSync(schegentDir)) created.schegentDir = true;
    if (!fs.existsSync(sessionsDir)) created.sessionsDir = true;

    const writer = new RawTranscriptWriter(workspaceRoot, new SanitizedLogger());
    await writer.appendStart({
      runId,
      phase: 'speckit-specify',
      iteration: 1,
      prompt: 'host-smoke prompt'
    });
    await writer.appendEnd({
      runId,
      stdout: 'host-smoke stdout',
      stderr: '',
      exitCode: 0,
      killed: false,
      timedOut: false
    });

    assert.ok(fs.existsSync(targetPath), `expected raw transcript at ${targetPath}`);
    created.file = true;

    const contents = fs.readFileSync(targetPath, 'utf8');
    assert.ok(
      contents.includes('========== SESSION START =========='),
      'SESSION START divider missing'
    );
    assert.match(contents, /\[EXIT_CODE\]:\s+/, '[EXIT_CODE] line missing');
    assert.ok(
      contents.includes(`Run ID: ${runId}`),
      'Run ID header missing'
    );

    const out = execSync('git status --porcelain', {
      cwd: workspaceRoot,
      encoding: 'utf8'
    });
    const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const offenders = lines.filter((l) => /\.schegent\//.test(l));
    assert.equal(
      offenders.length,
      0,
      `git status lists raw-transcript artefacts (must be gitignored): ${JSON.stringify(offenders)}`
    );
  } finally {
    if (created.file) {
      try { fs.unlinkSync(targetPath); } catch { /* best effort */ }
    }
    if (created.sessionsDir) {
      try { fs.rmdirSync(sessionsDir); } catch { /* may have other contents */ }
    }
    if (created.schegentDir) {
      try { fs.rmdirSync(schegentDir); } catch { /* may have other contents */ }
    }
  }
}
