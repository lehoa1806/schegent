// FR-R4-F05 (T4; contract C, C4, C5, C9; contract O, O8; FR-002, FR-006, FR-009;
// SC-001, SC-003) — the router gates what the declaration says it gates, for every
// webview command, and the review of the 17 commands the old table left out holds.
//
// WHY ALL 65. The old table was partial, so a command nobody had decided about
// ran with no gate and no record. A unit test of any one command cannot show that
// the rest are covered. This one sends every `COMMAND_TYPES` member, as a raw
// command with the smallest payload its own runtime guard accepts, through the
// production `MessageRouter` and `HANDLERS`, and checks the first answer under three
// conditions: untrusted, trusted but secondary, and untrusted and secondary.
//
// HOW "BEFORE ITS HANDLER" IS SHOWN. The router's dependencies are a proxy that
// records every property a handler reads beyond the ones the gate itself uses. A
// refused gated command must leave that record empty and must not call
// `executeCommand`. A read-only command that fails inside its handler on a missing
// dependency is fine here: the assertion is only that no gate refused it.
//
// TWO SOURCES OF TRUTH, ON PURPOSE. For all 65 the expectation is the declaration's,
// which proves the router matches it. For the 17 commands research R5 reviewed, the
// expected verdict is ALSO written out below by hand, so that reclassifying one in
// the declaration, in either direction, is a visible edit here and not a silent one.

import { describe, expect, it, vi } from 'vitest';
import {
  COMMAND_AUTHORITY,
  commandAuthorityOf
} from '../../src/contracts/sidebar-command-metadata';
import {
  COMMAND_GUARDS,
  COMMAND_TYPES,
  type CommandType
} from '../../src/contracts/sidebar-ipc';
import { SECONDARY_REJECT, UNTRUSTED_REJECT } from '../../src/ui/sidebar/commands/constants';
import type { RouterDeps } from '../../src/ui/sidebar/commands/router-types';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import type { CommandAckMessage, SidebarCommand } from '../../src/ui/sidebar/messages';

type Verdict = 'gated' | 'read-only';

/** Research R5's table: the 17 commands the declaration's predecessor left out. */
const R5_VERDICTS: Readonly<Record<string, Verdict>> = {
  CMD_PING_BACKEND: 'gated',
  CMD_DISMISS_MIGRATION_NOTICE: 'gated',
  CMD_EXPORT_PROCESS_YAML: 'gated',
  CMD_PREFLIGHT_PROCESS_YAML: 'gated',
  CMD_READ_METRICS: 'gated',
  CMD_READ_PHASE_LOG: 'gated',
  CMD_START_PHASE_LOG_TAIL: 'gated',
  CMD_STOP_PHASE_LOG_TAIL: 'gated',
  CMD_OPEN_AUDIT_LOG: 'read-only',
  CMD_OPEN_DASHBOARD: 'read-only',
  CMD_OPEN_HISTORY_ITEM_DETAILS: 'read-only',
  CMD_OPEN_VERBOSE_SETTING: 'read-only',
  CMD_OPEN_TRUST_SETTINGS: 'read-only',
  CMD_READ_DEFINITION_VERSION: 'read-only',
  CMD_RESOLVE_AUDIT_POINTER: 'read-only',
  CMD_RESOLVE_HISTORY_DESCRIPTION: 'read-only',
  CMD_READ_FAILURE_RECORD: 'read-only'
};

const EMPTY_LAUNCH_REQUEST = { inputs: [], supplemental: [], outputs: [] };

/**
 * The payloads a bare `{ type, correlationId }` envelope cannot stand in for. Every
 * other command's guard accepts the bare envelope. Each value is the smallest
 * payload that command's own guard in `COMMAND_GUARDS` accepts.
 */
