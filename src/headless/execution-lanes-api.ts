// FR-R6-F10 (live reconciled contract: docs/operations/execution-lanes.md; original historical
// filing: specs/309-isolated-workspace-lanes/contracts/execution-lanes.md §7, spec US6) — the headless execution-lanes port.
//
// One function per service operation. Each validates plain prototypes once and deep-snapshots its
// input (freezing objects and arrays, including nested verification profiles and `argv`) before
// delegating to the injected `LaneService` and returning its `LaneResult` unchanged. A malformed
// input is refused `invalid-input` before the service, the store or Git sees it. A thrown error,
// such as a `LaneGitError`, passes through to the caller.
//
// List filter semantics (`16-21`): omitting `states` returns all states; passing an explicit empty
// array `states: []` returns `{ items: [], nextCursor: null }`.
//
// Authority boundary (`16-22`): `approveRequest` and `landRequest` are host-only operator actions;
// receipt fields are freshness bindings readable on `IntegrationRequestView`, not a secret. Do not
// expose them to an agent or untrusted IPC caller without host-side human-approval verification
// (`LaneServiceDeps.authorizeApproval`).
//
// Validation (§7 and data-model "Shared column rules"):
//   - the input is a plain object whose keys are the operation's key set: no unknown key, every
//     required key present. Operations whose keys are all optional also take no input at all;
//   - random identifiers are 32 lowercase hex; commits are 40 or 64 lowercase hex; a profile
//     digest is 64; `rootExecutionId` and `profileId` are caller identifiers (1..128 chars);
//   - `targetBranch` passes the `git check-ref-format --branch` rules, applied without Git;
//   - `limit` is an integer 1..200; `cursor` is base64url of at most 256 characters;
//   - `profile` follows `VERIFICATION_LIMITS` and is validated and deep-snapshotted in one pass;
//   - `sourceRevision` is 1..256 printable characters with no space and no leading `-`, and
//     `dependencyRecipe` a short name; the service decides whether either resolves or is supported.
//
// This module imports no editor host API (rule 13). It performs no I/O of its own and retains nothing.

import {
  INTEGRATION_STATES,
  LANE_PAGE_LIMIT_MAX,
  LANE_STATES,
  laneRefused,
  type CandidateView,
  type CleanupReport,
  type IntegrationRequestView,
  type LanePage,
  type LaneResult,
  type LaneView,
  type ReceiptView,
  type ReconcileReport,
  type VerificationCheckView
} from '../contracts/execution-lanes';
import {
  isPlainObject,
  isValidTargetBranch,
  snapshotVerificationProfile
} from '../services/execution-lanes/lane-input-rules';
import type { LaneService } from '../services/execution-lanes/lane-service';

/** The service surface this module needs; a narrower type keeps fakes honest in tests. */
export type ExecutionLanesApiService = Pick<
  LaneService,
  | 'provisionLane'
  | 'getLane'
  | 'listLanes'
  | 'freezeCandidate'
  | 'requestIntegration'
  | 'verifyRequest'
  | 'getVerification'
  | 'approveRequest'
  | 'landRequest'
  | 'cancelRequest'
  | 'getRequest'
  | 'listRequests'
  | 'pauseLane'
  | 'resumeLane'
  | 'completeLane'
  | 'releaseLane'
  | 'setLanePinned'
  | 'reconcile'
  | 'cleanupLanes'
>;

type SnapshotOutcome = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
type Rule = (value: unknown) => SnapshotOutcome;

interface InputShape {
  readonly required: Readonly<Record<string, Rule>>;
  readonly optional: Readonly<Record<string, Rule>>;
}

const REJECT: SnapshotOutcome = Object.freeze({ ok: false });

function accept(value: unknown): SnapshotOutcome {
  return { ok: true, value };
}

function scalarRule(predicate: (value: unknown) => boolean): Rule {
  return (value) => (predicate(value) ? accept(value) : REJECT);
}

