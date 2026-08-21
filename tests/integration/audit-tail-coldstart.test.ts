// Feature 068 (US3 / T023) — integration test for the cold-start replay path
// wired into `StateProjector.subscribe()` (the snapshot bootstrap).
//
// Contract: specs/068-enhance-system-log/contracts/audit-tail-projector.md §3.
//
//   - Stub an audit log with 10 entries on disk → subscribe → first non-empty
//     snapshot push has those 10 entries in `auditTail`.
//   - Same with 100 entries → assert exactly the last AUDIT_TAIL_MAX (50).
//   - No audit log on disk → first snapshot push has empty `auditTail`.
//   - Live event arriving mid-bootstrap is not duplicated by id.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditAppendListener, AuditDisposable } from '../../src/audit/audit-log-writer';
import type { AuditEntry } from '../../src/audit/audit-entry';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import type { WorkflowSnapshot } from '../../src/ui/sidebar/snapshot';
import { AUDIT_TAIL_MAX } from '../../src/ui/sidebar/snapshot';

function entryLine(overrides: Partial<AuditEntry> = {}): string {
  const base: AuditEntry = {
    id: 'entry-1',
    timestamp: '2026-05-23T12:00:00.000Z',
    runId: 'run-abc',
    phase: 'speckit-plan',
    iteration: 1,
    eventType: 'phase-start',
    payload: { summary: 'starting plan' },
    outcome: 'info'
  };
  return JSON.stringify({ ...base, ...overrides });
}

function buildAuditDep(workspaceRoot: string): {
  audit: {
    subscribe: (l: AuditAppendListener) => AuditDisposable;
    logPath: string;
    workspaceRoot: string;
  };
  emitLiveEvent: (entry: AuditEntry) => void;
} {
  let listener: AuditAppendListener | null = null;
  const audit = {
    subscribe: (l: AuditAppendListener): AuditDisposable => {
      listener = l;
      return { dispose: () => { listener = null; } };
    },
    logPath: join(workspaceRoot, '.schegent', 'audit.log'),
    workspaceRoot
  };
  return {
    audit,
    emitLiveEvent: (entry: AuditEntry) => listener?.(entry)
  };
}

function buildProjector(workspaceRoot: string): {
  projector: StateProjector;
  emitLiveEvent: (entry: AuditEntry) => void;
  flush: () => Promise<void>;
} {
  const { audit, emitLiveEvent } = buildAuditDep(workspaceRoot);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    sanitize: (s: string) => s
  };
  const projector = new StateProjector({
    audit,
    ownerId: 'coldstart-integ',
    debounceMs: 0,
    logger: logger as any
  });
  return {
    projector,
    emitLiveEvent,
    flush: () => new Promise((r) => setTimeout(r, 25))
  };
}

/**
 * Wait until `predicate` holds, polling the macrotask queue.
 *
 * The cold-start tail read is real async disk I/O, so waiting a fixed 25ms
 * for it encodes an assumption about how fast the host is. Under full-suite
 * parallelism that assumption broke: the read had not finished, no populated
 * snapshot had been pushed, and the assertion failed on `undefined`
 * (observed 2026-08-17, once in 8 full-suite runs).
 *
 * Polling returns as soon as the condition holds — normally sooner than the
 * old sleep — and only spends the whole budget when something is genuinely
 * stuck, where it fails with the condition's name rather than a bare
 * `expected undefined to be defined`.
 */
async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const hasPopulatedTail = (snaps: readonly WorkflowSnapshot[]): boolean =>
  snaps.some((s) => s.auditTail.length > 0);

