// FR-R3-085 — the manifest matches the artifact, in BOTH directions.
//
// "Export produces an artifact whose manifest matches its contents exactly,
// proven by a fixture that adds an unlisted file and observes the check fail."
// The non-vacuity control is written into the acceptance criterion itself, which
// is unusual and correct: a manifest check that cannot fail is a manifest nobody
// can audit against.
import { promises as fsp } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRunEvidence, verifyExport } from '../../../src/services/evidence-export';
import { SanitizedLogger } from '../../../src/lib/logger';
import { createFailureRecorder } from '../../../src/services/failure-record/failure-record-service';
import { allocateAttemptStagingPaths } from '../../../src/services/phase-context/attempt-result-publisher';

const RUN = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const RUN_B = '9b2e5f10-1c2d-4e3f-8a4b-5c6d7e8f9a0b';

let workspace: string;
let destination: string;

async function seed(): Promise<void> {
  await fsp.mkdir(path.join(workspace, '.schegent', 'sessions', '.pending'), { recursive: true });
  await fsp.writeFile(path.join(workspace, '.schegent', 'audit.log'), '{"eventType":"run-started"}\n');
  await fsp.writeFile(
    path.join(workspace, '.schegent', 'sessions', `raw-${RUN}.log`),
    'transcript line\nANTHROPIC_API_KEY=sk-ant-secretvaluegoeshere0000000000\n'
  );
  await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', '.pending', `raw-${RUN}.log`), 'mid-write\n');
  await fsp.writeFile(path.join(workspace, '.schegent', `${RUN}.lock`), 'held\n');
}

beforeEach(async () => {
  workspace = mkdtempSync(path.join(tmpdir(), 'evidence-export-ws-'));
  destination = mkdtempSync(path.join(tmpdir(), 'evidence-export-out-'));
  await seed();
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
  await fsp.rm(destination, { recursive: true, force: true });
});