const REQUIRED_PAYLOADS: Readonly<Partial<Record<CommandType, unknown>>> = {
  CMD_SET_CONFIRM_SUPPRESSION: { actionKey: 'queue.clean-all', suppressed: true },
  CMD_READ_METRICS: {},
  CMD_READ_USAGE_ACCOUNTING: { query: {} },
  CMD_READ_DEFINITION_VERSION: { kind: 'phase', id: 'specify', versionId: 'v2' },
  CMD_PING_BACKEND: { runner: 'claude' },
  CMD_EXPORT_PROCESS_YAML: { resourceKind: 'phase', resourceId: 'specify' },
  CMD_PREFLIGHT_PROCESS_YAML: {},
  CMD_LAUNCH_PIPELINE: { request: { pipelineId: 'default', ...EMPTY_LAUNCH_REQUEST } },
  CMD_LAUNCH_WORKFLOW: {
    workflowId: 'release',
    startNodeId: 'n-triage',
    request: { pipelineId: 'triage-flow', ...EMPTY_LAUNCH_REQUEST }
  },
  CMD_CONTINUE_WORKFLOW: {
    connectedRunId: 'connected-run-1',
    expectedRevision: 0,
    nodeId: 'n-ship',
    request: { pipelineId: 'ship-flow', ...EMPTY_LAUNCH_REQUEST }
  },
  CMD_SAVE_MODELS: { models: {} },
  CMD_SAVE_DEFINITION_DRAFT: {
    kind: 'phase',
    id: 'specify',
    expectedDraftVersion: 'no-draft',
    body: null
  },
  CMD_PUBLISH_DEFINITION: { kind: 'phase', id: 'specify', expectedDraftVersion: 'v1' },
  CMD_DEACTIVATE_DEFINITION: { kind: 'phase', id: 'specify', expectedDraftVersion: 'v1' },
  CMD_DISCARD_DEFINITION_DRAFT: { kind: 'phase', id: 'specify', expectedDraftVersion: 'v1' },
  CMD_RESTORE_DEFINITION_VERSION: {
    kind: 'phase',
    id: 'specify',
    expectedDraftVersion: 'v1',
    fromVersionId: 'v1'
  },
  CMD_PUBLISH_PACKAGE: {
    layers: [
      {
        kind: 'phase',
        expectedRevision: 'rev-phase-0',
        definitions: [{ id: 'specify', body: null }]
      }
    ]
  },
  CMD_SET_UNCONTAINED_BACKEND_GRANT: { kind: 'claude', granted: true }
};

function minimalCommand(type: CommandType): SidebarCommand {
  const payload = REQUIRED_PAYLOADS[type];
  const envelope = { type, correlationId: `route-${type}` };
  return (payload === undefined ? envelope : { ...envelope, payload }) as SidebarCommand;
}

interface Conditions {
  readonly trusted: boolean;
  readonly primary: boolean;
}

interface Routed {
  readonly acks: readonly CommandAckMessage[];
  /** Properties a handler read beyond the gate's own, in order. */
  readonly touched: readonly string[];
  readonly executeCommandCalls: number;
}

const GATE_PROPERTIES: ReadonlySet<string> = new Set([
  'executeCommand',
  'isPrimary',
  'isTrusted',
  'logger',
  'notifyWarning'
]);

/** Sends one raw command through a fresh production router. */
async function route(type: CommandType, conditions: Conditions): Promise<Routed> {
  const touched: string[] = [];
  const executeCommand = vi.fn(async () => undefined);
  const base: Record<string, unknown> = {
    executeCommand,
    isPrimary: () => conditions.primary,
    isTrusted: () => conditions.trusted,
    notifyWarning: vi.fn(),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      sanitize: (value: string) => value
    }
  };
  const deps = new Proxy(base, {
    get(target, property) {
      if (typeof property === 'symbol') return undefined;
      if (GATE_PROPERTIES.has(property)) return target[property];
      touched.push(property);
      return undefined;
    }
  }) as unknown as RouterDeps;

  const acks: CommandAckMessage[] = [];
  await new MessageRouter(deps).dispatch(minimalCommand(type), async (ack) => {
    acks.push(ack);
    return true;
  });
  return { acks, touched, executeCommandCalls: executeCommand.mock.calls.length };
}

function firstReason(routed: Routed): string | undefined {
  return routed.acks[0]?.reason;
}

function isGateRefusal(routed: Routed): boolean {
  const reason = firstReason(routed);
  return reason === UNTRUSTED_REJECT || reason === SECONDARY_REJECT;
}

/** The types whose routing differs from `expected(type)`, with what happened. */
async function mismatches(
  conditions: Conditions,
  expected: (type: CommandType) => string | null
): Promise<string[]> {
  const offenders: string[] = [];
  for (const type of COMMAND_TYPES) {
    const routed = await route(type, conditions);
    const want = expected(type);
    if (want === null) {
      if (isGateRefusal(routed)) offenders.push(`${type}: refused by a gate (${firstReason(routed)})`);
      continue;
    }
    if (routed.acks.length !== 1 || firstReason(routed) !== want) {
      offenders.push(`${type}: wanted one ${want} ack, got ${JSON.stringify(routed.acks.map((a) => a.reason))}`);
    } else if (routed.touched.length > 0 || routed.executeCommandCalls > 0) {
      offenders.push(`${type}: its handler ran before the refusal (read ${routed.touched.join(', ')})`);
    }
  }
  return offenders;
}

