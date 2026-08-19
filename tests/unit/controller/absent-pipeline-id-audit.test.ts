// Feature 098 (T042, US6) — an invocation that supplied no Pipeline id records no
// Pipeline id (FR-034, SC-011).
//
// Thirteen expressions used to read `inputs.pipelineId ?? BUILT_IN_PIPELINE_ID`.
// Seven of them reach an audit record, which is the operator-observable half and
// the half SC-011 bounds; the rest feed a log line or a path. The substituted id
// named a Pipeline the product no longer ships, so an operator reading the audit
// log saw an attribution to a definition that does not exist and cannot be
// resolved. The correction is to omit: the field is absent rather than invented.
//
// "Absent" is asserted with `in`, not with `toBeUndefined()`. An explicit
// `pipelineId: undefined` still serializes as a key in some writers and still
// reads as a claim the invocation made no claim about — the requirement is that
// the key is not there at all.
//
// The path-composing sites are covered here too, because "omit" has a different
// shape for a path: a path segment cannot be absent, so the whole path is.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PhaseRetryEvaluator } from '../../../src/controller/phase-retry-evaluator';
import type { PhaseRetryEvaluatorInputs } from '../../../src/controller/phase-retry-evaluator';
import { PhaseSidecarReader } from '../../../src/controller/phase-sidecar-reader';
import type { PhaseSidecarInputs } from '../../../src/controller/phase-sidecar-reader';
import { SanitizedLogger } from '../../../src/lib/logger';
import type { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../../src/audit/audit-entry';
import type { InvocationResult } from '../../../src/parser/stdout-parser';
import type { PhaseDef } from '../../../src/config/pipeline-config';

interface Appended {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

function makeAuditWriter(): { writer: AuditLogWriter; appends: Appended[] } {
  const appends: Appended[] = [];
  let counter = 0;
  const writer = {
    append: vi.fn(async (entry: Omit<AuditEntry, 'id' | 'timestamp'>): Promise<AuditEntry> => {
      appends.push({
        eventType: entry.eventType,
        payload: entry.payload as Record<string, unknown>
      });
      return {
        id: `audit-${++counter}`,
        timestamp: '2026-05-19T00:00:00Z',
        ...entry
      } as AuditEntry;
    }),
    logPath: '/tmp/.schegent/audit.log'
  } as unknown as AuditLogWriter;
  return { writer, appends };
}

/** The assertion the whole file is about, named once so every case reads the same. */
function expectNoPipelineId(payload: Record<string, unknown>, where: string): void {
  expect(Object.prototype.hasOwnProperty.call(payload, 'pipelineId'), where).toBe(false);
}

let logger: SanitizedLogger;

beforeEach(() => {
  logger = new SanitizedLogger();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
});

// ---------------------------------------------------------------------------
// PhaseRetryEvaluator — `phase.retry_evaluated`
// ---------------------------------------------------------------------------

const retryInputs = (
  overrides?: Partial<PhaseRetryEvaluatorInputs>
): PhaseRetryEvaluatorInputs =>
  ({
    phase: 'draft',
    phaseDef: {
      id: 'draft',
      ruleset: 'speckit',
      iterationCap: 1,
      retryCondition: 'iteration < 2'
    } as unknown as PhaseDef,
    runId: 'run-1',
    iteration: 1,
    result: { kind: 'clean', auditEntry: {} as never } as InvocationResult,
    metrics: { iteration: 1 },
    ...overrides
  }) as PhaseRetryEvaluatorInputs;

describe('Feature 098 (T042) — retry evaluation records no invented Pipeline id', () => {
  it('omits pipelineId when the invocation supplied none', async () => {
    const { writer, appends } = makeAuditWriter();
    await new PhaseRetryEvaluator(writer, logger).maybeEmit(retryInputs());

    expect(appends).toHaveLength(1);
    expectNoPipelineId(appends[0]!.payload, 'phase.retry_evaluated');
    // The rest of the payload is unaffected: omission is not suppression.
    expect(appends[0]!.payload.phaseId).toBe('draft');
  });

  it('carries the Pipeline id through when the invocation supplied one', async () => {
    // The companion assertion. Without it, "the key is absent" would also be
    // satisfied by an emitter that stopped reporting attribution altogether.
    const { writer, appends } = makeAuditWriter();
    await new PhaseRetryEvaluator(writer, logger).maybeEmit(
      retryInputs({ pipelineId: 'authored-flow' })
    );

    expect(appends[0]!.payload.pipelineId).toBe('authored-flow');
  });
});

// ---------------------------------------------------------------------------
// PhaseSidecarReader — `phase-message-*` and the canonical sidecar path
// ---------------------------------------------------------------------------

const sidecarInputs = (overrides?: Partial<PhaseSidecarInputs>): PhaseSidecarInputs =>
  ({
    phase: 'draft',
    cwd: '/tmp/absent-pipeline-id',
    runId: 'run-1',
    iteration: 1,
    ...overrides
  }) as PhaseSidecarInputs;

describe('Feature 098 (T042) — the sidecar reader records no invented Pipeline id', () => {
  it('omits pipelineId from the phase-message audit payload', async () => {
    // An explicit `phaseMessagePath` to a file that really exists, so the read
    // succeeds and `phase-message-emitted` fires. Reaching an emission is the
    // point: "no payload carried the key" is also true of no payload at all.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'absent-pipeline-id-'));
    const sidecar = path.join(dir, 'phase-message.env');
    await fs.writeFile(sidecar, 'KEY=value\n', 'utf8');

    const { writer, appends } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    await reader.parsePhaseMessage(
      sidecarInputs({ cwd: dir, phaseMessagePath: sidecar }),
      null
    );

    expect(appends.length, 'no phase-message audit event was emitted').toBeGreaterThan(0);
    for (const append of appends) expectNoPipelineId(append.payload, append.eventType);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('composes no canonical sidecar path when the invocation supplied no Pipeline id', () => {
    // A path segment cannot be omitted the way a payload key can, so the whole
    // path is: `canonicalSidecarPath` already answers `null` for absent required
    // inputs, and the Pipeline id is one of them now.
    const { writer } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    expect(reader.canonicalSidecarPath(sidecarInputs())).toBeNull();
  });

  it('still composes the path when the invocation supplied one', () => {
    const { writer } = makeAuditWriter();
    const reader = new PhaseSidecarReader(writer, logger);

    const composed = reader.canonicalSidecarPath(sidecarInputs({ pipelineId: 'authored-flow' }));
    expect(composed).toContain('authored-flow');
  });
});
