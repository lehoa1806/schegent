import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import {
  CHAIN_DAMAGE_CONDITION,
  CHAIN_DAMAGE_CONDITION_VERSION,
  CHAIN_DAMAGE_EVENT_TYPE
} from '../../../src/audit/audit-chain';
import { SanitizedLogger } from '../../../src/lib/logger';
import { parseAuditLogLineDetailed } from '../../../src/parser/audit-log-parser';
import { projectAuditPayload } from '../../../src/audit/audit-payload';
import {
  ALL_AUDIT_EVENT_TYPES,
  classifyAuditEvent,
  type AuditEventType
} from '../../../src/contracts/audit-events';
import {
  AUDIT_INTEGRITY_CONDITION_EVENT,
  DAMAGE_DIGEST_ALG,
  INTEGRITY_CONDITIONS,
  INTEGRITY_CONDITION_VERSION
} from '../../../src/contracts/audit-integrity-condition';

/**
 * FR-R4-F03 (FR-019, FR-020; contract T17, data-model §2) — the payload of the
 * `audit-integrity-condition` event, as the write path projects it.
 *
 * WHY THIS PINS THE PROJECTION. The generic projector drops the key `file` (it is in
 * `OMITTED_KEYS`), so without a dedicated arm a `damaged-tail` row would lose the one field that
 * names where the damage is. The arm admits exactly the data-model fields of each condition by
 * identity, refuses a `file` that is a path, and preserves a shape it does not know (hard rule 5)
 * instead of refusing it, so a future condition written by a newer release is never lost here.
 *
 * The last two describes (T049) are the privacy row and the literal-parity row: no row the tail check
 * writes carries the workspace root or any of its path segments (FR-019, hard rule 22), and the
 * three literals the chain restates for its diagnosis (it may import nothing, R18) equal the
 * contracts module's constants, so the two copies cannot drift apart unseen.
 */

const EVENT = AUDIT_INTEGRITY_CONDITION_EVENT as AuditEventType;
const DIGEST = 'a'.repeat(64);

const damagedTail = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  condition: 'damaged-tail',
  conditionVersion: INTEGRITY_CONDITION_VERSION,
  file: 'audit.log',
  line: 7,
  byteOffset: 1234,
  byteLength: 41,
  digestAlg: DAMAGE_DIGEST_ALG,
  digest: DIGEST,
  ...overrides
});

const historyReset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  condition: 'history-reset',
  conditionVersion: INTEGRITY_CONDITION_VERSION,
  retiredPosition: 12,
  retiredAtMs: 1_700_000_000_000,
  ...overrides
});

const chainVerified = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  condition: 'chain-verified',
  conditionVersion: INTEGRITY_CONDITION_VERSION,
  entries: 14,
  cuts: 2,
  ...overrides
});

const checkpointReanchored = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  condition: 'checkpoint-reanchored',
  conditionVersion: INTEGRITY_CONDITION_VERSION,
  priorStatus: 'active',
  priorPosition: 10,
  newPosition: 7,
  reanchoredAtMs: 1_700_000_000_000,
  ...overrides
});

describe('the audit-integrity-condition event type', () => {
  it('is registered, so every reader meets a known event type', () => {
    expect(ALL_AUDIT_EVENT_TYPES).toContain('audit-integrity-condition');
    expect(INTEGRITY_CONDITIONS).toEqual([
      'damaged-tail',
      'history-reset',
      'chain-verified',
      'checkpoint-reanchored'
    ]);
  });
});

describe('projecting a damaged-tail condition', () => {
  it('admits exactly the data-model fields, including the basename the generic arm drops', () => {
    const projected = projectAuditPayload(EVENT, damagedTail());
    expect(projected).toEqual(damagedTail());
    expect(projected.file).toBe('audit.log');
  });

  it('drops a field that is not part of the condition', () => {
    const projected = projectAuditPayload(EVENT, damagedTail({ extra: 'x', path: 'y' }));
    expect(Object.keys(projected).sort()).toEqual(Object.keys(damagedTail()).sort());
  });

  it('refuses a file that is a path, whichever separator it uses', () => {
    expect(() => projectAuditPayload(EVENT, damagedTail({ file: 'a/audit.log' }))).toThrow();
    expect(() => projectAuditPayload(EVENT, damagedTail({ file: 'a\\audit.log' }))).toThrow();
    expect(() => projectAuditPayload(EVENT, damagedTail({ file: '' }))).toThrow();
  });

  it('refuses a field of the wrong type or an out-of-range number', () => {
    expect(() => projectAuditPayload(EVENT, damagedTail({ line: '7' }))).toThrow();
    expect(() => projectAuditPayload(EVENT, damagedTail({ line: 0 }))).toThrow();
    expect(() => projectAuditPayload(EVENT, damagedTail({ byteLength: -1 }))).toThrow();
    expect(() => projectAuditPayload(EVENT, damagedTail({ digest: 'xyz' }))).toThrow();
    expect(() => projectAuditPayload(EVENT, damagedTail({ digestAlg: 'md5' }))).toThrow();
  });
});

