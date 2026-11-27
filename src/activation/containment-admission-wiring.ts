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
import type {
  BindingInput,
  FingerprintRecord,
  ReviewScannerId,
  SpawnGate
} from '../contracts/containment-qualification';
import type { ProcessEnvironmentPolicy } from '../contracts/process-environment-policy';
import { executableFileStamp, resolveExecutableCommand } from '../lib/spawn-command';
import { createCliVersionProbe } from '../runner/cli-version-probe';
import { resolveCodexSecurityExecutable } from '../runner/native-review-launch';
import { buildSpawnEnv, policyRequestFields } from '../runner/spawn-env';
import {
  AcceptanceBindingStore,
  type AcceptanceMementoPort
} from '../services/containment-qualification/acceptance-bindings';
import { environmentPolicyDigestOf } from '../services/containment-qualification/fingerprint';
import { BackendIdentityCache } from '../services/containment-qualification/identity-cache';
import {
  ScannerAcceptanceBindingStore,
  createScannerAdmissionGate
} from '../services/containment-qualification/scanner-admission';
import { createSpawnAdmissionGate } from '../services/containment-qualification/spawn-admission-gate';
import type { BackendQualificationSource } from '../ui/sidebar/backend-qualification-projection';

const EMPTY_SCANNER_GRANTS: ReadonlySet<ReviewScannerId> = new Set();

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
  /** Optional explicit standalone scanner grant reader (defaults empty — fail closed; FR-R8-02 02-02). */
  readonly grantedScanners?: () => ReadonlySet<ReviewScannerId>;
  /** The registry's cached `--version` probe. */
  readonly observeVersion: (cliPath: string) => Promise<string | null>;
  /**
   * Optional dedicated scanner `--version` probe (defaults to a sanitized `buildCodexSecurityEnv`
   * probe keyed by `(resolvedPath, binaryDigest, policy)` with `AbortSignal` support).
   */
  readonly observeScannerVersion?: (
    resolvedPath: string,
    binaryDigest: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal
  ) => Promise<string | null>;
}

export interface ContainmentAdmissionWiring {
  /** Handed to the runner registry, which wraps every runner it builds. */
  readonly spawnGate: SpawnGate;
  /** What the sidebar's posture projection reads. */
  readonly qualification: BackendQualificationSource;
  /** Handed to the consent gate: an accepted fingerprint is bound with origin `consent`. */
  readonly recordAcceptance: (kind: BackendRunnerKind, fingerprint: FingerprintRecord) => Promise<void>;
  /** Records explicit operator consent for a standalone scanner fingerprint (`codex-security`). */
  readonly recordScannerAcceptance: (scanner: ReviewScannerId, fingerprint: FingerprintRecord) => Promise<void>;
  /** Revokes the stored workspace fingerprint binding for a standalone scanner (`codex-security`). */
  readonly revokeScannerAcceptance: (scanner: ReviewScannerId) => Promise<boolean>;
  /** Reads the stored workspace fingerprint binding for a standalone scanner (`codex-security`). */
  readonly readScannerBinding: (scanner: ReviewScannerId) => BindingInput;
  /** Explicit operator-initiated inspection helper returning the full scanner fingerprint for consent. */
  readonly inspectScannerForConsent: (
    scanner: ReviewScannerId,
    env?: Readonly<Record<string, string>>,
    cancellationSignal?: AbortSignal
  ) => Promise<
    | { readonly ok: true; readonly fingerprint: FingerprintRecord; readonly resolvedPath: string; readonly binaryDigest: string }
    | { readonly ok: false; readonly cause: 'not-found' | 'not-executable' }
  >;
}

function spawnEnvOf(
  policy: ProcessEnvironmentPolicy,
  extraEnv?: Readonly<Record<string, string>>
): NodeJS.ProcessEnv {
  return buildSpawnEnv({
    ...policyRequestFields(policy),
    ...(extraEnv !== undefined ? { env: { ...extraEnv } } : {})
  });
}

export function wireContainmentAdmission(deps: ContainmentAdmissionWiringDeps): ContainmentAdmissionWiring {
  const bindings = new AcceptanceBindingStore(deps.memento, deps.logger);
  const scannerBindings = new ScannerAcceptanceBindingStore(deps.memento, deps.logger);
  const identityCache = new BackendIdentityCache();
  const scannerVersionProbe = createCliVersionProbe({
    environmentPolicy: () => deps.environmentPolicy,
    isTrusted: deps.isTrusted
  });
  const scannerAdmission = createScannerAdmissionGate({
    isTrusted: deps.isTrusted,
    hasPrimacy: deps.hasPrimacy,
    resolveScannerExecutable: async (_scanner, env) =>
      resolveCodexSecurityExecutable(spawnEnvOf(deps.environmentPolicy, env), process.platform),
    observeScannerVersion: (_scanner, resolvedPath, binaryDigest, env, signal) =>
      deps.observeScannerVersion !== undefined
        ? deps.observeScannerVersion(resolvedPath, binaryDigest, env, signal)
        : (scannerVersionProbe.observeScanner?.(resolvedPath, binaryDigest, env, signal) ?? Promise.resolve(null)),
    grantedScanners: deps.grantedScanners ?? (() => EMPTY_SCANNER_GRANTS),
    bindings: scannerBindings,
    platform: { os: process.platform, arch: process.arch },
    environmentPolicyDigest: () => environmentPolicyDigestOf(deps.environmentPolicy),
    logger: deps.logger
  });
  const spawnGate = createSpawnAdmissionGate({
    isTrusted: deps.isTrusted,
    hasPrimacy: deps.hasPrimacy,
    resolveExecutable: async (cliPath, env) => {
      const executable = resolveExecutableCommand(cliPath, spawnEnvOf(deps.environmentPolicy, env));
      if (!executable.ok) return executable.cause === 'not-executable' ? 'not-executable' : 'not-found';
      const stamp = executableFileStamp(executable.resolvedPath);
      return stamp === null ? 'not-executable' : { path: executable.resolvedPath, stamp };
    },
    observeVersion: (_kind, cliPath) => deps.observeVersion(cliPath),
    granted: deps.granted,
    bindings,
    platform: { os: process.platform, arch: process.arch },
    environmentPolicyDigest: () => environmentPolicyDigestOf(deps.environmentPolicy),
    identityCache,
    scannerAdmission,
    logger: deps.logger
  });
  return Object.freeze({
    spawnGate,
    qualification: Object.freeze({
      identityOf: (kind: BackendRunnerKind) => identityCache.read(kind),
      bindingOf: (kind: BackendRunnerKind) => bindings.read(kind)
    }),
    recordAcceptance: (kind: BackendRunnerKind, fingerprint: FingerprintRecord) =>
      bindings.bind(kind, fingerprint, 'consent'),
    recordScannerAcceptance: (scanner: ReviewScannerId, fingerprint: FingerprintRecord) =>
      scannerBindings.bind(scanner, fingerprint, 'consent'),
    revokeScannerAcceptance: (scanner: ReviewScannerId) => scannerBindings.clear(scanner),
    readScannerBinding: (scanner: ReviewScannerId) => scannerBindings.read(scanner),
    inspectScannerForConsent: (
      scanner: ReviewScannerId,
      env?: Readonly<Record<string, string>>,
      cancellationSignal?: AbortSignal
    ) =>
      scannerAdmission.inspectScannerForConsent({
        scanner,
        ...(env !== undefined ? { env } : {}),
        ...(cancellationSignal !== undefined ? { cancellationSignal } : {})
      })
  });
}
