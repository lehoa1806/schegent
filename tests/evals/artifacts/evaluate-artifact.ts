/**
 * FR-R4-F12 (FR-015 to FR-018; contract AE3; tests-and-gates T10) -- a pure evaluator of Spec Kit
 * artifact STRUCTURE against versioned, machine-decidable criteria.
 *
 * WHAT IT DOES. `evaluateArtifact(kind, text, criteria, rubricVersion)` runs the criteria that judge
 * `kind` over `text` and returns every failure with the criterion that failed, a message naming that
 * criterion and the offending element, and a 1-based line where one exists. The result also names
 * the criteria version, the rubric version, the template provenance id and the scope sentence, so a
 * result is never read as more than it is.
 *
 * WHAT IT DOES NOT DO. It does not judge quality: the rubric is human-judged and unscored, and this
 * module reads no part of it (the caller passes the version it found). It reads no file, writes
 * nothing, and touches no network, credential, clock, randomness or environment variable. Nothing in
 * the host source tree imports it (FR-020, asserted by `artifact-conformance.test.ts`).
 *
 * COST. Each check is one pass over the lines. Every regular expression comes from `criteria.json`,
 * is anchored or a fixed literal, and has no lazy loop and no nested quantifier. Path detection is a
 * token walk, not a pattern, so a long hostile line cannot make it quadratic.
 */

export type ArtifactKind = 'spec' | 'plan' | 'tasks';

/** The closed set of checks the evaluator implements. */
export type CheckKind =
  | 'required-heading'
  | 'forbidden-text'
  | 'id-format'
  | 'id-unique'
  | 'line-shape'
  | 'max-count'
  | 'each-line-matches';

/** The parameters any check reads. Each check reads only its own. */
export interface CheckParams {
  /** `required-heading`: every prefix must open some line. */
  readonly prefixes?: readonly string[];
  /** `forbidden-text`: none of these may appear on any line. */
  readonly texts?: readonly string[];
  /** `id-unique`: a pattern whose first capture group is the id. */
  readonly pattern?: string;
  /** `id-unique`: ids must also be strictly increasing. */
  readonly increasing?: boolean;
  /** `max-count`: the literal counted. */
  readonly text?: string;
  /** `max-count`: the most occurrences allowed. */
  readonly max?: number;
  /** `id-format`, `line-shape`, `each-line-matches`: which lines the check judges. */
  readonly selector?: string;
  /** `id-format`, `line-shape`, `each-line-matches`: every pattern a selected line must match. */
  readonly patterns?: readonly string[];
  /** `each-line-matches`: only lines under a `## ` heading containing one of these are judged. */
  readonly scopeHeadingContains?: readonly string[];
  /** `each-line-matches`: a selected line must contain a path-like token. */
  readonly requirePathToken?: boolean;
}

export interface Criterion {
  readonly id: string;
  readonly artifact: ArtifactKind;
  readonly description: string;
  readonly check: CheckKind;
  readonly params: CheckParams;
}

export interface CriteriaFile {
  readonly criteriaVersion: number;
  readonly templateProvenance: {
    readonly id: string;
    readonly specKitVersion: string;
    readonly templates: Readonly<Record<ArtifactKind, string>>;
  };
  readonly criteria: readonly Criterion[];
}

export interface EvaluationFailure {
  readonly criterion: string;
  readonly message: string;
  readonly line?: number;
}

export interface EvaluationResult {
  readonly criteriaVersion: number;
  readonly rubricVersion: number;
  readonly templateProvenance: string;
  readonly scope: 'artifact structure, not execution safety';
  readonly artifact: ArtifactKind;
  readonly passed: boolean;
  readonly failures: readonly EvaluationFailure[];
}

const SCOPE = 'artifact structure, not execution safety' as const;
const MAX_EXTENSION_LENGTH = 10;
const EDGE_CHARACTERS = '`()[]{}<>,.;:"\'';

function compile(pattern: string | undefined): RegExp {
  if (pattern === undefined) throw new Error('a check is missing a required pattern');
  return new RegExp(pattern);
}

/** Strip `EDGE_CHARACTERS` from both ends of a token, in two linear scans. */
function trimEdges(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && EDGE_CHARACTERS.includes(token.charAt(start))) start += 1;
  while (end > start && EDGE_CHARACTERS.includes(token.charAt(end - 1))) end -= 1;
  return token.slice(start, end);
}

function isAlphanumeric(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const digit = code >= 48 && code <= 57;
    const upper = code >= 65 && code <= 90;
    const lower = code >= 97 && code <= 122;
    if (!digit && !upper && !lower) return false;
  }
  return text.length > 0;
}

/** A token containing a `/` and ending in a file extension: `src/models/thing.ts`. */
function isPathToken(rawToken: string): boolean {
  const token = trimEdges(rawToken);
  const slash = token.lastIndexOf('/');
  if (slash <= 0 || slash === token.length - 1) return false;
  const base = token.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const extension = base.slice(dot + 1);
  return extension.length <= MAX_EXTENSION_LENGTH && isAlphanumeric(extension);
}

function hasPathToken(line: string): boolean {
  return line.split(' ').some(isPathToken);
}

