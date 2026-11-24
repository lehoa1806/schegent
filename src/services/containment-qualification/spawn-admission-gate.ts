// FR-R6-F09 (FR-003, FR-008, FR-013; contract section 2, research R11) -- the admission check
// every backend spawn awaits, after the runner exists and before its child does.
//
// ORDER, first refusal wins:
//   1. workspace trust and 2. primacy, read before anything is started;
//   3. executable resolution -- an unresolved executable is never asked for its version;
//   4. the version, through the registry's cached probe;
//   5-7. the record, the grant and the binding (`judgeSpawnAdmission`);
//   8. the per-Run check: inside one Run, a backend's fingerprint may not change. It is keyed by
//      Run and backend, because one Run may use a different backend per phase, and it compares
//      components under the binding's rule, so a no-claim backend's unreadable version is no change.
// A `legacy-first-use` binding is written before `admit` resolves.
//
// FAILURE. A refusal throws `ContainmentAdmissionRefusedError`. Any other failure of a dependency
// is rethrown unchanged, so the caller's ordinary failure path reports it; nothing here admits on
// an error. Log lines name the kind and the reason, never a path or a version string.

import { getBackendDescriptor } from '../../contracts/backend-descriptors';
import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type {
  AcceptanceOrigin,
  BackendIdentity,
  BindingInput,
  ExecutableUnresolvedCause,
  FingerprintRecord,
  SpawnAdmissionDecision,
  SpawnAdmissionRequest,
  SpawnGate
} from '../../contracts/containment-qualification';
import { judgeSpawnAdmission, versionIsIgnorable } from './admission';
import { ContainmentAdmissionRefusedError } from './admission-refusal';
import { diffFingerprint, versionMinorOf } from './fingerprint';
import type { BackendIdentityCache } from './identity-cache';
import type { ScannerAdmissionGate } from './scanner-admission';

/** Runs whose first admitted fingerprints are kept; the oldest is evicted past this. */
export const PER_RUN_FINGERPRINT_CAPACITY = 256;

/**
 * Raised by {@link SpawnGate.admit} when `request.cancellationSignal` aborts before admission
 * completes. Fail-closed: an aborted admission never resolves as admitted, never spawns
 * `--version`, and never mutates Memento acceptance bindings.
 */
export class SpawnAdmissionCancelledError extends Error {
  public constructor() {
    super('Spawn admission cancelled.');
    this.name = 'SpawnAdmissionCancelledError';
  }
}

/** The slice of the acceptance binding store the gate reads and writes. */
export interface SpawnAdmissionBindings {
  read(kind: BackendRunnerKind): BindingInput;
  bind(kind: BackendRunnerKind, fingerprint: FingerprintRecord, origin: AcceptanceOrigin): Promise<void>;
}

export interface SpawnAdmissionGateDeps {
  isTrusted(): boolean;
  /** The workspace lock's answer, which is asynchronous: it verifies the claim in storage. */
  hasPrimacy(): boolean | Promise<boolean>;
  resolveExecutable(cliPath: string): Promise<'resolved' | ExecutableUnresolvedCause>;
  /** The registry's cached `--version` probe: the normalised line, or `null` when unreadable. */
  observeVersion(
    kind: BackendRunnerKind,
    cliPath: string,
    cancellationSignal?: AbortSignal
  ): Promise<string | null>;
  granted(): ReadonlySet<BackendRunnerKind>;
  readonly bindings: SpawnAdmissionBindings;
  readonly platform: { readonly os: string; readonly arch: string };
  /** Called at each admission; the wiring passes the policy resolved when the window started. */
  environmentPolicyDigest(): string;
  readonly identityCache?: BackendIdentityCache;
  /** FR-R8-02 (02-02): dedicated single-resolution admission gate for standalone review scanners (`codex-security`). */
  readonly scannerAdmission?: ScannerAdmissionGate;
  readonly logger: { warn(line: string): void };
}

class PerRunFingerprints {
  private readonly runs = new Map<string, Map<BackendRunnerKind, FingerprintRecord>>();

  /** The same rule as the binding: an unreadable version on a no-claim backend is no change. */
  changed(runId: string | undefined, kind: BackendRunnerKind, fingerprint: FingerprintRecord): boolean {
    if (runId === undefined) return false;
    const first = this.runs.get(runId)?.get(kind);
    if (first === undefined) return false;
    const ignoreVersion = versionIsIgnorable(kind, first, fingerprint);
    return diffFingerprint(first, fingerprint, { ignoreVersion }) !== null;
  }

