import type {
  BackendAvailabilityAdapter,
  BackendRunner,
  FrozenPhaseQuotaTarget,
  QuotaContext,
  QuotaStatusCheckSupport,
  TreeTeardownOutcome
} from '../contracts/backend-runner';
import {
  BACKEND_AVAILABILITY_VERSION,
  UNKNOWN_LOCAL_QUOTA_ID,
  validateQuotaContext
} from '../contracts/backend-availability';
import { type BackendRunnerFactoryOptions, createBackendRunner } from './backend-runner-factory';
import { DEFAULT_BACKEND, type BackendRunnerKind } from '../contracts/backend-kinds';
import { SHIPPED_DEFAULT_POLICY } from '../contracts/process-environment-policy';
import {
  UncontainedBackendRefusedError,
  containmentOf,
  judgeBackendContainment
} from '../services/backend-containment-policy';
import { createCliVersionProbe, type CliVersionProbe } from './cli-version-probe';
import { TEARDOWN_BOUND_MS } from './process-tree';

// Feature 074 — Lazy runner registry. Replaces single-runner injection in
// `PhaseRunner` with a per-invocation kind lookup so that individual phases
// can execute on different CLI backends.
//
// Lifecycle:
//   - Created once at activation.
//   - Runner instances are constructed lazily on first `getOrCreate(kind)`.
//   - Cached for the workspace lifetime.
//   - `closeAndTearDown()` closes every runner, cancels its active invocations
//     and waits, under one bound, for the backend trees to be gone; a runner
//     built after it is handed out closed. `cancelAll()` is its synchronous
//     wrapper for callers that cannot wait (FR-R4-F06).
//
// Thread safety: VS Code extension host is single-threaded; the Map
// provides natural exclusion. No mutex needed.

/**
 * FR-R4-F06 (FR-020; S3) -- what a shutdown teardown found: how every backend tree ended, the bound
 * it waited under, and how long it took. `elapsedMs` is monotonic; `boundMs` is the bound used.
 */
export interface TeardownReport {
  readonly outcomes: readonly TreeTeardownOutcome[];
  readonly boundMs: number;
  readonly elapsedMs: number;
}

/**
 * A lazy registry of `BackendRunner` instances keyed by `BackendRunnerKind`.
 * Runners are constructed on first use and cached for the workspace lifetime.
 *
 * The registry is the SINGLE construction site for runner instances so
 * `PhaseRunner` doesn't need to know how to build runners — it just
 * queries the registry per-invocation with the effective runner kind.
 */
export class BackendRunnerRegistry {
  private readonly runners = new Map<BackendRunnerKind, BackendRunner>();
  private readonly availabilityAdapters = new Map<BackendRunnerKind, BackendAvailabilityAdapter>();
  // FR-R4-F06 (FR-004) -- the probe takes its environment policy from the factory options,
  // read at each lookup. It used to take none, so a `--version` child inherited the host's
  // complete environment under every mode. An absent policy is the shipped allowlist default.
  private readonly versionProbe: CliVersionProbe = createCliVersionProbe({
    environmentPolicy: () => this.factoryOptions.environmentPolicy ?? SHIPPED_DEFAULT_POLICY
  });
  /** Set by `closeAndTearDown()`; every runner handed out after it is closed. */
  private closed = false;
  /** The one teardown (S3). A second call returns this promise rather than starting another. */
  private teardown: Promise<TeardownReport> | undefined;

  // FR-R3-056 — no default for `factoryOptions` any more. It carried `{}`, which
  // would now mean "uncontained refused" by accident rather than by decision; a
  // caller must state its posture, and tsc is what makes that true.
  constructor(
    private readonly factoryOptions: BackendRunnerFactoryOptions,
    private readonly globalDefault: BackendRunnerKind = DEFAULT_BACKEND,
    /** The teardown bound. Only a test injects another: a shorter one shows a ladder that never settles. */
    private readonly teardownBoundMs: number = TEARDOWN_BOUND_MS
  ) {}

  /**
   * Return the global default runner kind.
   */
  public getGlobalDefault(): BackendRunnerKind {
    return this.globalDefault;
  }