const RANDOM_ID_PATTERN = /^[0-9a-f]{32}$/;
const CALLER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECIPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CURSOR_MAX_CHARS = 256;
const SOURCE_REVISION_MAX_CHARS = 256;
const OPTION_PREFIX = '-';
/** Code points up to and including space, and DEL, are not allowed in a revision. */
const LAST_EXCLUDED_CODE_POINT = 0x20;
const DEL_CODE_POINT = 0x7f;
const RELEASE_DISPOSITIONS: readonly unknown[] = Object.freeze(['retain', 'eligible']);
const LANE_STATE_VALUES: readonly unknown[] = LANE_STATES;
const INTEGRATION_STATE_VALUES: readonly unknown[] = INTEGRATION_STATES;

const INVALID_INPUT = Object.freeze(laneRefused<never>('invalid-input'));

function matches(pattern: RegExp): Rule {
  return scalarRule((value) => typeof value === 'string' && pattern.test(value));
}

const isRandomIdString = (value: unknown): value is string => typeof value === 'string' && RANDOM_ID_PATTERN.test(value);
const isRandomId = scalarRule(isRandomIdString);
const isCommit = matches(COMMIT_PATTERN);

function isPrintableWithoutSpace(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= LAST_EXCLUDED_CODE_POINT || code === DEL_CODE_POINT) return false;
  }
  return true;
}