describe('Feature 068 (T023) — audit-tail cold-start integration', () => {
  let workspaceRoot: string;
  let auditDir: string;
  let auditLog: string;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'schegent-coldstart-integ-'));
    auditDir = join(workspaceRoot, '.schegent');
    auditLog = join(auditDir, 'audit.log');
  });

  afterEach(async () => {
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('seeds first snapshot push with all 10 disk entries (N ≤ AUDIT_TAIL_MAX)', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(entryLine({ id: `e-${i}`, iteration: i }));
    }
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const { projector } = buildProjector(workspaceRoot);

    const received: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((s) => {
      received.push(s);
    });
    await waitUntil(() => hasPopulatedTail(received), 'cold-start populated snapshot push');
    sub.dispose();
    projector.dispose();

    // The very first snapshot may be the synchronous in-memory baseline
    // (empty tail) before the awaited cold-start completes. Find the
    // first snapshot whose tail is non-empty — that one must carry all
    // 10 entries.
    const populated = received.find((s) => s.auditTail.length > 0);
    expect(populated, 'expected a populated cold-start snapshot push').toBeDefined();
    expect(populated!.auditTail.length).toBe(10);
    expect(populated!.auditTail.map((e) => e.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `e-${i}`)
    );
  });

  it('seeds first populated push with the last AUDIT_TAIL_MAX entries when disk has 100', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(entryLine({ id: `e-${i}`, iteration: i }));
    }
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const { projector } = buildProjector(workspaceRoot);
    const received: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((s) => received.push(s));
    await waitUntil(() => hasPopulatedTail(received), 'cold-start populated snapshot push');
    sub.dispose();
    projector.dispose();

    const populated = received.find((s) => s.auditTail.length > 0);
    expect(populated!.auditTail.length).toBe(AUDIT_TAIL_MAX);
    expect(populated!.auditTail[0]!.id).toBe(`e-${100 - AUDIT_TAIL_MAX}`);
    expect(populated!.auditTail[AUDIT_TAIL_MAX - 1]!.id).toBe('e-99');
  });

  it('keeps auditTail empty across all pushes when no audit log on disk', async () => {
    // .schegent/ deliberately absent
    const { projector, flush } = buildProjector(workspaceRoot);
    const received: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((s) => received.push(s));
    // No log on disk, so no snapshot will ever become populated: wait for the
    // first push, then settle so a late cold-start push would still be caught
    // by the all-empty assertion below rather than land after dispose.
    await waitUntil(() => received.length > 0, 'first snapshot push');
    await flush();
    sub.dispose();
    projector.dispose();

    expect(received.length).toBeGreaterThan(0);
    for (const snap of received) {
      expect(snap.auditTail.length).toBe(0);
    }
  });

  it('does not duplicate by id when a live event with a disk-side id arrives mid-bootstrap', async () => {
    await mkdir(auditDir, { recursive: true });
    const lines = [
      entryLine({ id: 'e-1', iteration: 1 }),
      entryLine({ id: 'e-2', iteration: 2 })
    ];
    await writeFile(auditLog, lines.join('\n') + '\n', 'utf8');

    const { projector, emitLiveEvent } = buildProjector(workspaceRoot);
    const received: WorkflowSnapshot[] = [];
    const sub = projector.subscribe((s) => received.push(s));

    // Race: emit a live event whose id matches a cold-start id BEFORE the
    // awaited cold-start completes. The dedupe must drop the cold-start
    // copy of `e-1`.
    emitLiveEvent({
      id: 'e-1',
      timestamp: '2026-05-23T12:00:00.000Z',
      runId: 'run-abc',
      phase: 'speckit-plan',
      iteration: 1,
      eventType: 'phase-start',
      payload: { summary: 'live e-1' },
      outcome: 'info'
    });

    await waitUntil(() => hasPopulatedTail(received), 'populated snapshot push after live event');
    sub.dispose();
    projector.dispose();

    const populated = received.find((s) => s.auditTail.length > 0);
    expect(populated, 'expected a populated snapshot push').toBeDefined();
    const ids = populated!.auditTail.map((e) => e.id);
    // Exactly one entry per id; live and cold-start did not stack.
    expect(ids.filter((id) => id === 'e-1').length).toBe(1);
    expect(ids.filter((id) => id === 'e-2').length).toBe(1);
  });
});