  /**
   * Return (or lazily construct) the runner for the given kind.
   *
   * When `kind` is `undefined`, falls back to the global default.
   */
  public getOrCreate(kind?: BackendRunnerKind): BackendRunner {
    const effectiveKind = kind ?? this.globalDefault;
    let runner = this.runners.get(effectiveKind);
    if (!runner) {
      runner = createBackendRunner(effectiveKind, this.factoryOptions);
      if (this.closed) runner.close();
      this.runners.set(effectiveKind, runner);
    } else {
      this.rejudgeCached(effectiveKind);
    }
    return runner;
  }

  /**
   * FR-R4-F06 (FR-010; contract D, D8) -- a revoked grant refuses the NEXT start, not only
   * a first construction.
   *
   * The grant was judged only when a runner was built, and a runner is cached for the
   * window. So after a backend's first Run, removing it from
   * `schegent.backend.uncontainedBackends` changed nothing until a reload, while the launch
   * notice tells the operator the grant is theirs to revoke. A cached runner whose backend
   * is uncontained is therefore judged again at each lookup, asking the same function and
   * the same live thunk that construction asks, and a refusal throws the same error.
   *
   * The cached runner is KEPT, not closed or cancelled: a child already started carries
   * on, and only the next start is refused. A contained backend is never re-judged;
   * its verdict does not depend on the grant. The judgement reads an in-memory
   * configuration model, so the cost per Phase lookup is negligible.
   */
  private rejudgeCached(kind: BackendRunnerKind): void {
    if (containmentOf(kind) !== 'none') return;
    const verdict = judgeBackendContainment(kind, this.factoryOptions.uncontainedGranted());
    if (verdict.outcome === 'refused') {
      throw new UncontainedBackendRefusedError(verdict.kind, verdict.message);
    }
  }

  /**
   * FR-R3-104 (FR-054) — the version of the CLI at `cliPath`, as observed on this machine.
   *
   * ON THE REGISTRY because the registry is already the single place that knows which backend a
   * phase resolved to, and because putting it here costs the phase runner one call rather than a
   * constructor argument, a field and a null guard. The probe itself is a leaf
   * (`cli-version-probe.ts`) with its own cache and TTL; this is the seam that makes it reachable
   * from the one site that builds the invocation record.
   *
   * Returns `null` rather than throwing or waiting long: a version is metadata on an evidence
   * record, and a phase must never fail to run because a `--version` call did not answer.
   */
  public async observedCliVersion(cliPath: string): Promise<string | null> {
    return this.versionProbe.observe(cliPath);
  }

  /**
   * Close every runner, cancel its active invocations, and wait for the backend trees to be gone.
   * Called at deactivation, so that ownership is released only once the outcome is known
   * (FR-R4-F06, FR-020 and FR-021).
   *
   * 1. SYNCHRONOUSLY, before any `await`: the registry is marked closed, then every cached runner
   *    is closed and cancelled. Nothing can spawn between this call and the first `await`. Every
   *    runner is closed first, so nothing spawns after this. The feature-228 security review, S1:
   *    a child stopped here can read as an unfinished turn, and the controller resumes an
   *    unfinished turn with a new spawn.
   * 2. Then each runner's `settleTeardowns()` is awaited under ONE shared deadline of
   *    `teardownBoundMs` from the call. A ladder still pending then is reported `bound-elapsed`,
   *    stamped by the runner that owns it, because only the runner knows its attribution.
   * 3. MEMOIZED: a second call returns the first call's promise, so the teardown runs once
   *    however many paths ask for it (FR-024).
   *
   * Never rejects. Adding the bound is what makes it safe to await in `dispose`: the editor ends
   * the extension host `HOST_DEACTIVATE_ALLOWANCE_MS` after deactivation begins.
   */
  public closeAndTearDown(): Promise<TeardownReport> {
    if (this.teardown !== undefined) return this.teardown;
    const startedAt = performance.now();
    this.closed = true;
    const runners = [...this.runners.values()];
    for (const runner of runners) {
      try {
        runner.close();
        runner.cancelActive();
      } catch {
        // Deactivation cleanup is best-effort; continue canceling the other
        // backend processes even if one adapter reports a teardown failure.
      }
    }
    this.teardown = this.collectOutcomes(runners, startedAt);
    return this.teardown;
  }

