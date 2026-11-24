/**
 * FR-R8-02 (02-02) — single-resolution qualification, fingerprinting, consent-binding persistence,
 * and fail-closed admission for standalone native-review scanner executables (`codex-security`).
 *
 * `codex-security` is a distinct executable from `codex` with NO observed OS containment sandbox
 * (`mechanism: 'none'`, `qualified: false`). Disabling write flags (`--patch=false`,
 * `--create-pr=false`, `--validate=false`) reduces risk but does NOT qualify as OS containment.
 *
 * Therefore:
 *   1. A qualified `codex` installation alone NEVER admits `codex-security`.
 *   2. The scanner executable is resolved ONCE in the host under the exact sanitized absolute-PATH
 *      environment (`buildCodexSecurityEnv`) and that single resolved absolute path is handed to
 *      the bridge (`--scanner-cli`) — the bridge never re-resolves from PATH.
 *   3. Scanner `--version` is probed against that exact resolved executable (never inherited from
 *      `codex`), fingerprinted separately, and checked against explicit scanner consent +
 *      workspace-scoped scanner acceptance bindings (`schegent.scanner.acceptanceBindings.v1`).
 *   4. Restricted Mode, lost workspace primacy, missing/revoked scanner grant, or a changed
 *      scanner identity/version fingerprint each refuse BEFORE spawn with zero child launches.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */
import { createHash } from 'node:crypto';
import {
  ACCEPTANCE_BINDINGS_MAX_BYTES,
  ACCEPTANCE_BINDINGS_SCHEMA_VERSION,
  DIGEST_PATTERN,
  FINGERPRINT_COMPONENTS,
  FINGERPRINT_COMPONENT_MAX,
  REVIEW_SCANNERS,
  SCANNER_ACCEPTANCE_BINDINGS_KEY,
  VERSION_MINOR_PATTERN,
  type AcceptanceBinding,
  type AcceptanceOrigin,
  type BindingInput,
  type ExecutableUnresolvedCause,
  type FingerprintComponent,
  type FingerprintRecord,
  type ReviewScannerId,
  type SpawnAdmissionDecision
} from '../../contracts/containment-qualification';
import {
  AcceptanceBindingsFutureSchemaError,
  type AcceptanceBindingsLogger,
  type AcceptanceMementoPort
} from './acceptance-bindings';
import { ContainmentAdmissionRefusedError } from './admission-refusal';
import { UNVERIFIED_VERSION, diffFingerprint, versionMinorOf } from './fingerprint';
import { SpawnAdmissionCancelledError } from './spawn-admission-gate';

const BOUND_AT_MAX = 40;
const VALUE_KEYS = Object.freeze(['bindings', 'schemaVersion']);
const ENTRY_KEYS = Object.freeze(['boundAt', 'fingerprint', 'origin']);
const FINGERPRINT_KEYS = Object.freeze(['components', 'digest']);
const LOG_PREFIX = 'scanner acceptance bindings:';
const PER_RUN_SCANNER_CAPACITY = 256;

const CODEX_SECURITY_CONFIRMED_FLAGS = Object.freeze([
  '--base',
  '--create-pr=false',
  '--exclude-path',
  '--full-output',
  '--headless',
  '--json',
  '--output-dir',
  '--patch=false',
  '--validate=false',
  '--working-tree'
] as const);

function sha256(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys.at(index));
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

export function isReviewScannerId(value: unknown): value is ReviewScannerId {
  return typeof value === 'string' && (REVIEW_SCANNERS as readonly string[]).includes(value);
}

export interface ScannerIdentity {
  readonly scanner: ReviewScannerId;
  readonly executable: 'resolved' | ExecutableUnresolvedCause;
  readonly versionMinor: string | null;
  /** Mandatory SHA-256 content digest of the resolved canonical executable bytes. */
  readonly binaryDigest: string;
  /** Mandatory SHA-256 digest of the canonical resolved executable path (never stores a raw path). */
  readonly resolvedPathDigest: string;
  readonly os: string;
  readonly arch: string;
  readonly environmentPolicyDigest: string;
}

export function scannerPathDigestOf(canonicalResolvedPath: string): string {
  return sha256(['scanner-path1', canonicalResolvedPath]);
}

