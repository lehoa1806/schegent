// FR-R6-F07 T033 (NFR-005, NFR-006, SC-002, SC-003) — live-log delivery under load.
//
// WHAT THIS PINS.
//   - NFR-005: with one phase writing 100 records per second, a complete record
//     is shown within 1 second at p95 after it is readable, through the real
//     registry, its file watcher and a consumer that acknowledges each batch.
//   - SC-002 / NFR-005: after hide, 50 writes and reveal, the shown records match
//     the file in order within 2 seconds at p95 over 20 trials.
//   - NFR-006 / SC-003: a slow consumer and a writer that leaves records without
//     a newline, compressed to ten simulated minutes, never pass 256 KiB of
//     retained partial state, 1 MiB of pending delivery, one batch's byte bound,
//     or 4 MiB and 500 rows of shown entries, checked after every tick.
//
// The consumer applies batches with the webview's own rules
// (`live-log-consumer.ts`) and keeps the webview's window (`phase-log-window.ts`),
// so "shown" here is what the view would show. The duplicate-delivery half of
// NFR-006 is pinned by the store and integration tests (T026, T028).

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LIVE_LOG_BATCH_MAX_BYTES,
  LIVE_LOG_PENDING_MAX_BYTES,
  LIVE_LOG_RESIDUAL_MAX_BYTES,
  LIVE_LOG_VISIBLE_MAX_BYTES,
  PHASE_LOG_MAX_ENTRIES
} from '../../src/contracts/phase-log-bounds';
import type { PhaseLogBatchPushMessage } from '../../src/contracts/sidebar-ipc';
import { SanitizedLogger } from '../../src/lib/logger';
import { resolveStreamJsonlPath } from '../../src/services/phase-log/phase-log-path';
import { PhaseLogTailRegistry } from '../../src/services/phase-log/phase-log-tail-registry';
import {
  PhaseLogTailSession,
  type PhaseLogBatchPush
} from '../../src/services/phase-log/phase-log-tail-session';
import type { PhaseLogDisplayEntry, PhaseLogSelection } from '../../src/services/phase-log/types';

/** NFR-005: a complete record is shown within this, at p95, after it is readable. */
const VISIBLE_P95_BUDGET_MS = 1_000;
/** NFR-005 / SC-002: a reveal shows the hidden writes within this, at p95. */
const REVEAL_P95_BUDGET_MS = 2_000;
/** The F03 normal workload: one phase writing 100 records per second. */
const RECORDS_PER_SECOND = 100;
const LATENCY_SECONDS = 5;
const REVEAL_TRIALS = 20;
const HIDDEN_WRITES = 50;
const WAIT_TIMEOUT_MS = 10_000;
const WAIT_INTERVAL_MS = 5;
const PRODUCTION_PER_FIELD_BYTES = 65_536;

/** NFR-006: ten minutes, one tick per simulated second. */
const SIMULATED_SECONDS = 600;
/** Each phase of the writer lasts this long, alternating complete and no-newline output. */
const PHASE_SECONDS = 20;
/** 6 records of 12 KB a second: one complete phase writes about 1.4 MiB, above the pending bound. */
const RECORDS_PER_COMPLETE_SECOND = 6;
const RECORD_TEXT_BYTES = 12_000;
const NO_NEWLINE_BYTES_PER_SECOND = 32_768;
/** The slow consumer acknowledges once every this many ticks: 30 s of output is above the pending bound. */
const ACK_EVERY_TICKS = 30;
/** A bound counts as reached when the peak is at least this share of it; below, the fixture proves nothing. */
const REACHED_SHARE = 0.5;
const DRAIN_TICK_LIMIT = 5_000;

const logger = new SanitizedLogger();
const sanitize = (value: string): string => logger.sanitize(value);
const encoder = new TextEncoder();

let workspaceRoot = '';

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-log-perf-'));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
});

