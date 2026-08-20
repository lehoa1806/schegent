// Feature 100 (FR-R3-016) T511a — `retryCondition` stays inert on the lifecycle
// path, and the capability gate keys on its presence rather than its contents
// (FR-045, FR-046).
//
// Two rules that look like one and are not, which is why they are pinned together.
//
// **Inert on the lifecycle path.** A `retryCondition` is a DSL expression, and the
// DSL has a parser. Nothing at import, publish, or restore calls it: the import
// carries the text through verbatim (099 FR-012), the store holds bodies without
// validating them (099 FR-010), and a restore copies a body the store already has.
// The expression is parsed exactly twice — by the resolver, when the published
// definition is read back into the effective catalog, and by the runner, when a
// phase decides whether to retry. That is the whole point of the lifecycle: a
// broken expression is the operator's draft to fix, surfaced as an invalid row
// after publication, not an import that refuses a file.
//
// **The gate keys on presence.** `retryConditions` is a trust capability, so
// something must decide whether a body "declares" one. The tempting answer is "it
// declares one if it has a valid expression", and that answer is wrong twice over:
// a body carrying `retryCondition: null` is an operator *clearing* a condition an
// untrusted workspace was never allowed to set, and a body carrying an unparseable
// string is an operator part-way through typing one. Both must be gated. A gate
// that consulted the parser would wave both through.
//
// The two rules pull against each other in the obvious way — one says "never parse
// it", the other says "decide something about it" — and the resolution is that the
// only thing decided is whether the key is there. The cross-checks below assert
// exactly that: every value the gate treats as a declaration is fed to the real
// parser, and the parser rejects it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { declaresRetryCondition } from '../../src/ui/sidebar/commands/cmd-catalog-lifecycle';
import { validate as parseRetryCondition } from '../../src/lib/retry-condition';
import { parseDocumentText } from '../../src/services/process-yaml/yaml-parser';
import { validatePhaseDocument } from '../../src/services/process-yaml/phase-yaml-validator';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('T511a — the retryConditions gate keys on presence, never on contents (FR-046)', () => {
  /**
   * Every one of these is a declaration. None of them is a valid expression, and
   * the second assertion in each case is what makes the first one mean something.
   */
  const DECLARATIONS: readonly (readonly [string, unknown])[] = [
    ['a valid expression', 'open_questions > 0'],
    ['an unparseable expression', 'open_questions >>> ((('],
    ['the empty string', ''],
    ['whitespace', '   '],
    ['null — the operator clearing the field', null],
    ['undefined — the key present with no value', undefined],
    ['a number', 42],
    ['an object', { gt: 0 }],
    ['an array', ['open_questions > 0']]
  ];

  for (const [label, value] of DECLARATIONS) {
    it(`treats ${label} as a declaration`, () => {
      expect(declaresRetryCondition({ retryCondition: value })).toBe(true);
    });
  }

  it('every non-expression declaration above is one the parser rejects', () => {
    // The cross-check. If the gate ever started consulting the parser, each of
    // these bodies would stop being gated, and the workspace that may not author
    // retry conditions could author these.
    const rejected = DECLARATIONS.filter(([, value]) => value !== 'open_questions > 0').filter(
      ([, value]) => !(typeof value === 'string' && parseRetryCondition(value).ok)
    );
    expect(rejected).toHaveLength(DECLARATIONS.length - 1);
  });

  it('the one valid expression really does parse (so the set above is not all noise)', () => {
    expect(parseRetryCondition('open_questions > 0').ok).toBe(true);
  });

  const NON_DECLARATIONS: readonly (readonly [string, unknown])[] = [
    ['a body without the key', { instruction: 'Do the thing.' }],
    ['an empty body', {}],
    ['the plural key, which is the capability name and not the field', { retryConditions: 'x' }],
    ['a near-miss key', { retry_condition: 'open_questions > 0' }],
    ['null', null],
    ['a string', 'retryCondition'],
    ['an array of entries', [['retryCondition', 'open_questions > 0']]]
  ];

  for (const [label, body] of NON_DECLARATIONS) {
    it(`does not treat ${label} as a declaration`, () => {
      expect(declaresRetryCondition(body)).toBe(false);
    });
  }
});