describe('FR-R3-085 — evidence export', () => {
  it('exports a run into an isolated child directory and verifies clean against its own manifest', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result.outcome).toBe('exported');
    if (result.outcome !== 'exported') throw new Error('expected an export');
    expect(path.dirname(result.directory)).toBe(await fsp.realpath(destination));
    const verdict = await verifyExport(result.directory);
    expect(verdict).toMatchObject({ ok: true, unlisted: [], missing: [], altered: [], chainBroken: false });
  });

  it('the manifest enumerates what it deliberately omits, with reasons', async () => {
    // The half FR-R3-085 calls the point. An export whose contents are not
    // enumerated is a leak the exporter cannot audit — and an omission with no
    // reason is one nobody can evaluate.
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    const omissions = result.manifest.deliberateOmissions;
    expect(omissions.length).toBeGreaterThan(0);
    expect(omissions.some((entry) => entry.path.includes('.pending'))).toBe(true);
    for (const omission of omissions) expect(omission.reason.length).toBeGreaterThan(20);
  });

  it('NON-VACUITY: an unlisted file added to the artifact fails the check', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    expect((await verifyExport(result.directory)).ok).toBe(true);

    await fsp.writeFile(path.join(result.directory, 'smuggled.txt'), 'not in the manifest\n');
    const verdict = await verifyExport(result.directory);
    expect(verdict.ok).toBe(false);
    expect(verdict.unlisted).toEqual(['smuggled.txt']);

    await fsp.rm(path.join(result.directory, 'smuggled.txt'));
    expect((await verifyExport(result.directory)).ok).toBe(true);
  });

  it('a listed file that is absent is reported separately from an unlisted one', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    const victim = result.manifest.contents[0] as { path: string };
    await fsp.rm(path.join(result.directory, victim.path));
    const verdict = await verifyExport(result.directory);
    expect(verdict.missing).toEqual([victim.path]);
    expect(verdict.unlisted).toEqual([]);
  });

  it('an edited exported file is detected by its digest', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    const victim = result.manifest.contents[0] as { path: string };
    await fsp.appendFile(path.join(result.directory, victim.path), 'tampered\n');
    const verdict = await verifyExport(result.directory);
    expect(verdict.altered).toEqual([victim.path]);
  });

  it('the chain links each entry to its predecessor, and a broken or truncated chain is detected', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    const { chain } = result.manifest;
    expect(chain.length).toBe(result.manifest.contents.length);
    expect(chain[0]?.previousDigest).toBeNull();
    for (let index = 1; index < chain.length; index += 1) {
      expect(chain[index]?.previousDigest).toBe(chain[index - 1]?.digest);
    }

    const manifestPath = path.join(result.directory, 'manifest.json');
    const tampered = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as {
      chain: { previousDigest: string | null }[];
    };
    const originalFirst = tampered.chain[0];
    tampered.chain[0] = { ...tampered.chain[0], previousDigest: 'forged' } as never;
    await fsp.writeFile(manifestPath, JSON.stringify(tampered, null, 2));
    expect((await verifyExport(result.directory)).chainBroken).toBe(true);

    // Truncating chain shorter than contents is also detected.
    tampered.chain[0] = originalFirst as never;
    tampered.chain.pop();
    await fsp.writeFile(manifestPath, JSON.stringify(tampered, null, 2));
    expect((await verifyExport(result.directory)).chainBroken).toBe(true);
  });

  it('redacts at least as much as the product redaction set', async () => {
    // The raw transcript is deliberately unredacted ON DISK. An export crosses a
    // trust boundary the local file does not, so the secret must not survive it.
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    for (const entry of result.manifest.contents) {
      const body = await fsp.readFile(path.join(result.directory, entry.path), 'utf8');
      expect(body).not.toContain('sk-ant-secretvaluegoeshere0000000000');
    }
    // ...and the surrounding content still made it out, so redaction did not
    // simply drop the file.
    const transcript = result.manifest.contents.find((entry) => entry.path.includes('raw-'));
    expect(transcript).toBeDefined();
    const body = await fsp.readFile(path.join(result.directory, (transcript as { path: string }).path), 'utf8');
    expect(body).toContain('transcript line');
  });

  it('refuses when the run has no evidence, rather than producing an empty export', async () => {
    const result = await exportRunEvidence(workspace, '00000000-0000-4000-8000-000000000000', destination);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('no-evidence');
  });

  it('SECURITY: refuses a degenerate run id rather than matching by substring', async () => {
    for (const bad of ['.', '', 'log', 'raw', '../../etc', '%2e%2e']) {
      const result = await exportRunEvidence(workspace, bad, destination);
      expect(result.outcome, `run id ${JSON.stringify(bad)} must be refused`).toBe('refused');
      if (result.outcome !== 'refused') throw new Error('unreachable');
      expect(result.reason).toBe('invalid-run-id');
    }
    expect((await exportRunEvidence(workspace, RUN, destination)).outcome).toBe('exported');
  });

  it('SECURITY: an oversized eligible artifact is omitted WITH its reason, not read into memory', async () => {
    const runSessionDir = path.join(workspace, '.schegent', 'sessions', RUN);
    await fsp.mkdir(runSessionDir, { recursive: true });
    const huge = path.join(runSessionDir, 'transport.log');
    await fsp.writeFile(huge, 'x'.repeat(17 * 1024 * 1024));

    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result.outcome).toBe('exported');
    if (result.outcome !== 'exported') throw new Error('unreachable');

    const omission = result.manifest.deliberateOmissions.find((entry) =>
      entry.path.includes('transport.log')
    );
    expect(omission, 'the oversized artifact must be enumerated as an omission').toBeDefined();
    expect(omission?.reason).toContain('MiB per-artifact');
    expect(result.manifest.contents.length).toBeGreaterThan(0);
    expect((await verifyExport(result.directory)).ok).toBe(true);
  });
});

