// FR-R6-F09 (FR-003, FR-013; research R2) -- the refusal a spawn admission check throws.
//
// WHY A SUBTYPE OF `UncontainedBackendRefusedError`. The phase runner marks that type as a refusal
// raised before any child exists, and the start-failure classification and the consent gate already
// recognise it. A subtype inherits all three without an edit to the phase runner, and the
// classification checks this subtype first so it is reported as itself.
//
// WHAT THE MESSAGE HOLDS. The kind, the reason, and for two reasons a closed qualifier (the
// unresolved cause, the changed fingerprint component). Nothing else: no path, no environment
// value, no version string from a CLI's output (FR-008, NFR-005).

import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  CONSENTABLE_REFUSAL_REASONS,
  type ContainmentRefusalReason,
  type ExecutableUnresolvedCause,
  type FingerprintComponent,
  type FingerprintRecord
} from '../../contracts/containment-qualification';
import { UncontainedBackendRefusedError } from '../backend-containment-policy';

export interface ContainmentAdmissionRefusalInit {
  readonly kind: BackendRunnerKind;
  readonly reason: ContainmentRefusalReason;
  /** Defaults to whether `reason` is consentable. A caller may only narrow it to `false`. */
  readonly consentable?: boolean;
  readonly fingerprint?: FingerprintRecord;
  readonly changedComponent?: FingerprintComponent;
  readonly cause?: ExecutableUnresolvedCause;
}

const REMEDY: Readonly<Record<ContainmentRefusalReason, string>> = Object.freeze({
  'containment-unqualified-for-tuple':
    'its containment is not qualified for this version and platform; accept it to run without a qualified bound',
  'acceptance-fingerprint-changed':
    'its configuration changed since it was accepted; review and accept it again',
  'backend-executable-unresolved':
    'the configured executable could not be resolved; check the backend path setting',
  'workspace-untrusted-at-spawn': 'the workspace is not trusted; trust it to run a backend',
  'ownership-lost-at-spawn': 'this window no longer owns the workspace queue',
  'configuration-changed-at-spawn':
    'its configuration changed during this Run; start a new Run to use the new configuration'
});

/**
 * The one consentable reason a caller narrows: an acceptance written by a newer host, which this
 * host can neither read nor replace (review R9). Telling the operator to accept it again would
 * offer a remedy that does not exist.
 */
const NEWER_HOST_REMEDY =
  'it was recorded by a newer version of this extension, which this version cannot read; use that version';

function remedyFor(init: ContainmentAdmissionRefusalInit): string {
  if (init.reason === 'acceptance-fingerprint-changed' && init.consentable === false) return NEWER_HOST_REMEDY;
  return REMEDY[init.reason];
}

function messageFor(init: ContainmentAdmissionRefusalInit): string {
  const detail = init.cause ?? init.changedComponent;
  const qualifier = detail === undefined ? '' : ` (${detail})`;
  return `Backend '${init.kind}' refused: ${init.reason}${qualifier} -- ${remedyFor(init)}.`;
}

export class ContainmentAdmissionRefusedError extends UncontainedBackendRefusedError {
  public readonly reason: ContainmentRefusalReason;
  public readonly consentable: boolean;
  public readonly fingerprint: FingerprintRecord | undefined;
  public readonly changedComponent: FingerprintComponent | undefined;
  public readonly executableCause: ExecutableUnresolvedCause | undefined;

  public constructor(init: ContainmentAdmissionRefusalInit) {
    super(init.kind, messageFor(init));
    this.name = 'ContainmentAdmissionRefusedError';
    this.reason = init.reason;
    this.consentable = CONSENTABLE_REFUSAL_REASONS.includes(init.reason) && init.consentable !== false;
    this.fingerprint = init.fingerprint;
    this.changedComponent = init.changedComponent;
    this.executableCause = init.cause;
  }

  /** The 64-hex digest of the fingerprint the refusal judged, when it had one. */
  public get fingerprintDigest(): string | undefined {
    return this.fingerprint?.digest;
  }
}

export function isContainmentAdmissionRefusal(error: unknown): error is ContainmentAdmissionRefusedError {
  return error instanceof ContainmentAdmissionRefusedError;
}