/**
 * Computes a scanner-specific fingerprint strictly disjoint from core `codex` fingerprints.
 * Uses `mechanism: 'none'` (no observed OS sandbox) and binds `scanner`, `version`,
 * `binaryDigest`, `resolvedPathDigest`, `os`, `arch`, `environment-policy`, and scanner flags.
 */
export function computeScannerFingerprint(identity: ScannerIdentity): FingerprintRecord {
  const flagSurface = sha256([
    'scanner-flags1',
    identity.scanner,
    CODEX_SECURITY_CONFIRMED_FLAGS,
    identity.binaryDigest,
    identity.resolvedPathDigest
  ]);
  const components: Readonly<Record<FingerprintComponent, string>> = Object.freeze({
    backend: identity.scanner,
    version: identity.versionMinor ?? UNVERIFIED_VERSION,
    os: identity.os,
    arch: identity.arch,
    mechanism: 'none',
    'environment-policy': identity.environmentPolicyDigest,
    'flag-surface': flagSurface
  });
  const digest = sha256(['scanner-fp1', ...FINGERPRINT_COMPONENTS.map((name) => components[name])]);
  return Object.freeze({ digest, components });
}

function isScannerComponents(value: unknown, scanner: ReviewScannerId): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, [...FINGERPRINT_COMPONENTS].sort())) return false;
  if (!FINGERPRINT_COMPONENTS.every((name) => isBoundedString(value[name], FINGERPRINT_COMPONENT_MAX))) return false;
  const version = value['version'];
  if (typeof version !== 'string' || (version !== UNVERIFIED_VERSION && !VERSION_MINOR_PATTERN.test(version))) {
    return false;
  }
  return value['backend'] === scanner && value['mechanism'] === 'none';
}

function parseScannerAcceptanceBinding(value: unknown, scanner: ReviewScannerId): AcceptanceBinding | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENTRY_KEYS)) return null;
  const { fingerprint, origin, boundAt } = value;
  if (
    !isPlainObject(fingerprint) ||
    !hasExactKeys(fingerprint, FINGERPRINT_KEYS) ||
    typeof fingerprint['digest'] !== 'string' ||
    !DIGEST_PATTERN.test(fingerprint['digest']) ||
    !isScannerComponents(fingerprint['components'], scanner)
  ) {
    return null;
  }
  // Verify the stored digest matches the recomputed SHA-256 of its components so forged digests fail closed.
  const comps = fingerprint['components'] as Record<FingerprintComponent, string>;
  const expectedDigest = sha256(['scanner-fp1', ...FINGERPRINT_COMPONENTS.map((name) => comps[name])]);
  if (fingerprint['digest'] !== expectedDigest) return null;
  // Standalone scanners MUST only accept explicit operator `'consent'` bindings (never `'legacy-first-use'`).
  if (origin !== 'consent') return null;
  if (!isBoundedString(boundAt, BOUND_AT_MAX) || Number.isNaN(Date.parse(boundAt))) return null;
  return Object.freeze({
    fingerprint: fingerprint as unknown as FingerprintRecord,
    origin: origin as AcceptanceOrigin,
    boundAt
  });
}

export interface ScannerAdmissionBindings {
  read(scanner: ReviewScannerId): BindingInput;
  bind(scanner: ReviewScannerId, fingerprint: FingerprintRecord, origin: AcceptanceOrigin): Promise<void>;
}

/** Workspace-scoped acceptance binding store for standalone review scanners. */
export class ScannerAcceptanceBindingStore implements ScannerAdmissionBindings {
  private readonly logged = new Set<string>();

  public constructor(
    private readonly memento: AcceptanceMementoPort,
    private readonly logger: AcceptanceBindingsLogger,
    private readonly now: () => Date = () => new Date()
  ) {}

  public read(scanner: ReviewScannerId): BindingInput {
    const parsed = this.parse();
    if (parsed.state === 'future-schema') return 'future-schema';
    return parsed.bindings.get(scanner) ?? null;
  }

