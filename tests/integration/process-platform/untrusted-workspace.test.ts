// Feature 089 (T027, T030, US5, FR-028, FR-030, FR-031, FR-006, SC-004) — an
// untrusted workspace cannot write, a read-only command still works, and a
// payload that does not match its command is refused at the boundary.
//
// The mutating table is `MUTATING_COMMAND_TYPES` itself, deliberately. Elsewhere
// in this feature a hand-written list is the point — `mutating-commands-pinned-
// list.test.ts` exists precisely so the gate's membership cannot define itself.
// Here the claim is behavioral rather than about membership: *whatever* the
// platform gates must refuse. Driving it from the live set means a command
// registered tomorrow is qualified against this gate the day it lands, and the
// pinned-list fixture is what stops that set from silently shrinking.

import { describe, expect, it } from 'vitest';
import { MUTATING_COMMAND_TYPES } from '../../../src/contracts/sidebar-command-metadata';
import { validateInboundMessage } from '../../../src/ui/sidebar/ipc-validator';
import {
  CMD_EXPORT_PROCESS_YAML,
  CMD_PREFLIGHT_PROCESS_YAML,
  CMD_REMOVE_QUEUE_ITEM,
  CMD_RETRY_QUEUE_ITEM,
  CMD_SAVE_DEFINITION_DRAFT,
  CMD_START
} from '../../../src/ui/sidebar/messages';
import {
  EXPORTABLE_PHASE_ID,
  makeGateProbe,
  SECONDARY_REJECT,
  UNTRUSTED_REJECT
} from './gate-harness';

const UNTRUSTED = { isTrusted: () => false, isPrimary: () => true };
const OPEN = { isTrusted: () => true, isPrimary: () => true };

describe('an untrusted workspace refuses every mutating command (T027, FR-028)', () => {
  it('has a table to drive — the live mutating set is not empty', () => {
    // Guards the whole file: an empty table would make every `it.each` below
    // vacuous and the suite would report green having asserted nothing.
    expect(MUTATING_COMMAND_TYPES.length).toBeGreaterThan(0);
  });

  it.each([...MUTATING_COMMAND_TYPES])('refuses %s before any write', async (type) => {
    const probe = makeGateProbe(UNTRUSTED);
    const ack = await probe.dispatch(type);

    expect(ack?.status).toBe('rejected');
    expect(ack?.reason).toBe(UNTRUSTED_REJECT);
    // FR-028's actual claim. The ack says "refused"; only this says "before".
    expect(probe.writes).toEqual([]);
  });

  it('answers untrusted before primary, so the refusal leaks no host status', async () => {
    // Both gates closed. The trust check runs first by construction
    // (`message-router.ts`), so a malicious untrusted workspace cannot use the
    // rejection token to learn whether this window holds the workspace lock.
    const probe = makeGateProbe({ isTrusted: () => false, isPrimary: () => false });
    const ack = await probe.dispatch(CMD_SAVE_DEFINITION_DRAFT);

    expect(ack?.reason).toBe(UNTRUSTED_REJECT);
    expect(ack?.reason).not.toBe(SECONDARY_REJECT);
    expect(probe.writes).toEqual([]);
  });

  it('treats a missing trust callback as untrusted (fail-closed)', async () => {
    // A deps-wiring regression on the host must not silently disable the gate.
    const probe = makeGateProbe({ isPrimary: () => true });
    const ack = await probe.dispatch(CMD_SAVE_DEFINITION_DRAFT);

    expect(ack?.reason).toBe(UNTRUSTED_REJECT);
    expect(probe.writes).toEqual([]);
  });

  it('would have recorded a write had one happened (positive control)', async () => {
    // Without this, deleting the trust gate outright would leave every
    // assertion above passing: an unwired recorder is also an empty one.
    const probe = makeGateProbe(OPEN);
    await probe.dispatch(CMD_START, { description: 'probe', pipelineId: null });

    expect(probe.writes).toContain('executeCommand:schegent.enqueue');
  });
});

describe('read-only commands are not gated by trust (T027, FR-031, SC-004)', () => {
  it('runs the export command in an untrusted workspace', async () => {
    const probe = makeGateProbe(UNTRUSTED);
    const ack = await probe.dispatch(CMD_EXPORT_PROCESS_YAML, {
      resourceKind: 'phase',
      resourceId: EXPORTABLE_PHASE_ID
    });

    // Reaching the save adapter is the evidence. Asserting only "the reason is
    // not the gate token" would also pass if the handler refused for a reason
    // of its own and never ran.
    expect(probe.writes).toContain('saveProcessYamlDocument');
    expect(ack?.reason).not.toBe(UNTRUSTED_REJECT);
  });

  it('runs the import preflight in an untrusted workspace', async () => {
    const probe = makeGateProbe(UNTRUSTED);
    const ack = await probe.dispatch(CMD_PREFLIGHT_PROCESS_YAML);

    expect(probe.writes).toContain('openProcessYamlDocument');
    expect(ack?.reason).not.toBe(UNTRUSTED_REJECT);
  });
});