// Post-merge review Findings 1 & 2 — explicit eligible classes, real handoff staging exclusion,
// isolated private per-invocation directory, exact membership verification, and unreadable-source refusal.
describe('Post-merge review Findings 1 & 2 — explicit artifact eligibility, isolated bundle dir, and unreadable sources', () => {
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  it('excludes real producer handoff staging paths, F05 external artifact dirs, and unclassified files even when their path contains the Run UUID', async () => {
    // Seed real producer staging paths via `allocateAttemptStagingPaths` (Finding 1).
    const staging = allocateAttemptStagingPaths(workspace, RUN, 'attempt-0001');
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(staging.contributionAbsPath, '{"summary":"proprietary confidential prose"}\n');
    await fsp.writeFile(staging.reviewReportAbsPath, '{"findings":["internal security details"]}\n');
    await fsp.writeFile(staging.fixClaimsAbsPath, '{"claims":["private patch explanation"]}\n');
    await fsp.writeFile(staging.legacySidecarAbsPath, 'SUMMARY=confidential\n');

    // Also seed sibling omitted subtrees + another Run's handoff + an unclassified path carrying RUN.
    const otherStaging = allocateAttemptStagingPaths(workspace, RUN_B, 'attempt-0002');
    await fsp.mkdir(otherStaging.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(otherStaging.contributionAbsPath, '{"summary":"other run prose"}\n');

    await fsp.mkdir(path.join(workspace, '.schegent', 'immutable-results', RUN), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.schegent', 'immutable-results', RUN, 'capture.json'), '{"secret":"no"}\n');
    await fsp.mkdir(path.join(workspace, '.schegent', 'handoff-materialized', RUN), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.schegent', 'handoff-materialized', RUN, 'note.md'), 'private handoff\n');
    await fsp.mkdir(path.join(workspace, '.schegent', 'transcripts'), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.schegent', 'transcripts', `${RUN}.log`), 'f05 external blob\n');
    await fsp.writeFile(path.join(workspace, '.schegent', `unclassified-${RUN}.txt`), 'unknown class prose\n');
    await fsp.writeFile(path.join(workspace, '.schegent', 'cli-transport.log'), 'legacy shared transport\n');

    // Also seed eligible diagnostics tree, transport, and history description for RUN.
    const diagDir = path.join(workspace, '.schegent', 'sessions', RUN, 'diagnostics', 'wf', 'plan', 'iter-1');
    await fsp.mkdir(diagDir, { recursive: true });
    await fsp.writeFile(path.join(diagDir, 'debug.json'), '{"ok":true}\n');
    await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', RUN, 'transport.log'), 'transport ok\n');
    await fsp.mkdir(path.join(workspace, '.schegent', 'history'), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.schegent', 'history', `${RUN}.txt`), 'task description\n');

    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result.outcome).toBe('exported');
    if (result.outcome !== 'exported') throw new Error('expected exported');

    const exportedNames = result.manifest.contents.map((entry) => entry.path);
    expect(exportedNames).toContain('.schegent__audit.log');
    expect(exportedNames).toContain(`.schegent__sessions__raw-${RUN}.log`);
    expect(exportedNames).toContain(`.schegent__sessions__${RUN}__transport.log`);
    expect(exportedNames).toContain(`.schegent__sessions__${RUN}__diagnostics__wf__plan__iter-1__debug.json`);
    expect(exportedNames).toContain(`.schegent__history__${RUN}.txt`);

    // None of the omitted or unclassified files may appear in exported contents or on disk.
    for (const forbidden of [
      'results',
      'immutable-results',
      'handoff-materialized',
      'transcripts',
      'unclassified-',
      'cli-transport.log',
      'contribution.json',
      'review-report.json',
      'fix-claims.json'
    ]) {
      expect(exportedNames.some((name) => name.includes(forbidden)), `must not export ${forbidden}`).toBe(false);
    }

    // Disclosed omitted subtrees and the run-named unknown file are enumerated in deliberateOmissions,
    // and RUN_B never leaks into RUN's manifest.
    const omittedPaths = result.manifest.deliberateOmissions.map((o) => o.path);
    expect(omittedPaths).toContain('.schegent/results');
    expect(omittedPaths).toContain('.schegent/immutable-results');
    expect(omittedPaths).toContain('.schegent/handoff-materialized');
    expect(omittedPaths).toContain('.schegent/transcripts');
    expect(omittedPaths).toContain('.schegent/cli-transport.log');
    expect(omittedPaths).toContain(`.schegent/unclassified-${RUN}.txt`);
    expect(JSON.stringify(result.manifest)).not.toContain(RUN_B);
    expect((await verifyExport(result.directory)).ok).toBe(true);
  });

  it('refuses with no-evidence when only staged handoff files exist for the Run', async () => {
    const onlyHandoffRun = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const staging = allocateAttemptStagingPaths(workspace, onlyHandoffRun, 'attempt-0001');
    await fsp.mkdir(staging.stagingDirAbsPath, { recursive: true });
    await fsp.writeFile(staging.contributionAbsPath, '{"summary":"private only"}\n');

    const result = await exportRunEvidence(workspace, onlyHandoffRun, destination);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'no-evidence' });
    expect(await fsp.readdir(destination)).toEqual([]);
  });

  it('publishes two exports to one selected parent into disjoint child directories, verifies exact membership, and preserves pre-existing operator files untouched', async () => {
    // Seed a second Run's evidence too.
    await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', `raw-${RUN_B}.log`), 'run B transcript\n');

    // Pre-existing operator files (including a pre-existing manifest.json!) in the selected parent folder.
    const operatorNotes = path.join(destination, 'operator-notes.txt');
    const preExistingManifest = path.join(destination, 'manifest.json');
    await fsp.writeFile(operatorNotes, 'keep my notes untouched\n');
    await fsp.writeFile(preExistingManifest, '{"owner":"operator-file"}\n');

    const fixedNow = () => new Date('2026-11-27T13:00:00.000Z');
    const exportA = await exportRunEvidence(workspace, RUN, destination, fixedNow);
    const exportB = await exportRunEvidence(workspace, RUN_B, destination, fixedNow);
    const exportA2 = await exportRunEvidence(workspace, RUN, destination, fixedNow);

    expect(exportA.outcome).toBe('exported');
    expect(exportB.outcome).toBe('exported');
    expect(exportA2.outcome).toBe('exported');
    if (exportA.outcome !== 'exported' || exportB.outcome !== 'exported' || exportA2.outcome !== 'exported') {
      throw new Error('expected all exports to succeed');
    }

    // All three bundle directories are disjoint children of destination.
    const dirs = new Set([exportA.directory, exportB.directory, exportA2.directory]);
    expect(dirs.size).toBe(3);

    // Every bundle verifies clean on its own with zero cross-run mixing.
    expect(await verifyExport(exportA.directory)).toMatchObject({ ok: true, unlisted: [], missing: [], altered: [], chainBroken: false });
    expect(await verifyExport(exportB.directory)).toMatchObject({ ok: true, unlisted: [], missing: [], altered: [], chainBroken: false });
    expect(await verifyExport(exportA2.directory)).toMatchObject({ ok: true, unlisted: [], missing: [], altered: [], chainBroken: false });
    expect(exportA.manifest.contents.some((e) => e.path.includes(RUN_B))).toBe(false);
    expect(exportB.manifest.contents.some((e) => e.path.includes(RUN))).toBe(false);

    // Pre-existing operator files in the selected parent remain untouched byte-for-byte.
    expect(await fsp.readFile(operatorNotes, 'utf8')).toBe('keep my notes untouched\n');
    expect(await fsp.readFile(preExistingManifest, 'utf8')).toBe('{"owner":"operator-file"}\n');
  });

  posixOnly('refuses explicitly with unreadable-source when an eligible evidence directory cannot be listed', async () => {
    const unreadableDir = path.join(workspace, '.schegent', 'sessions', RUN, 'diagnostics');
    await fsp.mkdir(unreadableDir, { recursive: true });
    await fsp.writeFile(path.join(unreadableDir, 'verbose.log'), 'secret diag\n');
    await fsp.chmod(unreadableDir, 0o000);
    try {
      const result = await exportRunEvidence(workspace, RUN, destination);
      // Root users (uid 0) bypass POSIX mode 000; skip assertion only in that rare case.
      if (process.getuid?.() !== 0) {
        expect(result.outcome).toBe('refused');
        if (result.outcome !== 'refused') throw new Error('expected refused');
        expect(result.reason).toBe('unreadable-source');
        expect(result.detail).toContain('diagnostics');
        expect(await fsp.readdir(destination)).toEqual([]);
      }
    } finally {
      await fsp.chmod(unreadableDir, 0o700);
    }
  });
});

// FR-R4-F15 (feature 243, contract K4, K6.9; FR-017, D14) — the Run-scoped export carries a Run's
// failure records and no other Run's.
describe('FR-R4-F15 K6.9 — the export includes one Run\'s failure records', () => {
  const TASK_A = '11111111-1111-4111-8111-111111111111';
  const TASK_B = '22222222-2222-4222-8222-222222222222';

  async function writeRecord(runId: string, taskId: string, summary: string): Promise<void> {
    const recorder = createFailureRecorder({
      logger: new SanitizedLogger(),
      queue: { queueIdForExistingTask: () => 'default' },
      workspaceRoot: workspace
    });
    const wrote = await recorder.record({
      run: { id: runId, featureId: taskId, currentPhase: 'implement' },
      cause: 'last_phase_issues_remain',
      result: { kind: 'remaining_issues', issues: [{ tag: 'regression', summary }], auditEntry: null }
    });
    expect(wrote).toBe(true);
  }

  it('carries both of Run A\'s records and none of Run B\'s, and verifies clean', async () => {
    await writeRecord(RUN, TASK_A, 'run A first');
    await writeRecord(RUN, TASK_A, 'run A second');
    await writeRecord(RUN_B, TASK_B, 'run B only');
    const onDisk = await fsp.readdir(path.join(workspace, '.schegent', 'failure-records'));
    expect(onDisk.filter((name) => name.includes(`_${RUN_B}_`))).toHaveLength(1);

    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');

    const exported = result.manifest.contents.map((entry) => entry.path);
    const records = exported.filter((entry) => entry.includes('failure-records__'));
    expect(records).toHaveLength(2);
    for (const entry of records) {
      expect(entry).toContain(`_${RUN}_`);
      expect(entry).toContain(TASK_A);
    }
    expect(exported.some((entry) => entry.includes(RUN_B))).toBe(false);
    expect(JSON.stringify(result.manifest)).not.toContain(RUN_B);
    expect(await verifyExport(result.directory)).toMatchObject({ ok: true, unlisted: [], missing: [], altered: [] });
  });

  it('omits the records of a Run with none, and refuses a Run that has no evidence at all', async () => {
    await writeRecord(RUN_B, TASK_B, 'run B only');
    await fsp.rm(path.join(workspace, '.schegent', 'sessions'), { recursive: true });
    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'no-evidence' });
  });
});

