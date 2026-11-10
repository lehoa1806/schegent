// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// Constructs the gate, the identity cache and the acceptance store. The `--version` probe the
// gate spawns runs inside `admit`, after its trust check refuses an untrusted window.

// FR-R6-F09 (FR-003, FR-008, FR-012, FR-014; T032) -- the containment admission collaborators,
// wired once per window and shared.
//
// ONE STORE, ONE CACHE. The spawn gate reads the acceptance bindings and records each identity it
// observes; the consent modal writes an acceptance; the sidebar reads both. They must be the same
// two objects, or the modal's acceptance would not admit the retry it triggers and the sidebar
// would describe an identity the gate never saw.
//
// THE PATH THE SPAWN WILL SEE. Executable resolution searches the PATH of the environment the
// runner builds for its child, not the host's: under the allowlist policy the two can differ, and
// a name found only on the host's PATH is one the spawn cannot start.

import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { FingerprintRecord, SpawnGate } from '../contracts/containment-qualification';
import type { ProcessEnvironmentPolicy } from '../contracts/process-environment-policy';
import { resolveExecutable } from '../runner/executable-identity';
import { buildSpawnEnv, policyRequestFields } from '../runner/spawn-env';
import {
  AcceptanceBindingStore,
  type AcceptanceMementoPort
} from '../services/containment-qualification/acceptance-bindings';
import { environmentPolicyDigestOf } from '../services/containment-qualification/fingerprint';
import { BackendIdentityCache } from '../services/containment-qualification/identity-cache';
import { createSpawnAdmissionGate } from '../services/containment-qualification/spawn-admission-gate';
import type { BackendQualificationSource } from '../ui/sidebar/backend-qualification-projection';

export interface ContainmentAdmissionWiringDeps {
  /** The workspace memento the acceptance bindings live in. */
  readonly memento: AcceptanceMementoPort;
  readonly logger: { warn(line: string): void };
  /** `vscode.workspace.isTrusted`, read at each admission. */
  readonly isTrusted: () => boolean;
  /** The workspace lock's `hasPrimacy()`, read at each admission. */
  readonly hasPrimacy: () => Promise<boolean>;
  /** The resolved policy the runners spawn under. */
  readonly environmentPolicy: ProcessEnvironmentPolicy;
  /** The live grant reader, the same thunk the runner factory judges against. */
  readonly granted: () => ReadonlySet<BackendRunnerKind>;
  /** The registry's cached `--version` probe. */
  readonly observeVersion: (cliPath: string) => Promise<string | null>;
}

export interface ContainmentAdmissionWiring {
  /** Handed to the runner registry, which wraps every runner it builds. */
  readonly spawnGate: SpawnGate;
  /** What the sidebar's posture projection reads. */
  readonly qualification: BackendQualificationSource;
  /** Handed to the consent gate: an accepted fingerprint is bound with origin `consent`. */
  readonly recordAcceptance: (kind: BackendRunnerKind, fingerprint: FingerprintRecord) => Promise<void>;
}

function spawnPathOf(policy: ProcessEnvironmentPolicy): string | undefined {
  const env = buildSpawnEnv(policyRequestFields(policy));
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH');
  return key === undefined ? undefined : env[key];
}

export function wireContainmentAdmission(deps: ContainmentAdmissionWiringDeps): ContainmentAdmissionWiring {
  const bindings = new AcceptanceBindingStore(deps.memento, deps.logger);
  const identityCache = new BackendIdentityCache();
  const spawnGate = createSpawnAdmissionGate({
    isTrusted: deps.isTrusted,
    hasPrimacy: deps.hasPrimacy,
    resolveExecutable: (cliPath) =>
      resolveExecutable(cliPath, spawnPathOf(deps.environmentPolicy), process.platform),
    observeVersion: (_kind, cliPath) => deps.observeVersion(cliPath),
    granted: deps.granted,
    bindings,
    platform: { os: process.platform, arch: process.arch },
    environmentPolicyDigest: () => environmentPolicyDigestOf(deps.environmentPolicy),
    identityCache,
    logger: deps.logger
  });
  return Object.freeze({
    spawnGate,
    qualification: Object.freeze({
      identityOf: (kind: BackendRunnerKind) => identityCache.read(kind),
      bindingOf: (kind: BackendRunnerKind) => bindings.read(kind)
    }),
    recordAcceptance: (kind: BackendRunnerKind, fingerprint: FingerprintRecord) =>
      bindings.bind(kind, fingerprint, 'consent')
  });
}
