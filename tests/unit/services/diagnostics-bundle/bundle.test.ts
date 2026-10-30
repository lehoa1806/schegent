// Feature 251 (FR-R4-F04, contract T23, SC-012, FR-034, FR-035, B2 to B9) — the diagnostics bundle, from the
// plan to the serialized file, over a fixture with two Runs, synthetic secrets and a runtime log over 3 MiB.
//
// What it pins: the plan lists every item with its share or its omission reason from sizes alone (it works on
// files whose contents cannot be read); the default bundle holds no raw marker, no synthetic secret and no
// absolute path; the serialized bundle is at most `DIAGNOSTICS_BUNDLE_MAX_BYTES` with truncation recorded per
// item and the OLDEST content the part that is cut; every item carries the selected `runId`; the sibling Run's
// lines and records are absent; and opting in to raw conversation adds the three raw items, still redacted and
// still inside the limit.
//
// Why: the filing's finding (O-19) is that an operator asked for help had nothing to send but the evidence
// directory, whose raw files hold prompts and source. Each "absent" claim is paired with a control that must
// hit: the same marker is in the fixture and in a file the bundle reads.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';

import { collectBundle, probeBundle, runIdOfLogLine, truncateFront } from '../../../../src/services/diagnostics-bundle/bundle-collect';
import {
  BUNDLE_ITEM_IDS,
  BUNDLE_ITEM_SHARES,
  DIAGNOSTICS_BUNDLE_MAX_BYTES,
  planBundle,
  RAW_BUNDLE_ITEMS,
  RAW_OMISSION_REASON
} from '../../../../src/services/diagnostics-bundle/bundle-plan';
import { bundleFileName, serializeBundle } from '../../../../src/services/diagnostics-bundle/bundle-write';
import { buildBundleFixture, MARKERS, SECRETS, SELECTED_RUN, SIBLING_RUN, type BundleFixture } from './bundle-fixture';

let fixture: BundleFixture;

beforeEach(async () => {
  fixture = await buildBundleFixture();
});

afterEach(async () => {
  // A case may have made a file unreadable; undo that so the removal can run.
  await Promise.all(fixture.rawFiles.map((file) => fs.chmod(file, 0o600).catch(() => undefined)));
  await fixture.cleanup();
});

async function build(includeRaw: boolean) {
  const probes = await probeBundle(fixture.sources, SELECTED_RUN);
  const plan = planBundle(probes, includeRaw);
  const items = await collectBundle(fixture.sources, SELECTED_RUN, plan);
  return {
    plan,
    items,
    serialized: serializeBundle({
      runId: SELECTED_RUN,
      createdAt: new Date('2026-10-31T00:00:00.000Z'),
      hostVersion: fixture.sources.hostVersion,
      rawConversationIncluded: includeRaw,
      items,
      omitted: plan.omitted
    })
  };
}