function selectionFor(taskId: string): PhaseLogSelection {
  return { queueId: 'q1', taskId, pipelineId: 'pipe-1', phaseId: 'phase-1', iterationN: 1 };
}

function streamFile(selection: PhaseLogSelection): string {
  return resolveStreamJsonlPath({
    workspaceRoot,
    runId: selection.taskId,
    pipelineId: selection.pipelineId,
    phaseId: selection.phaseId,
    iterationN: 1
  });
}

function assistantLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
}

function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted.at(index) ?? Number.POSITIVE_INFINITY;
}

function utf8Bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

async function loadWebview() {
  // The webview is an ES module; this CommonJS test loads it with a dynamic import.
  const consumer = await import('../../webview-ui/src/lib/live-log-consumer.js');
  const window = await import('../../webview-ui/src/lib/phase-log-window.js');
  return { consumer, window };
}

type WebviewModules = Awaited<ReturnType<typeof loadWebview>>;

/** What the view shows: batches applied with the webview's rules into its window. */
class ShownView {
  entries: readonly PhaseLogDisplayEntry[] = [];
  private state;
  private readonly modules: WebviewModules;

  constructor(modules: WebviewModules) {
    this.modules = modules;
    this.state = modules.consumer.FRESH_CONSUMER_STATE;
  }

  /** Applies one batch; returns the acknowledgement the view would send, or null. */
  apply(batch: PhaseLogBatchPush): { batchSeq: number; resync?: boolean; duplicate?: boolean } | null {
    const verdict = this.modules.consumer.applyLiveLogBatch(this.state, batch);
    if (verdict.kind === 'incompatible') throw new Error('protocol mismatch');
    this.state = verdict.state;
    if (verdict.kind === 'apply') {
      if (verdict.replace) this.entries = [];
      for (const entry of verdict.entries) {
        this.entries = this.modules.window.appendToWindow(
          this.entries,
          entry,
          this.modules.window.PHASE_LOG_WINDOW_MAX_ENTRIES
        );
      }
    }
    return verdict.ack;
  }

  texts(): string[] {
    return this.entries
      .filter((entry) => entry.kind === 'assistant-text')
      .map((entry) => String(entry.body.text));
  }
}

