import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { UNKNOWN_BUILD_IDENTITY } from '../../../src/lib/build-identity';
import { SanitizedLogger } from '../../../src/lib/logger';
import { collectBundle, probeBundle, type BundleSources } from '../../../src/services/diagnostics-bundle/bundle-collect';
import { planBundle } from '../../../src/services/diagnostics-bundle/bundle-plan';
import { exportRunEvidence } from '../../../src/services/evidence-export';
import { appendExportAudit } from '../../../src/services/process-yaml/export-service';
import type { RedactionCase } from '../../fixtures/redaction-corpus';
import { assertAbsentIn, assertOutcomeIn, casesFor } from './sink-cases';

/**
 * FR-R4-F10 (contract test T14; SK1 to SK4; FR-024, FR-025; hard rules 21, 22) -- the export paths,
 * each driven through its real caller and read back from what it produced.
 *
 * WHAT IT PINS. An export crosses a trust boundary the local file does not. Evidence export reads a
 * whole artifact (up to 16 MiB) and sanitizes it in one call, so the cases are placed at the start,
 * in the middle and at the end of a file that mixes audit JSONL with transport lines, and the files in
 * the destination are what is read. The diagnostics bundle redacts its text items and its structured
 * items (`sanitizeRecord`), so a keyed secret in the host settings and in the run status is checked
 * in the collected items. The process-definition export records an audit row, so the identifier it
 * carries goes through the real writer: a supported secret in it is refused and never written, a
 * negative is written whole.
 *
 * NOT A SINK OF THIS FEATURE (SK4): the exported DOCUMENT body is not passed through the redactor
 * today, and nothing here asserts it.
 */
/** A URL or an absolute path: the audit projection refuses one, and the bundle rewrites paths by design. */
const carriesUrlOrPath = (text: string): boolean => /:\/\/|\/(?:Users|home|var|tmp)\//.test(text);

const RUN = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ISO = '2026-11-01T00:00:00.000Z';

let workspace: string;
let destination: string;

beforeEach(async () => {
  workspace = await fsp.mkdtemp(path.join(tmpdir(), 'redaction-export-ws-'));
  destination = await fsp.mkdtemp(path.join(tmpdir(), 'redaction-export-out-'));
});

afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
  await fsp.rm(destination, { recursive: true, force: true });
});

/** Supported cases first and last, so the start and the end of the artifact both hold a secret. */
function arrangedCases(): RedactionCase[] {
  const cases = casesFor('export');
  const supported = cases.filter((testCase) => testCase.expected === 'redacted');
  const others = cases.filter((testCase) => testCase.expected !== 'redacted');
  expect(supported.length).toBeGreaterThan(20);
  return [supported.at(0) as RedactionCase, ...others, ...supported.slice(1, -1), supported.at(-1) as RedactionCase];
}

/** One artifact mixing audit JSONL rows and transport lines, one line per case. */
function artifactFor(cases: readonly RedactionCase[]): string {
  return cases
    .map((testCase, index) =>
      index % 2 === 0
        ? JSON.stringify({ eventType: 'monitor-note', runId: RUN, payload: { note: testCase.build() } })
        : `${ISO}\t${RUN}\tspeckit-implement\tstdout\t${testCase.build()}`
    )
    .join('\n');
}

async function destinationText(): Promise<string> {
  const names = (await fsp.readdir(destination)).filter((name) => name !== 'manifest.json');
  const parts = await Promise.all(names.map((name) => fsp.readFile(path.join(destination, name), 'utf8')));
  return parts.join('\n');
}

describe('evidence export, a whole artifact in one call (SK2)', () => {
  it('writes no part of a supported secret, at the start, in the middle or at the end', async () => {
    const cases = arrangedCases();
    const artifact = artifactFor(cases);
    await fsp.mkdir(path.join(workspace, '.schegent', 'sessions'), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', `raw-${RUN}.log`), artifact);
    await fsp.writeFile(path.join(workspace, '.schegent', 'audit.log'), artifact);
    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result.outcome).toBe('exported');
    const text = await destinationText();
    expect(text.length).toBeGreaterThan(artifact.length / 2);
    for (const testCase of cases) {
      if (testCase.expected === 'redacted' || testCase.expected === 'over-redacted') {
        assertAbsentIn(text, testCase, 'evidence export');
      }
    }
  });

  it('writes every negative case whole in the exported raw transcript', async () => {
    const cases = arrangedCases();
    await fsp.mkdir(path.join(workspace, '.schegent', 'sessions'), { recursive: true });
    await fsp.writeFile(path.join(workspace, '.schegent', 'sessions', `raw-${RUN}.log`), cases.map((c) => `${ISO}\t${RUN}\tp\tstdout\t${c.build()}`).join('\n'));
    const result = await exportRunEvidence(workspace, RUN, destination);
    expect(result.outcome).toBe('exported');
    const text = await destinationText();
    for (const testCase of cases) {
      if (testCase.expected === 'preserved') assertOutcomeIn(text, testCase, 'evidence export');
    }
  });
});

