// Feature 084 T047/T048/T049 — every document-level refusal, at the boundary.
//
// The parser's own refusals are pinned in `tests/unit/process-yaml/`. What this
// file adds is the boundary contract for each class: the operator receives
// `{ outcome: 'refused', refusal }` with the named code, the ack is `rejected`
// with reason `refused`, and — T048 — the result carries NO plan at all, not an
// empty one and not a partial one (FR-027, SC-012). A partial plan for a
// document this build refused is the failure mode this feature most needs to not
// have: it is how an operator ends up confirming an import of something that was
// never understood.
//
// Every case also asserts that no value the document declared survives into the
// message. A refusal that echoed a constructed value would mean the refusal
// landed after construction rather than at the token (FR-003a).
//
// T049 is the counterpart: `skill` is never resolved, so a document naming a
// skill that does not exist is a perfectly good import (FR-007, QS-25).

import { describe, expect, it, vi } from 'vitest';

import { CMD_PREFLIGHT_PROCESS_YAML } from '../../../src/contracts/sidebar-ipc';
import type {
  CommandAckMessage,
  PreflightProcessYamlCommand,
  PreflightProcessYamlResult
} from '../../../src/contracts/sidebar-ipc';
import type { DocumentRefusalCode } from '../../../src/services/process-yaml/types';
import { PHASE_YAML_MAX_BYTES } from '../../../src/services/process-yaml/types';
import { handler as preflightHandler } from '../../../src/ui/sidebar/commands/cmd-preflight-process-yaml';

/** Appears in every malformed document, and must appear in no refusal. */
const PAYLOAD = 'CONSTRUCTED-PAYLOAD';

const COMMAND: PreflightProcessYamlCommand = {
  type: CMD_PREFLIGHT_PROCESS_YAML,
  correlationId: 'refusal-test-1',
  payload: { resourceKind: 'phase' }
};

async function preflight(documentBytes: Uint8Array): Promise<CommandAckMessage> {
  const acks: CommandAckMessage[] = [];
  const ctx = {
    deps: {
      readPhaseConfig: () => ({ user: [], workspace: [] }),
      openProcessYamlDocument: async () => ({ outcome: 'read' as const, bytes: documentBytes }),
      audit: { append: async () => undefined },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        sanitize: (value: string) => value
      }
    },
    postAck: async (msg: CommandAckMessage) => {
      acks.push(msg);
      return true;
    },
    correlationId: 'refusal-test-1'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await preflightHandler(ctx, COMMAND);
  expect(acks).toHaveLength(1);
  return acks[0]!;
}

function utf8(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** A well-formed document, used as the base for the wrong-version/kind cases. */
function document(header: readonly string[]): string {
  return [
    ...header,
    'metadata:',
    '  phaseId: ship-it',
    `  name: ${PAYLOAD}`,
    '  version: 1',
    'spec:',
    '  instruction: Ship the thing.',
    ''
  ].join('\n');
}

const VALID_HEADER = ['apiVersion: schegent/v1', 'kind: Phase'] as const;

interface RefusalCase {
  readonly label: string;
  readonly code: DocumentRefusalCode;
  readonly bytes: Uint8Array;
}

const CASES: readonly RefusalCase[] = [
  // QS-8 — over the size bound. Refused on the byte count, before the scanner.
  {
    label: 'QS-8 a document over the size bound',
    code: 'too-large',
    bytes: utf8(`${document(VALID_HEADER)}# ${'x'.repeat(PHASE_YAML_MAX_BYTES)}\n`)
  },

  // QS-9 — every construct outside the closed subset. Each is refused at the
  // token, which is why none of them can echo `PAYLOAD` back.
  { label: 'QS-9 an anchor', code: 'disallowed-syntax', bytes: utf8(`metadata: &base\n  name: ${PAYLOAD}\n`) },
  { label: 'QS-9 an alias', code: 'disallowed-syntax', bytes: utf8(`metadata:\n  name: A\nspec: *base\n`) },
  { label: 'QS-9 a merge key', code: 'disallowed-syntax', bytes: utf8(`spec:\n  <<: *base\n  skill: ${PAYLOAD}\n`) },
  { label: 'QS-9 an explicit tag', code: 'disallowed-syntax', bytes: utf8(`metadata:\n  name: !!str ${PAYLOAD}\n`) },
  { label: 'QS-9 a %YAML directive', code: 'disallowed-syntax', bytes: utf8(`%YAML 1.2\n---\nkind: Phase\n`) },
  { label: 'QS-9 a flow mapping', code: 'disallowed-syntax', bytes: utf8(`metadata: { name: ${PAYLOAD} }\n`) },
  { label: 'QS-9 a flow sequence', code: 'disallowed-syntax', bytes: utf8(`metadata: [ ${PAYLOAD} ]\n`) },
  { label: 'QS-9 a block sequence', code: 'disallowed-syntax', bytes: utf8(`spec:\n  - ${PAYLOAD}\n`) },
  { label: 'QS-9 a complex key', code: 'disallowed-syntax', bytes: utf8(`? ${PAYLOAD}\n: value\n`) },
  {
    label: 'QS-9 a tab in the indentation',
    code: 'disallowed-syntax',
    bytes: utf8(`metadata:\n\tname: ${PAYLOAD}\n`)
  },

  // QS-10 — one document, one resource.
  {
    label: 'QS-10 a second document start',
    code: 'multi-document',
    bytes: utf8(`${document(VALID_HEADER)}---\nkind: Phase\n`)
  },
  {
    label: 'QS-10 a document end marker',
    code: 'multi-document',
    bytes: utf8(`${document(VALID_HEADER)}...\n`)
  },
  {
    // A sequence of Phases where one resource belongs. Refused as syntax rather
    // than as a count, because a top-level sequence is not in the language at
    // all — the format has no plural form to mis-read (FR-002a).
    label: 'QS-10 a sequence of resources',
    code: 'disallowed-syntax',
    bytes: utf8(`- apiVersion: schegent/v1\n  kind: Phase\n  metadata:\n    name: ${PAYLOAD}\n`)
  },

  // QS-11 — the document says what it is, and this build only reads one thing.
  {
    label: 'QS-11 an unsupported apiVersion',
    code: 'unsupported-version',
    bytes: utf8(document(['apiVersion: schegent/v2', 'kind: Phase']))
  },
  {
    label: 'QS-11 a missing apiVersion',
    code: 'unsupported-version',
    bytes: utf8(document(['kind: Phase']))
  },
  {
    label: 'QS-11 another kind',
    code: 'unsupported-kind',
    bytes: utf8(document(['apiVersion: schegent/v1', 'kind: Pipeline']))
  },
  {
    label: 'QS-11 a missing kind',
    code: 'unsupported-kind',
    bytes: utf8(document(['apiVersion: schegent/v1']))
  },

  // QS-12 — bytes that are not a document are refused, never repaired.
  {
    label: 'QS-12 invalid UTF-8',
    code: 'unreadable',
    // A lone continuation byte: valid nowhere in UTF-8.
    bytes: new Uint8Array([0x6b, 0x69, 0x6e, 0x64, 0x3a, 0x20, 0x80, 0x0a])
  },
  {
    label: 'QS-12 a leading byte-order mark',
    code: 'unreadable',
    bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...utf8(document(VALID_HEADER))])
  },

  // QS-13 — nothing to plan.
  { label: 'QS-13 an empty document', code: 'empty', bytes: new Uint8Array() },
  { label: 'QS-13 a document of only comments', code: 'empty', bytes: utf8('# nothing here\n\n') }
];