  public async bind(
    scanner: ReviewScannerId,
    fingerprint: FingerprintRecord,
    origin: AcceptanceOrigin
  ): Promise<void> {
    const parsed = this.parse();
    if (parsed.state === 'future-schema') throw new AcceptanceBindingsFutureSchemaError();
    const next = new Map(parsed.bindings);
    next.set(scanner, Object.freeze({ fingerprint, origin, boundAt: this.now().toISOString() }));
    const bindings: Record<string, AcceptanceBinding> = {};
    for (const id of REVIEW_SCANNERS) {
      const binding = next.get(id);
      if (binding !== undefined) bindings[id] = binding;
    }
    await this.memento.update(SCANNER_ACCEPTANCE_BINDINGS_KEY, {
      schemaVersion: ACCEPTANCE_BINDINGS_SCHEMA_VERSION,
      bindings
    });
  }

  private parse():
    | { readonly state: 'future-schema' }
    | { readonly state: 'valid'; readonly bindings: ReadonlyMap<ReviewScannerId, AcceptanceBinding> } {
    const empty = { state: 'valid' as const, bindings: new Map<ReviewScannerId, AcceptanceBinding>() };
    const value = this.memento.get(SCANNER_ACCEPTANCE_BINDINGS_KEY);
    if (value === undefined) return empty;
    if (!isPlainObject(value)) return this.ignoreValue('not an object', empty);
    const version = value['schemaVersion'];
    if (!Number.isInteger(version)) return this.ignoreValue('no schema version', empty);
    if ((version as number) > ACCEPTANCE_BINDINGS_SCHEMA_VERSION) return { state: 'future-schema' };
    try {
      const text = JSON.stringify(value);
      if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > ACCEPTANCE_BINDINGS_MAX_BYTES) {
        return this.ignoreValue('over the size bound', empty);
      }
    } catch {
      return this.ignoreValue('unserializable', empty);
    }
    if (version !== ACCEPTANCE_BINDINGS_SCHEMA_VERSION || !hasExactKeys(value, VALUE_KEYS)) {
      return this.ignoreValue('unexpected shape', empty);
    }
    const stored = value['bindings'];
    if (!isPlainObject(stored)) return this.ignoreValue('unexpected shape', empty);
    const bindings = new Map<ReviewScannerId, AcceptanceBinding>();
    for (const [key, entry] of Object.entries(stored)) {
      if (!isReviewScannerId(key)) {
        this.warnOnce(`${LOG_PREFIX} entry ignored scanner=unknown`);
        continue;
      }
      const binding = parseScannerAcceptanceBinding(entry, key);
      if (binding === null) {
        this.warnOnce(`${LOG_PREFIX} entry ignored scanner=${key}`);
        continue;
      }
      bindings.set(key, binding);
    }
    return { state: 'valid', bindings };
  }

  private ignoreValue<T>(why: string, fallback: T): T {
    this.warnOnce(`${LOG_PREFIX} stored value ignored (${why})`);
    return fallback;
  }

  private warnOnce(line: string): void {
    if (this.logged.has(line)) return;
    this.logged.add(line);
    this.logger.warn(line);
  }
}

export type ResolvedScannerExecutable =
  | { readonly ok: true; readonly resolvedPath: string; readonly binaryDigest: string }
  | { readonly ok: false; readonly cause: ExecutableUnresolvedCause };

export interface ScannerAdmissionDeps {
  readonly isTrusted: () => boolean;
  readonly hasPrimacy: () => boolean | Promise<boolean>;
  readonly resolveScannerExecutable: (
    scanner: ReviewScannerId,
    env?: Readonly<Record<string, string>>
  ) => Promise<ResolvedScannerExecutable>;
  readonly observeScannerVersion: (
    scanner: ReviewScannerId,
    resolvedPath: string,
    binaryDigest: string,
    env?: Readonly<Record<string, string>>,
    cancellationSignal?: AbortSignal
  ) => Promise<string | null>;
  readonly grantedScanners: () => ReadonlySet<ReviewScannerId>;
  readonly bindings: ScannerAdmissionBindings;
  readonly platform: { readonly os: string; readonly arch: string };
  readonly environmentPolicyDigest: () => string;
  readonly logger: { warn(line: string): void };
}