  /**
   * The synchronous form, for callers that cannot wait. It starts the same single teardown.
   * Deactivation does not use it: the host awaits `closeAndTearDown()` through `createHostTeardown`.
   */
  public cancelAll(): void {
    void this.closeAndTearDown();
  }

  /** One runner's outcomes. A runner that throws or rejects reports none; the teardown never rejects. */
  private settleOne(
    runner: BackendRunner,
    deadline: Promise<void>
  ): Promise<readonly TreeTeardownOutcome[]> {
    try {
      return Promise.resolve(runner.settleTeardowns(deadline)).catch(
        (): readonly TreeTeardownOutcome[] => []
      );
    } catch {
      return Promise.resolve([]);
    }
  }

  private async collectOutcomes(
    runners: readonly BackendRunner[],
    startedAt: number
  ): Promise<TeardownReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.teardownBoundMs);
    });
    // A runner that ignores the deadline must not hold the shutdown past it: one macrotask after
    // the deadline, its outcomes are given up. It can be neither attributed nor reported.
    const giveUp = deadline.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    // Called synchronously, in the same turn as the `cancelActive()` that started the ladders, so
    // each runner's snapshot of open ladders includes every one the cancel just started.
    const perRunner = runners.map(
      (runner): Promise<readonly TreeTeardownOutcome[]> =>
        Promise.race([
          this.settleOne(runner, deadline),
          giveUp.then((): readonly TreeTeardownOutcome[] => [])
        ])
    );
    const settled = await Promise.all(perRunner);
    clearTimeout(timer);
    return {
      outcomes: settled.flat(),
      boundMs: this.teardownBoundMs,
      elapsedMs: performance.now() - startedAt
    };
  }

  /**
   * Check if any cached runner has an active process.
   */
  public hasAnyActiveProcess(): boolean {
    for (const runner of this.runners.values()) {
      if (runner.hasActiveProcess) return true;
    }
    return false;
  }

  /**
   * FR-R5-F28 (SPEC-06, D7) — Register a read-only availability adapter for a backend kind.
   */
  public registerAvailabilityAdapter(
    kind: BackendRunnerKind,
    adapter: BackendAvailabilityAdapter
  ): void {
    this.availabilityAdapters.set(kind, adapter);
  }

  /**
   * FR-R5-F28 (SPEC-06, D7) — Return the availability adapter for `kind`.
   * Built-in CLI adapters default to explicit `statusCheck: 'unsupported'` and
   * conservative `unknown-local-quota` identity unless a qualified adapter is registered.
   */
  public getAvailabilityAdapter(kind?: BackendRunnerKind): BackendAvailabilityAdapter {
    const effectiveKind = kind ?? this.globalDefault;
    const registered = this.availabilityAdapters.get(effectiveKind);
    if (registered !== undefined) {
      return registered;
    }
    const cachedRunner = this.runners.get(effectiveKind);
    if (cachedRunner?.availabilityAdapter !== undefined) {
      return cachedRunner.availabilityAdapter;
    }
    const adapterId = `${effectiveKind}-cli`;
    return Object.freeze({
      adapterId,
      adapterVersion: BACKEND_AVAILABILITY_VERSION,
      backend: effectiveKind,
      statusCheck: 'unsupported' as QuotaStatusCheckSupport,
      resolveQuotaContext: (): QuotaContext =>
        Object.freeze({
          version: BACKEND_AVAILABILITY_VERSION,
          adapterId,
          adapterVersion: BACKEND_AVAILABILITY_VERSION,
          quotaIds: Object.freeze([UNKNOWN_LOCAL_QUOTA_ID]),
          identity: 'unknown',
          statusCheck: 'unsupported',
          capacity: 1
        })
    });
  }

  /**
   * FR-R5-F28 (SPEC-06, D7) — Resolve and validate the `QuotaContext` for a frozen Phase.
   */
  public resolveQuotaContext(frozenPhase: FrozenPhaseQuotaTarget): QuotaContext {
    const adapter = this.getAvailabilityAdapter(frozenPhase.runner);
    const rawContext = adapter.resolveQuotaContext(frozenPhase);
    const validated = validateQuotaContext(rawContext);
    if (!validated.ok) {
      throw new Error(validated.message);
    }
    return validated.value;
  }
}