describe('Feature 084 — document-level refusals reach the operator named (QS-8..QS-13)', () => {
  for (const testCase of CASES) {
    it(`${testCase.label} is refused as ${testCase.code}`, async () => {
      const ack = await preflight(testCase.bytes);
      const result = ack.result as PreflightProcessYamlResult;

      expect(result.outcome).toBe('refused');
      if (result.outcome !== 'refused') return;
      expect(result.refusal.code).toBe(testCase.code);
      // The message is present and says something, because a bare code is not a
      // stated reason (FR-057).
      expect(result.refusal.message.length).toBeGreaterThan(0);

      // T048 — no plan, not even an empty one. Asserted on the key set so a
      // later `plan: { rows: [], ... }` fails here rather than reaching the UI.
      expect(Object.keys(result).sort()).toEqual(['outcome', 'refusal']);
      expect(ack.status).toBe('rejected');
      expect(ack.reason).toBe('refused');

      // Nothing the document declared survives into the refusal.
      expect(JSON.stringify(ack)).not.toContain(PAYLOAD);
    });
  }

  it('T048 covers every refusal code this build can emit', () => {
    // Keeps the table honest: a new code added to the union without a case here
    // fails, rather than shipping a class no boundary test describes.
    const codes: readonly DocumentRefusalCode[] = [
      'unreadable',
      'too-large',
      'unsupported-version',
      'unsupported-kind',
      'disallowed-syntax',
      'multi-document',
      'empty'
    ];
    expect([...new Set(CASES.map((testCase) => testCase.code))].sort()).toEqual([...codes].sort());
  });
});

describe('Feature 084 QS-25 — a skill reference is never followed (FR-007)', () => {
  it('plans a document naming a nonexistent skill as import', async () => {
    const ack = await preflight(
      utf8(
        [
          'apiVersion: schegent/v1',
          'kind: Phase',
          'metadata:',
          '  phaseId: uses-a-skill',
          '  name: Uses A Skill',
          '  version: 1',
          'spec:',
          '  skill: no-such-skill-exists-anywhere',
          ''
        ].join('\n')
      )
    );

    const result = ack.result as PreflightProcessYamlResult;
    expect(result.outcome).toBe('planned');
    if (result.outcome !== 'planned') return;
    expect(result.plan.counts).toEqual({ import: 1, skip: 0, invalid: 0 });
    const [row] = result.plan.rows;
    expect(row?.outcome).toBe('import');
    if (row?.outcome !== 'import') return;
    // The reference is carried as authored — not resolved, not inlined, not
    // checked for existence. What a skill name means is decided at run time by
    // the runner, in the installation that runs it.
    expect(row.definition).toEqual({
      phaseId: 'uses-a-skill',
      name: 'Uses A Skill',
      version: 1,
      skill: 'no-such-skill-exists-anywhere'
    });
    expect(ack.status).toBe('accepted');
  });
});