const isSourceRevision: Rule = scalarRule(
  (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= SOURCE_REVISION_MAX_CHARS &&
    !value.startsWith(OPTION_PREFIX) &&
    isPrintableWithoutSpace(value)
);

const isLimit: Rule = scalarRule(
  (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= LANE_PAGE_LIMIT_MAX
);

const isCursor: Rule = scalarRule(
  (value) => typeof value === 'string' && value.length <= CURSOR_MAX_CHARS && BASE64URL_PATTERN.test(value)
);

const isTargetBranch: Rule = scalarRule((value) => typeof value === 'string' && isValidTargetBranch(value));

const isPositiveInteger: Rule = scalarRule(
  (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
);

const snapshotProfile: Rule = (value) => {
  const snapped = snapshotVerificationProfile(value);
  return snapped === null ? REJECT : accept(snapped);
};

/** Validates and snapshots an array of at most one entry per allowed value, reading each index once. */
function snapshotListOf(allowed: readonly unknown[]): Rule {
  return (value) => {
    if (!Array.isArray(value)) return REJECT;
    const len = value.length;
    if (len > allowed.length) return REJECT;
    const copy: unknown[] = [];
    for (let i = 0; i < len; i += 1) {
      if (!Object.hasOwn(value, i)) return REJECT;
      let item: unknown;
      try {
        item = value[i];
      } catch {
        return REJECT;
      }
      if (!allowed.includes(item)) return REJECT;
      copy.push(item);
    }
    return accept(Object.freeze(copy));
  };
}

const snapshotLaneIdList: Rule = (value) => {
  if (!Array.isArray(value)) return REJECT;
  const len = value.length;
  if (len < 1 || len > LANE_PAGE_LIMIT_MAX) return REJECT;
  const copy: string[] = [];
  for (let i = 0; i < len; i += 1) {
    if (!Object.hasOwn(value, i)) return REJECT;
    let item: unknown;
    try {
      item = value[i];
    } catch {
      return REJECT;
    }
    if (!isRandomIdString(item)) return REJECT;
    copy.push(item);
  }
  return accept(Object.freeze(copy));
};

const LANE_ID = { laneId: isRandomId };
const REQUEST_ID = { requestId: isRandomId };
const NONE = {};

/** Contract §5 and §7: each operation's key set and the rule for each key. */
export const EXECUTION_LANES_OPERATIONS: Readonly<Record<keyof ExecutionLanesApiService, InputShape>> = Object.freeze({
  provisionLane: {
    required: { rootExecutionId: matches(CALLER_ID_PATTERN), sourceRevision: isSourceRevision, dependencyRecipe: matches(RECIPE_PATTERN) },
    optional: NONE
  },
  getLane: { required: LANE_ID, optional: NONE },
  listLanes: { required: NONE, optional: { limit: isLimit, cursor: isCursor, states: snapshotListOf(LANE_STATE_VALUES) } },
  freezeCandidate: { required: LANE_ID, optional: NONE },
  requestIntegration: { required: { ...LANE_ID, targetBranch: isTargetBranch, profile: snapshotProfile }, optional: NONE },
  verifyRequest: { required: REQUEST_ID, optional: NONE },
  getVerification: { required: REQUEST_ID, optional: NONE },
  approveRequest: {
    required: {
      ...REQUEST_ID,
      candidateCommit: isCommit,
      targetCommit: isCommit,
      profileRevision: isPositiveInteger,
      profileDigest: matches(DIGEST_PATTERN)
    },
    optional: NONE
  },
  landRequest: { required: REQUEST_ID, optional: NONE },
  cancelRequest: { required: REQUEST_ID, optional: NONE },
  getRequest: { required: REQUEST_ID, optional: NONE },
  listRequests: {
    required: NONE,
    optional: { limit: isLimit, cursor: isCursor, laneId: isRandomId, states: snapshotListOf(INTEGRATION_STATE_VALUES) }
  },
  pauseLane: { required: LANE_ID, optional: NONE },
  resumeLane: { required: LANE_ID, optional: NONE },
  completeLane: { required: LANE_ID, optional: NONE },
  releaseLane: {
    required: { ...LANE_ID, disposition: scalarRule((value) => RELEASE_DISPOSITIONS.includes(value)) },
    optional: NONE
  },
  setLanePinned: {
    required: { ...LANE_ID, pinned: scalarRule((value) => typeof value === 'boolean') },
    optional: NONE
  },
  reconcile: { required: NONE, optional: NONE },
  cleanupLanes: { required: NONE, optional: { laneIds: snapshotLaneIdList } }
});

type Operation = keyof ExecutionLanesApiService;
type InputOf<K extends Operation> = Parameters<ExecutionLanesApiService[K]>[0];

function ruleFor(shape: InputShape, key: string): Rule | undefined {
  if (Object.hasOwn(shape.required, key)) return shape.required[key];
  if (Object.hasOwn(shape.optional, key)) return shape.optional[key];
  return undefined;
}

/**
 * Validates and deep-snapshots `input` in one single pass (reading each own property at most once
 * and freezing the snapshot) when it fits the operation's shape, else `null`.
 */
function accepted<K extends Operation>(operation: K, input: unknown): InputOf<K> | null {
  const shape = EXECUTION_LANES_OPERATIONS[operation];
  if (input === undefined) return Object.keys(shape.required).length === 0 ? (Object.freeze({}) as InputOf<K>) : null;
  if (!isPlainObject(input)) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const rule = ruleFor(shape, key);
    if (rule === undefined) return null;
    let raw: unknown;
    try {
      raw = input[key];
    } catch {
      return null;
    }
    const outcome = rule(raw);
    if (!outcome.ok) return null;
    snapshot[key] = outcome.value;
  }
  const complete = Object.keys(shape.required).every((key) => Object.hasOwn(snapshot, key));
  return complete ? (Object.freeze(snapshot) as InputOf<K>) : null;
}

export async function provisionLane(service: ExecutionLanesApiService, input?: unknown): Promise<LaneResult<LaneView>> {
  const valid = accepted('provisionLane', input);
  return valid === null ? INVALID_INPUT : service.provisionLane(valid);
}

export function getLane(service: ExecutionLanesApiService, input?: unknown): LaneResult<LaneView> {
  const valid = accepted('getLane', input);
  return valid === null ? INVALID_INPUT : service.getLane(valid);
}

export function listLanes(service: ExecutionLanesApiService, input?: unknown): LaneResult<LanePage<LaneView>> {
  const valid = accepted('listLanes', input);
  return valid === null ? INVALID_INPUT : service.listLanes(valid);
}

export async function freezeCandidate(service: ExecutionLanesApiService, input?: unknown): Promise<LaneResult<CandidateView>> {
  const valid = accepted('freezeCandidate', input);
  return valid === null ? INVALID_INPUT : service.freezeCandidate(valid);
}

export async function requestIntegration(
  service: ExecutionLanesApiService,
  input?: unknown
): Promise<LaneResult<IntegrationRequestView>> {
  const valid = accepted('requestIntegration', input);
  return valid === null ? INVALID_INPUT : service.requestIntegration(valid);
}

export async function verifyRequest(service: ExecutionLanesApiService, input?: unknown): Promise<LaneResult<IntegrationRequestView>> {
  const valid = accepted('verifyRequest', input);
  return valid === null ? INVALID_INPUT : service.verifyRequest(valid);
}

export function getVerification(service: ExecutionLanesApiService, input?: unknown): LaneResult<readonly VerificationCheckView[]> {
  const valid = accepted('getVerification', input);
  return valid === null ? INVALID_INPUT : service.getVerification(valid);
}

export function approveRequest(service: ExecutionLanesApiService, input?: unknown): LaneResult<ReceiptView> {
  const valid = accepted('approveRequest', input);
  return valid === null ? INVALID_INPUT : service.approveRequest(valid);
}

export async function landRequest(service: ExecutionLanesApiService, input?: unknown): Promise<LaneResult<IntegrationRequestView>> {
  const valid = accepted('landRequest', input);
  return valid === null ? INVALID_INPUT : service.landRequest(valid);
}

export function cancelRequest(service: ExecutionLanesApiService, input?: unknown): LaneResult<IntegrationRequestView> {
  const valid = accepted('cancelRequest', input);
  return valid === null ? INVALID_INPUT : service.cancelRequest(valid);
}

export function getRequest(service: ExecutionLanesApiService, input?: unknown): LaneResult<IntegrationRequestView> {
  const valid = accepted('getRequest', input);
  return valid === null ? INVALID_INPUT : service.getRequest(valid);
}

export function listRequests(service: ExecutionLanesApiService, input?: unknown): LaneResult<LanePage<IntegrationRequestView>> {
  const valid = accepted('listRequests', input);
  return valid === null ? INVALID_INPUT : service.listRequests(valid);
}

export function pauseLane(service: ExecutionLanesApiService, input?: unknown): LaneResult<LaneView> {
  const valid = accepted('pauseLane', input);
  return valid === null ? INVALID_INPUT : service.pauseLane(valid);
}

export function resumeLane(service: ExecutionLanesApiService, input?: unknown): LaneResult<LaneView> {
  const valid = accepted('resumeLane', input);
  return valid === null ? INVALID_INPUT : service.resumeLane(valid);
}

export function completeLane(service: ExecutionLanesApiService, input?: unknown): LaneResult<LaneView> {
  const valid = accepted('completeLane', input);
  return valid === null ? INVALID_INPUT : service.completeLane(valid);
}

export function releaseLane(service: ExecutionLanesApiService, input?: unknown): LaneResult<LaneView> {
  const valid = accepted('releaseLane', input);
  return valid === null ? INVALID_INPUT : service.releaseLane(valid);
}

export function setLanePinned(service: ExecutionLanesApiService, input?: unknown): LaneResult<LaneView> {
  const valid = accepted('setLanePinned', input);
  return valid === null ? INVALID_INPUT : service.setLanePinned(valid);
}

/** Takes `{}` or no input; the service takes none. */
export async function reconcile(service: ExecutionLanesApiService, input?: unknown): Promise<LaneResult<ReconcileReport>> {
  const valid = accepted('reconcile', input);
  return valid === null ? INVALID_INPUT : service.reconcile();
}

export async function cleanupLanes(service: ExecutionLanesApiService, input?: unknown): Promise<LaneResult<CleanupReport>> {
  const valid = accepted('cleanupLanes', input);
  return valid === null ? INVALID_INPUT : service.cleanupLanes(valid);
}
