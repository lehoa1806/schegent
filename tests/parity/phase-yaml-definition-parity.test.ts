// Feature 254 (FR-R4-F07, H-T4; contract H5; FR-034, US6 AS4) — the two Phase validators, held together.
//
// A Phase is judged twice. The exchange reader (`validatePhaseDocument`, `phase-yaml-validator.ts`) judges
// the document an operator imports; the definition validator (`validatePhaseDefinition`,
// `process-definition-validator.ts`) judges the definition the catalog stores. They share their bounds and
// their enums, and they were written to agree, but they are two bodies of code and nothing held them
// together: a value one admitted and the other refused would import clean and fail at the commit, or the
// reverse (the failure feature 098 and FR-R3-157 each describe in a comment).
//
// This file feeds both of them the boundary values of the fields they both check, and compares the SET OF
// `(field, code)` PAIRS each returns. Messages are not compared (the two words differ on purpose in places,
// and a message is not a contract); order is not compared. A pair present on one side only is a divergence,
// and a divergence is either FIXED (the shared leaf is extracted into the validator that owns it) or LISTED
// in `INTENTIONAL_DIFFERENCES` with its reason. Nothing else is allowed (H5).
//
// How the two sides are fed. The YAML reader is given a mapping node built here, not text: this is a test
// of the two validators, not of the scanner, and the scanner has its own suites. A node is the shape the
// parser hands the reader. The definition validator is given the plain object the same value would be in a
// stored definition, called the way every call site in the product calls it
// (`{ allowLegacyId: true, defaultVersion: 1 }`, as tests/parity/process-definition-parity.test.ts records).
// A value that is text in a document and a number in a definition is expressed once, by a constructor
// below, so that a case reads as one value and not as two.
//
// What is not compared, and why it is not a gap:
//   * the Workflow and Pipeline readers: they delegate to the definition validators
//     (`pipeline-document.ts`, `workflow-document.ts`), so there is no second body of code to hold;
//   * a field's NAME on the two sides: the reader's paths and the validator's agree for every field here
//     (`phaseId`, `directive`, ...), and a path that stopped agreeing would be a pair on one side only.

import { describe, expect, it } from 'vitest';

import { SUPPORTED_BACKENDS } from '../../src/contracts/backend-kinds';
import { ALL_PHASE_CAPABILITIES } from '../../src/contracts/phase-capabilities';
import {
  PHASE_EFFORT_LEVELS,
  PHASE_EVIDENCE_POLICIES,
  PHASE_HOST_VERIFICATIONS,
  PHASE_RETRY_CONDITION_MAX_LEN,
  PHASE_SIDE_EFFECTS,
  RETRY_CAP_OUTCOMES
} from '../../src/contracts/process-definitions';
import {
  ARGV_VALUE_MAX_LEN,
  PHASE_DESCRIPTION_MAX_LEN,
  PHASE_ID_MAX_LEN,
  PHASE_INSTRUCTION_MAX_LEN,
  PHASE_NAME_MAX_LEN,
  PHASE_SKILL_MAX_LEN,
  PHASE_SPEND_TOKENS_MAX,
  PHASE_SPEND_USD_MAX,
  PHASE_TIMEOUT_MAX,
  validatePhaseDefinition
} from '../../src/config/process-definition-validator';
import { validatePhaseDocument } from '../../src/services/process-yaml/phase-yaml-validator';
import {
  PHASE_YAML_API_VERSION,
  PHASE_YAML_KIND,
  type YamlMappingEntry,
  type YamlMappingNode,
  type YamlNode,
  type YamlScalarNode
} from '../../src/services/process-yaml/types';
import { CAPABILITY_SEPARATOR } from '../../src/services/process-yaml/yaml-serializer';

// ---------------------------------------------------------------------------
// The differences that are intended
// ---------------------------------------------------------------------------

/** One known, intended difference between the two validators, with the reason it is intended. */
export interface IntentionalDifference {
  /** The probe it applies to, as `"<field>: <label>"`. */
  readonly probe: string;
  readonly reason: string;
}