describe('T511a — an imported retryCondition is carried verbatim (FR-045)', () => {
  const UNPARSEABLE = 'open_questions >>> (((';

  function phaseDocument(retryCondition: string): string {
    return [
      'apiVersion: schegent/v1',
      'kind: Phase',
      'metadata:',
      '  phaseId: half-typed',
      '  name: Half Typed',
      '  version: 1',
      'spec:',
      '  instruction: Do the thing.',
      `  retryCondition: ${retryCondition}`,
      ''
    ].join('\n');
  }

  function importedRetryCondition(source: string): string | undefined {
    const parsed = parseDocumentText(source);
    expect(parsed.ok, 'the document must parse as YAML').toBe(true);
    if (!parsed.ok) return undefined;
    const result = validatePhaseDocument(parsed.node);
    expect(result.ok, `import must accept the document: ${JSON.stringify(result)}`).toBe(true);
    if (!result.ok) return undefined;
    return result.document.spec.retryCondition;
  }

  it('accepts a document whose retryCondition the parser would reject', () => {
    // The load-bearing case. If the import ever grew a parse, this is the
    // assertion that fails, and it fails for the right reason: the operator's file
    // was refused for content the store is supposed to hold and the Builder is
    // supposed to show them as a defect after publication.
    expect(parseRetryCondition(UNPARSEABLE).ok).toBe(false);
    expect(importedRetryCondition(phaseDocument(UNPARSEABLE))).toBe(UNPARSEABLE);
  });

  it('carries a valid expression through unnormalized', () => {
    // Not rewritten, not canonicalized, not re-serialized from an AST. The
    // redundant parentheses and the doubled spaces survive, which is how an
    // operator's file stays their file.
    const authored = '(( open_questions  >  0 ))';
    expect(importedRetryCondition(phaseDocument(authored))).toBe(authored);
  });
});

describe('T511a — nothing on the import, publish, or restore path imports the DSL parser', () => {
  /**
   * The three paths T511a names, as the directories and modules that implement
   * them. `src/catalog/` is included even though its purity lint already forbids
   * `vscode`: purity is about the host boundary, and this is about the DSL.
   */
  const INERT_SCOPES: readonly string[] = [
    'src/services/process-yaml',
    'src/catalog',
    'src/ui/sidebar/commands/cmd-catalog-lifecycle.ts',
    'src/ui/sidebar/commands/catalog-lifecycle-commit.ts',
    'src/headless/process-yaml-api.ts'
  ];

  /**
   * Where the expression IS parsed, and the reason the scan above cannot pass by
   * finding nothing anywhere: the parser has real callers, and they are these.
   */
  const PARSE_SITES: readonly string[] = [
    'src/config/process-definition-validator.ts',
    'src/controller/phase.ts',
    'src/controller/phase-retry-evaluator.ts'
  ];

  const IMPORT_RE = /from\s+'[^']*lib\/retry-condition'/;

  function filesUnder(relative: string): readonly string[] {
    const abs = resolve(REPO_ROOT, relative);
    const out = execSync(`find "${abs}" -name '*.ts'`, { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => line.slice(REPO_ROOT.length + 1));
  }

  const INERT_FILES = INERT_SCOPES.flatMap((scope) => filesUnder(scope));

  it('finds the modules it claims to scan (an empty scan must not pass)', () => {
    expect(INERT_FILES.length).toBeGreaterThan(10);
    expect(INERT_FILES).toContain('src/ui/sidebar/commands/cmd-catalog-lifecycle.ts');
    expect(INERT_FILES).toContain('src/catalog/snapshot-rows.ts');
  });

  it('no module on those paths imports src/lib/retry-condition', () => {
    const offenders = INERT_FILES.filter((rel) =>
      IMPORT_RE.test(readFileSync(resolve(REPO_ROOT, rel), 'utf8'))
    );
    expect(
      offenders,
      `These modules import the retry-condition DSL parser but must carry the field as inert text (FR-045):\n${offenders.join('\n')}`
    ).toEqual([]);
  });

  for (const site of PARSE_SITES) {
    it(`${site} still imports the parser (the field is not inert everywhere)`, () => {
      expect(IMPORT_RE.test(readFileSync(resolve(REPO_ROOT, site), 'utf8'))).toBe(true);
    });
  }

  it('the parser has exactly the callers listed, across all of src/', () => {
    // The complement, so a fourth parse site cannot appear on a path this file
    // does not happen to scan.
    const importers = filesUnder('src').filter((rel) =>
      IMPORT_RE.test(readFileSync(resolve(REPO_ROOT, rel), 'utf8'))
    );
    expect([...importers].sort()).toEqual([...PARSE_SITES].sort());
  });
});
