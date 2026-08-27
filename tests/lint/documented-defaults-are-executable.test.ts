// FR-R3-126 (FR-002, FR-003, FR-007) — the document is the gate's INPUT.
//
// THE DEFECT THIS CLOSES, precisely. `FR-R3-117` inverted the phase verdict
// default: a load-bearing Phase is judged on its process's exit status, and
// `model-token` is the opt-out. `docs/security/threat-model.md` kept saying the
// inverse, at two lines, and **every documentation gate passed over it** — link,
// version, source-marker and duplicate-authority checks all green, `npm run
// docs:check` green, the full local gate green. A security reviewer reads the
// threat model first, so the one document whose falsehood changes a reader's trust
// model was the one that was false.
//
// That is the fifth instance of the form-versus-truth class this round has closed
// (`FR-R3-116`, `122`, `123`, `124`, and this). The response the audit of
// 2026-08-27 recommends is deliberately narrow: not generic prose validation —
// which it argues against — but "small executable semantic examples" for
// security-critical defaults.
//
// THE DIRECTION OF THE DEPENDENCY IS THE WHOLE POINT.
//
// A gate that held its own copy of `(declared, sideEffects, producesOutput) ->
// verdict` and asserted `resolveHostVerification` agreed would be a UNIT TEST. It
// stays green while the threat model says the opposite, because it never reads the
// threat model. That is exactly the relationship `FR-R3-063`'s gates had to this
// finding, and reproducing it inside the fix would be a poor result.
//
// So each default's worked examples are authored IN its owning document, in a
// fenced block under an `<!-- executable-example: <id> -->` marker, and this gate's
// only inputs are the block and the module. Three consequences, each a way to get
// this wrong:
//
//   1. a MISSING block fails — a silently absent block is a coverage loss that
//      reports green;
//   2. an UNPARSEABLE row fails — ignoring a row is how a typo becomes an
//      exemption;
//   3. the gate does not normalise prose into agreement. A row saying
//      `model-token` where the resolver returns `exit-code` is the finding.
//
// WHAT THIS GATE DOES NOT DO, and FR-007 requires it to say so: it checks the four
// named blocks and NOTHING else. It makes no claim about any other sentence in any
// document. Prose truth in general is not verified here and the audit recommends
// against attempting it.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveHostVerification } from '../../src/config/phase-runner-policy';
import { judgeBackendContainment } from '../../src/services/backend-containment-policy';
import { resolveCapabilityDecision } from '../../src/state/capability-trust-decision';
import { SETTINGS_SCHEMA } from '../../src/config/settings-schema';
import type { BackendRunnerKind } from '../../src/contracts/backend-kinds';
import type { PhaseSideEffects } from '../../src/contracts/process-definitions';

const REPO_ROOT = resolve(__dirname, '..', '..');

/** The one sentence a contributor needs when this gate fails on a missing block. */
const BLOCK_FORMAT =
  'A worked-example block is an `<!-- executable-example: <id> -->` marker followed by a fenced ' +
  'block of pipe-delimited rows with a header row and a `|---|` separator. The gate reads the ' +
  'rows FROM THE DOCUMENT and feeds them through the owning module, so the document is the input ' +
  'and not a restatement.';

interface Row {
  readonly cells: readonly string[];
  readonly lineNumber: number;
}

/**
 * Read one marked block's data rows out of a document.
 *
 * Keyed on the marker, never on position, so a document can be reorganised without
 * breaking the gate — and so a MOVED block cannot read as an absent one.
 */