/**
 * Every probe on which the two validators are allowed to give different answers.
 *
 * Each entry is asserted to STILL differ: an entry that no longer diverges is a stale reason, and it
 * fails the file. The list is the fixture's whole claim about where the two bodies of code are not the
 * same, so an entry is added only with the reason an author reading it would accept.
 */
export const INTENTIONAL_DIFFERENCES: readonly IntentionalDifference[] = [
  {
    probe: 'retryCondition: an expression that does not parse',
    reason:
      'retryCondition is inert text during exchange (FR-035, hard rule 43): the reader checks its length ' +
      'and that it is not blank and never parses it, where the definition validator parses it and says ' +
      'invalid-expression. A document must not be refused on the strength of a DSL the format does not run.'
  }
];

// ---------------------------------------------------------------------------
// The two sides
// ---------------------------------------------------------------------------

type Section = 'metadata' | 'spec';

/** A value as the definition holds it, and as the document spells it. */
interface Probe {
  readonly definition: unknown;
  readonly text: string;
  readonly quoted: boolean;
}

const text = (value: string): Probe => ({ definition: value, text: value, quoted: false });
/** A number: bare in a document, a number in a definition. */
const num = (value: number): Probe => ({ definition: value, text: String(value), quoted: false });
/** A number the author wrote in quotes: text in a document, and a string in a definition. */
const quotedNum = (value: number): Probe => ({
  definition: String(value),
  text: String(value),
  quoted: true
});
const bool = (value: boolean): Probe => ({ definition: value, text: String(value), quoted: false });
/** A capability list: an array in a definition, one joined scalar in a document. */
const caps = (members: readonly string[]): Probe => ({
  definition: [...members],
  text: members.join(CAPABILITY_SEPARATOR),
  quoted: false
});

interface Case {
  /** The field under test; the covered-field guard reads it. */
  readonly field: string;
  readonly label: string;
  readonly section: Section;
  readonly key: string;
  readonly probe: Probe;
  /** Keys of the base Phase to drop, for cases that replace the directive. */
  readonly drop?: readonly string[];
  /** Extra keys to add beside the probed one, as `[section, key, probe]`. */
  readonly with?: readonly (readonly [Section, string, Probe])[];
}

const BASE: Readonly<Record<Section, Readonly<Record<string, Probe>>>> = {
  metadata: { phaseId: text('my-phase'), name: text('My Phase'), version: num(1) },
  spec: { instruction: text('Do the work.') }
};

function scalarNode(probe: Probe): YamlScalarNode {
  return { kind: 'scalar', value: probe.text, quoted: probe.quoted, line: 1 };
}

function mappingOf(entries: readonly YamlMappingEntry[]): YamlMappingNode {
  return { kind: 'mapping', entries, line: 1 };
}

function entryOf(key: string, node: YamlNode): YamlMappingEntry {
  return { key, value: node, line: 1 };
}

/** The merged key/probe pairs of one section: the base, minus what is dropped, plus the case's own. */
function sectionOf(subject: Case, section: Section): readonly (readonly [string, Probe])[] {
  const kept = Object.entries(BASE[section]).filter(
    ([key]) => !(subject.drop ?? []).includes(key) && !(subject.section === section && key === subject.key)
  );
  const extra = (subject.with ?? [])
    .filter(([where]) => where === section)
    .map(([, key, probe]) => [key, probe] as const);
  const own = subject.section === section ? [[subject.key, subject.probe] as const] : [];
  return [...kept, ...extra, ...own];
}

/** The `(field|code)` pairs the exchange reader returns, sorted. */
function yamlPairs(subject: Case): readonly string[] {
  const section = (name: Section): YamlMappingNode =>
    mappingOf(sectionOf(subject, name).map(([key, probe]) => entryOf(key, scalarNode(probe))));
  const document = mappingOf([
    entryOf('apiVersion', scalarNode(text(PHASE_YAML_API_VERSION))),
    entryOf('kind', scalarNode(text(PHASE_YAML_KIND))),
    entryOf('metadata', section('metadata')),
    entryOf('spec', section('spec'))
  ]);
  const result = validatePhaseDocument(document);
  if (result.ok) return [];
  if (result.kind === 'document') {
    throw new Error(`the harness built a document the reader refused as a whole: ${result.refusal.code}`);
  }
  return [...new Set(result.defects.map((entry) => `${entry.field}|${entry.code}`))].sort();
}

