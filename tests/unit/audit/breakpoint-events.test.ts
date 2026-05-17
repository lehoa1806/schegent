// Feature 028 — phase-breakpoint audit events end-to-end emission tests.
//
// Verifies that:
//   1. All three lifecycle events (`phase-breakpoint-set` / `-cleared` /
//      `-fired`) round-trip through `AuditLogWriter.append` and serialize
//      to .schegent/audit.log with the documented payload shape.
//   2. `phase-breakpoint-cleared.cause` accepts all four discriminator
//      values (`operator`, `consumed-by-fire`, `override-applied`,
//      `run-ended`).
//   3. Payloads pass the `SECRET_PATTERNS` redaction set unchanged —
//      enum / id / number fields contain no free-form text, so the
//      writer-level sanitizer (single source of truth for redaction)
//      MUST leave them byte-identical on disk.
//
// These tests assert the audit-pipeline contract (T030) — the controller
// + runner emit sites (T032-T037) drive these events at runtime.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';
import {
  PHASE_BREAKPOINT_EVENT_TYPES,
  type PhaseBreakpointClearedCause
} from '../../../src/contracts/audit-events';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-bp-'));
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function readAuditLines(): Promise<unknown[]> {
  const contents = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
  return contents
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('Feature 028 — phase-breakpoint audit events', () => {
  it('registers all three event types in PHASE_BREAKPOINT_EVENT_TYPES', () => {
    expect(PHASE_BREAKPOINT_EVENT_TYPES).toEqual([
      'phase-breakpoint-set',
      'phase-breakpoint-cleared',
      'phase-breakpoint-fired'
    ]);
  });

  it('writes phase-breakpoint-set with operator actor', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    await writer.append({
      runId: 'run-bp-1',
      phase: 'speckit-clarify',
      iteration: 1,
      eventType: 'phase-breakpoint-set',
      payload: {
        runId: 'run-bp-1',
        phaseId: 'speckit-implement',
        actor: 'operator'
      },
      outcome: 'info'
    });
    const [entry] = (await readAuditLines()) as Array<{
      eventType: string;
      payload: { runId: string; phaseId: string; actor: string };
      outcome: string;
    }>;
    expect(entry.eventType).toBe('phase-breakpoint-set');
    expect(entry.payload).toEqual({
      runId: 'run-bp-1',
      phaseId: 'speckit-implement',
      actor: 'operator'
    });
    expect(entry.outcome).toBe('info');
  });

  it('writes phase-breakpoint-cleared for each cause value', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const causes: PhaseBreakpointClearedCause[] = [
      'operator',
      'consumed-by-fire',
      'override-applied',
      'run-ended'
    ];
    for (const cause of causes) {
      await writer.append({
        runId: 'run-bp-1',
        phase: 'speckit-clarify',
        iteration: 1,
        eventType: 'phase-breakpoint-cleared',
        payload: {
          runId: 'run-bp-1',
          phaseId: 'speckit-implement',
          cause
        },
        outcome: 'info'
      });
    }
    const entries = (await readAuditLines()) as Array<{
      payload: { cause: PhaseBreakpointClearedCause };
    }>;
    expect(entries).toHaveLength(4);
    expect(entries.map((e) => e.payload.cause)).toEqual(causes);
  });

  it('writes phase-breakpoint-fired with structural payload only', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    await writer.append({
      runId: 'run-bp-1',
      phase: 'speckit-implement',
      iteration: 3,
      eventType: 'phase-breakpoint-fired',
      payload: {
        pipelineId: 'standard',
        phaseId: 'speckit-implement',
        iterationN: 3,
        timestamp: 1_700_000_000_500
      },
      outcome: 'info'
    });
    const [entry] = (await readAuditLines()) as Array<{
      eventType: string;
      payload: { pipelineId: string; phaseId: string; iterationN: number; timestamp: number };
    }>;
    expect(entry.eventType).toBe('phase-breakpoint-fired');
    expect(entry.payload.pipelineId).toBe('standard');
    expect(entry.payload.phaseId).toBe('speckit-implement');
    expect(entry.payload.iterationN).toBe(3);
    expect(typeof entry.payload.timestamp).toBe('number');
  });

  it('payloads are byte-identical after sanitization (no secrets in enum/id fields)', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const setPayload = {
      runId: 'run-bp-1',
      phaseId: 'speckit-implement',
      actor: 'operator' as const
    };
    await writer.append({
      runId: 'run-bp-1',
      phase: 'speckit-clarify',
      iteration: 1,
      eventType: 'phase-breakpoint-set',
      payload: setPayload,
      outcome: 'info'
    });
    const clearedPayload = {
      runId: 'run-bp-1',
      phaseId: 'speckit-implement',
      cause: 'consumed-by-fire' as const
    };
    await writer.append({
      runId: 'run-bp-1',
      phase: 'speckit-implement',
      iteration: 3,
      eventType: 'phase-breakpoint-cleared',
      payload: clearedPayload,
      outcome: 'info'
    });
    const firedPayload = {
      pipelineId: 'standard',
      phaseId: 'speckit-implement',
      iterationN: 3,
      timestamp: 1_700_000_000_500
    };
    await writer.append({
      runId: 'run-bp-1',
      phase: 'speckit-implement',
      iteration: 3,
      eventType: 'phase-breakpoint-fired',
      payload: firedPayload,
      outcome: 'info'
    });

    const entries = (await readAuditLines()) as Array<{ payload: Record<string, unknown> }>;
    expect(entries[0].payload).toEqual(setPayload);
    expect(entries[1].payload).toEqual(clearedPayload);
    expect(entries[2].payload).toEqual(firedPayload);

    const contents = await fs.readFile(
      path.join(tmpRoot, '.schegent', 'audit.log'),
      'utf8'
    );
    expect(contents).not.toContain('[REDACTED]');
  });
});
