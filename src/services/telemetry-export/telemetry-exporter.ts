/**
 * FR-R6-F14 (FR-001, FR-005, FR-010, FR-011, FR-012, FR-013, FR-016; NFR-001, NFR-002,
 * NFR-004; research R5, R6) — the exporter: it takes source records into one open batch, seals
 * the batch into a bounded queue and delivers one batch at a time, with bounded retries.
 *
 * It is off until `configure` gives it an authorized destination. `offer` is synchronous and
 * waits for nothing; a slow or failing destination can only fill the queue, which drops its
 * oldest batch. A batch is sent only under the authorization generation it was sealed under:
 * every change of destination or generation aborts the request in flight and drops what is
 * queued. The transport, the secret port and the ledger are each called behind a guard, so a
 * throw from one of them is counted and never reaches the caller.
 *
 * Nothing constructs this in production yet (F14-B owns the wiring).
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { randomUUID } from 'node:crypto';

import {
  TELEMETRY_EXPORT_BOUNDS,
  type DeliveryErrorClass,
  type DropReason,
  type ExpiryReason,
  type OfferResult,
  type ProfileEvaluation,
  type ResolvedDestination,
  type TelemetryExporter,
  type TelemetryExporterOptions,
  type TransportRequest,
  type TransportResult
} from '../../contracts/telemetry-export';
import { CREDENTIAL_UNREAD, readCredential, type CredentialState } from './credential-reader';
import { createHealthCounters } from './delivery-health';
import { createExportQueue, type QueuedBatch } from './export-queue';
import { createRecordIntake } from './record-intake';
import { CONNECTION_LOST, classifyDelivery, isTransportResult, nextRetry, type DeliveryClassification } from './retry-policy';

const BOUNDS = TELEMETRY_EXPORT_BOUNDS;
const CONTENT_TYPE = 'application/json';

type TeardownReason = Extract<DropReason, 'disabled' | 'authorization-changed' | 'shutdown'>;

interface Destination {
  readonly resolved: ResolvedDestination;
  readonly url: URL;
  readonly generation: number;
}

interface InFlight {
  readonly controller: AbortController;
  done: Promise<void>;
}

interface TimerSlot {
  handle: unknown;
}

function destinationOf(evaluation: ProfileEvaluation, generation: number): Destination | null {
  if (evaluation.kind !== 'authorized') return null;
  try {
    return { resolved: evaluation.destination, url: new URL(evaluation.destination.endpoint), generation };
  } catch {
    // An endpoint the policy would not have authorized: no destination.
    return null;
  }
}

function sameDestination(left: Destination, right: Destination): boolean {
  const a = left.resolved;
  const b = right.resolved;
  return (
    left.generation === right.generation &&
    a.profileId === b.profileId &&
    a.profileRevision === b.profileRevision &&
    a.endpoint === b.endpoint &&
    a.plaintextLoopback === b.plaintextLoopback &&
    (a.credential === null ? null : a.credential.reference) === (b.credential === null ? null : b.credential.reference) &&
    (a.credential === null ? null : a.credential.headerName) === (b.credential === null ? null : b.credential.headerName)
  );
}

function listOf(records: readonly unknown[]): readonly unknown[] | null {
  try {
    return Array.isArray(records) ? Array.from(records as readonly unknown[]) : null;
  } catch {
    // A list that cannot be read is one refused offer.
    return null;
  }
}

function errorClassOf(verdict: DeliveryClassification): DeliveryErrorClass | null {
  switch (verdict.outcome) {
    case 'acknowledged':
      return verdict.anomaly;
    case 'retry':
    case 'rejected':
      return verdict.errorClass;
    case 'redirect-refused':
      return 'redirect-refused';
  }
}

export function createTelemetryExporter(options: TelemetryExporterOptions): TelemetryExporter {
  const { transport, clock, timers, random, secrets, ledger } = options;
  const batches = createExportQueue();
  const counters = createHealthCounters();
  const intake = createRecordIntake({
    ledger,
    counters,
    clock,
    batch: options.serviceVersion === undefined ? {} : { serviceVersion: options.serviceVersion },
    onBound: () => {
      seal();
    }
  });
  let destination: Destination | null = null;
  let inFlight: InFlight | null = null;
  let retryTimer: TimerSlot | null = null;
  let credential: CredentialState = CREDENTIAL_UNREAD;
  /** Raised by every teardown, so a continuation can tell that its batch is gone. */
  let epoch = 0;
  /** Aborted requests that have not ended yet; nothing new is sent until they have. */
  let unwinding = 0;
  let shutDown = false;
  let idleWaiters: (() => void)[] = [];

  function guardLedger(call: () => void): void {
    try {
      call();
    } catch {
      counters.ledgerFault();
    }
  }

  function finishDropped(batchId: string, reason: DropReason): void {
    counters.dropped(reason);
    guardLedger(() => {
      ledger.recordDisposition(batchId, 'dropped', reason);
    });
  }

  function finishExpired(batchId: string, reason: ExpiryReason): void {
    counters.expired(reason);
    guardLedger(() => {
      ledger.recordDisposition(batchId, 'expired', reason);
    });
  }

  function clearRetryTimer(): void {
    if (retryTimer === null) return;
    timers.clear(retryTimer.handle);
    retryTimer = null;
  }

  function resolveIdle(): void {
    if (batches.size() > 0 || inFlight !== null || idleWaiters.length === 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Ends all delivery work; returns the aborted request's completion, if one was in flight. */
  function teardown(reason: TeardownReason): Promise<void> | null {
    epoch += 1;
    const aborted = inFlight;
    inFlight = null;
    clearRetryTimer();
    if (intake.discard()) finishDropped(randomUUID(), reason);
    for (const batch of batches.drain()) finishDropped(batch.batchId, reason);
    credential = CREDENTIAL_UNREAD;
    resolveIdle();
    if (aborted === null) return null;
    unwinding += 1;
    aborted.controller.abort();
    return aborted.done.then(() => {
      unwinding -= 1;
      pump();
    });
  }

  async function sendOnce(request: TransportRequest): Promise<TransportResult> {
    try {
      const result: unknown = await transport.send(request);
      return isTransportResult(result) ? result : CONNECTION_LOST;
    } catch {
      return CONNECTION_LOST;
    }
  }

  function scheduleRetry(attempt: QueuedBatch, retryAfterMs: number | null, now: number): void {
    const decision = nextRetry({
      attemptsMade: attempt.attemptsMade,
      firstAttemptAt: attempt.firstAttemptAt ?? now,
      now,
      retryAfterMs,
      random
    });
    if (decision.kind === 'exhausted') {
      batches.remove(attempt.batchId);
      finishExpired(attempt.batchId, 'retry-budget-exhausted');
      return;
    }
    batches.awaitRetry(attempt.batchId);
    const slot: TimerSlot = { handle: undefined };
    retryTimer = slot;
    slot.handle = timers.set(() => {
      if (retryTimer !== slot) return;
      retryTimer = null;
      pump();
    }, decision.delayMs);
  }

  function conclude(attempt: QueuedBatch, attemptId: string, result: TransportResult): void {
    const now = clock.now();
    const verdict = classifyDelivery(result);
    const { batchId } = attempt;
    const errorClass = errorClassOf(verdict);
    guardLedger(() => {
      ledger.recordReceipt({
        batchId,
        attemptId,
        at: now,
        outcome: verdict.outcome,
        statusCode: result.kind === 'response' ? result.statusCode : null,
        rejectedDataPoints: verdict.outcome === 'acknowledged' ? verdict.rejectedDataPoints : 0,
        errorClass
      });
    });
    if (verdict.outcome === 'acknowledged') {
      batches.remove(batchId);
      counters.acknowledged(now, verdict.rejectedDataPoints, verdict.anomaly);
      guardLedger(() => {
        ledger.recordDisposition(batchId, 'acknowledged', null);
      });
      return;
    }
    if (errorClass !== null) counters.error(errorClass);
    if (verdict.outcome === 'retry') {
      scheduleRetry(attempt, verdict.retryAfterMs, now);
      return;
    }
    batches.remove(batchId);
    finishDropped(batchId, verdict.outcome);
  }

  async function deliver(head: QueuedBatch, target: Destination, signal: AbortSignal, sendEpoch: number): Promise<void> {
    const reference = target.resolved.credential;
    let held = credential;
    if (reference !== null && held.kind === 'unread') {
      held = await readCredential(secrets, reference.reference);
      if (epoch !== sendEpoch) return;
      credential = held;
    }
    if (held.kind === 'failed') {
      // Saturation may have dropped the batch while the credential was read.
      if (batches.remove(head.batchId) === undefined) return;
      counters.error(held.reason);
      finishDropped(head.batchId, held.reason);
      return;
    }
    const attempt = batches.beginAttempt(head.batchId, clock.now());
    if (attempt === undefined) return;
    const headers: Record<string, string> = { 'content-type': CONTENT_TYPE };
    if (reference !== null && held.kind === 'value') headers[reference.headerName] = held.value;
    const attemptId = randomUUID();
    const result = await sendOnce({
      url: target.url,
      plaintextLoopback: target.resolved.plaintextLoopback,
      headers,
      body: attempt.body,
      deadlineMs: BOUNDS.requestDeadlineMs,
      signal
    });
    if (epoch !== sendEpoch) return;
    conclude(attempt, attemptId, result);
  }

  /** Starts the next delivery when nothing is in flight and no retry is pending. */
  function pump(): void {
    if (shutDown || destination === null || inFlight !== null || retryTimer !== null || unwinding > 0) return;
    for (const batch of batches.takeExpired(clock.now())) finishExpired(batch.batchId, 'age');
    const head = batches.head();
    if (head === undefined) {
      resolveIdle();
      return;
    }
    const controller = new AbortController();
    const flight: InFlight = { controller, done: Promise.resolve() };
    inFlight = flight;
    flight.done = deliver(head, destination, controller.signal, epoch).then(() => {
      if (inFlight !== flight) return;
      inFlight = null;
      pump();
    });
  }

  /** Closes the open batch into the queue and starts delivery. */
  function seal(): void {
    const closed = intake.close();
    if (closed === null || destination === null) return;
    const batchId = randomUUID();
    if (closed.body.byteLength > BOUNDS.batchBytesMax) {
      finishDropped(batchId, 'batch-oversized');
      return;
    }
    const sealed = { batchId, ...closed, sealedAt: clock.now(), authorizationGeneration: destination.generation };
    for (const dropped of batches.enqueue(sealed)) finishDropped(dropped.batchId, 'queue-saturated');
    // The batch that was waiting for its retry may be the one that made room.
    const head = batches.head();
    if (head === undefined || head.state !== 'retrying') clearRetryTimer();
    pump();
  }

  return {
    configure(evaluation, authorizationGeneration) {
      if (shutDown) return;
      const next = destinationOf(evaluation, authorizationGeneration);
      if (destination !== null && next !== null && sameDestination(destination, next)) return;
      if (destination !== null) void teardown(evaluation.kind === 'disabled' ? 'disabled' : 'authorization-changed');
      destination = next;
      counters.destinationChanged();
    },
    offer(records): OfferResult {
      const list = listOf(records);
      if (list === null || shutDown || destination === null) {
        counters.refusedOffer();
        return { accepted: 0, duplicate: 0, refused: list === null ? 0 : list.length };
      }
      const { profileId } = destination.resolved;
      const counts = { accepted: 0, duplicate: 0, refused: 0 };
      for (const value of list) counts[intake.take(value, profileId)] += 1;
      return counts;
    },
    flush() {
      if (shutDown) return;
      seal();
      pump();
    },
    disable() {
      if (shutDown || destination === null) return;
      void teardown('disabled');
      destination = null;
      counters.destinationChanged();
    },
    shutdown() {
      if (shutDown) return Promise.resolve();
      shutDown = true;
      const aborted = teardown('shutdown');
      destination = null;
      if (aborted === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const slot: TimerSlot = { handle: undefined };
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          timers.clear(slot.handle);
          resolve();
        };
        slot.handle = timers.set(finish, BOUNDS.shutdownBudgetMs);
        void aborted.then(finish);
      });
    },
    health() {
      const head = batches.head();
      return counters.snapshot({
        hasDestination: destination !== null,
        retrying: head !== undefined && (head.state === 'retrying' || head.attemptsMade > 1),
        queuedBatches: batches.size(),
        queuedBytes: batches.bytes()
      });
    },
    idle() {
      if (batches.size() === 0 && inFlight === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    }
  };
}