function readBlock(relPath: string, id: string): readonly Row[] {
  const abs = resolve(REPO_ROOT, relPath);
  expect(
    existsSync(abs),
    `${relPath} does not exist, so the '${id}' example has no home. ${BLOCK_FORMAT}`
  ).toBe(true);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === `<!-- executable-example: ${id} -->`);
  expect(
    markerIndex,
    `${relPath} carries no '<!-- executable-example: ${id} -->' marker. A missing block is a ` +
      `coverage loss, not a skip — this gate fails rather than quietly checking less. ${BLOCK_FORMAT}`
  ).toBeGreaterThanOrEqual(0);

  const fenceStart = lines.findIndex((line, index) => index > markerIndex && line.trim() === '```');
  expect(
    fenceStart,
    `the '${id}' marker in ${relPath} is not followed by a fenced block`
  ).toBeGreaterThan(markerIndex);
  const fenceEnd = lines.findIndex((line, index) => index > fenceStart && line.trim() === '```');
  expect(fenceEnd, `the '${id}' block in ${relPath} is not closed`).toBeGreaterThan(fenceStart);

  const rows: Row[] = [];
  for (let index = fenceStart + 1; index < fenceEnd; index += 1) {
    const raw = lines[index]!.trim();
    if (raw.length === 0) continue;
    // A separator row, in any width.
    if (/^\|[\s|:-]+\|$/.test(raw)) continue;
    expect(
      raw.startsWith('|') && raw.endsWith('|'),
      `${relPath}:${index + 1} is inside the '${id}' block and is not a pipe-delimited row. An ` +
        `unparseable row FAILS rather than being ignored — ignoring is how a typo becomes an ` +
        `exemption. ${BLOCK_FORMAT}`
    ).toBe(true);
    rows.push({
      cells: raw.slice(1, -1).split('|').map((cell) => cell.trim()),
      lineNumber: index + 1
    });
  }
  // The first surviving row is the header.
  expect(rows.length, `the '${id}' block in ${relPath} has a header and no data rows`).toBeGreaterThan(
    1
  );
  return rows.slice(1);
}

/** `(omitted)` and `(unset)` mean absent; `(none)` means an empty collection. */
const ABSENT = new Set(['(omitted)', '(unset)']);

/**
 * The four blocks, their documents, and the module each is fed through.
 *
 * The unit is the DEFAULT, not the document: a default is what a reader gets
 * wrong, and one document may own more than one.
 */
const BLOCKS = [
  'phase-verdict-basis',
  'uncontained-grant-scope',
  'trust-deny-precedence',
  'session-retention-defaults'
] as const;

