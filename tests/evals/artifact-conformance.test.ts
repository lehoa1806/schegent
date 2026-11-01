/**
 * FR-R4-F12 (FR-015 to FR-018, FR-020; contract AE1 to AE4; SC-006, SC-008; tests-and-gates T10) -- an
 * offline, deterministic evaluation of Spec Kit artifact STRUCTURE against versioned criteria.
 *
 * WHAT THIS MEASURES. Twelve synthetic fixtures (one conforming and three malformed spec, plan and
 * tasks documents) are judged against `artifacts/criteria.json` by the pure evaluator in
 * `artifacts/evaluate-artifact.ts`. A conforming fixture passes; a malformed one fails with exactly
 * the criteria `fixtures/expected.json` lists; two runs agree.
 *
 * WHAT IT DOES NOT MEASURE. Quality (the rubric's, human-judged and unscored), and execution safety.
 * No result is an input to Phase advancement, a save gate or any autonomous action: nothing under
 * the host source tree reads the evaluator (FR-020, asserted below with a control).
 *
 * `readFileSync` is the only I/O in the suite. No network, credential or clock is touched (SC-008).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  evaluateArtifact,
  type ArtifactKind,
  type CriteriaFile,
  type EvaluationResult
} from './artifacts/evaluate-artifact';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ARTIFACTS_DIR = join(__dirname, 'artifacts');
const FIXTURES_DIR = join(ARTIFACTS_DIR, 'fixtures');
const SCOPE_SENTENCE = 'artifact structure, not execution safety';
const RUBRIC_SENTENCE = 'No automated check scores this rubric.';
const KINDS: readonly ArtifactKind[] = ['spec', 'plan', 'tasks'];

interface ExpectedEntry {
  readonly file: string;
  readonly violations: readonly string[];
}

const criteria = JSON.parse(readFileSync(join(ARTIFACTS_DIR, 'criteria.json'), 'utf8')) as CriteriaFile;
const rubricText = readFileSync(join(ARTIFACTS_DIR, 'rubric.md'), 'utf8');
const expected = JSON.parse(readFileSync(join(FIXTURES_DIR, 'expected.json'), 'utf8')) as ExpectedEntry[];

function rubricVersion(): number {
  const match = /^rubricVersion: (\d+)$/m.exec(rubricText);
  if (match === null) throw new Error('rubric.md has no "rubricVersion: N" line');
  return Number(match[1]);
}

function kindOf(file: string): ArtifactKind {
  const found = KINDS.find((kind) => file.startsWith(`${kind}/`));
  if (found === undefined) throw new Error(`fixture ${file} is not under spec/, plan/ or tasks/`);
  return found;
}

function evaluateFixture(file: string): EvaluationResult {
  const text = readFileSync(join(FIXTURES_DIR, file), 'utf8');
  return evaluateArtifact(kindOf(file), text, criteria, rubricVersion());
}

const CONFORMING = KINDS.map((kind) => `${kind}/conforming.md`);
const MALFORMED = expected.map((entry) => entry.file);

function evaluateAll(): Record<string, EvaluationResult> {
  const results: Record<string, EvaluationResult> = {};
  for (const file of [...CONFORMING, ...MALFORMED]) results[file] = evaluateFixture(file);
  return results;
}

describe('FR-015 -- the fixture set is one conforming and three malformed per artifact kind', () => {
  it('has 12 fixtures: 3 conforming and 9 malformed, 3 of each kind', () => {
    expect(CONFORMING).toHaveLength(3);
    expect(MALFORMED).toHaveLength(9);
    for (const kind of KINDS) {
      expect(MALFORMED.filter((file) => file.startsWith(`${kind}/`))).toHaveLength(3);
    }
    const onDisk = KINDS.flatMap((kind) => readdirSync(join(FIXTURES_DIR, kind)).map((name) => `${kind}/${name}`));
    expect(onDisk.sort()).toEqual([...CONFORMING, ...MALFORMED].sort());
  });
});

describe('FR-016 -- every conforming fixture passes, every malformed one fails with exactly its criteria', () => {
  it.each(CONFORMING)('%s passes', (file) => {
    const result = evaluateFixture(file);

    expect(result.failures, file).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it.each(expected)('$file fails with exactly $violations', (entry) => {
    const result = evaluateFixture(entry.file);

    expect(result.passed).toBe(false);
    expect([...new Set(result.failures.map((failure) => failure.criterion))].sort()).toEqual([...entry.violations].sort());
    for (const failure of result.failures) {
      expect(failure.message, `${entry.file}: the message must name its criterion`).toContain(failure.criterion);
    }
  });
});

describe('FR-018 -- results carry their versions and scope', () => {
  it('every result names criteria v1, rubric v1, the provenance id and the scope', () => {
    for (const [file, result] of Object.entries(evaluateAll())) {
      expect(result.criteriaVersion, file).toBe(1);
      expect(result.rubricVersion, file).toBe(1);
      expect(result.templateProvenance, file).toBe(criteria.templateProvenance.id);
      expect(result.scope, file).toBe(SCOPE_SENTENCE);
    }
    expect(criteria.criteriaVersion).toBe(1);
    expect(criteria.templateProvenance.specKitVersion).toBe('1.2.3');
  });

  it('the provenance names three template hashes, each a sha256 digest', () => {
    for (const kind of KINDS) {
      expect(criteria.templateProvenance.templates[kind]).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe('FR-017 -- results are deterministic', () => {
  it('two runs over the whole set are deep-equal', () => {
    expect(evaluateAll()).toEqual(evaluateAll());
  });

  it('the evaluator does not mutate the criteria it is handed', () => {
    const before = JSON.stringify(criteria);
    evaluateAll();
    expect(JSON.stringify(criteria)).toBe(before);
  });
});

describe('AE4 -- each criterion is live', () => {
  it('every criterion id in criteria.json is violated by at least one fixture', () => {
    const violated = new Set(Object.values(evaluateAll()).flatMap((result) => result.failures.map((failure) => failure.criterion)));

    const dead = criteria.criteria.map((criterion) => criterion.id).filter((id) => !violated.has(id));
    expect(dead, 'a criterion no fixture violates cannot be shown to fail').toEqual([]);
    expect(criteria.criteria).toHaveLength(13);
  });

  it('every violation expected.json names is an existing criterion', () => {
    const ids = new Set(criteria.criteria.map((criterion) => criterion.id));
    for (const entry of expected) {
      for (const violation of entry.violations) expect(ids.has(violation), `${entry.file}: ${violation}`).toBe(true);
    }
  });

  it('criterion ids are unique and each names the artifact kind it judges', () => {
    const ids = criteria.criteria.map((criterion) => criterion.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prefixes: Readonly<Record<ArtifactKind, string>> = { spec: 'SPEC-', plan: 'PLAN-', tasks: 'TASK-' };
    for (const criterion of criteria.criteria) {
      expect(criterion.id.startsWith(prefixes[criterion.artifact]), criterion.id).toBe(true);
    }
  });
});

describe('AE4 -- the rubric is never scored', () => {
  it('rubric.md states that no automated check scores it, and carries its version', () => {
    expect(rubricText).toContain(RUBRIC_SENTENCE);
    expect(rubricVersion()).toBe(1);
  });

  it('no result has a rubric score field', () => {
    for (const result of Object.values(evaluateAll())) {
      expect(Object.keys(result).sort()).toEqual(
        ['artifact', 'criteriaVersion', 'failures', 'passed', 'rubricVersion', 'scope', 'templateProvenance']
      );
      expect(Object.keys(result).some((key) => /score|rating|grade/i.test(key))).toBe(false);
    }
  });
});

describe('FR-020 -- nothing in the host source tree reads the evaluator', () => {
  const NEEDLES = ['tests/evals', 'evaluate-artifact'] as const;

  /** The files under `directory`, as paths, by a plain recursive walk. */
  function walk(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) found.push(...walk(path));
      else if (entry.isFile()) found.push(path);
    }
    return found;
  }

  function mentionsEvaluator(text: string): boolean {
    return NEEDLES.some((needle) => text.includes(needle));
  }

  it('no file under the host source root mentions the evals tree or the evaluator', () => {
    const files = walk(join(REPO_ROOT, 'src'));
    const mentioning = files.filter((file) => mentionsEvaluator(readFileSync(file, 'utf8')));

    expect(files.length).toBeGreaterThan(100);
    expect(mentioning.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([]);
  });

  it('control: the same search reports a planted line', () => {
    expect(mentionsEvaluator('import { evaluateArtifact } from "../../tests/evals/artifacts/evaluate-artifact";')).toBe(true);
    expect(mentionsEvaluator('// nothing to see here')).toBe(false);
  });
});