  remember(runId: string | undefined, kind: BackendRunnerKind, fingerprint: FingerprintRecord): void {
    if (runId === undefined) return;
    const existing = this.runs.get(runId);
    if (existing !== undefined) {
      if (!existing.has(kind)) existing.set(kind, fingerprint);
      return;
    }
    if (this.runs.size >= PER_RUN_FINGERPRINT_CAPACITY) {
      const oldest = this.runs.keys().next();
      if (oldest.done !== true) this.runs.delete(oldest.value);
    }
    this.runs.set(runId, new Map([[kind, fingerprint]]));
  }
}

export function createSpawnAdmissionGate(deps: SpawnAdmissionGateDeps): SpawnGate {
  const perRun = new PerRunFingerprints();

  function refused(kind: BackendRunnerKind, init: Omit<ConstructorParameters<typeof ContainmentAdmissionRefusedError>[0], 'kind'>) {
    deps.logger.warn(`spawn admission: refused kind=${kind} reason=${init.reason}`);
    return new ContainmentAdmissionRefusedError({ kind, ...init });
  }

  async function observe(
    kind: BackendRunnerKind,
    cliPath: string,
    signal?: AbortSignal
  ): Promise<BackendIdentity> {
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    const executable = await deps.resolveExecutable(cliPath);
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    const versionMinor =
      executable === 'resolved'
        ? versionMinorOf(
            signal === undefined
              ? await deps.observeVersion(kind, cliPath)
              : await deps.observeVersion(kind, cliPath, signal)
          )
        : null;
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    const identity: BackendIdentity = {
      kind,
      executable,
      versionMinor,
      os: deps.platform.os,
      arch: deps.platform.arch,
      environmentPolicyDigest: deps.environmentPolicyDigest()
    };
    deps.identityCache?.record(identity);
    return identity;
  }

  async function admitWithDecision(
    kind: BackendRunnerKind,
    request: SpawnAdmissionRequest
  ): Promise<SpawnAdmissionDecision> {
    const signal = request.cancellationSignal;
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    if (!deps.isTrusted()) throw refused(kind, { reason: 'workspace-untrusted-at-spawn' });
    const primacy = await deps.hasPrimacy();
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    if (!primacy) throw refused(kind, { reason: 'ownership-lost-at-spawn' });

    // FR-R8-02 (02-02): Codex native security review launches the standalone `codex-security`
    // scanner, NOT `codex`. Never inherit `codex`'s qualification, consent, or fingerprint; fail
    // closed unless the dedicated single-resolution scanner gate admits it.
    if (kind === 'codex' && request.review?.kind === 'security') {
      if (deps.scannerAdmission === undefined) {
        throw refused(kind, {
          reason: 'containment-unqualified-for-tuple',
          consentable: false
        });
      }
      return deps.scannerAdmission.admitScanner({
        scanner: 'codex-security',
        runId: request.runId,
        ...(request.env !== undefined ? { env: request.env } : {}),
        ...(signal !== undefined ? { cancellationSignal: signal } : {})
      });
    }

    const identity = await observe(kind, request.cliPath, signal);
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    const verdict = judgeSpawnAdmission({ identity, granted: deps.granted(), binding: deps.bindings.read(kind) });
    if (verdict.outcome === 'refused') {
      const { outcome: _outcome, ...init } = verdict;
      throw refused(kind, init);
    }
    const { fingerprint } = verdict;
    if (perRun.changed(request.runId, kind, fingerprint)) {
      throw refused(kind, { reason: 'configuration-changed-at-spawn', fingerprint });
    }
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    if (verdict.bindingWrite !== undefined) await deps.bindings.bind(kind, fingerprint, verdict.bindingWrite);
    if (signal?.aborted) throw new SpawnAdmissionCancelledError();
    perRun.remember(request.runId, kind, fingerprint);
    const permissionMode =
      kind === 'codex' && request.review?.kind === 'code'
        ? 'read-only'
        : getBackendDescriptor(kind).defaultAuditPermissionMode;
    return Object.freeze({
      kind,
      executableTarget: kind,
      resolvedExecutablePath: request.cliPath,
      containmentPosture: verdict.containment,
      permissionMode,
      fingerprint
    });
  }

  async function admit(kind: BackendRunnerKind, request: SpawnAdmissionRequest): Promise<void> {
    await admitWithDecision(kind, request);
  }

  return Object.freeze({ admit, admitWithDecision });
}