/** The `(field|code)` pairs the definition validator returns for the same Phase, sorted. */
function definitionPairs(subject: Case): readonly string[] {
  const raw: Record<string, unknown> = {};
  for (const name of ['metadata', 'spec'] as const) {
    for (const [key, probe] of sectionOf(subject, name)) raw[key] = probe.definition;
  }
  const result = validatePhaseDefinition(raw, { allowLegacyId: true, defaultVersion: 1 });
  return [...new Set(result.errors.map((entry) => `${entry.field}|${entry.code}`))].sort();
}

// ---------------------------------------------------------------------------
// The probes: boundary values of every field both validators check
// ---------------------------------------------------------------------------

const meta = (field: string, label: string, probe: Probe): Case => ({
  field,
  label,
  section: 'metadata',
  key: field,
  probe
});
const spec = (field: string, label: string, probe: Probe, rest: Partial<Case> = {}): Case => ({
  field,
  label,
  section: 'spec',
  key: field,
  probe,
  ...rest
});

/** The base Phase's directive is an instruction; a skill case swaps it. */
const SKILL_ONLY = { drop: ['instruction'] } as const;

const RETRY_AT_BOUND = `a > 0 or ${'b'.repeat(PHASE_RETRY_CONDITION_MAX_LEN - 13)} > 0`;
const RETRY_OVER_BOUND = `a > 0 or ${'b'.repeat(PHASE_RETRY_CONDITION_MAX_LEN - 12)} > 0`;

const ENUM_FIELDS: readonly (readonly [string, readonly string[]])[] = [
  ['runner', SUPPORTED_BACKENDS],
  ['sideEffects', PHASE_SIDE_EFFECTS],
  ['evidencePolicy', PHASE_EVIDENCE_POLICIES],
  ['hostVerification', PHASE_HOST_VERIFICATIONS],
  ['effort', PHASE_EFFORT_LEVELS],
  ['onRetryCap', RETRY_CAP_OUTCOMES]
];

const ENUM_CASES: readonly Case[] = ENUM_FIELDS.flatMap(([field, legal]) => [
  ...legal.map((member) => spec(field, `legal member ${member}`, text(member))),
  spec(field, 'unknown member', text('bogus')),
  spec(field, 'empty', text('')),
  spec(field, 'wrong case', text(legal.at(0)?.toUpperCase() ?? 'X'))
]);