export interface ScannerAdmissionGate {
  admitScanner(input: {
    readonly scanner: ReviewScannerId;
    readonly runId: string | undefined;
    readonly env?: Readonly<Record<string, string>>;
    readonly cancellationSignal?: AbortSignal;
  }): Promise<SpawnAdmissionDecision>;
  /**
   * Explicit operator-initiated inspection helper used ONLY when consenting to a scanner binary
   * (never called automatically on a refused spawn). Resolves, probes `--version` under sanitized
   * env, and returns the exact fingerprint to pass to `recordScannerAcceptance`.
   */
  inspectScannerForConsent(input: {
    readonly scanner: ReviewScannerId;
    readonly env?: Readonly<Record<string, string>>;
    readonly cancellationSignal?: AbortSignal;
  }): Promise<
    | { readonly ok: true; readonly fingerprint: FingerprintRecord; readonly resolvedPath: string; readonly binaryDigest: string }
    | { readonly ok: false; readonly cause: ExecutableUnresolvedCause }
  >;
}

/**
 * Fail-closed admission gate for standalone review scanners (`codex-security`).
 * Unlike `codex` (which may be qualified on darwin/arm64), `codex-security` has NO observed OS
 * containment and therefore ALWAYS requires:
 *   - trusted workspace + live primacy,
 *   - non-executable resolution + canonical path & SHA-256 binary digest verification,
 *   - explicit `codex-security` consent grant (NEVER inherited from `codex`) + matching pre-probe
 *     binding BEFORE any `--version` subprocess executes (strictly zero spawns on unconsented,
 *     revoked, or swapped binaries), AND
 *   - matching full scanner fingerprint binding including probed `--version`.
 */
