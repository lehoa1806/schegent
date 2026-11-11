/**
 * FR-R6-F15 (F15-A; NFR-003, research R11) — admission of handoff preparations: two active
 * owners, eight queued in arrival order, 8 MiB of working set across the active owners and a
 * two-second deadline counted from activation.
 *
 * A refusal changes nothing, so a refused preparation stays pending with its owner. Arrival
 * order is strict: the oldest queued owner is the only one that may become active, and an owner
 * that asks while others wait joins the end, however small its working set. A queued owner has
 * no deadline. The clock is injected; nothing here reads the time or schedules anything, so the
 * host decides when `expire` is asked.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { IDENTIFIER_PATTERN, PHASE_CONTEXT_LIMITS, type Refusal } from '../../contracts/phase-context/context-policy';
import { isWholeNumber, matchesPattern, refuse } from './primitives';

export type AdmissionState = 'active' | 'queued';
export type AdmissionResult = { readonly ok: true; readonly state: AdmissionState } | Refusal;

export interface AdmissionSnapshot {
  readonly active: number;
  readonly queued: number;
  /** The working set of the active owners together. */
  readonly workingSetBytes: number;
}

export interface PreparationAdmission {
  /** Admits or queues an owner, returns the state of one already known, or refuses and keeps nothing. */
  request(ownerKey: string, workingSetBytes: number): AdmissionResult;
  /** Ends an owner, active or queued, and lets the queue move up. An unknown owner changes nothing. */
  release(ownerKey: string): void;
  /** Ends every owner active for more than 2,000 ms and returns their keys in activation order. */
  expire(): string[];
  snapshot(): AdmissionSnapshot;
}

export interface AdmissionOptions {
  /** Milliseconds on any clock that does not go back. */
  now(): number;
}

interface ActiveOwner {
  readonly ownerKey: string;
  readonly workingSetBytes: number;
  readonly startedAt: number;
}

interface QueuedOwner {
  readonly ownerKey: string;
  readonly workingSetBytes: number;
}

class Admission implements PreparationAdmission {
  /** In activation order. */
  private active: ActiveOwner[] = [];
  /** In arrival order. */
  private queue: QueuedOwner[] = [];

  constructor(private readonly options: AdmissionOptions) {}

  request(ownerKey: string, workingSetBytes: number): AdmissionResult {
    if (!matchesPattern(IDENTIFIER_PATTERN, ownerKey)) return refuse('invalid-source', 'owner-key');
    if (!isWholeNumber(workingSetBytes, 0)) return refuse('invalid-source', 'working-set');
    if (this.active.some((owner) => owner.ownerKey === ownerKey)) return { ok: true, state: 'active' };
    if (this.queue.some((owner) => owner.ownerKey === ownerKey)) return { ok: true, state: 'queued' };
    if (workingSetBytes > PHASE_CONTEXT_LIMITS.workingSetBytesMax) return refuse('capacity-exceeded', 'working-set-exceeded');
    if (this.queue.length === 0 && this.fits(workingSetBytes)) {
      this.activate({ ownerKey, workingSetBytes });
      return { ok: true, state: 'active' };
    }
    if (this.queue.length >= PHASE_CONTEXT_LIMITS.queuedPreparationsMax) return refuse('capacity-exceeded', 'preparation-queue-full');
    this.queue = [...this.queue, { ownerKey, workingSetBytes }];
    return { ok: true, state: 'queued' };
  }

  release(ownerKey: string): void {
    this.active = this.active.filter((owner) => owner.ownerKey !== ownerKey);
    this.queue = this.queue.filter((owner) => owner.ownerKey !== ownerKey);
    this.promote();
  }

  expire(): string[] {
    const now = this.options.now();
    const ended = this.active.filter((owner) => now - owner.startedAt > PHASE_CONTEXT_LIMITS.preparationDeadlineMs);
    if (ended.length === 0) return [];
    this.active = this.active.filter((owner) => !ended.includes(owner));
    this.promote();
    return ended.map((owner) => owner.ownerKey);
  }

  snapshot(): AdmissionSnapshot {
    return { active: this.active.length, queued: this.queue.length, workingSetBytes: this.activeBytes() };
  }

  private activeBytes(): number {
    return this.active.reduce((total, owner) => total + owner.workingSetBytes, 0);
  }

  /** True when one more owner of this working set keeps both limits. */
  private fits(workingSetBytes: number): boolean {
    return (
      this.active.length < PHASE_CONTEXT_LIMITS.activePreparationsMax &&
      this.activeBytes() + workingSetBytes <= PHASE_CONTEXT_LIMITS.workingSetBytesMax
    );
  }

  private activate(owner: QueuedOwner): void {
    this.active = [...this.active, { ownerKey: owner.ownerKey, workingSetBytes: owner.workingSetBytes, startedAt: this.options.now() }];
  }

  /** Activates queued owners from the oldest while the oldest fits; it never skips one. */
  private promote(): void {
    for (;;) {
      const head = this.queue.at(0);
      if (head === undefined || !this.fits(head.workingSetBytes)) return;
      this.queue = this.queue.slice(1);
      this.activate(head);
    }
  }
}

/** NFR-003: the admission rule of handoff preparations, over the caller's clock. */
export function createPreparationAdmission(options: AdmissionOptions): PreparationAdmission {
  return new Admission(options);
}