const CASES: readonly Case[] = [
  // The base Phase, so a harness that refuses everything cannot pass.
  spec('instruction', 'the base instruction', text('Do the work.')),

  meta('phaseId', 'one letter', text('a')),
  meta('phaseId', 'at the length bound', text(`a${'b'.repeat(PHASE_ID_MAX_LEN - 1)}`)),
  meta('phaseId', 'over the length bound', text(`a${'b'.repeat(PHASE_ID_MAX_LEN)}`)),
  meta('phaseId', 'uppercase', text('My-Phase')),
  meta('phaseId', 'leading digit', text('1phase')),
  meta('phaseId', 'underscore', text('my_phase')),
  meta('phaseId', 'empty', text('')),
  meta('phaseId', 'padded with spaces', text('  my-phase  ')),

  meta('name', 'one character', text('N')),
  meta('name', 'at the length bound', text('n'.repeat(PHASE_NAME_MAX_LEN))),
  meta('name', 'over the length bound', text('n'.repeat(PHASE_NAME_MAX_LEN + 1))),
  meta('name', 'empty', text('')),
  meta('name', 'only spaces', text('   ')),
  meta('name', 'padded to the bound', text(` ${'n'.repeat(PHASE_NAME_MAX_LEN)} `)),

  meta('version', 'one', num(1)),
  meta('version', 'zero', num(0)),
  meta('version', 'negative', num(-1)),
  meta('version', 'a fraction', text('1.5')),
  meta('version', 'quoted', quotedNum(1)),
  meta('version', 'not a number', text('one')),

  meta('description', 'empty', text('')),
  meta('description', 'at the length bound', text('d'.repeat(PHASE_DESCRIPTION_MAX_LEN))),
  meta('description', 'over the length bound', text('d'.repeat(PHASE_DESCRIPTION_MAX_LEN + 1))),

  spec('instruction', 'at the length bound', text('i'.repeat(PHASE_INSTRUCTION_MAX_LEN))),
  spec('instruction', 'over the length bound', text('i'.repeat(PHASE_INSTRUCTION_MAX_LEN + 1))),
  spec('instruction', 'empty (no skill)', text('')),
  spec('instruction', 'only spaces (no skill)', text('   ')),
  spec('instruction', 'beside a skill', text('Do the work.'), {
    with: [['spec', 'skill', text('speckit-plan')]]
  }),

  spec('skill', 'a name', text('speckit-plan'), SKILL_ONLY),
  spec('skill', 'at the length bound', text('s'.repeat(PHASE_SKILL_MAX_LEN)), SKILL_ONLY),
  spec('skill', 'over the length bound', text('s'.repeat(PHASE_SKILL_MAX_LEN + 1)), SKILL_ONLY),
  spec('skill', 'empty (no instruction)', text(''), SKILL_ONLY),
  spec('skill', 'only spaces (no instruction)', text('   '), SKILL_ONLY),
  spec('skill', 'empty beside an instruction', text('')),

  ...ENUM_CASES,

  spec('effort', 'xhigh on the agy runner', text('xhigh'), { with: [['spec', 'runner', text('agy')]] }),
  spec('effort', 'max on the agy runner', text('max'), { with: [['spec', 'runner', text('agy')]] }),
  spec('effort', 'high on the agy runner', text('high'), { with: [['spec', 'runner', text('agy')]] }),
  spec('effort', 'max on the claude runner', text('max'), { with: [['spec', 'runner', text('claude')]] }),

  spec('capabilities', 'the empty set', caps([])),
  spec('capabilities', 'every capability', caps(ALL_PHASE_CAPABILITIES)),
  ...ALL_PHASE_CAPABILITIES.map((member) => spec('capabilities', `only ${member}`, caps([member]))),
  spec('capabilities', 'an unknown member', caps(['workspace-write', 'launch-missiles'])),
  spec('capabilities', 'a repeated member', caps(['network', 'network'])),
  spec('capabilities', 'a member with a space', caps(['workspace-write', ' network'])),
  spec('capabilities', 'one more than the vocabulary holds', caps([...ALL_PHASE_CAPABILITIES, 'network'])),
  spec('capabilities', 'one more, all unknown', caps(['a', 'b', 'c', 'd', 'e'])),

  spec('timeoutSeconds', 'the minimum', num(1)),
  spec('timeoutSeconds', 'the maximum', num(PHASE_TIMEOUT_MAX)),
  spec('timeoutSeconds', 'zero', num(0)),
  spec('timeoutSeconds', 'over the maximum', num(PHASE_TIMEOUT_MAX + 1)),
  spec('timeoutSeconds', 'negative', num(-1)),
  spec('timeoutSeconds', 'a fraction', text('1.5')),
  spec('timeoutSeconds', 'quoted', quotedNum(10)),
  spec('timeoutSeconds', 'not a number', text('ten')),

  spec('spendBoundUsd', 'the minimum', num(0.01)),
  spec('spendBoundUsd', 'the maximum', num(PHASE_SPEND_USD_MAX)),
  spec('spendBoundUsd', 'under the minimum', num(0.009)),
  spec('spendBoundUsd', 'over the maximum', num(PHASE_SPEND_USD_MAX + 0.01)),
  spec('spendBoundUsd', 'zero', num(0)),
  spec('spendBoundUsd', 'negative', num(-1)),
  spec('spendBoundUsd', 'quoted', quotedNum(5)),
  spec('spendBoundUsd', 'not a number', text('five')),

  spec('spendBoundTokens', 'the minimum', num(1)),
  spec('spendBoundTokens', 'the maximum', num(PHASE_SPEND_TOKENS_MAX)),
  spec('spendBoundTokens', 'zero', num(0)),
  spec('spendBoundTokens', 'over the maximum', num(PHASE_SPEND_TOKENS_MAX + 1)),
  spec('spendBoundTokens', 'a fraction', text('1.5')),
  spec('spendBoundTokens', 'quoted', quotedNum(1000)),

  spec('retryCondition', 'a short expression', text('a > 0')),
  spec('retryCondition', 'at the length bound', text(RETRY_AT_BOUND)),
  spec('retryCondition', 'over the length bound', text(RETRY_OVER_BOUND)),
  spec('retryCondition', 'empty', text('')),
  spec('retryCondition', 'only spaces', text('   ')),
  // The one place the reader is meant to say less: the expression is inert text in a document
  // (hard rule 43), so it is never parsed on import, and the definition validator parses it.
  spec('retryCondition', 'an expression that does not parse', text('a >')),

  spec('model', 'a model name', text('sonnet')),
  spec('model', 'empty', text('')),
  spec('model', 'only spaces', text('   ')),
  spec('model', 'at the argv length bound', text('m'.repeat(ARGV_VALUE_MAX_LEN))),
  spec('model', 'over the argv length bound', text('m'.repeat(ARGV_VALUE_MAX_LEN + 1))),
  spec('model', 'a leading dash (a flag)', text('--dangerously-skip-permissions')),
  spec('model', 'a space inside', text('two words')),

  spec('loopable', 'true', bool(true)),
  spec('loopable', 'not a boolean', text('yes')),
  spec('isRequired', 'false', bool(false)),
  spec('isRequired', 'not a boolean', text('yes')),
  spec('forceContinueOnRetryCap', 'true', bool(true)),
  spec('forceContinueOnRetryCap', 'not a boolean', text('yes'))
];