describe('the plan lists every item before any read (B2)', () => {
  it('names an included item with its share and an omitted one with its reason, for all eight items', async () => {
    const plan = planBundle(await probeBundle(fixture.sources, SELECTED_RUN), false);

    expect(plan.previewRows).toHaveLength(BUNDLE_ITEM_IDS.length);
    for (const item of BUNDLE_ITEM_IDS) {
      expect(plan.previewRows.some((row) => row.includes(item)), `${item} is listed`).toBe(true);
    }
    expect(plan.included.map((entry) => entry.item)).toEqual(['host', 'run-status', 'failure-records', 'audit-rows', 'runtime-log']);
    for (const entry of plan.included) expect(entry.share).toBe(BUNDLE_ITEM_SHARES[entry.item]);
    expect(plan.omitted.map((entry) => entry.item)).toEqual([...RAW_BUNDLE_ITEMS]);
    for (const entry of plan.omitted) expect(entry.reason).toBe(RAW_OMISSION_REASON);
  });

  it('probes sizes only: it succeeds on files whose contents cannot be read', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    await Promise.all(fixture.rawFiles.map((file) => fs.chmod(file, 0o000)));

    const probes = await probeBundle(fixture.sources, SELECTED_RUN);

    for (const item of RAW_BUNDLE_ITEMS) {
      const probe = probes.find((candidate) => candidate.item === item);
      expect(probe?.available, `${item} is seen by its size`).toBe(true);
      expect(probe?.bytes ?? 0).toBeGreaterThan(0);
    }
    // The control: the same file cannot be opened for reading, so a probe that read would have failed.
    const unreadable = fixture.rawFiles[0]!;
    await expect(fs.readFile(unreadable, 'utf8')).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('lists an item nothing was recorded for, with that as its reason, not silently', () => {
    const plan = planBundle([], false);
    expect(plan.included).toEqual([]);
    expect(plan.omitted).toHaveLength(BUNDLE_ITEM_IDS.length);
    expect(plan.previewRows.join('\n')).toContain('nothing recorded for this Run');
  });
});

describe('the default bundle (FR-035, B6)', () => {
  it('holds no raw marker, no synthetic secret and no absolute path', async () => {
    const { serialized, items } = await build(false);

    // The controls: the fixture holds each marker in a file this Run's bundle reads or must decline.
    expect(items.find((item) => item.item === 'runtime-log')?.content).toContain(MARKERS.newestLog);
    expect(await fs.readFile(fixture.rawFiles[0]!, 'utf8')).toContain(MARKERS.rawTranscript);

    for (const marker of [MARKERS.rawTranscript, MARKERS.rawTransport, MARKERS.rawVerbose]) {
      expect(serialized.text, `${marker} is raw conversation`).not.toContain(marker);
    }
    for (const secret of Object.values(SECRETS)) expect(serialized.text).not.toContain(secret);
    expect(serialized.text).not.toContain(fixture.workspaceRoot);
    expect(serialized.text).not.toMatch(/\/Users\/|\/home\/|\/var\/folders\//);
    expect(serialized.bundle.manifest.rawConversationIncluded).toBe(false);
  });

  it('redacts a secret a line carried when it was written straight to the file', async () => {
    const { items } = await build(false);
    const log = items.find((item) => item.item === 'runtime-log')!;
    expect(log.content).toContain('[REDACTED]');
    expect(log.content).not.toContain(SECRETS.bearer);
    const settings = items.find((item) => item.item === 'host')!;
    expect(settings.content).not.toContain(SECRETS.anthropic);
    // A path outside the workspace becomes `[path]`; one inside it reads relative to the workspace.
    expect(settings.content).toContain('[path]');
    expect(settings.content).not.toContain('/srv/elsewhere');
    expect(settings.content).toContain('notes.md');
    expect(settings.content).not.toContain(fixture.workspaceRoot);
  });

  it('carries the Run status and this Run\'s failure record and audit row only', async () => {
    const { items } = await build(false);
    const byItem = new Map(items.map((item) => [item.item, item.content]));
    expect(byItem.get('run-status')).toContain('cap_exhausted');
    expect(byItem.get('failure-records')).toContain(MARKERS.failureSelected);
    expect(byItem.get('failure-records')).not.toContain(MARKERS.sibling);
    const auditRows = (byItem.get('audit-rows') ?? '').split('\n').filter((line) => line.length > 0);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toContain('cli-invocation');
  });
});

describe('one Run only (B9, US7-6)', () => {
  it('has no sibling marker anywhere, with the control that the sibling marker is in the fixture', async () => {
    const log = await fs.readFile(`${fixture.workspaceRoot}/.schegent/syslog`, 'utf8');
    expect(log).toContain(MARKERS.sibling);

    for (const includeRaw of [false, true]) {
      const { serialized } = await build(includeRaw);
      expect(serialized.text, `raw=${includeRaw}`).not.toContain(MARKERS.sibling);
      expect(serialized.text).not.toContain(SIBLING_RUN);
    }
  });

  it('gives every item the selected Run id', async () => {
    const { serialized } = await build(true);
    expect(serialized.bundle.items.length).toBeGreaterThan(5);
    for (const item of serialized.bundle.items) expect(item.runId).toBe(SELECTED_RUN);
    expect(serialized.bundle.manifest.runId).toBe(SELECTED_RUN);
  });
});

describe('the size limit (SC-012, B5)', () => {
  it('stays within the limit, cuts the runtime log from the front and records it', async () => {
    const { serialized, items } = await build(false);
    const source = await fs.stat(`${fixture.workspaceRoot}/.schegent/syslog`);
    expect(source.size, 'the fixture log is over the 3 MiB share').toBeGreaterThan(BUNDLE_ITEM_SHARES['runtime-log']);

    expect(serialized.bytes).toBeLessThanOrEqual(DIAGNOSTICS_BUNDLE_MAX_BYTES);
    expect(Buffer.byteLength(serialized.text, 'utf8')).toBe(serialized.bytes);
    const log = items.find((item) => item.item === 'runtime-log')!;
    expect(log.truncated).toBe(true);
    expect(log.bytes).toBeLessThanOrEqual(BUNDLE_ITEM_SHARES['runtime-log']);
    expect(log.content, 'the newest line is kept').toContain(MARKERS.newestLog);
    expect(log.content, 'the oldest line is the part that is cut').not.toContain(MARKERS.oldestLog);
    const recorded = serialized.bundle.manifest.included.find((entry) => entry.item === 'runtime-log');
    expect(recorded?.truncated).toBe(true);
  });

  it('stays within the limit with raw conversation included and the largest item shrunk further when it must', async () => {
    const { serialized } = await build(true);
    expect(serialized.bytes).toBeLessThanOrEqual(DIAGNOSTICS_BUNDLE_MAX_BYTES);

    // A limit far under the content forces the shrink step: still within it, every cut item marked.
    const tight = serializeBundle(
      {
        runId: SELECTED_RUN,
        createdAt: new Date('2026-10-31T00:00:00.000Z'),
        hostVersion: '0.2.0',
        rawConversationIncluded: false,
        items: (await build(false)).items,
        omitted: []
      },
      512 * 1024
    );
    expect(tight.bytes).toBeLessThanOrEqual(512 * 1024);
    expect(tight.bundle.manifest.included.some((entry) => entry.truncated)).toBe(true);
  });
});

describe('opting in to raw conversation (FR-035, B4)', () => {
  it('adds the three raw items, redacted, inside the limit, and says so in the manifest', async () => {
    const { serialized, plan } = await build(true);

    expect(plan.omitted).toEqual([]);
    const included = serialized.bundle.manifest.included.map((entry) => entry.item);
    for (const item of RAW_BUNDLE_ITEMS) expect(included).toContain(item);
    for (const marker of [MARKERS.rawTranscript, MARKERS.rawTransport, MARKERS.rawVerbose]) {
      expect(serialized.text, `${marker} is included by choice`).toContain(marker);
    }
    for (const secret of Object.values(SECRETS)) expect(serialized.text).not.toContain(secret);
    expect(serialized.text).not.toContain(fixture.workspaceRoot);
    expect(serialized.bundle.manifest.rawConversationIncluded).toBe(true);
    expect(serialized.bytes).toBeLessThanOrEqual(DIAGNOSTICS_BUNDLE_MAX_BYTES);
  });
});

describe('the helpers', () => {
  it('names the file by Run and UTC stamp', () => {
    expect(bundleFileName(SELECTED_RUN, new Date('2026-10-31T07:08:09.000Z'))).toBe(
      `schegent-diagnostics-${SELECTED_RUN}-20261031T070809Z.json`
    );
  });

  it('reads the Run a log line names from its JSON context, and nothing from a line without one', () => {
    expect(runIdOfLogLine(`[t] INFO note {"runId":"${SELECTED_RUN}","phase":"p"}`)).toBe(SELECTED_RUN);
    expect(runIdOfLogLine('[t] INFO a message that mentions { braces } but no context')).toBeNull();
    expect(runIdOfLogLine(`[t] INFO has {a brace} then ctx {"runId":"${SIBLING_RUN}"}`)).toBe(SIBLING_RUN);
    expect(runIdOfLogLine('[t] INFO no context at all')).toBeNull();
  });

  it('cuts from the front on a line boundary and keeps a short text whole', () => {
    expect(truncateFront('short', 100)).toEqual({ text: 'short', truncated: false });
    const cut = truncateFront('aaaa\nbbbb\ncccc', 10);
    expect(cut.truncated).toBe(true);
    expect(cut.text.endsWith('cccc')).toBe(true);
    expect(cut.text.startsWith('aaaa')).toBe(false);
  });
});