export function createScannerAdmissionGate(deps: ScannerAdmissionDeps): ScannerAdmissionGate {
  const perRun = new Map<string, Map<ReviewScannerId, FingerprintRecord>>();

  const refused = (
    scanner: ReviewScannerId,
    init: Omit<ConstructorParameters<typeof ContainmentAdmissionRefusedError>[0], 'kind' | 'scannerTarget'>
  ): ContainmentAdmissionRefusedError => {
    deps.logger.warn(`scanner spawn admission: refused target=${scanner} reason=${init.reason}`);
    return new ContainmentAdmissionRefusedError({
      kind: 'codex',
      scannerTarget: scanner,
      ...init,
      consentable: false
    });
  };

  const rememberPerRun = (runId: string | undefined, scanner: ReviewScannerId, fp: FingerprintRecord): void => {
    if (runId === undefined) return;
    const existing = perRun.get(runId);
    if (existing !== undefined) {
      if (!existing.has(scanner)) existing.set(scanner, fp);
      return;
    }
    if (perRun.size >= PER_RUN_SCANNER_CAPACITY) {
      const oldest = perRun.keys().next();
      if (oldest.done !== true) perRun.delete(oldest.value);
    }
    perRun.set(runId, new Map([[scanner, fp]]));
  };

  const admitScanner: ScannerAdmissionGate['admitScanner'] = async ({
    scanner,
    runId,
    env,
    cancellationSignal
  }) => {
    if (cancellationSignal?.aborted) throw new SpawnAdmissionCancelledError();
    if (!deps.isTrusted()) throw refused(scanner, { reason: 'workspace-untrusted-at-spawn' });
    const primacy = await deps.hasPrimacy();
    if (cancellationSignal?.aborted) throw new SpawnAdmissionCancelledError();
    if (!primacy) throw refused(scanner, { reason: 'ownership-lost-at-spawn' });

    const resolved = await deps.resolveScannerExecutable(scanner, env);
    if (cancellationSignal?.aborted) throw new SpawnAdmissionCancelledError();
    if (!resolved.ok) {
      throw refused(scanner, {
        reason: 'backend-executable-unresolved',
        cause: resolved.cause
      });
    }

    const resolvedPathDigest = scannerPathDigestOf(resolved.resolvedPath);
    const envDigest = deps.environmentPolicyDigest();
    const preProbeFingerprint = computeScannerFingerprint({
      scanner,
      executable: 'resolved',
      versionMinor: null,
      binaryDigest: resolved.binaryDigest,
      resolvedPathDigest,
      os: deps.platform.os,
      arch: deps.platform.arch,
      environmentPolicyDigest: envDigest
    });

    // FR-R8-02 (02-02 / SEC-01): check explicit grant, stored binding, and non-version identity
    // (binary SHA-256, canonical path digest, platform, env policy) BEFORE spawning `--version`
    // so unconsented, revoked, or swapped binaries execute ZERO processes.
    if (!deps.grantedScanners().has(scanner)) {
      throw refused(scanner, {
        reason: 'containment-unqualified-for-tuple',
        fingerprint: preProbeFingerprint
      });
    }

    const binding = deps.bindings.read(scanner);
    if (binding === 'future-schema') {
      throw refused(scanner, {
        reason: 'acceptance-fingerprint-changed',
        fingerprint: preProbeFingerprint
      });
    }
    if (binding === null) {
      throw refused(scanner, {
        reason: 'containment-unqualified-for-tuple',
        fingerprint: preProbeFingerprint
      });
    }

    const preChanged = diffFingerprint(binding.fingerprint, preProbeFingerprint, { ignoreVersion: true });
    if (preChanged !== null) {
      throw refused(scanner, {
        reason: 'acceptance-fingerprint-changed',
        fingerprint: preProbeFingerprint,
        changedComponent: preChanged
      });
    }

    // Only now that grant + binding + binaryDigest + pathDigest match may we probe `--version`.
    const rawVersion = await deps.observeScannerVersion(
      scanner,
      resolved.resolvedPath,
      resolved.binaryDigest,
      env,
      cancellationSignal
    );
    if (cancellationSignal?.aborted) throw new SpawnAdmissionCancelledError();
    const versionMinor = versionMinorOf(rawVersion);

    const fingerprint = computeScannerFingerprint({
      scanner,
      executable: 'resolved',
      versionMinor,
      binaryDigest: resolved.binaryDigest,
      resolvedPathDigest,
      os: deps.platform.os,
      arch: deps.platform.arch,
      environmentPolicyDigest: envDigest
    });

    const changed = diffFingerprint(binding.fingerprint, fingerprint, { ignoreVersion: false });
    if (changed !== null) {
      throw refused(scanner, {
        reason: 'acceptance-fingerprint-changed',
        fingerprint,
        changedComponent: changed
      });
    }

    const firstInRun = runId === undefined ? undefined : perRun.get(runId)?.get(scanner);
    if (firstInRun !== undefined && diffFingerprint(firstInRun, fingerprint, { ignoreVersion: false }) !== null) {
      throw refused(scanner, {
        reason: 'configuration-changed-at-spawn',
        fingerprint
      });
    }

    rememberPerRun(runId, scanner, fingerprint);

    return Object.freeze({
      kind: 'codex',
      executableTarget: scanner,
      resolvedExecutablePath: resolved.resolvedPath,
      resolvedExecutableSha256: resolved.binaryDigest,
      containmentPosture: 'accepted-uncontained',
      permissionMode: 'unrestricted',
      fingerprint
    });
  };

  const inspectScannerForConsent: ScannerAdmissionGate['inspectScannerForConsent'] = async ({
    scanner,
    env,
    cancellationSignal
  }) => {
    if (cancellationSignal?.aborted) throw new SpawnAdmissionCancelledError();
    if (!deps.isTrusted()) throw refused(scanner, { reason: 'workspace-untrusted-at-spawn' });
    const resolved = await deps.resolveScannerExecutable(scanner, env);
    if (cancellationSignal?.aborted) throw new SpawnAdmissionCancelledError();
    if (!resolved.ok) return { ok: false, cause: resolved.cause };
    const rawVersion = await deps.observeScannerVersion(
      scanner,
      resolved.resolvedPath,
      resolved.binaryDigest,
      env,
      cancellationSignal
    );
    if (cancellationSignal?.aborted) throw new SpawnAdmissionCancelledError();
    const fingerprint = computeScannerFingerprint({
      scanner,
      executable: 'resolved',
      versionMinor: versionMinorOf(rawVersion),
      binaryDigest: resolved.binaryDigest,
      resolvedPathDigest: scannerPathDigestOf(resolved.resolvedPath),
      os: deps.platform.os,
      arch: deps.platform.arch,
      environmentPolicyDigest: deps.environmentPolicyDigest()
    });
    return {
      ok: true,
      fingerprint,
      resolvedPath: resolved.resolvedPath,
      binaryDigest: resolved.binaryDigest
    };
  };

  return Object.freeze({ admitScanner, inspectScannerForConsent });
}

