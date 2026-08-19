// FR-R3-001 (T273) — widening what the backend receives does not widen what the
// audit log records.
//
// The envelope carries the most sensitive material in the system: operator-typed
// instructions, a brief, workspace paths, and URLs. All of it now reaches the
// prompt, and the prompt is a place it belongs. The structured audit log is not:
// it is durable, it is read by tooling, and one of this repo's hard rules is
// that workspace root paths never enter it.
//
// So this fixture asserts a negative over the *whole* log rather than over a
// chosen payload. A per-field assertion only covers the fields someone thought
// to name, and the way this boundary fails is by a new field appearing — a
// helpful `requestSummary`, an `outputs` echo on `phase-end`, a debug dump on
// `warning`. Stringifying every record and searching for the fixture's literals
// catches any of those wherever it lands.
//
// One thing is deliberately *not* asserted absent: the task description. It is
// operator-authored, but it is not envelope-derived, and phase events have
// always carried task identity. Feature 092's FR-023a bans descriptions from
// *schedule* payloads specifically; asserting it here would be asserting a rule
// this feature does not have.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BRIEF,
  INSTRUCTIONS,
  REPORT_TARGET,
  SPEC_PATH,
  SUMMARY_TARGET,
  SUPPLEMENTAL_FILE,
  SUPPLEMENTAL_TEXT,
  SUPPLEMENTAL_URL,
  driveEnvelopeRun
} from './envelope-harness';

/** Every literal the envelope carries, by the name of the arm it came from. */
const ENVELOPE_CONTENT: readonly (readonly [string, string])[] = [
  ['bound input value', BRIEF],
  ['bound input path', SPEC_PATH],
  ['supplemental path', SUPPLEMENTAL_FILE],
  ['supplemental url', SUPPLEMENTAL_URL],
  ['supplemental text', SUPPLEMENTAL_TEXT],
  ['declared output target', REPORT_TARGET],
  ['declared output target', SUMMARY_TARGET],
  ['operator instructions', INSTRUCTIONS]
];

let workspaceRoot: string;
let records: readonly Record<string, unknown>[];
let serialized: string;

beforeAll(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-envelope-audit-'));

  const harness = await driveEnvelopeRun(workspaceRoot, {
    existingOutputs: [REPORT_TARGET]
  });

  records = await harness.auditRecords();
  serialized = JSON.stringify(records);
}, 30_000);

afterAll(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('the envelope does not widen the audit payload (FR-R3-001)', () => {
  it('wrote an audit log worth searching', () => {
    // Without this, every negative below would pass against an empty file — and
    // an empty file is a plausible failure of the harness, not of the boundary.
    expect(records.length).toBeGreaterThan(0);

    const eventTypes = new Set(records.map((record) => record.eventType));
    expect(eventTypes.has('phase-start')).toBe(true);
    expect(eventTypes.has('phase-end')).toBe(true);
  });

  it('records the run by bounded identifier, which is what it is allowed to carry', () => {
    const start = records.find((record) => record.eventType === 'phase-start');
    const payload = start?.payload as Record<string, unknown> | undefined;

    expect(payload?.pipelineId).toBe('envelope-flow');
    expect(payload?.phaseId).toBe('compose');
  });

  for (const [arm, value] of ENVELOPE_CONTENT) {
    it(`carries no ${arm}`, () => {
      expect(serialized).not.toContain(value);
    });
  }

  it('carries no absolute workspace path', () => {
    // The standing hard rule, restated against this feature's new material: the
    // resolver turns declared targets into workspace-relative references
    // precisely so an absolute one has no route into a durable record.
    expect(serialized).not.toContain(workspaceRoot);
  });

  it('carries no prompt text', () => {
    // The prompt is where the envelope legitimately goes. A payload that echoed
    // it — for debugging, for a transcript pointer — would move every literal
    // above into the log in one edit, so the section headers are checked too.
    for (const header of [
      'REQUEST INPUTS:',
      'SUPPLEMENTAL CONTEXT:',
      'DECLARED OUTPUT TARGETS:',
      'OPERATOR INSTRUCTIONS:'
    ]) {
      expect(serialized).not.toContain(header);
    }
  });
});
