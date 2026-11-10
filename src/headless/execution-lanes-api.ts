// FR-R6-F10 (contract execution-lanes.md §7, spec US6) — the headless execution-lanes port.
//
// One function per service operation. Each validates its input, then delegates to the injected
// `LaneService` and returns its `LaneResult` unchanged. A malformed input is refused
// `invalid-input` before the service, the store or Git sees it. A thrown error, such as a
// `LaneGitError`, passes through to the caller.
//
// Validation (§7 and data-model "Shared column rules"):
//   - the input is a plain object whose keys are the operation's key set: no unknown key, every
//     required key present. Operations whose keys are all optional also take no input at all;
//   - random identifiers are 32 lowercase hex; commits are 40 or 64 lowercase hex; a profile
//     digest is 64; `rootExecutionId` is a caller identifier;
//   - `targetBranch` passes the `git check-ref-format --branch` rules, applied without Git;
//   - `limit` is an integer 1..200; `cursor` is base64url of at most 256 characters;
//   - `profile` follows `VERIFICATION_LIMITS`;
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
import { isValidProfile, isValidTargetBranch } from '../services/execution-lanes/lane-input-rules';
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

type Rule = (value: unknown) => boolean;

interface InputShape {
  readonly required: Readonly<Record<string, Rule>>;
  readonly optional: Readonly<Record<string, Rule>>;
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
  return (value) => typeof value === 'string' && pattern.test(value);
}

const isRandomId = matches(RANDOM_ID_PATTERN);
const isCommit = matches(COMMIT_PATTERN);

function isPrintableWithoutSpace(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= LAST_EXCLUDED_CODE_POINT || code === DEL_CODE_POINT) return false;
  }
  return true;
}

const isSourceRevision: Rule = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= SOURCE_REVISION_MAX_CHARS &&
  !value.startsWith(OPTION_PREFIX) &&
  isPrintableWithoutSpace(value);

const isLimit: Rule = (value) => typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= LANE_PAGE_LIMIT_MAX;

const isCursor: Rule = (value) =>
  typeof value === 'string' && value.length <= CURSOR_MAX_CHARS && BASE64URL_PATTERN.test(value);

const isTargetBranch: Rule = (value) => typeof value === 'string' && isValidTargetBranch(value);

const isPositiveInteger: Rule = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** An array of at most one entry per allowed value, each one of them. */
function isListOf(allowed: readonly unknown[]): Rule {
  return (value) => Array.isArray(value) && value.length <= allowed.length && value.every((item) => allowed.includes(item));
}

const isLaneIdList: Rule = (value) =>
  Array.isArray(value) && value.length >= 1 && value.length <= LANE_PAGE_LIMIT_MAX && value.every(isRandomId);

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
  listLanes: { required: NONE, optional: { limit: isLimit, cursor: isCursor, states: isListOf(LANE_STATE_VALUES) } },
  freezeCandidate: { required: LANE_ID, optional: NONE },
  requestIntegration: { required: { ...LANE_ID, targetBranch: isTargetBranch, profile: isValidProfile }, optional: NONE },
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
    optional: { limit: isLimit, cursor: isCursor, laneId: isRandomId, states: isListOf(INTEGRATION_STATE_VALUES) }
  },
  pauseLane: { required: LANE_ID, optional: NONE },
  resumeLane: { required: LANE_ID, optional: NONE },
  completeLane: { required: LANE_ID, optional: NONE },
  releaseLane: { required: { ...LANE_ID, disposition: (value: unknown) => RELEASE_DISPOSITIONS.includes(value) }, optional: NONE },
  setLanePinned: { required: { ...LANE_ID, pinned: (value: unknown) => typeof value === 'boolean' }, optional: NONE },
  reconcile: { required: NONE, optional: NONE },
  cleanupLanes: { required: NONE, optional: { laneIds: isLaneIdList } }
});

type Operation = keyof ExecutionLanesApiService;
type InputOf<K extends Operation> = Parameters<ExecutionLanesApiService[K]>[0];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ruleFor(shape: InputShape, key: string): Rule | undefined {
  if (Object.hasOwn(shape.required, key)) return shape.required[key];
  if (Object.hasOwn(shape.optional, key)) return shape.optional[key];
  return undefined;
}

/** The input when it fits the operation's shape, else `null`. */
function accepted<K extends Operation>(operation: K, input: unknown): InputOf<K> | null {
  const shape = EXECUTION_LANES_OPERATIONS[operation];
  if (input === undefined) return Object.keys(shape.required).length === 0 ? ({} as InputOf<K>) : null;
  if (!isPlainObject(input)) return null;
  for (const key of Object.keys(input)) {
    const rule = ruleFor(shape, key);
    if (rule === undefined || !rule(input[key])) return null;
  }
  const complete = Object.keys(shape.required).every((key) => Object.hasOwn(input, key));
  return complete ? (input as InputOf<K>) : null;
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
