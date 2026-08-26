import type { BackendRunner } from '../contracts/backend-runner';
import { type BackendRunnerFactoryOptions, createBackendRunner } from './backend-runner-factory';
import { DEFAULT_BACKEND, type BackendRunnerKind } from '../contracts/backend-kinds';
import { createCliVersionProbe, type CliVersionProbe } from './cli-version-probe';

// Feature 074 — Lazy runner registry. Replaces single-runner injection in
// `PhaseRunner` with a per-invocation kind lookup so that individual phases
// can execute on different CLI backends.
//
// Lifecycle:
//   - Created once at activation.
//   - Runner instances are constructed lazily on first `getOrCreate(kind)`.
//   - Cached for the workspace lifetime.
//   - `cancelAll()` cancels every active runner on deactivation.
//
// Thread safety: VS Code extension host is single-threaded; the Map
// provides natural exclusion. No mutex needed.

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
  private readonly versionProbe: CliVersionProbe = createCliVersionProbe();

  // FR-R3-056 — no default for `factoryOptions` any more. It carried `{}`, which
  // would now mean "uncontained refused" by accident rather than by decision; a
  // caller must state its posture, and tsc is what makes that true.
  constructor(
    private readonly factoryOptions: BackendRunnerFactoryOptions,
    private readonly globalDefault: BackendRunnerKind = DEFAULT_BACKEND
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
      this.runners.set(effectiveKind, runner);
    }
    return runner;
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
   * Cancel all active invocations across every cached runner.
   * Called at deactivation to ensure no orphaned CLI processes.
   */
  public cancelAll(): void {
    for (const runner of this.runners.values()) {
      try {
        runner.cancelActive();
      } catch {
        // Deactivation cleanup is best-effort; continue canceling the other
        // backend processes even if one adapter reports a teardown failure.
      }
    }
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
}