const key = (subject: Case): string => `${subject.field}: ${subject.label}`;

/** The fields the differential is required to reach: every field the research names, plus the extras. */
const COVERED_FIELDS: readonly string[] = [
  'phaseId',
  'name',
  'description',
  'instruction',
  'skill',
  'runner',
  'sideEffects',
  'evidencePolicy',
  'hostVerification',
  'capabilities',
  'effort',
  'timeoutSeconds',
  'spendBoundUsd',
  'spendBoundTokens',
  'retryCondition',
  'onRetryCap',
  'version',
  'model',
  'loopable',
  'isRequired',
  'forceContinueOnRetryCap'
];

const intentional = (subject: Case): boolean =>
  INTENTIONAL_DIFFERENCES.some((entry) => entry.probe === key(subject));

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

describe('FR-R4-F07 H-T4 — the two Phase validators agree (FR-034)', () => {
  it('reaches every field both validators check, with a boundary on each side where one exists', () => {
    const reached = new Set(CASES.map((subject) => subject.field));
    expect([...reached].sort()).toEqual([...COVERED_FIELDS].sort());
    expect(CASES.length).toBeGreaterThan(100);
  });

  it('has unique probe names (the intentional list addresses a probe by name)', () => {
    const names = CASES.map(key);
    expect(new Set(names).size).toBe(names.length);
  });

  it('lists only probes that exist', () => {
    const names = new Set(CASES.map(key));
    for (const entry of INTENTIONAL_DIFFERENCES) {
      expect(names.has(entry.probe), `no probe is named "${entry.probe}"`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  it('control: the base Phase is accepted by both, and a bad value is refused by both', () => {
    const base = spec('instruction', 'the base instruction', text('Do the work.'));
    expect(yamlPairs(base)).toEqual([]);
    expect(definitionPairs(base)).toEqual([]);

    const bad = spec('runner', 'unknown member', text('bogus'));
    expect(yamlPairs(bad)).toEqual(['runner|invalid-enum']);
    expect(definitionPairs(bad)).toEqual(['runner|invalid-enum']);
  });

  describe.each(CASES.map((subject) => [key(subject), subject] as const))('%s', (_name, subject) => {
    it(
      intentional(subject)
        ? 'differs, and the difference is listed (a stale entry fails here)'
        : 'gives the same (field, code) pairs on both sides',
      () => {
        const fromDocument = yamlPairs(subject);
        const fromDefinition = definitionPairs(subject);
        if (intentional(subject)) {
          expect(fromDocument).not.toEqual(fromDefinition);
          return;
        }
        expect({ document: fromDocument }).toEqual({ document: fromDefinition });
      }
    );
  });
});