function requiredHeading(criterion: Criterion, lines: readonly string[]): EvaluationFailure[] {
  const failures: EvaluationFailure[] = [];
  for (const prefix of criterion.params.prefixes ?? []) {
    if (!lines.some((line) => line.startsWith(prefix))) {
      failures.push({ criterion: criterion.id, message: `${criterion.id}: missing required heading "${prefix}"` });
    }
  }
  return failures;
}

function forbiddenText(criterion: Criterion, lines: readonly string[]): EvaluationFailure[] {
  const failures: EvaluationFailure[] = [];
  for (const text of criterion.params.texts ?? []) {
    const index = lines.findIndex((line) => line.includes(text));
    if (index >= 0) {
      failures.push({
        criterion: criterion.id,
        message: `${criterion.id}: forbidden text "${text}" is present`,
        line: index + 1
      });
    }
  }
  return failures;
}

function idUnique(criterion: Criterion, lines: readonly string[]): EvaluationFailure[] {
  const failures: EvaluationFailure[] = [];
  const pattern = compile(criterion.params.pattern);
  const firstSeen = new Map<string, number>();
  let previous: string | null = null;
  for (const [index, line] of lines.entries()) {
    const match = pattern.exec(line);
    const id = match === null ? undefined : match[1];
    if (id === undefined) continue;
    const first = firstSeen.get(id);
    if (first !== undefined) {
      failures.push({
        criterion: criterion.id,
        message: `${criterion.id}: duplicate id ${id} (first at line ${first})`,
        line: index + 1
      });
    } else {
      firstSeen.set(id, index + 1);
      if (criterion.params.increasing === true && previous !== null && id <= previous) {
        failures.push({
          criterion: criterion.id,
          message: `${criterion.id}: id ${id} does not follow ${previous}`,
          line: index + 1
        });
      }
    }
    previous = id;
  }
  return failures;
}

function maxCount(criterion: Criterion, lines: readonly string[]): EvaluationFailure[] {
  const text = criterion.params.text;
  const max = criterion.params.max;
  if (text === undefined || text.length === 0 || max === undefined) {
    throw new Error(`${criterion.id}: max-count needs a non-empty text and a max`);
  }
  let count = 0;
  for (const line of lines) {
    let from = line.indexOf(text);
    while (from !== -1) {
      count += 1;
      from = line.indexOf(text, from + text.length);
    }
  }
  return count > max
    ? [{ criterion: criterion.id, message: `${criterion.id}: ${count} occurrences of "${text}", at most ${max} allowed` }]
    : [];
}

/** `id-format`, `line-shape`: each selected line must match every pattern. */
function selectedLinesMatch(criterion: Criterion, lines: readonly string[]): EvaluationFailure[] {
  const selector = compile(criterion.params.selector);
  const patterns = (criterion.params.patterns ?? []).map((pattern) => compile(pattern));
  const failures: EvaluationFailure[] = [];
  for (const [index, line] of lines.entries()) {
    if (selector.test(line) && !patterns.every((pattern) => pattern.test(line))) {
      failures.push({
        criterion: criterion.id,
        message: `${criterion.id}: line ${index + 1} does not have the required shape`,
        line: index + 1
      });
    }
  }
  return failures;
}

function eachLineMatches(criterion: Criterion, lines: readonly string[]): EvaluationFailure[] {
  const selector = compile(criterion.params.selector);
  const patterns = (criterion.params.patterns ?? []).map((pattern) => compile(pattern));
  const scopes = criterion.params.scopeHeadingContains ?? [];
  const failures: EvaluationFailure[] = [];
  let heading = '';
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('## ')) {
      heading = line;
      continue;
    }
    const inScope = scopes.length === 0 || scopes.some((scope) => heading.includes(scope));
    if (!inScope || !selector.test(line)) continue;
    const pathMissing = criterion.params.requirePathToken === true && !hasPathToken(line);
    const patternMissing = !patterns.every((pattern) => pattern.test(line));
    if (pathMissing || patternMissing) {
      failures.push({
        criterion: criterion.id,
        message: `${criterion.id}: line ${index + 1} ${pathMissing ? 'names no path' : 'does not have the required shape'}`,
        line: index + 1
      });
    }
  }
  return failures;
}

function runCheck(criterion: Criterion, lines: readonly string[]): EvaluationFailure[] {
  switch (criterion.check) {
    case 'required-heading':
      return requiredHeading(criterion, lines);
    case 'forbidden-text':
      return forbiddenText(criterion, lines);
    case 'id-unique':
      return idUnique(criterion, lines);
    case 'max-count':
      return maxCount(criterion, lines);
    case 'id-format':
    case 'line-shape':
      return selectedLinesMatch(criterion, lines);
    case 'each-line-matches':
      return eachLineMatches(criterion, lines);
  }
}

/**
 * Judge `text` as an artifact of `kind` against `criteria`. Pure and deterministic: equal arguments
 * give a deep-equal result.
 */
export function evaluateArtifact(
  kind: ArtifactKind,
  text: string,
  criteria: CriteriaFile,
  rubricVersion: number
): EvaluationResult {
  const lines = text.split(/\r?\n/);
  const failures = criteria.criteria
    .filter((criterion) => criterion.artifact === kind)
    .flatMap((criterion) => runCheck(criterion, lines));
  return {
    criteriaVersion: criteria.criteriaVersion,
    rubricVersion,
    templateProvenance: criteria.templateProvenance.id,
    scope: SCOPE,
    artifact: kind,
    passed: failures.length === 0,
    failures
  };
}
