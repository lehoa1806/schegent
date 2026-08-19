// ---------------------------------------------------------------------------
// FR-R3-010 (T414) — the drill-down against a real evidence corpus.
//
// `HistoryEntry.auditLogPointer` shipped in feature 013 and nothing resolved
// one until T408. The unit tests cover the resolver's decision table with a
// stubbed corpus; this file covers the part a stub cannot: that the pointer a
// completion *wrote* is the pointer a drill-down can *read*, across a real
// `.schegent/` directory with real archives, rotation naming, and a live log.
//
// Three cases, matching the three the requirement names:
//
//   resolve                 the entries come back, in order, from wherever they
//                           landed across the archive/live split
//   evidence-expired        the row outlived its evidence, and says so rather
//                           than reporting the run wrote nothing
//   legacy-format tolerance a pointer an older build minted is `unaddressable`,
//                           not an error and not a false expiry claim
//
// Exercised through `HistoryEvidenceService`, because that is the seam the IPC
// handler calls — testing the resolver alone would skip the history lookup and
// the health reporting, which is where two of the three verdicts are decided.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AuditPointerResolver } from '../../../src/services/history/audit-pointer-resolver';
import { HistoryEvidenceService } from '../../../src/services/history/history-evidence-service';
import { buildAuditLogPointer, type HistoryRecord } from '../../../src/state/history-entry';
import {
  EvidenceHealthMonitor
} from '../../../src/services/evidence-health/evidence-health-monitor';

const LOGGER = {
  warn: () => undefined,
  sanitize: (value: string) => value
};

/** One line as `audit-log-writer.ts` would have written it. */
function auditLine(over: {
  runId: string;
  id: string;
  timestamp: string;
  phase?: string;
  iteration?: number;
  eventType?: string;
}): string {
  return JSON.stringify({
    schemaVersion: 3,
    id: over.id,
    timestamp: over.timestamp,
    runId: over.runId,
    phase: over.phase ?? 'implement',
    iteration: over.iteration ?? 1,
    eventType: over.eventType ?? 'phase-end',
    outcome: 'success',
    payload: {}
  });
}

function historyRow(over: Partial<HistoryRecord> & { runId: string }): HistoryRecord {
  return {
    queueId: 'default',
    featureId: 'feat-1',
    descriptionPreview: 'a task',
    terminalStatus: 'completed',
    startedAt: '2026-08-18T10:00:00.000Z',
    completedAt: '2026-08-18T10:05:00.000Z',
    durationMs: 300_000,
    lastErrorSummary: null,
    auditLogPointer: buildAuditLogPointer(over.runId),
    ...over
  };
}

let workspaceRoot: string;
let evidenceDir: string;
let health: EvidenceHealthMonitor;

/** A service whose history holds exactly `rows`. */
function serviceFor(rows: readonly HistoryRecord[]): HistoryEvidenceService {
  return new HistoryEvidenceService({
    historyStore: {
      findByRunId: (runId: string) => rows.find((row) => row.runId === runId) ?? null
    },
    resolver: new AuditPointerResolver({ workspaceRoot, logger: LOGGER }),
    evidenceHealth: health
  });
}

async function writeLive(...lines: string[]): Promise<void> {
  await fs.writeFile(path.join(evidenceDir, 'audit.log'), `${lines.join('\n')}\n`, 'utf8');
}

