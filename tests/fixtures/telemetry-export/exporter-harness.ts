// FR-R6-F14 T003 — a harness for the exporter: a clock the test moves, timers that fire in time
// order when the clock moves, a seeded random, a scripted transport that records each request,
// and a secret port that counts its reads. Everything here is synthetic; no network is used.
import type {
  ExporterTimers,
  ProfileEvaluation,
  ResolvedDestination,
  TelemetryExporter,
  TelemetryLedgerPort,
  TelemetrySecretPort,
  TelemetryTransport,
  TransportRequest,
  TransportResult
} from '../../../src/contracts/telemetry-export';
import { createInMemoryLedger, type InMemoryLedger } from '../../../src/services/telemetry-export/in-memory-ledger';
import { createTelemetryExporter } from '../../../src/services/telemetry-export/telemetry-exporter';
import { mulberry32 } from '../seeded-rng';

/** 2026-11-11T06:00:00Z, a fixed start so no test reads the wall clock. */
export const HARNESS_START_MS = 1_762_840_800_000;
export const SYNTHETIC_ENDPOINT = 'https://collector.example.test/v1/metrics';
export const SYNTHETIC_HEADER = 'x-export-credential';
export const SYNTHETIC_CREDENTIAL = 'synthetic-credential-value';
export const SYNTHETIC_REFERENCE = 'telemetry/profile-1';

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

export function ok(body = '{}'): TransportResult {
  return { kind: 'response', statusCode: 200, retryAfterSeconds: null, body: ENCODER.encode(body), bodyTruncated: false };
}

export function status(statusCode: number, retryAfterSeconds: number | null = null): TransportResult {
  return { kind: 'response', statusCode, retryAfterSeconds, body: new Uint8Array(0), bodyTruncated: false };
}

export function failure(errorClass: 'network' | 'tls' | 'deadline'): TransportResult {
  return { kind: 'failure', errorClass };
}

/** What the scripted transport does with one request. */
export type Answer = TransportResult | 'hang' | 'throw';

export interface SentRequest {
  readonly url: string;
  readonly plaintextLoopback: boolean;
  readonly headers: Readonly<Record<string, string>>;
  /** A copy taken when the request was sent. */
  readonly body: Uint8Array;
  readonly text: string;
  readonly deadlineMs: number;
}

export interface ScriptedTransport extends TelemetryTransport {
  /** Queues answers; a request with no queued answer is acknowledged. */
  answer(...answers: Answer[]): void;
  readonly requests: readonly SentRequest[];
  /** Requests that have not ended. */
  inFlight(): number;
  /** The most requests that were ever in flight together. */
  inFlightMax(): number;
}

export function createScriptedTransport(): ScriptedTransport {
  const queued: Answer[] = [];
  const requests: SentRequest[] = [];
  let inFlight = 0;
  let inFlightMax = 0;

  function record(request: TransportRequest): void {
    const body = Uint8Array.from(request.body);
    requests.push({
      url: request.url.href,
      plaintextLoopback: request.plaintextLoopback,
      headers: { ...request.headers },
      body,
      text: DECODER.decode(body),
      deadlineMs: request.deadlineMs
    });
  }

  /** Ends only when the request is aborted, like a destination that never answers. */
  function hang(signal: AbortSignal): Promise<TransportResult> {
    return new Promise((resolve) => {
      const end = (): void => {
        resolve({ kind: 'failure', errorClass: 'aborted' });
      };
      if (signal.aborted) end();
      else signal.addEventListener('abort', end, { once: true });
    });
  }

  return {
    requests,
    answer(...answers) {
      queued.push(...answers);
    },
    inFlight: () => inFlight,
    inFlightMax: () => inFlightMax,
    async send(request) {
      record(request);
      const answer = queued.shift() ?? ok();
      if (answer === 'throw') throw new Error('synthetic transport fault');
      inFlight += 1;
      inFlightMax = Math.max(inFlightMax, inFlight);
      try {
        // One turn of the event loop, so a response never arrives inside the call that sent it.
        await Promise.resolve();
        return answer === 'hang' ? await hang(request.signal) : answer;
      } finally {
        inFlight -= 1;
      }
    }
  };
}

export interface CountingSecrets extends TelemetrySecretPort {
  reads(): number;
  /** What the next reads return; `'throw'` makes the port throw. */
  set(value: string | null | 'throw'): void;
  setAvailability(value: 'available' | 'unavailable'): void;
}

const THROW = 'throw';