// Feature 089 (T030, FR-030, FR-006) — a payload that does not match its
// declared command.
//
// The refusal is at the transport boundary, not in a handler: `sidebar-view-
// provider.ts` validates every inbound message and drops it without dispatching
// when validation fails. The pipeline below is that composition, so "no partial
// effect" is asserted on the path the extension actually runs rather than on a
// router call the provider would never have made.
const MISMATCHED: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['CMD_START with a non-string description', { type: CMD_START, correlationId: 'c1', payload: { description: 42 } }],
  ['CMD_START with no payload at all', { type: CMD_START, correlationId: 'c2' }],
  [
    'CMD_REMOVE_QUEUE_ITEM missing its confirmation',
    { type: CMD_REMOVE_QUEUE_ITEM, correlationId: 'c3', payload: { id: 'q-1' } }
  ],
  [
    'CMD_RETRY_QUEUE_ITEM whose id is an absolute path',
    {
      type: CMD_RETRY_QUEUE_ITEM,
      correlationId: 'c4',
      payload: { id: { nested: '/Users/someone/secret/workspace' } }
    }
  ],
  // Feature 100 (T514) — the same two mismatches the retired `CMD_SAVE_PHASES`
  // entry carried, restated against the command that replaced it: a field whose
  // domain is closed arriving as a filesystem path, and an envelope missing the
  // one field that says what it is writing.
  [
    'CMD_SAVE_DEFINITION_DRAFT whose kind is a path, not a catalog kind',
    {
      type: CMD_SAVE_DEFINITION_DRAFT,
      correlationId: 'c5',
      payload: {
        kind: '/etc/passwd',
        id: 'speckit-specify',
        expectedDraftVersion: 'none',
        body: {}
      }
    }
  ],
  [
    'CMD_SAVE_DEFINITION_DRAFT with no body to save',
    {
      type: CMD_SAVE_DEFINITION_DRAFT,
      correlationId: 'c6',
      payload: { kind: 'phase', id: 'speckit-specify', expectedDraftVersion: 'none' }
    }
  ]
];

/** Every string anywhere in a submitted payload, so a refusal can be checked against all of them. */
function stringValues(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(stringValues);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(stringValues);
  }
  return [];
}

describe('a payload that does not match its command is refused (T030, FR-030)', () => {
  it.each(MISMATCHED)('refuses %s with no partial effect', async (_label, raw) => {
    const probe = makeGateProbe(OPEN);

    // The provider's own composition, mirrored: validate, and dispatch only
    // what validated (`sidebar-view-provider.ts`).
    const result = validateInboundMessage(raw);
    if (result.ok) {
      await probe.dispatch(result.command.type, (result.command as { payload?: unknown }).payload);
    }

    expect(result.ok).toBe(false);
    expect(probe.writes).toEqual([]);
  });

  it.each(MISMATCHED)('sanitizes the refusal for %s (FR-006)', (_label, raw) => {
    const result = validateInboundMessage(raw);
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;

    // A closed vocabulary of hyphenated tokens — `description-not-string`,
    // `missing-payload`, `invalid-id`. The character class is what forbids a
    // location: no separator of either platform can appear in a token that
    // matches it, so a refusal cannot name a file, a folder, or a URL.
    expect(reason).toMatch(/^[a-z0-9-]+$/);

    // And nothing the sender wrote comes back inside it. Values under three
    // characters are skipped: a coincidence that short would say nothing.
    for (const submitted of stringValues((raw as { payload?: unknown }).payload)) {
      if (submitted.length >= 3) {
        expect(reason, `refusal echoes submitted content: ${submitted}`).not.toContain(submitted);
      }
    }
  });

  it('echoes none of the submitted content back in the refusal', () => {
    // The planted values are the ones an attacker would want reflected: a
    // filesystem path and a secret-looking token.
    const planted = '/Users/someone/.aws/credentials';
    const result = validateInboundMessage({
      type: CMD_SAVE_DEFINITION_DRAFT,
      correlationId: 'c7',
      payload: {
        kind: planted,
        id: planted,
        expectedDraftVersion: planted,
        body: { id: planted }
      }
    });

    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).not.toContain(planted);
    expect(reason).not.toContain('someone');
    expect(reason).not.toContain('.aws');
  });
});