async function writeArchive(stamp: string, ...lines: string[]): Promise<void> {
  await fs.writeFile(
    path.join(evidenceDir, `audit.log.${stamp}`),
    `${lines.join('\n')}\n`,
    'utf8'
  );
}

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-pointer-resolution-'));
  evidenceDir = path.join(workspaceRoot, '.schegent');
  await fs.mkdir(evidenceDir, { recursive: true });
  health = new EvidenceHealthMonitor();
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe('resolve', () => {
  it('returns the run’s entries and leaves other runs’ out', async () => {
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' }),
      auditLine({ runId: 'run-b', id: 'b1', timestamp: '2026-08-18T10:02:00.000Z' }),
      auditLine({ runId: 'run-a', id: 'a2', timestamp: '2026-08-18T10:03:00.000Z' })
    );

    const result = await serviceFor([historyRow({ runId: 'run-a' })]).resolve('run-a');

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.entries.map((entry) => entry.id)).toEqual(['a1', 'a2']);
    expect(result.truncated).toBe(false);
    expect(result.parseWarnings).toBe(0);
  });

  it('spans the archive/live split and returns the entries chronologically', async () => {
    // A rotation mid-run puts one run's entries in two files. The corpus is
    // read archives-first, but the order that matters to a phase timeline is
    // the timestamps' — so this fixture deliberately puts the *later* entry in
    // the *earlier* archive to prove the sort is real and not incidental.
    await writeArchive(
      '20260818-100000',
      auditLine({ runId: 'run-a', id: 'a3', timestamp: '2026-08-18T10:04:00.000Z' }),
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' })
    );
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a2', timestamp: '2026-08-18T10:02:00.000Z' })
    );

    const result = await serviceFor([historyRow({ runId: 'run-a' })]).resolve('run-a');

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.entries.map((entry) => entry.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('counts a malformed line as a warning and still returns the good entries', async () => {
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' }),
      '{ not json',
      auditLine({ runId: 'run-a', id: 'a2', timestamp: '2026-08-18T10:02:00.000Z' })
    );

    const result = await serviceFor([historyRow({ runId: 'run-a' })]).resolve('run-a');

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.entries).toHaveLength(2);
    // A count, never the text: a malformed line can quote whatever the writer
    // was handed, and this number crosses IPC.
    expect(result.parseWarnings).toBe(1);
  });

  it('preserves an entry whose eventType this build does not know', async () => {
    await writeLive(
      auditLine({
        runId: 'run-a',
        id: 'a1',
        timestamp: '2026-08-18T10:01:00.000Z',
        eventType: 'invented-by-a-newer-build'
      })
    );

    const result = await serviceFor([historyRow({ runId: 'run-a' })]).resolve('run-a');

    // The `CLAUDE.md` rule against dropping unknown audit event types reaches
    // the drill-down too: an entry the parser warned about is still the run's
    // evidence, and hiding it would understate what the run did.
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(result.entries.map((entry) => entry.eventType)).toEqual([
      'invented-by-a-newer-build'
    ]);
    expect(result.parseWarnings).toBe(1);
  });

  it('ignores files the writer would not have produced', async () => {
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' })
    );
    await fs.writeFile(
      path.join(evidenceDir, 'audit.log.bak'),
      `${auditLine({ runId: 'run-a', id: 'forged', timestamp: '2026-08-18T09:00:00.000Z' })}\n`,
      'utf8'
    );

    const result = await serviceFor([historyRow({ runId: 'run-a' })]).resolve('run-a');

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    // A hand-deposited file next to the archives is not evidence this build
    // wrote, and the archive-name check is what keeps it from answering a
    // drill-down.
    expect(result.entries.map((entry) => entry.id)).toEqual(['a1']);
  });
});

describe('evidence-expired', () => {
  it('reports expiry when the corpus starts after the run completed', async () => {
    // The two retention windows are independent by design: the audit log prunes
    // at 10 archives or 90 days, a history row lives until its queue's cap
    // evicts it. A row outliving its evidence is expected, not a fault.
    await writeLive(
      auditLine({ runId: 'run-z', id: 'z1', timestamp: '2026-08-18T12:00:00.000Z' })
    );

    const result = await serviceFor([
      historyRow({ runId: 'run-a', completedAt: '2026-08-18T10:05:00.000Z' })
    ]).resolve('run-a');

    expect(result).toEqual({ status: 'evidence-expired', runId: 'run-a' });
  });

  it('reports expiry, not silence, when the corpus is empty', async () => {
    await writeLive('');

    const result = await serviceFor([historyRow({ runId: 'run-a' })]).resolve('run-a');

    // A log holding nothing cannot cover anything. Saying "this run recorded no
    // entries" would be a claim about the run drawn from evidence about the log.
    expect(result).toEqual({ status: 'evidence-expired', runId: 'run-a' });
  });

  it('separates a run inside the window that wrote nothing', async () => {
    await writeLive(
      auditLine({ runId: 'run-z', id: 'z1', timestamp: '2026-08-18T09:00:00.000Z' })
    );

    const result = await serviceFor([
      historyRow({ runId: 'run-a', completedAt: '2026-08-18T10:05:00.000Z' })
    ]).resolve('run-a');

    // Same empty match as the expiry case above, opposite verdict, and
    // `completedAt` is the only thing that told them apart — a run canceled
    // before its first phase wrote a record has an intact corpus and no
    // entries, and calling that "expired" is a false claim about retention.
    expect(result).toEqual({ status: 'no-evidence-recorded', runId: 'run-a' });
  });

  it('treats a missing evidence directory as expiry rather than a failure', async () => {
    await fs.rm(evidenceDir, { recursive: true, force: true });

    const result = await serviceFor([historyRow({ runId: 'run-a' })]).resolve('run-a');

    expect(result).toEqual({ status: 'evidence-expired', runId: 'run-a' });
    // A workspace that has never run anything has no `.schegent/`. Degrading
    // the sink on that would flag every fresh workspace.
    expect(health.getSnapshot().historyPointer.status).toBe('healthy');
  });
});

