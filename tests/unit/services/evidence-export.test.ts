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

const RUN = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

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
  it('exports a run and verifies clean against its own manifest', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result.outcome).toBe('exported');
    const verdict = await verifyExport(destination);
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
    await exportRunEvidence(workspace, RUN, destination);
    expect((await verifyExport(destination)).ok).toBe(true);

    await fsp.writeFile(path.join(destination, 'smuggled.txt'), 'not in the manifest\n');
    const verdict = await verifyExport(destination);
    expect(verdict.ok).toBe(false);
    expect(verdict.unlisted).toEqual(['smuggled.txt']);

    await fsp.rm(path.join(destination, 'smuggled.txt'));
    expect((await verifyExport(destination)).ok).toBe(true);
  });

  it('a listed file that is absent is reported separately from an unlisted one', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    const victim = result.manifest.contents[0] as { path: string };
    await fsp.rm(path.join(destination, victim.path));
    const verdict = await verifyExport(destination);
    expect(verdict.missing).toEqual([victim.path]);
    expect(verdict.unlisted).toEqual([]);
  });

  it('an edited exported file is detected by its digest', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    const victim = result.manifest.contents[0] as { path: string };
    await fsp.appendFile(path.join(destination, victim.path), 'tampered\n');
    const verdict = await verifyExport(destination);
    expect(verdict.altered).toEqual([victim.path]);
  });

  it('the chain links each entry to its predecessor, and a broken link is detected', async () => {
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    const { chain } = result.manifest;
    expect(chain.length).toBe(result.manifest.contents.length);
    expect(chain[0]?.previousDigest).toBeNull();
    for (let index = 1; index < chain.length; index += 1) {
      expect(chain[index]?.previousDigest).toBe(chain[index - 1]?.digest);
    }

    const manifestPath = path.join(destination, 'manifest.json');
    const tampered = JSON.parse(await fsp.readFile(manifestPath, 'utf8')) as {
      chain: { previousDigest: string | null }[];
    };
    tampered.chain[0] = { ...tampered.chain[0], previousDigest: 'forged' } as never;
    await fsp.writeFile(manifestPath, JSON.stringify(tampered, null, 2));
    expect((await verifyExport(destination)).chainBroken).toBe(true);
  });

  it('redacts at least as much as the product redaction set', async () => {
    // The raw transcript is deliberately unredacted ON DISK. An export crosses a
    // trust boundary the local file does not, so the secret must not survive it.
    const result = await exportRunEvidence(workspace, RUN, destination);
    if (result.outcome !== 'exported') throw new Error('expected an export');
    for (const entry of result.manifest.contents) {
      const body = await fsp.readFile(path.join(destination, entry.path), 'utf8');
      expect(body).not.toContain('sk-ant-secretvaluegoeshere0000000000');
    }
    // ...and the surrounding content still made it out, so redaction did not
    // simply drop the file.
    const transcript = result.manifest.contents.find((entry) => entry.path.includes('raw-'));
    expect(transcript).toBeDefined();
    const body = await fsp.readFile(path.join(destination, (transcript as { path: string }).path), 'utf8');
    expect(body).toContain('transcript line');
  });

  it('refuses when the run has no evidence, rather than producing an empty export', async () => {
    const result = await exportRunEvidence(workspace, '00000000-0000-4000-8000-000000000000', destination);
    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') throw new Error('unreachable');
    expect(result.reason).toBe('no-evidence');
  });

  it('SECURITY: refuses a degenerate run id rather than matching by substring', async () => {
    // `relative.includes(runId)` is how evidence is selected, so `.` or `log` is
    // a substring of nearly every path — an unvalidated id turns a scoped export
    // into one that hands over every Run's evidence. Validated at the boundary
    // because "the caller passes a real id today" is an argument for the check
    // being cheap, not for omitting it.
    for (const bad of ['.', '', 'log', 'raw', '../../etc', '%2e%2e']) {
      const result = await exportRunEvidence(workspace, bad, destination);
      expect(result.outcome, `run id ${JSON.stringify(bad)} must be refused`).toBe('refused');
      if (result.outcome !== 'refused') throw new Error('unreachable');
      expect(result.reason).toBe('invalid-run-id');
    }
    // ...and a real UUID is still accepted, so the guard is not refusing everything.
    expect((await exportRunEvidence(workspace, RUN, destination)).outcome).toBe('exported');
  });

  it('SECURITY: an oversized artifact is omitted WITH its reason, not read into memory', async () => {
    // Retention caps each artifact, but rotated siblings accumulate and the
    // export reads whole files — so without a bound the ceiling is "however much
    // evidence has piled up", and the failure lands during an operator's privacy
    // action. Skip-and-record rather than refuse: refusing the whole export
    // because one artifact is large hands the operator nothing.
    const huge = path.join(workspace, '.schegent', 'sessions', `raw-${RUN}-huge.log`);
    await fsp.writeFile(huge, 'x'.repeat(17 * 1024 * 1024));

    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result.outcome).toBe('exported');
    if (result.outcome !== 'exported') throw new Error('unreachable');

    const omission = result.manifest.deliberateOmissions.find((entry) =>
      entry.path.includes('huge')
    );
    expect(omission, 'the oversized artifact must be enumerated as an omission').toBeDefined();
    expect(omission?.reason).toContain('MiB per-artifact');
    // ...and the rest of the export still happened.
    expect(result.manifest.contents.length).toBeGreaterThan(0);
    expect((await verifyExport(destination)).ok).toBe(true);
  });
});