export function createCountingSecrets(initial: string | null = SYNTHETIC_CREDENTIAL): CountingSecrets {
  let value: string | null = initial;
  let throws = false;
  let availability: 'available' | 'unavailable' = 'available';
  let reads = 0;
  return {
    availability: () => availability,
    read() {
      reads += 1;
      if (throws) return Promise.reject(new Error('synthetic secret store fault'));
      return Promise.resolve(value);
    },
    reads: () => reads,
    set(next) {
      throws = next === THROW;
      value = next === THROW ? null : next;
    },
    setAvailability(next) {
      availability = next;
    }
  };
}

interface Scheduled {
  readonly id: number;
  readonly at: number;
  readonly callback: () => void;
}

export interface FakeTime {
  readonly clock: { now(): number };
  readonly timers: ExporterTimers;
  /** Moves the clock without firing a timer, as a suspended machine would. */
  jump(ms: number): void;
  /** Moves the clock, firing each timer that falls due, in time order. */
  advance(ms: number): Promise<void>;
  pendingTimers(): number;
  /** The delays the timers were set with, in the order they were set. */
  delays(): readonly number[];
}

/** Lets promise continuations and immediates run. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export function createFakeTime(start = HARNESS_START_MS): FakeTime {
  let now = start;
  let nextId = 1;
  let scheduled: readonly Scheduled[] = [];
  const delays: number[] = [];

  function nextDue(limit: number): Scheduled | undefined {
    return scheduled
      .filter((entry) => entry.at <= limit)
      .reduce<Scheduled | undefined>((first, entry) => {
        if (first === undefined) return entry;
        if (entry.at !== first.at) return entry.at < first.at ? entry : first;
        return entry.id < first.id ? entry : first;
      }, undefined);
  }

  return {
    clock: { now: () => now },
    timers: {
      set(callback, delayMs) {
        const entry: Scheduled = { id: nextId, at: now + delayMs, callback };
        nextId += 1;
        scheduled = [...scheduled, entry];
        delays.push(delayMs);
        return entry.id;
      },
      clear(handle) {
        scheduled = scheduled.filter((entry) => entry.id !== handle);
      }
    },
    jump(ms) {
      now += ms;
    },
    async advance(ms) {
      const limit = now + ms;
      await settle();
      for (let due = nextDue(limit); due !== undefined; due = nextDue(limit)) {
        const firing = due;
        scheduled = scheduled.filter((entry) => entry.id !== firing.id);
        now = Math.max(now, firing.at);
        firing.callback();
        await settle();
      }
      now = limit;
      await settle();
    },
    pendingTimers: () => scheduled.length,
    delays: () => delays
  };
}

export function destination(overrides: Partial<ResolvedDestination> = {}): ResolvedDestination {
  return {
    profileId: 'profile-1',
    profileRevision: 1,
    endpoint: SYNTHETIC_ENDPOINT,
    plaintextLoopback: false,
    credential: { reference: SYNTHETIC_REFERENCE, headerName: SYNTHETIC_HEADER },
    ...overrides
  };
}

export function authorized(overrides: Partial<ResolvedDestination> = {}): ProfileEvaluation {
  return { kind: 'authorized', destination: destination(overrides) };
}

export interface HarnessOptions {
  readonly seed?: number;
  readonly secrets?: TelemetrySecretPort | null;
  readonly ledger?: TelemetryLedgerPort;
  readonly transport?: TelemetryTransport;
  readonly random?: () => number;
  readonly serviceVersion?: string;
}

export interface Harness {
  readonly exporter: TelemetryExporter;
  readonly time: FakeTime;
  readonly transport: ScriptedTransport;
  readonly secrets: CountingSecrets;
  readonly ledger: InMemoryLedger;
  /** Configures the default authorized destination under generation 1. */
  authorize(overrides?: Partial<ResolvedDestination>, generation?: number): void;
}

const DEFAULT_SEED = 313;

export function createHarness(options: HarnessOptions = {}): Harness {
  const time = createFakeTime();
  const transport = createScriptedTransport();
  const secrets = createCountingSecrets();
  const ledger = createInMemoryLedger();
  const exporter = createTelemetryExporter({
    transport: options.transport ?? transport,
    clock: time.clock,
    timers: time.timers,
    random: options.random ?? mulberry32(options.seed ?? DEFAULT_SEED),
    secrets: options.secrets === undefined ? secrets : options.secrets,
    ledger: options.ledger ?? ledger,
    ...(options.serviceVersion === undefined ? {} : { serviceVersion: options.serviceVersion })
  });
  return {
    exporter,
    time,
    transport,
    secrets,
    ledger,
    authorize(overrides = {}, generation = 1) {
      exporter.configure(authorized(overrides), generation);
    }
  };
}