describe('FR-R6-F07 NFR-005 — visible latency under the normal workload', () => {
  it('shows a complete record within 1 s at p95, and a reveal within 2 s at p95 over 20 trials', async () => {
    const modules = await loadWebview();
    const view = new ShownView(modules);
    const shownAt = new Map<string, number>();
    const selection = selectionFor('run-latency');
    const file = streamFile(selection);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');

    const registry = new PhaseLogTailRegistry({
      sanitize,
      appendAudit: () => undefined,
      onTaskNoLongerInFlight: () => ({ dispose: () => undefined }),
      caps: { perFieldBytes: PRODUCTION_PER_FIELD_BYTES }
    });
    let sessionId = '';
    registry.bindSink('dashboard', (msg: PhaseLogBatchPushMessage) => {
      const ack = view.apply(msg.payload);
      const now = performance.now();
      for (const text of view.texts()) if (!shownAt.has(text)) shownAt.set(text, now);
      if (ack !== null) queueMicrotask(() => registry.ack(sessionId, ack));
      return true;
    });
    try {
      const started = await registry.start({ workspaceRoot, selection, consumer: 'dashboard' });
      if (started.outcome !== 'success') throw new Error(`start failed: ${started.reason}`);
      sessionId = started.sessionId;
      registry.ack(sessionId, { batchSeq: 0 });

      // NFR-005: 100 records per second; each is readable when its append resolves.
      const readableAt = new Map<string, number>();
      const spacingMs = 1_000 / RECORDS_PER_SECOND;
      const total = RECORDS_PER_SECOND * LATENCY_SECONDS;
      const begin = performance.now();
      for (let index = 0; index < total; index += 1) {
        const due = begin + index * spacingMs;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        const text = `live ${index}`;
        await fs.appendFile(file, `${assistantLine(text)}\n`);
        readableAt.set(text, performance.now());
      }
      await vi.waitFor(() => expect(shownAt.has(`live ${total - 1}`)).toBe(true), {
        timeout: WAIT_TIMEOUT_MS,
        interval: WAIT_INTERVAL_MS
      });
      const latencies = [...readableAt].map(([text, at]) => (shownAt.get(text) ?? Number.POSITIVE_INFINITY) - at);
      expect(latencies).toHaveLength(total);
      expect(p95(latencies), 'p95 ms from readable to shown').toBeLessThanOrEqual(VISIBLE_P95_BUDGET_MS);

      // SC-002: hide, 50 writes, reveal; the shown records match the file in order.
      const revealMs: number[] = [];
      for (let trial = 0; trial < REVEAL_TRIALS; trial += 1) {
        registry.setConsumerVisible('dashboard', false);
        const written: string[] = [];
        for (let index = 0; index < HIDDEN_WRITES; index += 1) {
          const text = `hidden ${trial}.${index}`;
          written.push(text);
          await fs.appendFile(file, `${assistantLine(text)}\n`);
        }
        const revealedAt = performance.now();
        registry.setConsumerVisible('dashboard', true);
        const last = written.at(-1) ?? '';
        await vi.waitFor(() => expect(shownAt.has(last)).toBe(true), {
          timeout: WAIT_TIMEOUT_MS,
          interval: WAIT_INTERVAL_MS
        });
        revealMs.push((shownAt.get(last) ?? Number.POSITIVE_INFINITY) - revealedAt);
        const shown = view.texts();
        expect(shown.slice(-HIDDEN_WRITES), `trial ${trial} shows the file in order`).toEqual(written);
      }
      expect(p95(revealMs), 'p95 ms from reveal to the last hidden write shown').toBeLessThanOrEqual(
        REVEAL_P95_BUDGET_MS
      );
      console.info(
        `[FR-R6-F07 NFR-005] visible p95 ${p95(latencies).toFixed(1)} ms over ${total}; reveal p95 ${p95(revealMs).toFixed(1)} ms over ${REVEAL_TRIALS}`
      );
    } finally {
      await registry.disposeAll('webview-stop');
    }
  }, 120_000);
});