describe('projecting a history-reset condition', () => {
  it('admits exactly the data-model fields', () => {
    expect(projectAuditPayload(EVENT, historyReset())).toEqual(historyReset());
  });

  it('drops a field that is not part of the condition', () => {
    const projected = projectAuditPayload(EVENT, historyReset({ extra: 1 }));
    expect(Object.keys(projected).sort()).toEqual(Object.keys(historyReset()).sort());
  });

  it('refuses a field of the wrong type', () => {
    expect(() => projectAuditPayload(EVENT, historyReset({ retiredPosition: 'x' }))).toThrow();
    expect(() => projectAuditPayload(EVENT, historyReset({ retiredAtMs: -1 }))).toThrow();
  });
});

describe('projecting a chain-verified and checkpoint-reanchored condition (FR-R5-F13)', () => {
  it('admits chain-verified fields and drops unknown fields', () => {
    expect(projectAuditPayload(EVENT, chainVerified({ extra: 'nope' }))).toEqual(chainVerified());
    expect(() => projectAuditPayload(EVENT, chainVerified({ entries: -1 }))).toThrow();
    expect(() => projectAuditPayload(EVENT, chainVerified({ cuts: '2' }))).toThrow();
  });

  it('admits checkpoint-reanchored fields, allows omitted priorPosition, and validates priorStatus', () => {
    expect(projectAuditPayload(EVENT, checkpointReanchored({ extra: 'nope' }))).toEqual(
      checkpointReanchored()
    );
    const withoutPrior = checkpointReanchored();
    delete withoutPrior.priorPosition;
    expect(projectAuditPayload(EVENT, withoutPrior)).toEqual(withoutPrior);
    expect(() =>
      projectAuditPayload(EVENT, checkpointReanchored({ priorStatus: 'invalid' }))
    ).toThrow();
    expect(() => projectAuditPayload(EVENT, checkpointReanchored({ newPosition: 0 }))).toThrow();
  });
});

describe('a shape this release does not know', () => {
  // A PIN, green before and after the change: its job is to stop the new arm from refusing what a
  // newer release wrote (hard rule 5). It is made non-vacuous by the mutation in tasks T011.
  it('is preserved, never refused and never read as a diagnosis', () => {
    const future = projectAuditPayload(EVENT, {
      condition: 'a-future-condition',
      conditionVersion: 1,
      count: 3
    });
    expect(future.condition).toBe('a-future-condition');
    expect(future.count).toBe(3);
  });

  it('keeps a higher conditionVersion of a known condition as it was written', () => {
    const projected = projectAuditPayload(EVENT, damagedTail({ conditionVersion: 2, file: 'x' }));
    expect(projected.conditionVersion).toBe(2);
    expect(projected.condition).toBe('damaged-tail');
  });
});

describe('what the tail check writes carries no path (FR-019, hard rule 22)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-priv-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** The root, and every segment of it longer than three characters, that `text` contains. */
  const leaks = (text: string): string[] =>
    [root, ...root.split(path.sep).filter((segment) => segment.length > 3)].filter((needle) =>
      text.includes(needle)
    );

  it('writes no row that contains the workspace root or a long segment of it', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([]));
    const entry = { eventType: 'phase-start', runId: 'r', payload: { phase: 'p' } } as never;
    await writer.append(entry);
    await fs.appendFile(path.join(root, '.schegent', 'audit.log'), '{"id":"torn","eventTy');

    await new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([])).append(entry);

    const text = await fs.readFile(path.join(root, '.schegent', 'audit.log'), 'utf8');
    expect(text, 'the fixture really diagnosed a damaged tail').toContain('audit-integrity-condition');
    expect(leaks(text)).toEqual([]);
  });

  it('writes rows the line parser keeps, as system events, so no reader drops them or counts a warning', async () => {
    const entry = { eventType: 'phase-start', runId: 'r', payload: { phase: 'p' } } as never;
    await new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([])).append(entry);
    await fs.appendFile(path.join(root, '.schegent', 'audit.log'), '{"id":"torn","eventTy');
    await new AuditLogWriter({ workspaceRoot: root }, new SanitizedLogger([])).append(entry);

    const lines = (await fs.readFile(path.join(root, '.schegent', 'audit.log'), 'utf8'))
      .split('\n')
      .filter((line) => line.includes('audit-integrity-condition'));
    expect(lines).toHaveLength(1);
    const parsed = parseAuditLogLineDetailed(lines[0] as string);
    expect(parsed.warning).toBeUndefined();
    expect(parsed.entry?.eventType).toBe('audit-integrity-condition');
    expect(classifyAuditEvent('audit-integrity-condition')).toBe('system');
  });

  it('is not vacuous: the same search finds a root planted in the file field', () => {
    const planted = JSON.stringify({ payload: { condition: 'damaged-tail', file: root } });
    expect(leaks(planted)).toContain(root);
  });
});

describe('the literals the chain restates equal the contracts module (R18, TA5)', () => {
  it('restates the event type, the condition and the version exactly', () => {
    expect(CHAIN_DAMAGE_EVENT_TYPE).toBe(AUDIT_INTEGRITY_CONDITION_EVENT);
    expect(CHAIN_DAMAGE_CONDITION).toBe(INTEGRITY_CONDITIONS[0]);
    expect(CHAIN_DAMAGE_CONDITION_VERSION).toBe(INTEGRITY_CONDITION_VERSION);
  });
});