function bundleSources(hostSettings: Record<string, unknown>, runStatus: Record<string, unknown>): BundleSources {
  const logger = new SanitizedLogger([]);
  return {
    workspaceRoot: workspace,
    sanitize: (text) => logger.sanitize(text),
    sanitizeRecord: (record) => logger.sanitizeRecord(record),
    hostVersion: '0.2.0',
    hostBuild: UNKNOWN_BUILD_IDENTITY,
    hostSettings: () => hostSettings,
    runStatus: () => runStatus,
    runtimeLog: () => null,
    platform: 'linux'
  };
}

describe('the diagnostics bundle (SK2)', () => {
  it('collects no part of a supported secret from a raw transcript, and keeps a negative whole', async () => {
    // The bundle makes absolute paths relative or `[path]` on purpose, so a path or URL case is not
    // byte-identical in it: that is the bundle's own scrub, and not what is asserted here.
    const cases = casesFor('export').filter((testCase) => !carriesUrlOrPath(testCase.build()));
    await fsp.mkdir(path.join(workspace, '.schegent', 'sessions'), { recursive: true });
    await fsp.writeFile(
      path.join(workspace, '.schegent', 'sessions', `raw-${RUN}.log`),
      cases.map((testCase) => testCase.build()).join('\n')
    );
    const sources = bundleSources({}, {});
    const plan = planBundle(await probeBundle(sources, RUN), true);
    const items = await collectBundle(sources, RUN, plan);
    const raw = items.find((item) => item.item === 'raw-transcript');
    expect(raw, 'the raw transcript item was not collected').toBeDefined();
    for (const testCase of cases) assertOutcomeIn((raw as NonNullable<typeof raw>).content, testCase, 'bundle raw transcript');
  });

  it('removes a keyed secret from the host settings and the run status, and keeps the counts', async () => {
    const keyed = casesFor('export', 'structured').filter((testCase) => testCase.key !== undefined);
    expect(keyed.length).toBeGreaterThanOrEqual(3);
    const settings: Record<string, unknown> = { 'logging.sessionRetentionMaxAgeDays': 30 };
    const status: Record<string, unknown> = { status: 'failed', input_tokens: 4096 };
    for (const testCase of keyed) {
      settings[testCase.key as string] = testCase.build();
      status[`nested_${testCase.key}`] = { [testCase.key as string]: testCase.build() };
    }
    const sources = bundleSources(settings, status);
    const plan = planBundle(await probeBundle(sources, RUN), false);
    const items = await collectBundle(sources, RUN, plan);
    const text = items.map((item) => item.content).join('\n');
    for (const testCase of keyed) assertAbsentIn(text, testCase, 'bundle structured item');
    expect(text).toContain('30');
    expect(text).toContain('4096');
  });
});

describe('the process-definition export audit row (SK1)', () => {
  async function auditText(): Promise<string> {
    return fsp.readFile(path.join(workspace, '.schegent', 'audit.log'), 'utf8').catch(() => '');
  }

  it('refuses a supported secret in the identifier and writes none of it; a negative is written whole', async () => {
    const warnings: string[] = [];
    const logger = new SanitizedLogger([{ appendLine: (line) => warnings.push(line) }]);
    const audit = new AuditLogWriter({ workspaceRoot: workspace }, logger);
    const deps = { audit, logger } as never;
    // The audit projection refuses a URL or a path outright, so a case of that shape has no audit row.
    const cases = casesFor('export').filter(
      (testCase) =>
        (testCase.expected === 'redacted' || testCase.expected === 'preserved') && !carriesUrlOrPath(testCase.build())
    );
    expect(cases.length).toBeGreaterThan(20);
    for (const testCase of cases) {
      await appendExportAudit(deps, { resourceKind: 'workflow', resourceId: testCase.build(), outcome: 'saved' });
    }
    const text = await auditText();
    for (const testCase of cases) {
      if (testCase.expected === 'redacted') assertAbsentIn(text, testCase, 'process export audit row');
    }
    const rows = text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { payload: { resourceIds: string[] } });
    const written = rows.map((row) => row.payload.resourceIds.at(0));
    for (const testCase of cases.filter((candidate) => candidate.expected === 'preserved')) {
      expect(written, `process export audit row: ${testCase.name}: a negative case was changed or not written`).toContain(
        testCase.build()
      );
    }
    expect(warnings.some((line) => line.includes('audit append failed') || line.includes('export audit'))).toBe(true);
  });
});
