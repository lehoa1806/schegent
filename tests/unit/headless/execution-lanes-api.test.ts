// FR-R6-F10 T037 -- the headless execution-lanes port (contract section 7, spec US6).
//
// WHAT THIS PINS:
//   - every operation refuses malformed input `invalid-input` before the service sees it: a
//     service fake that throws on any access proves zero service calls;
//   - valid input reaches the service unchanged, and its result comes back unchanged;
//   - canceling one lane's request leaves the other lane's request and both lanes byte-equal
//     (US6-2);
//   - the cancel rules of the integration lifecycle (data-model): which states cancel, which
//     refuse, and the `acknowledged-uncertain` journal entry.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LANE_PAGE_LIMIT_MAX, VERIFICATION_LIMITS, type IntegrationState, type VerificationProfile } from '../../../src/contracts/execution-lanes';
import * as api from '../../../src/headless/execution-lanes-api';
import { HARNESS_NOW_MS, HARNESS_WS, createLaneHarness, disposeLaneHarnesses, type LaneHarness } from '../execution-lanes/lane-harness';

afterEach(() => disposeLaneHarnesses());

const CASE_TIMEOUT_MS = 120_000;
const LANE = 'a'.repeat(32);
const REQUEST = 'b'.repeat(32);
const COMMIT = 'c'.repeat(40);
const DIGEST = 'd'.repeat(64);
const CURSOR = 'Y3Vyc29y';
const INVALID = { ok: false, refusal: { reason: 'invalid-input' } };
const SENTINEL = { ok: true, value: 'delegated' };
const NOW_ISO = new Date(HARNESS_NOW_MS).toISOString();

const PROFILE: VerificationProfile = {
  profileId: 'unit',
  revision: 1,
  checks: [{ name: 'ok', argv: [process.execPath, '-e', 'process.exitCode = 0'], timeoutMs: 30_000 }]
};

type Operation = keyof typeof api.EXECUTION_LANES_OPERATIONS;
type PortFunction = (service: api.ExecutionLanesApiService, input?: unknown) => unknown;

function port(operation: Operation): PortFunction {
  const fn: unknown = Reflect.get(api, operation);
  if (typeof fn !== 'function') throw new Error(`the port exports no ${operation}`);
  return fn as PortFunction;
}

/** One valid input per operation; every key of the operation's key set is present. */
const VALID: Readonly<Record<Operation, Record<string, unknown>>> = {
  provisionLane: { rootExecutionId: 'root-exec-1', sourceRevision: 'HEAD', dependencyRecipe: 'none' },
  getLane: { laneId: LANE },
  listLanes: { limit: LANE_PAGE_LIMIT_MAX, cursor: CURSOR, states: ['active', 'paused'] },
  freezeCandidate: { laneId: LANE },
  requestIntegration: { laneId: LANE, targetBranch: 'feature/x-1', profile: PROFILE },
  verifyRequest: { requestId: REQUEST },
  getVerification: { requestId: REQUEST },
  approveRequest: { requestId: REQUEST, candidateCommit: COMMIT, targetCommit: 'e'.repeat(64), profileRevision: 3, profileDigest: DIGEST },
  landRequest: { requestId: REQUEST },
  cancelRequest: { requestId: REQUEST },
  getRequest: { requestId: REQUEST },
  listRequests: { limit: 1, cursor: CURSOR, laneId: LANE, states: ['queued', 'uncertain'] },
  pauseLane: { laneId: LANE },
  resumeLane: { laneId: LANE },
  completeLane: { laneId: LANE },
  releaseLane: { laneId: LANE, disposition: 'eligible' },
  setLanePinned: { laneId: LANE, pinned: false },
  reconcile: {},
  cleanupLanes: { laneIds: [LANE, LANE] }
};

const OPERATIONS = Object.keys(VALID) as Operation[];

/** Operations whose every key is optional; an absent input is the empty object. */
const ALL_OPTIONAL: readonly Operation[] = ['listLanes', 'listRequests', 'reconcile', 'cleanupLanes'];

function withField(operation: Operation, key: string, value: unknown): Record<string, unknown> {
  return { ...VALID[operation], [key]: value };
}

function withoutField(operation: Operation, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(VALID[operation]).filter(([name]) => name !== key));
}

function profileWith(over: Partial<VerificationProfile>): VerificationProfile {
  return { ...PROFILE, ...over };
}

function checkWith(over: Record<string, unknown>): Record<string, unknown> {
  return { ...PROFILE.checks.at(0), ...over };
}