describe('FR-R4-F04 T16 — owner-only outputs and the shared-audit statement', () => {
  const STATEMENT = "The audit history is shared: it holds every Run's metadata, not only this Run's.";
  const posixOnly = process.platform === 'win32' ? it.skip : it;

  async function writeAudit(...lines: string[]): Promise<void> {
    await fsp.writeFile(path.join(workspace, '.schegent', 'audit.log'), `${lines.join('\n')}\n`);
  }

  posixOnly('writes bundle files 0600 inside a fresh 0700 child directory without touching pre-existing 0644 files in the parent', async () => {
    const flatInParent = path.join(destination, `.schegent__sessions__raw-${RUN}.log`);
    await fsp.writeFile(flatInParent, 'older bytes\n');
    await fsp.chmod(flatInParent, 0o644);

    const result = await exportRunEvidence(workspace, RUN, destination);

    expect(result.outcome).toBe('exported');
    if (result.outcome !== 'exported') throw new Error('expected exported');
    expect((await fsp.stat(result.directory)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(path.join(result.directory, `.schegent__sessions__raw-${RUN}.log`))).mode & 0o777).toBe(0o600);
    expect((await fsp.stat(path.join(result.directory, 'manifest.json'))).mode & 0o777).toBe(0o600);
    expect(await fsp.readFile(flatInParent, 'utf8')).toBe('older bytes\n');
  });

  posixOnly('creates a destination parent and child bundle directory owner-only when the parent does not exist', async () => {
    const nested = path.join(destination, 'made', 'here');
    const result = await exportRunEvidence(workspace, RUN, nested);
    expect(result.outcome).toBe('exported');
    if (result.outcome !== 'exported') throw new Error('expected exported');
    expect((await fsp.stat(nested)).mode & 0o777).toBe(0o700);
    expect((await fsp.stat(result.directory)).mode & 0o777).toBe(0o700);
  });

  it('states that the audit history is shared, once, with a file entry for each audit file included', async () => {
    await fsp.writeFile(path.join(workspace, '.schegent', 'audit.log.20260101T000000Z'), '{"eventType":"phase-start","schemaVersion":3,"payload":{}}\n');
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');

    const shared = result.manifest.sharedAuditHistory;
    expect(shared, 'present when an audit file is included').not.toBeNull();
    expect(shared!.statement).toBe(STATEMENT);
    const auditContents = result.manifest.contents.filter((entry) => /audit\.log/.test(entry.path));
    expect(auditContents.length, 'the control: audit files were included').toBeGreaterThanOrEqual(2);
    expect(shared!.files.map((file) => file.path).sort()).toEqual(auditContents.map((entry) => entry.path).sort());
  });

  it('labels an audit file holding retired stream rows legacy-content, and a v3 history metadata-only', async () => {
    await writeAudit(
      '{"eventType":"phase-start","schemaVersion":3,"payload":{}}',
      '{"eventType":"monitor-stdout-line","schemaVersion":2,"payload":{"line":"x"}}'
    );
    await fsp.writeFile(path.join(workspace, '.schegent', 'audit.log.20260101T000000Z'), '{"eventType":"phase-start","schemaVersion":3,"payload":{}}\n');
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');

    const byName = Object.fromEntries(result.manifest.sharedAuditHistory!.files.map((file) => [file.path, file.content]));
    expect(byName['.schegent__audit.log']).toBe('legacy-content');
    expect(byName['.schegent__audit.log.20260101T000000Z']).toBe('metadata-only');
  });

  it('is null when no audit file is included', async () => {
    await fsp.rm(path.join(workspace, '.schegent', 'audit.log'));
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    expect(result.manifest.sharedAuditHistory).toBeNull();
  });

  it('is null when the Run has no evidence of its own, because nothing is exported', async () => {
    const result = await exportRunEvidence(workspace, RUN_B, destination);
    expect(result.outcome).toBe('refused');
  });

  it('still verifies: the new field is additive', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    expect(await verifyExport(result.directory)).toMatchObject({ ok: true, unlisted: [], missing: [], altered: [], chainBroken: false });
  });

  it('rolls back the isolated bundle directory and preserves pre-existing operator files when redaction or writing fails mid-export (FR-R5-F14, NS-08)', async () => {
    const preExisting = path.join(destination, 'operator-notes.txt');
    await fsp.writeFile(preExisting, 'keep me intact\n');

    let calls = 0;
    const throwingLogger = {
      sanitize: (text: string): string => {
        calls += 1;
        if (calls >= 2) throw new RangeError('simulated sanitizer stack overflow on second artifact');
        return text;
      }
    };

    const result = await exportRunEvidence(workspace, RUN, destination, () => new Date(), throwingLogger);
    expect(result).toEqual({
      outcome: 'refused',
      reason: 'write-failed',
      detail: 'redaction-failed'
    });
    const remaining = await fsp.readdir(destination);
    expect(remaining).toEqual(['operator-notes.txt']);
    expect(await fsp.readFile(preExisting, 'utf8')).toBe('keep me intact\n');
  });

  it('removes newly created parent and bundle directories when a later artifact fails mid-export (FR-R5-F14)', async () => {
    const priorAuditCopy = path.join(destination, '.schegent__audit.log');
    await fsp.writeFile(priorAuditCopy, 'prior exported audit bytes\n');

    let calls = 0;
    const throwingLogger = {
      sanitize: (text: string): string => {
        calls += 1;
        if (calls >= 2) throw new Error('second artifact failed after first was written');
        return text;
      }
    };

    const result = await exportRunEvidence(workspace, RUN, destination, () => new Date(), throwingLogger);
    expect(result.outcome).toBe('refused');
    expect(await fsp.readFile(priorAuditCopy, 'utf8')).toBe('prior exported audit bytes\n');
    expect(await fsp.readdir(destination)).toEqual(['.schegent__audit.log']);

    const nestedDest = path.join(destination, 'fresh-subdir', 'nested');
    let nestedCalls = 0;
    const nestedResult = await exportRunEvidence(workspace, RUN, nestedDest, () => new Date(), {
      sanitize: (text: string): string => {
        nestedCalls += 1;
        if (nestedCalls >= 2) throw new Error('fail inside newly created directory');
        return text;
      }
    });
    expect(nestedResult.outcome).toBe('refused');
    await expect(fsp.stat(path.join(destination, 'fresh-subdir'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