describe('FR-R6-F07 NFR-006 / SC-003 — a slow consumer and no-newline output', () => {
  it('stays within every bound for ten simulated minutes, then drains', async () => {
    const modules = await loadWebview();
    const view = new ShownView(modules);
    const selection = selectionFor('run-slow');
    const file = streamFile(selection);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');

    const received: PhaseLogBatchPush[] = [];
    const session = new PhaseLogTailSession({
      sessionId: 'sess-slow',
      workspaceRoot,
      filePath: file,
      selection,
      sanitize,
      caps: { perFieldBytes: PRODUCTION_PER_FIELD_BYTES },
      postBatch: (batch) => {
        received.push(batch);
        return true;
      }
    });
    await session.start();
    session.ack({ batchSeq: 0 });

    let largestBatch = 0;
    let oversizedGaps = 0;
    const peak = { residual: 0, pending: 0, shownBytes: 0, shownRows: 0 };
    const checkBounds = (when: string): void => {
      const shownBytesNow = view.entries.reduce((sum, entry) => sum + utf8Bytes(entry), 0);
      peak.residual = Math.max(peak.residual, session.retainedResidualBytes);
      peak.pending = Math.max(peak.pending, session.pendingDeliveryBytes);
      peak.shownBytes = Math.max(peak.shownBytes, shownBytesNow);
      peak.shownRows = Math.max(peak.shownRows, view.entries.length);
      expect(session.retainedResidualBytes, `${when}: retained partial state`).toBeLessThanOrEqual(
        LIVE_LOG_RESIDUAL_MAX_BYTES
      );
      expect(session.pendingDeliveryBytes, `${when}: pending delivery`).toBeLessThanOrEqual(
        LIVE_LOG_PENDING_MAX_BYTES
      );
      expect(view.entries.length, `${when}: shown rows`).toBeLessThanOrEqual(PHASE_LOG_MAX_ENTRIES);
      const shownBytes = view.entries.reduce((sum, entry) => sum + utf8Bytes(entry), 0);
      expect(shownBytes, `${when}: shown bytes`).toBeLessThanOrEqual(LIVE_LOG_VISIBLE_MAX_BYTES);
    };
    const deliver = (): void => {
      let ack: { batchSeq: number } | null = null;
      for (const batch of received.splice(0)) {
        const size = utf8Bytes(batch);
        largestBatch = Math.max(largestBatch, size);
        expect(size, `batch ${batch.batchSeq} bytes`).toBeLessThanOrEqual(LIVE_LOG_BATCH_MAX_BYTES);
        oversizedGaps += batch.entries.filter(
          (item) => item.entry.kind === 'coverage-gap' && item.entry.body.reason === 'oversized-record'
        ).length;
        ack = view.apply(batch) ?? ack;
      }
      if (ack !== null) session.ack(ack);
    };

    let complete = 0;
    let noNewlinePhases = 0;
    for (let second = 0; second < SIMULATED_SECONDS; second += 1) {
      const inNoNewlinePhase = Math.floor(second / PHASE_SECONDS) % 2 === 1;
      if (!inNoNewlinePhase) {
        const lines: string[] = [];
        for (let index = 0; index < RECORDS_PER_COMPLETE_SECOND; index += 1) {
          lines.push(assistantLine(`r${complete} ${'x'.repeat(RECORD_TEXT_BYTES)}`));
          complete += 1;
        }
        await fs.appendFile(file, `${lines.join('\n')}\n`);
      } else {
        const endsPhase = second % PHASE_SECONDS === PHASE_SECONDS - 1;
        await fs.appendFile(file, 'n'.repeat(NO_NEWLINE_BYTES_PER_SECOND) + (endsPhase ? '\n' : ''));
        if (endsPhase) noNewlinePhases += 1;
      }
      await session.tick();
      if (second % ACK_EVERY_TICKS === ACK_EVERY_TICKS - 1) deliver();
      checkBounds(`second ${second}`);
    }

    // Drain: the consumer catches up and acknowledges every tick.
    for (let tick = 0; tick < DRAIN_TICK_LIMIT; tick += 1) {
      await session.tick();
      if (received.length === 0) break;
      deliver();
      checkBounds(`drain tick ${tick}`);
    }

    expect(received, 'the drain posted everything').toHaveLength(0);
    expect(view.texts().at(-1)?.startsWith(`r${complete - 1} `), 'the newest record is shown').toBe(true);
    expect(oversizedGaps, 'one oversized-record gap per no-newline phase').toBe(noNewlinePhases);
    // Each bound was reached, so staying under it was a property of the code, not of a light fixture.
    expect(peak.residual, 'peak retained partial state').toBeGreaterThanOrEqual(LIVE_LOG_RESIDUAL_MAX_BYTES * REACHED_SHARE);
    expect(peak.pending, 'peak pending delivery').toBeGreaterThanOrEqual(LIVE_LOG_PENDING_MAX_BYTES * REACHED_SHARE);
    expect(peak.shownBytes, 'peak shown bytes').toBeGreaterThanOrEqual(LIVE_LOG_VISIBLE_MAX_BYTES * REACHED_SHARE);
    expect(largestBatch, 'largest batch').toBeGreaterThanOrEqual(LIVE_LOG_BATCH_MAX_BYTES * REACHED_SHARE);
    console.info(
      `[FR-R6-F07 NFR-006] peaks: residual ${peak.residual} B, pending ${peak.pending} B, shown ${peak.shownBytes} B in ${peak.shownRows} rows, batch ${largestBatch} B; oversized gaps ${oversizedGaps}; records ${complete}`
    );
    await session.dispose('webview-stop');
  }, 300_000);
});