const BAD_IDS: readonly unknown[] = ['a'.repeat(33), 'a'.repeat(31), 'A'.repeat(32), '', 7, null];
const BAD_COMMITS: readonly unknown[] = ['c'.repeat(39), 'c'.repeat(41), 'C'.repeat(40), 'g'.repeat(40), ''];
const BAD_BRANCHES: readonly unknown[] = ['a..b', '-x', 'x.lock', 'a b', '@{', '', '@', 'a'.repeat(201), 'x\ty', 'a~1', 'a/', 7];
const BAD_LIMITS: readonly unknown[] = [0, LANE_PAGE_LIMIT_MAX + 1, 1.5, '10', -1, Number.NaN];
const BAD_CURSORS: readonly unknown[] = ['', 'a'.repeat(257), 'not a cursor', 'a+b/c=', 5];

/** Each profile exceeds one bound of `VERIFICATION_LIMITS` or breaks one shape rule. */
const BAD_PROFILES: readonly unknown[] = [
  profileWith({ checks: Array.from({ length: VERIFICATION_LIMITS.maxChecks + 1 }, (_, i) => ({ ...PROFILE.checks.at(0), name: `c${i}` })) as never }),
  profileWith({ checks: [] }),
  profileWith({ checks: [checkWith({ argv: Array.from({ length: VERIFICATION_LIMITS.maxArgs + 1 }, () => 'x') })] as never }),
  profileWith({ checks: [checkWith({ argv: ['x'.repeat(VERIFICATION_LIMITS.maxArgChars + 1)] })] as never }),
  profileWith({ checks: [checkWith({ argv: [] })] as never }),
  profileWith({ checks: [checkWith({ timeoutMs: VERIFICATION_LIMITS.minTimeoutMs - 1 })] as never }),
  profileWith({ checks: [checkWith({ timeoutMs: VERIFICATION_LIMITS.maxTimeoutMs + 1 })] as never }),
  profileWith({ checks: [checkWith({ name: '-bad' })] as never }),
  profileWith({ checks: [checkWith({ shell: true })] as never }),
  profileWith({
    checks: Array.from({ length: VERIFICATION_LIMITS.maxChecks }, (_, i) => ({
      name: `c${i}`,
      argv: Array.from({ length: VERIFICATION_LIMITS.maxArgs }, () => 'x'.repeat(40)),
      timeoutMs: 30_000
    }))
  }),
  profileWith({ revision: 0 }),
  profileWith({ profileId: '' }),
  { ...PROFILE, extra: 1 },
  'unit'
];

/** Per operation and key, values the port must refuse. */
const BAD_VALUES: ReadonlyMap<string, readonly unknown[]> = new Map(Object.entries({
  laneId: BAD_IDS,
  requestId: BAD_IDS,
  rootExecutionId: ['-x', 'a'.repeat(129), '', 'a b', 3],
  sourceRevision: ['', '-x', '--upload-pack=x', 'a b', 'x\u0001', 'a'.repeat(257), 3],
  dependencyRecipe: ['', 'x'.repeat(65), 'a b', 1],
  limit: BAD_LIMITS,
  cursor: BAD_CURSORS,
  targetBranch: BAD_BRANCHES,
  profile: BAD_PROFILES,
  candidateCommit: BAD_COMMITS,
  targetCommit: BAD_COMMITS,
  profileRevision: [0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1],
  profileDigest: ['d'.repeat(63), 'D'.repeat(64), COMMIT, ''],
  disposition: ['delete', '', null],
  pinned: ['true', 1, null]
}));

const BAD_STATE_LISTS: readonly unknown[] = ['active', ['nope'], [1], [null]];
const OVERLONG_STATE_LIST_LENGTH = 64;
const BAD_LANE_ID_LISTS: readonly unknown[] = [[], ['a'.repeat(33)], LANE, Array.from({ length: LANE_PAGE_LIMIT_MAX + 1 }, () => LANE)];

function badValuesFor(operation: Operation, key: string): readonly unknown[] {
  if (key === 'states') {
    const valid = operation === 'listLanes' ? 'active' : 'queued';
    return [...BAD_STATE_LISTS, operation === 'listLanes' ? ['queued'] : ['active'], Array.from({ length: OVERLONG_STATE_LIST_LENGTH }, () => valid)];
  }
  if (key === 'laneIds') return BAD_LANE_ID_LISTS;
  const values = BAD_VALUES.get(key);
  if (values === undefined) throw new Error(`no bad values for ${key}`);
  return values;
}

/** Every malformed input for one operation, each with a label. */
function malformed(operation: Operation): readonly (readonly [string, unknown])[] {
  const cases: [string, unknown][] = [
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
    ['an unknown key', withField(operation, 'extra', 1)],
    ['a prototype key', withField(operation, '__proto__', {})]
  ];
  if (!ALL_OPTIONAL.includes(operation)) {
    cases.push(['no input', undefined]);
    for (const key of Object.keys(VALID[operation])) cases.push([`no ${key}`, withoutField(operation, key)]);
  }
  for (const key of Object.keys(VALID[operation])) {
    for (const value of badValuesFor(operation, key)) cases.push([`${key} = ${String(JSON.stringify(value)).slice(0, 40)}`, withField(operation, key, value)]);
  }
  return cases;
}