describe('legacy-format tolerance', () => {
  it('reports a path-shaped pointer as unaddressable', async () => {
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' })
    );

    const result = await serviceFor([
      historyRow({ runId: 'run-a', auditLogPointer: '.schegent/audit.log' })
    ]).resolve('run-a');

    // Not an error, and specifically not `evidence-expired`: the evidence is
    // right there. What is missing is a way to address it, and an operator told
    // "expired" would go looking through archives for a run whose entries are
    // in the live log.
    expect(result).toEqual({ status: 'unaddressable' });
  });

  it('reports an empty pointer as unaddressable', async () => {
    const result = await serviceFor([
      historyRow({ runId: 'run-a', auditLogPointer: '' })
    ]).resolve('run-a');

    expect(result).toEqual({ status: 'unaddressable' });
  });

  it('never repairs a legacy pointer from the run id it was asked about', async () => {
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' })
    );

    const result = await serviceFor([
      historyRow({ runId: 'run-a', auditLogPointer: 'audit.log#legacy' })
    ]).resolve('run-a');

    // The pointer is what the entry *claims*. Substituting the run id would
    // resolve this run's entries against a pointer that never addressed them,
    // turning an honest "cannot address this" into a fabricated success.
    expect(result).toEqual({ status: 'unaddressable' });
  });

  it('reports an evicted row as unknown-run without touching the corpus verdict', async () => {
    const result = await serviceFor([]).resolve('run-gone');

    // Reachable in ordinary use — a webview holding a stale snapshot asks about
    // a row the per-queue cap has since evicted.
    expect(result).toEqual({ status: 'unknown-run' });
  });
});

describe('evidence health', () => {
  it('leaves the sink healthy for every definitive verdict', async () => {
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' })
    );
    const service = serviceFor([
      historyRow({ runId: 'run-a' }),
      historyRow({ runId: 'run-b', auditLogPointer: 'legacy' }),
      historyRow({ runId: 'run-c', completedAt: '2026-08-18T10:05:00.000Z' })
    ]);

    await service.resolve('run-a');
    await service.resolve('run-b');
    await service.resolve('run-c');
    await service.resolve('run-gone');

    // Resolved, unaddressable, no-evidence-recorded, unknown-run. Each is an
    // answer the resolver reached by reading what it needed to read, so none of
    // them says the corpus is unreadable — which is the only question this sink
    // answers.
    expect(health.getSnapshot().historyPointer.status).toBe('healthy');
    expect(health.getSnapshot().overall).toBe('healthy');
  });

  it('degrades on an unreadable corpus and recovers on the next good read', async () => {
    await writeLive(
      auditLine({ runId: 'run-a', id: 'a1', timestamp: '2026-08-18T10:01:00.000Z' })
    );
    const rows = [historyRow({ runId: 'run-a' })];
    await fs.chmod(evidenceDir, 0o000);

    const denied = await serviceFor(rows).resolve('run-a');

    // Root can read a 0000 directory, so the fixture cannot force the failure
    // everywhere. Where it does hold, the assertions below are the point.
    if (denied.status === 'unavailable') {
      expect(denied.reason).toBe('corpus-unreadable');
      const degraded = health.getSnapshot();
      expect(degraded.historyPointer.status).toBe('degraded');
      expect(degraded.historyPointer.continuationPolicy).toBe('continue-degraded');
      // The cause is a host-minted token, not an adapter message: an adapter's
      // own text names the path it tried to open, and this value reaches the UI.
      expect(degraded.historyPointer.cause).toBe('corpus-unreadable');
      // A read path over already-written evidence cannot make a new run's
      // evidence less durable, so the workspace is degraded, never unavailable.
      expect(degraded.overall).toBe('degraded');
    }

    await fs.chmod(evidenceDir, 0o700);
    await serviceFor(rows).resolve('run-a');

    expect(health.getSnapshot().historyPointer.status).toBe('healthy');
  });
});