const gatedByDeclaration = (type: CommandType): boolean =>
  commandAuthorityOf(type).authority === 'gated';

describe('every webview command is routed as the declaration says (T4)', () => {
  it('parses 66 commands, each with a payload its own guard accepts', () => {
    // FR-R6-F05 added the read-only CMD_READ_STORAGE_DETAILS (63 to 64).
    // FR-R6-F06 added the read-only CMD_READ_USAGE_ACCOUNTING (64 to 65).
    // FR-R6-F07 added the gated CMD_ACK_PHASE_LOG_TAIL (65 to 66).
    expect(COMMAND_TYPES).toHaveLength(66);
    const rejected = COMMAND_TYPES.filter((type) => !COMMAND_GUARDS[type](minimalCommand(type)));
    expect(rejected, `commands whose minimal payload their guard refuses: ${rejected.join(', ')}`).toEqual([]);
  });

  it('refuses every gated command in an untrusted workspace before its handler, and no read-only one', async () => {
    const offenders = await mismatches(
      { trusted: false, primary: true },
      (type) => (gatedByDeclaration(type) ? UNTRUSTED_REJECT : null)
    );
    expect(offenders).toEqual([]);
  });

  it('refuses every gated command in a trusted secondary window before its handler, and no read-only one', async () => {
    const offenders = await mismatches(
      { trusted: true, primary: false },
      (type) => (gatedByDeclaration(type) ? SECONDARY_REJECT : null)
    );
    expect(offenders).toEqual([]);
  });

  it('checks trust before primacy: an untrusted secondary window gets the trust refusal', async () => {
    const offenders = await mismatches(
      { trusted: false, primary: false },
      (type) => (gatedByDeclaration(type) ? UNTRUSTED_REJECT : null)
    );
    expect(offenders).toEqual([]);
  });

  it('serves a trusted primary window: no command is refused by a gate', async () => {
    const offenders: string[] = [];
    for (const type of COMMAND_TYPES) {
      const routed = await route(type, { trusted: true, primary: true });
      if (isGateRefusal(routed)) offenders.push(`${type}: ${firstReason(routed)}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the review of the 17 commands the old table left out (T4, research R5)', () => {
  it('names 17 commands, none of them twice', () => {
    expect(Object.keys(R5_VERDICTS)).toHaveLength(17);
    expect(Object.values(R5_VERDICTS).filter((verdict) => verdict === 'gated')).toHaveLength(8);
    expect(Object.values(R5_VERDICTS).filter((verdict) => verdict === 'read-only')).toHaveLength(9);
    for (const type of Object.keys(R5_VERDICTS)) {
      expect(COMMAND_TYPES as readonly string[], type).toContain(type);
    }
  });

  it('declares each verdict, in the declaration', () => {
    const wrong = COMMAND_TYPES.filter(
      (type) => Object.hasOwn(R5_VERDICTS, type) && COMMAND_AUTHORITY[type].authority !== R5_VERDICTS[type]
    ).map((type) => `${type}: declared ${COMMAND_AUTHORITY[type].authority}, reviewed ${R5_VERDICTS[type]}`);
    expect(wrong).toEqual([]);
  });

  it('routes each verdict, in an untrusted workspace and in a trusted secondary window', async () => {
    const offenders: string[] = [];
    for (const [type, verdict] of Object.entries(R5_VERDICTS)) {
      const command = type as CommandType;
      const untrusted = await route(command, { trusted: false, primary: true });
      const secondary = await route(command, { trusted: true, primary: false });
      if (verdict === 'gated') {
        if (firstReason(untrusted) !== UNTRUSTED_REJECT) offenders.push(`${type}: not refused untrusted`);
        if (firstReason(secondary) !== SECONDARY_REJECT) offenders.push(`${type}: not refused secondary`);
      } else {
        if (isGateRefusal(untrusted)) offenders.push(`${type}: read-only but refused untrusted`);
        if (isGateRefusal(secondary)) offenders.push(`${type}: read-only but refused secondary`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