/** A service that fails the test on any property access. */
function untouchable(): api.ExecutionLanesApiService {
  return new Proxy({} as api.ExecutionLanesApiService, {
    get(_target, name) {
      throw new Error(`the service was reached: ${String(name)}`);
    }
  });
}

/** A service that records each call and answers with the sentinel. */
function recording(): { service: api.ExecutionLanesApiService; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const service = new Proxy({} as api.ExecutionLanesApiService, {
    get(_target, name) {
      return (...args: unknown[]) => {
        calls.push([String(name), args]);
        return SENTINEL;
      };
    }
  });
  return { service, calls };
}

describe('FR-R6-F10 headless port: malformed input', () => {
  it('names one port function per contract operation', () => {
    expect(Object.keys(api.EXECUTION_LANES_OPERATIONS).sort()).toEqual([...OPERATIONS].sort());
    for (const operation of OPERATIONS) expect(typeof Reflect.get(api, operation), operation).toBe('function');
  });

  it.each(OPERATIONS)('%s refuses every malformed input without calling the service', async (operation) => {
    const cases = malformed(operation);
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const [label, input] of cases) {
      expect(await port(operation)(untouchable(), input), `${operation}: ${label}`).toEqual(INVALID);
    }
  });

  it('refuses a profile whose canonical JSON passes the byte bound', async () => {
    const big = BAD_PROFILES.at(9) as VerificationProfile;
    expect(Buffer.byteLength(JSON.stringify(big), 'utf8')).toBeGreaterThan(VERIFICATION_LIMITS.maxProfileJsonBytes);
    expect(big.checks.every((check) => check.argv.length <= VERIFICATION_LIMITS.maxArgs)).toBe(true);
    expect(await port('requestIntegration')(untouchable(), withField('requestIntegration', 'profile', big))).toEqual(INVALID);
  });
});

describe('FR-R6-F10 headless port: valid input', () => {
  it.each(OPERATIONS)('%s hands valid input to the service unchanged and returns its result', async (operation) => {
    const { service, calls } = recording();
    const input = VALID[operation];
    expect(await port(operation)(service, input)).toBe(SENTINEL);
    expect(calls).toHaveLength(1);
    const [name, args] = calls.at(0) ?? ['', []];
    expect(name).toBe(operation);
    expect(args).toEqual(operation === 'reconcile' ? [] : [input]);
  });

  it.each(ALL_OPTIONAL)('%s takes an absent input as the empty one', async (operation) => {
    const { service, calls } = recording();
    expect(await port(operation)(service)).toBe(SENTINEL);
    expect(calls.at(0)?.at(1)).toEqual(operation === 'reconcile' ? [] : [{}]);
  });

  it('accepts the bounds themselves', async () => {
    const edge: readonly (readonly [Operation, Record<string, unknown>])[] = [
      ['listLanes', { limit: 1 }],
      ['listLanes', { cursor: 'a'.repeat(256) }],
      ['listRequests', { states: [] }],
      ['requestIntegration', withField('requestIntegration', 'targetBranch', 'a'.repeat(200))],
      ['provisionLane', withField('provisionLane', 'rootExecutionId', 'a'.repeat(128))],
      ['provisionLane', withField('provisionLane', 'sourceRevision', 'HEAD~1')],
      ['cleanupLanes', { laneIds: Array.from({ length: LANE_PAGE_LIMIT_MAX }, () => LANE) }]
    ];
    for (const [operation, input] of edge) {
      const { service } = recording();
      expect(await port(operation)(service, input), `${operation} ${JSON.stringify(input).slice(0, 60)}`).toBe(SENTINEL);
    }
  });
});

// ---- the real service ----

const MAIN = 'main';

/** A lane with one frozen candidate and a `queued` request for it. */
async function queuedRequest(h: LaneHarness, text: string): Promise<{ laneId: string; requestId: string }> {
  const lane = await h.provision();
  const root = await h.laneRoot(lane.laneId);
  fs.writeFileSync(path.join(root, 'src', 'a.txt'), text);
  const frozen = await h.service.freezeCandidate({ laneId: lane.laneId });
  if (!frozen.ok) throw new Error(`freeze refused: ${frozen.refusal.reason}`);
  const request = await api.requestIntegration(h.service, { laneId: lane.laneId, targetBranch: MAIN, profile: PROFILE });
  if (!request.ok) throw new Error(`request refused: ${request.refusal.reason}`);
  return { laneId: lane.laneId, requestId: request.value.requestId };
}