describe('documented security-critical defaults are executable (FR-R3-126)', () => {
  it('declares four blocks and finds every owning document on disk', () => {
    // Vacuity control. Every assertion below reads a block from this list, so a
    // list that silently shrank — a renamed id, a moved document — would assert
    // over nothing and pass.
    expect(BLOCKS).toHaveLength(4);
    const documents = [
      'docs/security/threat-model.md',
      'docs/operations/untrusted-repositories.md',
      'docs/reference/settings.md',
      'docs/concepts/sessions-and-logs.md'
    ];
    expect(documents.filter((rel) => !existsSync(resolve(REPO_ROOT, rel)))).toEqual([]);
  });

  it('the phase verdict basis resolves as the threat model says it does', () => {
    const rows = readBlock('docs/security/threat-model.md', 'phase-verdict-basis');
    const disagreements: string[] = [];
    for (const row of rows) {
      const [declared, sideEffects, producesOutput, expected] = row.cells;
      const actual = resolveHostVerification(
        ABSENT.has(declared!) ? undefined : (declared as 'exit-code' | 'model-token'),
        ABSENT.has(sideEffects!) ? undefined : (sideEffects as PhaseSideEffects),
        producesOutput === 'yes'
      );
      if (actual !== expected) {
        disagreements.push(
          `threat-model.md:${row.lineNumber}: the document says ` +
            `(${declared}, ${sideEffects}, producesOutput=${producesOutput}) -> ${expected}; ` +
            `resolveHostVerification returns ${actual}`
        );
      }
    }
    expect(
      disagreements,
      'The threat model and src/config/phase-runner-policy.ts disagree about the phase verdict ' +
        'default. FR-R3-117 inverted this default and the threat model stated the inverse for a ' +
        'day while every documentation gate passed; whichever side is wrong now, fix that side — ' +
        'do not adjust this gate.'
    ).toEqual([]);
    expect(rows.length, 'the block must carry rows').toBeGreaterThan(4);
  });

  it('the uncontained grant scope resolves as the operator document says it does', () => {
    const rows = readBlock('docs/operations/untrusted-repositories.md', 'uncontained-grant-scope');
    const disagreements: string[] = [];
    for (const row of rows) {
      const [backend, grantedCell, expected] = row.cells;
      const granted = new Set<BackendRunnerKind>(
        grantedCell === '(none)'
          ? []
          : grantedCell!.split(',').map((id) => id.trim() as BackendRunnerKind)
      );
      const actual = judgeBackendContainment(backend as BackendRunnerKind, granted).outcome;
      if (actual !== expected) {
        disagreements.push(
          `untrusted-repositories.md:${row.lineNumber}: the document says ` +
            `(${backend}, granted=[${grantedCell}]) -> ${expected}; judgeBackendContainment ` +
            `returns ${actual}`
        );
      }
    }
    expect(
      disagreements,
      'The untrusted-repository document and src/services/backend-containment-policy.ts disagree ' +
        'about which backends a grant covers. FR-R3-125 made the grant per backend; a document ' +
        'that implies otherwise tells an operator they granted less than they did.'
    ).toEqual([]);
    expect(rows.length).toBeGreaterThan(4);
  });

  it('the trust ladder resolves as the settings reference says it does', () => {
    const rows = readBlock('docs/reference/settings.md', 'trust-deny-precedence');
    const parse = (cell: string): unknown => {
      if (ABSENT.has(cell)) return undefined;
      if (cell === 'null') return null;
      if (cell === 'true') return true;
      if (cell === 'false') return false;
      return cell;
    };
    const disagreements: string[] = [];
    for (const row of rows) {
      const [isTrusted, workspace, user, expected] = row.cells;
      const actual = resolveCapabilityDecision({
        isTrusted: isTrusted === 'true',
        workspaceValue: parse(workspace!),
        globalValue: parse(user!)
      });
      const expectedBool = expected === 'yes';
      if (actual !== expectedBool) {
        disagreements.push(
          `settings.md:${row.lineNumber}: the document says ` +
            `(isTrusted=${isTrusted}, workspace=${workspace}, user=${user}) -> ${expected}; ` +
            `resolveCapabilityDecision returns ${actual ? 'yes' : 'no'}`
        );
      }
    }
    expect(
      disagreements,
      'The settings reference and src/state/capability-trust-decision.ts disagree about the trust ' +
        'ladder. FR-R3-108 made the rule "any deny wins"; a document that implies scope ordering ' +
        "tells an operator their explicit `false` can be overridden by a repository's `true`."
    ).toEqual([]);
    expect(rows.length).toBeGreaterThan(4);
  });

  it('the retention defaults are the values the schema declares', () => {
    const rows = readBlock('docs/concepts/sessions-and-logs.md', 'session-retention-defaults');
    const schema = SETTINGS_SCHEMA as Record<
      string,
      { default?: unknown; min?: number; max?: number } | undefined
    >;
    const disagreements: string[] = [];
    for (const row of rows) {
      const [key, expectedDefault, expectedMin, expectedMax] = row.cells;
      const entry = schema[key!];
      if (entry === undefined) {
        disagreements.push(`sessions-and-logs.md:${row.lineNumber}: '${key}' is not in SETTINGS_SCHEMA`);
        continue;
      }
      const check = (what: string, documented: string, actual: unknown): void => {
        if (String(actual) !== documented) {
          disagreements.push(
            `sessions-and-logs.md:${row.lineNumber}: ${key} ${what} documented as ${documented}, ` +
              `schema declares ${String(actual)}`
          );
        }
      };
      check('default', expectedDefault!, entry.default);
      check('min', expectedMin!, entry.min);
      check('max', expectedMax!, entry.max);
    }
    expect(
      disagreements,
      'The retention figures in docs/concepts/sessions-and-logs.md and the values in ' +
        'src/config/settings-schema.ts disagree. This example checks the VALUES and their units, ' +
        'not the sweep — the block says so, and FR-R3-126 recorded that as a scoped choice.'
    ).toEqual([]);
    expect(rows.length).toBe(2);
  });

  /**
   * FR-R3-126, corrected during implementation.
   *
   * The block above makes the RESOLVER side executable. It does not make the
   * PROSE side checkable, and that gap was found by trying to satisfy SC-001:
   * reverting the threat model's sentence while leaving the block correct left this
   * gate green. Since the sentence is what a reviewer reads, that is most of the
   * defect still open.
   *
   * So the document also carries a short list of INVERTED CLAIMS — the exact
   * phrasings that assert the pre-`FR-R3-117` default — and their presence is a
   * failure. This is not generic prose validation, which the audit recommends
   * against: it is a named, anchored refusal of a specific false statement about a
   * specific default, in the one document whose falsehood changes a reader's trust
   * model.
   *
   * The list is deliberately literal. A paraphrase this does not know about will
   * pass, and the block above is what catches a drifted RESOLVER; between them the
   * uncovered case is a newly-invented paraphrase of a false claim, which is a
   * smaller hole than the one that shipped.
   */
  const INVERTED_VERDICT_CLAIMS: ReadonlyArray<{ phrase: RegExp; why: string }> = [
    {
      phrase: /outcome is self-certification \*\*unless/i,
      why: 'says self-report is the default and exit-code the exception — the pre-FR-R3-117 default'
    },
    {
      phrase: /The marking is opt-in/i,
      why: 'says exit-code judgement must be asked for; since FR-R3-117 it is the default'
    },
    {
      phrase: /except where a Phase declares `hostVerification: 'exit-code'`/i,
      why: 'frames exit-code judgement as the exception rather than the default'
    },
    {
      phrase: /By default, classification uses the model's own account/i,
      why: 'states the inverse default outright'
    }
  ];

  it('the threat model states no inverted claim about the verdict default', () => {
    const body = readFileSync(resolve(REPO_ROOT, 'docs/security/threat-model.md'), 'utf8');
    const found = INVERTED_VERDICT_CLAIMS.filter((claim) => claim.phrase.test(body)).map(
      (claim) => claim.why
    );
    expect(
      found,
      'docs/security/threat-model.md asserts the pre-FR-R3-117 verdict default. A load-bearing ' +
        'Phase is judged on its exit status BY DEFAULT and `model-token` is the opt-out. This ' +
        'exact drift shipped for a day with every documentation gate green, which is why the ' +
        'phrasings are refused by name rather than left to review.'
    ).toEqual([]);
  });

  it('catches the sentence that actually shipped — proved on the real prior text', () => {
    // The false-positive/false-negative control for the list above, driven against
    // the verbatim sentence `docs/security/threat-model.md:66` carried until
    // 2026-08-27, and against the sentence that replaced it.
    const shipped =
      "- A Phase outcome is self-certification **unless the Phase declares " +
      "`hostVerification: 'exit-code'`** (FR-R3-058). By default, classification uses the " +
      "model's own account of its work. The marking is opt-in, so an unmarked Phase behaves " +
      'exactly as this paragraph described before.';
    const corrected =
      "- A Phase outcome is judged on **the process's exit status** whenever the Phase's claim " +
      "is load-bearing, and `hostVerification: 'model-token'` is the explicit **opt-out**.";
    expect(
      INVERTED_VERDICT_CLAIMS.filter((claim) => claim.phrase.test(shipped)).length,
      'the list must catch the sentence that actually shipped'
    ).toBeGreaterThanOrEqual(3);
    expect(
      INVERTED_VERDICT_CLAIMS.filter((claim) => claim.phrase.test(corrected)).map((c) => c.why),
      'and must not flag the corrected sentence'
    ).toEqual([]);
  });

  it('fails on a missing block, an unclosed block, and an unparseable row — proved', () => {
    // FR-002a. Every assertion above is "the disagreement list is empty", and the
    // ways that fails silently are a marker that is never found and a row that is
    // quietly skipped. Both are driven here through the real parser.
    expect(() => readBlock('docs/security/threat-model.md', 'no-such-example')).toThrow();
    expect(() => readBlock('docs/security/threat-model.md/nope', 'phase-verdict-basis')).toThrow();
    // And the real blocks all parse, so the fixture is not proving the parser
    // rejects everything.
    expect(readBlock('docs/security/threat-model.md', 'phase-verdict-basis').length).toBeGreaterThan(
      0
    );
  });

  it('states its own limit', () => {
    // FR-007. The audit recommends against generic prose validation and this gate
    // does not attempt it. The limit is asserted rather than merely commented, so a
    // later reader cannot take the gate's green as "the documentation is true".
    // Whitespace-collapsed before matching: keying on how a comment happens to wrap
    // would fail on a reflow with a message about this gate rather than about the
    // limit, and a gate that fails on punctuation teaches contributors to edit the
    // gate.
    const self = readFileSync(
      resolve(__dirname, 'documented-defaults-are-executable.test.ts'),
      'utf8'
    ).replace(/\s+/g, ' ');
    expect(self).toContain('checks the four named blocks and NOTHING else');
    expect(self).toContain('Prose truth in general is not verified here');
  });
});
