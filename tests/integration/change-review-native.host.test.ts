import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { PLACEHOLDER_SENTENCES } from '../../src/contracts/change-review';
import { createChangeReviewService } from '../../src/services/change-review/change-review-service';
import { createExecFileGitRunner } from '../../src/services/execution-lanes/git-runner';
import type { RequestRecord } from '../../src/services/execution-lanes/integration-store-rows';
import { CHANGES_COMMAND, openReviewInEditor, type EditorPort } from '../../src/ui/change-review/review-opener';
import { createVscodeEditorPort, registerChangeReviewProvider } from '../../src/ui/change-review/review-editor-binding';
import { ABSENT_SEGMENT, REVIEW_SCHEME, documentPath } from '../../src/ui/change-review/review-uri';

const REQUEST_ID = 'e'.repeat(32);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'user.name=Review Test', '-c', 'user.email=review@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(cwd) }
  }).trim();
}

function fixtureRepository(root: string): { readonly target: string; readonly candidate: string } {
  git(root, ['init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(root, 'kept.txt'), 'before\n');
  fs.writeFileSync(path.join(root, 'gone.txt'), 'old file\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'target']);
  const target = git(root, ['rev-parse', 'HEAD']);
  git(root, ['checkout', '--quiet', '-b', 'candidate']);
  fs.writeFileSync(path.join(root, 'kept.txt'), 'after\n');
  fs.rmSync(path.join(root, 'gone.txt'));
  fs.writeFileSync(path.join(root, 'new.txt'), 'new file\n');
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'candidate']);
  return { target, candidate: git(root, ['rev-parse', 'HEAD']) };
}

function request(target: string, candidate: string): RequestRecord {
  return {
    requestId: REQUEST_ID,
    laneId: 'lane-host',
    workspaceId: 'ws-host',
    repositoryId: 'repo-host',
    candidateId: 'cand-host',
    candidateCommit: candidate,
    targetRef: 'refs/heads/main',
    expectedTargetCommit: target,
    profileId: 'default',
    profileRevision: 1,
    profileDigest: 'digest-host',
    profileJson: '{}',
    state: 'awaiting-review',
    reason: null,
    verificationAttempt: 1,
    ownerGeneration: 1,
    createdAt: '2026-11-11T00:00:00.000Z',
    updatedAt: '2026-11-11T00:00:00.000Z'
  };
}

async function documentText(documentPathValue: string): Promise<string> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: REVIEW_SCHEME, path: documentPathValue }));
  return document.getText();
}

/**
 * FR-R6-F12 T021 (FR-004, FR-005, FR-014) — a change review served by the real editor host: the
 * content provider reads each side by handle, the absent side reads empty, an unknown path reads the
 * fixed sentence, and the opener uses the multi-file view when the host has it. The pick is
 * answered by the test, so a fallback host never waits on a person.
 */
export async function run(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-change-review-host-'));
  const disposables: vscode.Disposable[] = [];
  try {
    const { target, candidate } = fixtureRepository(root);
    const record = request(target, candidate);
    const reviews = createChangeReviewService({
      source: { getRequest: (id) => (id === REQUEST_ID ? record : null), getReceipt: () => null },
      git: createExecFileGitRunner(),
      cwd: root
    });
    disposables.push(registerChangeReviewProvider(reviews));

    const result = await reviews.openReview({ requestId: REQUEST_ID });
    assert.ok(result.ok, 'openReview refused');
    const opened = result.value;
    assert.equal(opened.state, 'current');
    const entries = opened.firstPage.entries;
    assert.deepEqual(
      entries.map((entry) => [entry.kind, entry.oldPath, entry.newPath]),
      [
        ['deleted', 'gone.txt', null],
        ['modified', 'kept.txt', 'kept.txt'],
        ['added', null, 'new.txt']
      ]
    );

    const [deleted, modified, added] = [entries.at(0), entries.at(1), entries.at(2)];
    assert.equal(await documentText(documentPath(modified?.oldHandle ?? null, 'kept.txt')), 'before\n');
    assert.equal(await documentText(documentPath(modified?.newHandle ?? null, 'kept.txt')), 'after\n');
    assert.equal(await documentText(documentPath(deleted?.oldHandle ?? null, 'gone.txt')), 'old file\n');
    assert.equal(await documentText(documentPath(added?.newHandle ?? null, 'new.txt')), 'new file\n');
    assert.equal(await documentText(`/${ABSENT_SEGMENT}/new.txt`), '');
    assert.equal(await documentText('/not-a-handle/x.txt'), PLACEHOLDER_SENTENCES.unavailable);

    const real = createVscodeEditorPort();
    const answered: EditorPort = { ...real, showNotice: () => undefined, pick: () => Promise.resolve(0) };
    const native = await real.hasCommand(CHANGES_COMMAND);
    const shown = await openReviewInEditor(answered, opened, reviews.entriesOf(opened.review.reviewId) ?? []);
    console.log(`[change-review] multi-file review view in this host: ${native ? 'native' : 'fallback'}`);
    assert.deepEqual(shown, native ? { mode: 'native', opened: 3 } : { mode: 'fallback', opened: 1 });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  } finally {
    for (const disposable of disposables) disposable.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