/** Moves a request straight to `state` in the store, as an earlier operation would have. */
function force(h: LaneHarness, requestId: string, state: IntegrationState): void {
  const moved = h.integrations.transitionRequest(HARNESS_WS, requestId, ['queued'], state, { reason: null, now: NOW_ISO, generation: 1 });
  if (!moved.ok) throw new Error(`could not force ${state}: ${moved.refusal.reason}`);
}

function bytes(value: unknown): string {
  return JSON.stringify(value);
}

describe('FR-R6-F10 headless port: cancellation (US6-2)', () => {
  it('cancels one request and leaves the other lane, its request and the canceled lane byte-equal', async () => {
    const h = createLaneHarness({ label: 'api-cancel' });
    const first = await queuedRequest(h, 'alpha, lane one\n');
    const second = await queuedRequest(h, 'alpha, lane two\n');
    const before = {
      firstLane: bytes(api.getLane(h.service, { laneId: first.laneId })),
      secondLane: bytes(api.getLane(h.service, { laneId: second.laneId })),
      secondRequest: bytes(api.getRequest(h.service, { requestId: second.requestId }))
    };

    const canceled = api.cancelRequest(h.service, { requestId: first.requestId });
    expect(canceled.ok && canceled.value.state).toBe('canceled');

    expect(bytes(api.getLane(h.service, { laneId: first.laneId }))).toBe(before.firstLane);
    expect(bytes(api.getLane(h.service, { laneId: second.laneId }))).toBe(before.secondLane);
    expect(bytes(api.getRequest(h.service, { requestId: second.requestId }))).toBe(before.secondRequest);
    const page = api.listRequests(h.service, { states: ['queued'] });
    expect(page.ok && page.value.items.map((item) => item.requestId)).toEqual([second.requestId]);
  }, CASE_TIMEOUT_MS);
});

describe('FR-R6-F10 cancel rules (data-model, integration lifecycle)', () => {
  it.each<IntegrationState>(['queued', 'awaiting-review', 'blocked'])('cancels a %s request with no journal entry', async (state) => {
    const h = createLaneHarness({ label: `cancel-${state}` });
    const { requestId } = await queuedRequest(h, `alpha, ${state}\n`);
    if (state !== 'queued') force(h, requestId, state);
    const canceled = h.service.cancelRequest({ requestId });
    expect(canceled.ok && canceled.value.state).toBe('canceled');
    expect(h.integrations.listJournal(requestId)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it('cancels an uncertain request and journals that the operator acknowledged it', async () => {
    const h = createLaneHarness({ label: 'cancel-uncertain' });
    const { requestId } = await queuedRequest(h, 'alpha, uncertain\n');
    force(h, requestId, 'uncertain');
    const record = h.integrations.getRequest(HARNESS_WS, requestId);
    const canceled = h.service.cancelRequest({ requestId });
    expect(canceled.ok && canceled.value.state).toBe('canceled');
    const journal = h.integrations.listJournal(requestId);
    expect(journal).toHaveLength(1);
    expect(journal.at(0)).toMatchObject({
      kind: 'cancel',
      method: null,
      outcome: 'canceled',
      reason: 'acknowledged-uncertain',
      observedTip: null,
      candidateCommit: record?.candidateCommit,
      expectedCommit: record?.expectedTargetCommit
    });
  }, CASE_TIMEOUT_MS);

  it.each<IntegrationState>(['verifying', 'landing'])('refuses to cancel a %s request and changes nothing', async (state) => {
    const h = createLaneHarness({ label: `cancel-${state}` });
    const { requestId } = await queuedRequest(h, `alpha, ${state}\n`);
    force(h, requestId, state);
    const before = bytes(h.service.getRequest({ requestId }));
    expect(h.service.cancelRequest({ requestId })).toEqual({ ok: false, refusal: { reason: 'request-state-invalid' } });
    expect(bytes(h.service.getRequest({ requestId }))).toBe(before);
    expect(h.integrations.listJournal(requestId)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  it('refuses a terminal request, an unknown one, and a superseded host', async () => {
    const h = createLaneHarness({ label: 'cancel-terminal' });
    const { requestId } = await queuedRequest(h, 'alpha, terminal\n');
    expect(h.service.cancelRequest({ requestId }).ok).toBe(true);
    expect(h.service.cancelRequest({ requestId })).toEqual({ ok: false, refusal: { reason: 'request-state-invalid' } });
    expect(h.service.cancelRequest({ requestId: 'f'.repeat(32) })).toEqual({ ok: false, refusal: { reason: 'request-not-found' } });

    const other = await queuedRequest(h, 'alpha, superseded\n');
    h.reopen();
    expect(h.service.cancelRequest({ requestId: other.requestId })).toEqual({ ok: false, refusal: { reason: 'ownership-superseded' } });
    expect(h.integrations.getRequest(HARNESS_WS, other.requestId)?.state).toBe('queued');
  }, CASE_TIMEOUT_MS);
});
