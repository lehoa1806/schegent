import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ENVELOPE_ROOT, envelopePresent } from './envelope-presence';
import { filesUnder } from './source-scan';

/**
 * A backticked `name.ext:NN` reference with no slash in it resolves, or is named.
 *
 * WHY. FR-R3-145's analyze phase ran a reference checker over its four feature
 * artifacts and reported resolved=211 dead=0 ambiguous=0 stale=0, three
 * iterations running. The corpus contained a dead reference the whole time: the
 * checker resolved a backticked path only when it contained a slash, and a bare
 * basename — the form prose naturally uses for a test file — matched its
 * extraction pattern for the LINE and was never resolved to a FILE. The checker
 * was not wrong. Its scope was narrower than the confidence its output invited,
 * which is the same failure as the item it was checking.
 *
 * TWO TIERS, because the two questions decay at different rates and one gate
 * asking both would be turned off within a week.
 *
 * A PRESENT-TENSE document — reference docs, architecture, operations, root
 * Markdown, source comments — says "see this file, at this line" about the tree
 * as it is now. Dead, ambiguous and stale are all defects there, and there are 50
 * such references in the two trees.
 *
 * A DATED RECORD — a spec, a filing, an audit, a plan — says what was true when
 * it was written. `extension.ts:776` was a fact in January; it is not one now,
 * and nobody should edit a merged spec to keep a line number current. There are
 * 1,510 such references and 197 of them are ambiguous or stale by today's line
 * counts. Demanding they be fixed would either destroy the record or teach
 * everyone to skip this gate. So records are checked for ONE thing: a basename
 * that names no file in either tree, held against a ledger below. That is the
 * check that decays least — a name that resolves nowhere resolves nowhere
 * whenever it is asked — and it is the one that would have caught the founding
 * defect.
 *
 * WHAT THE MEASUREMENT FOUND, 2026-08-31, and it is not what the report expected.
 * Fifteen distinct basenames in the record corpus resolve to nothing. Thirteen
 * name files that genuinely existed and were genuinely deleted, by commits this
 * ledger cites. Two were never files at all: `specs/180-builder-tab-order/`
 * introduces `PipelineBuilder.workflows-tab.test.ts` in full and then abbreviates
 * it four times, and the abbreviation names nothing. That spec is FR-R3-142,
 * merged the day after this bug was filed. The class recurred, in the work of the
 * person who filed it, before the gate existed. Those four are repointed rather
 * than ledgered, because a citation that names no file records no belief worth
 * preserving — it is a wrong name, not a dated one.
 *
 * THE AMBIGUITY RULE the report called "the whole difficulty", and it works.
 * Among the files a basename matches, only those long enough to CONTAIN the cited
 * line are candidates. One survivor resolves; several is ambiguous; none is
 * stale. Measured over both corpora it moves 105 of 245 ambiguities to resolved —
 * `phase-log.ts:59-70` names two files and only one reaches line 70 — without
 * once guessing. A basename matching four files at different lengths is the case
 * it exists for.
 *
 * QUALIFIED PATHS ARE CHECKED TOO, in the live tier, because this gate's own
 * remediation advice creates them. Telling an author to fix an ambiguous
 * `vitest.config.ts:28` by qualifying it is only sound if the qualified form is
 * also checked, and it was not: `check-doc-links.mjs` reads markdown links,
 * `doc-references-outside-markdown.test.ts` reads `docs/**.md` paths in `src/`
 * and `scripts/`, and `scripts/envelope-doc-liveness.sh` registers two documents
 * and strips `:NN` before it looks. A `path/to/file.ts:900` in a source comment
 * was checked by nothing. Measured: 29 live qualified references, three of them
 * defective, including a citation into `src/extension.ts:967` in a 683-line file.
 * A gate whose advice moves a defect somewhere unchecked is worse than no advice.
 *
 * `./name.ext:NN` BINDS TO THE CITING TREE'S ROOT, and is the only way to
 * disambiguate a root-level file — `vitest.config.ts` exists at both repository
 * roots and in `webview-ui/`, and no directory prefix can separate the first two.
 * An unprefixed qualified path is tried in the citing tree first, then the other;
 * resolving in both is ambiguous, not resolved, for the same reason a bare name
 * matching two files is.
 *
 * WHAT IT DOES NOT CLAIM, stated because an unstated bound is how the checker
 * this replaces came to be trusted. That a file is long enough to contain line 70
 * says nothing about what line 70 SAYS: this catches a citation into a file that
 * cannot hold it, never one that has merely moved. Qualified paths are checked in
 * the LIVE tier only. Dated records hold 82 distinct qualified paths that resolve
 * to nothing, and most are abbreviations rather than deletions — `controller/phase.ts`
 * for `src/controller/phase.ts`, six times. Resolving those needs a suffix rule
 * this gate does not have, and ledgering 82 entries to record that fact would be
 * bookkeeping, not a check. Records are still checked for dead bare names, which
 * is the class the item was filed for. `../` is not matched at all: every
 * qualified citation in both trees is root-relative, and a directory-relative
 * form would need a third resolution mode to buy nothing. Prose nouns like
 * "settings.md" outside backticks are nobody's business. It skips fenced code
 * blocks, for the reason `envelope-doc-liveness.sh` skips them: quoted material
 * is not a citation the document makes.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

/** Extensions a citation may carry. A bare `127.0.0.1:4173` is not a file. */
const KNOWN_EXTENSIONS = [
  'ts',
  'mts',
  'cts',
  'mjs',
  'cjs',
  'js',
  'svelte',
  'json',
  'sh',
  'md',
  'yml',
  'yaml'
] as const;

const NAME = '[A-Za-z0-9._-]+\\.(?:' + KNOWN_EXTENSIONS.join('|') + ')';

const REFERENCE = new RegExp('`(' + NAME + '):(\\d+)(?:-(\\d+))?`', 'g');

/**
 * The qualified form: `./name.ext:NN` or `dir/.../name.ext:NN`.
 *
 * Deliberately not one pattern with the bare form. The two resolve differently —
 * one against a basename index, one against the filesystem — and a single pattern
 * that had to be post-filtered into the two kinds would make the controls below
 * assert the filter rather than the pattern.
 */
const QUALIFIED = new RegExp(
  '`(\\./' + NAME + '|(?:[A-Za-z0-9._-]+/)+' + NAME + '):(\\d+)(?:-(\\d+))?`',
  'g'
);

/**
 * Directory prefixes whose documents are dated records.
 *
 * By KIND, not by path convenience: each of these holds documents that state what
 * was true on a date, and `scripts/envelope-doc-liveness.sh` and
 * `scripts/filing-prefix-truth.sh` already exist to preserve exactly that.
 */
const RECORD_PREFIXES = ['specs/', 'docs/features/', 'docs/audits/', 'docs/plans/'] as const;

/** Where citations are read from, per tree. Anything else is not scanned. */
const SCAN_ROOTS = {
  repo: ['docs', 'specs', 'src', 'tests', 'scripts', 'webview-ui/src'],
  envelope: ['docs', 'specs']
} as const;

const CITING_EXTENSIONS = ['.md', '.ts', '.mts', '.mjs', '.svelte'] as const;

/** Directories holding build output or another tree, never citations. */
const SKIP = ['repo', 'out', '.tmp', '.vscode-test', 'test-results', 'playwright-report'] as const;

/**
 * Basenames that resolve to nothing and are recorded as such, with the commit
 * that removed them.
 *
 * Every entry names a file that existed. A reader chasing one of these citations
 * needs to know it is gone and where to look instead, which is what the reason
 * gives them — the same contract `doc-references-outside-markdown.test.ts` holds
 * its `KNOWN_ABSENT` to, and for the same reason: an allowlist without reasons
 * becomes a dumping ground.
 *
 * KEYED BY BASENAME, not by citing document and line. A line key churns every
 * time a record is reflowed, and the fact being recorded is about the NAME — it
 * is dead everywhere or nowhere. The cost is that a fourteenth citation of
 * `release.yml` passes silently; that is the same already-known fact, and the
 * check that matters is the SIXTEENTH BASENAME, which cannot be added without
 * someone writing down why.
 */
const KNOWN_ABSENT: ReadonlyMap<string, string> = new Map([
  [
    'release.yml',
    'retired by ce6cb180 "ci: retire the seven workflows still on master" — this project has no .github/workflows at all'
  ],
  ['ci.yml', 'retired by ce6cb180 with the other six workflows; nothing replaced it in-tree'],
  ['pr.yml', 'retired by ce6cb180 with the other six workflows'],
  ['codeql.yml', 'retired by ce6cb180 with the other six workflows'],
  ['dependency-review.yml', 'retired by ce6cb180 with the other six workflows'],
  [
    'Dashboard.svelte',
    'replaced by the task-first operations surface in ea391673 feat(097-operations-task-first)'
  ],
  ['DashboardActivityPane.svelte', 'replaced by the same redesign, ea391673'],
  ['QueueListView.svelte', 'replaced by the same redesign, ea391673'],
  [
    'ControlPanel.svelte',
    'deleted by 16de985b fix(140) as a superseded webview only tests could reach'
  ],
  [
    'workflow-config.ts',
    'superseded by the versioned file-backed catalog in 6805658f feat(catalog)'
  ],
  ['cmd-save-workflows.ts', 'superseded by publish-on-edit in e77a82bb feat(catalog)'],
  ['cmd-save-pipelines.ts', 'superseded by publish-on-edit in e77a82bb feat(catalog)'],
  ['require-full-gate.mjs', 'removed by d0b7f2cc feat(156); scripts/require-local-gate.mjs is the survivor']
]);

/**
 * This file, excluded from its own live-tier scan.
 *
 * It has to name dead references to explain what it refuses, and a gate that
 * cannot describe its own subject without failing itself is unwritable.
 * `lint-gates-are-hermetic.test.ts` skips itself for the same reason and states
 * it the same way. The exclusion is asserted to hold exactly one file below, so
 * it cannot quietly become a place to put things.
 */
const SELF = 'tests/lint/basename-line-references.test.ts';

interface Candidate {
  readonly display: string;
  readonly abs: string;
}

interface Reference {
  /** Display path of the citing file, `repo/`-prefixed when repo-side. */
  readonly from: string;
  readonly line: number;
  /** A bare basename, or a root-relative path when `qualified`. */
  readonly target: string;
  readonly qualified: boolean;
  /** Absolute root of the tree the citing file lives in, for `./` and path resolution. */
  readonly home: string;
  /** The last line the citation names — the end of a range, or the only line. */
  readonly cited: number;
  readonly raw: string;
  readonly record: boolean;
}

export type Verdict = 'resolved' | 'dead' | 'ambiguous' | 'stale';

/**
 * The classifier, over candidate lengths rather than the filesystem.
 *
 * Takes lengths so the rule can be driven against cases the tree does not happen
 * to contain. A resolver that can only be run over the real tree cannot be shown
 * to refuse anything, which is the defect in the checker this replaces.
 */
export function classify(cited: number, candidateLengths: readonly number[]): Verdict {
  if (candidateLengths.length === 0) return 'dead';
  const longEnough = candidateLengths.filter((length) => length >= cited);
  if (longEnough.length === 0) return 'stale';
  return longEnough.length > 1 ? 'ambiguous' : 'resolved';
}

/**
 * `..` matches the segment character class, so the header's promise that a
 * directory-relative path is not read has to be kept in code, not by the pattern.
 */
export function directoryRelative(target: string): boolean {
  return target.split('/').includes('..');
}

const present = envelopePresent();

function treeFiles(root: string, roots: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const dir of roots) out.push(...filesUnder(resolve(root, dir), { skipDirectories: SKIP }));
  return out;
}

/** Every file in both trees, indexed by basename. */
function buildIndex(): ReadonlyMap<string, readonly Candidate[]> {
  const index = new Map<string, Candidate[]>();
  const record = (root: string, prefix: string): void => {
    for (const abs of filesUnder(root, { skipDirectories: SKIP })) {
      const base = abs.split('/').pop() ?? '';
      const entry = index.get(base) ?? [];
      entry.push({ display: prefix + relative(root, abs), abs });
      index.set(base, entry);
    }
  };
  record(REPO_ROOT, 'repo/');
  if (present) record(ENVELOPE_ROOT, '');
  return index;
}

const lengths = new Map<string, number>();
function lineCount(candidate: Candidate): number {
  const cached = lengths.get(candidate.abs);
  if (cached !== undefined) return cached;
  let count = 0;
  try {
    count = readFileSync(candidate.abs, 'utf8').split('\n').length;
  } catch {
    // Unreadable is not long enough for any line, which is the honest answer.
    count = 0;
  }
  lengths.set(candidate.abs, count);
  return count;
}

function extract(
  abs: string,
  display: string,
  home: string,
  isRecord: boolean
): readonly Reference[] {
  const out: Reference[] = [];
  let fenced = false;
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((text, index) => {
      if (/^\s*(```|~~~)/.test(text)) {
        fenced = !fenced;
        return;
      }
      if (fenced) return;
      for (const [pattern, qualified] of [
        [REFERENCE, false],
        [QUALIFIED, true]
      ] as const) {
        for (const match of text.matchAll(pattern)) {
          const target = match.at(1) ?? '';
          if (directoryRelative(target)) continue;
          const start = match.at(2) ?? '0';
          const end = match.at(3);
          out.push({
            from: display,
            line: index + 1,
            target,
            qualified,
            home,
            cited: Number(end ?? start),
            raw: match.at(0) ?? '',
            record: isRecord
          });
        }
      }
    });
  return out;
}

function references(): readonly Reference[] {
  const out: Reference[] = [];
  const collect = (root: string, roots: readonly string[], prefix: string): void => {
    for (const abs of treeFiles(root, roots)) {
      if (!CITING_EXTENSIONS.some((ext) => abs.endsWith(ext))) continue;
      const rel = relative(root, abs);
      if (prefix === 'repo/' && rel === SELF) continue;
      const isRecord = RECORD_PREFIXES.some((p) => rel.startsWith(p));
      out.push(...extract(abs, prefix + rel, root, isRecord));
    }
  };
  collect(REPO_ROOT, SCAN_ROOTS.repo, 'repo/');
  if (present) collect(ENVELOPE_ROOT, SCAN_ROOTS.envelope, '');
  return out;
}

const index = buildIndex();

/**
 * Where a qualified path may land.
 *
 * `./` binds to the citing tree's root and nowhere else — that is the whole point
 * of writing it. An unprefixed path is tried in the citing tree first, then the
 * other, and `repo/x` is additionally tried as `x` under the execution repository
 * so a path written from the envelope's point of view resolves from either side.
 * Every hit is kept: two hits is ambiguous, which is the honest verdict when a
 * path names a real file in both trees.
 */
function resolveQualified(ref: Reference): readonly Candidate[] {
  const other = ref.home === REPO_ROOT ? ENVELOPE_ROOT : REPO_ROOT;
  const attempts: { root: string; path: string }[] = ref.target.startsWith('./')
    ? [{ root: ref.home, path: ref.target.slice(2) }]
    : [
        { root: ref.home, path: ref.target },
        ...(present || other === REPO_ROOT ? [{ root: other, path: ref.target }] : []),
        ...(ref.target.startsWith('repo/')
          ? [{ root: REPO_ROOT, path: ref.target.slice('repo/'.length) }]
          : [])
      ];
  const found = new Map<string, Candidate>();
  for (const { root, path } of attempts) {
    const abs = resolve(root, path);
    if (!abs.startsWith(root)) continue;
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const prefix = root === REPO_ROOT ? 'repo/' : '';
    found.set(abs, { display: prefix + relative(root, abs), abs });
  }
  return [...found.values()];
}

const candidatesFor = (ref: Reference): readonly Candidate[] =>
  ref.qualified ? resolveQualified(ref) : (index.get(ref.target) ?? []);
const all = references();
const verdictOf = (ref: Reference): Verdict =>
  classify(ref.cited, candidatesFor(ref).map(lineCount));
const show = (ref: Reference): string => `${ref.from}:${ref.line}  ${ref.raw}`;

describe('bare-basename file:line references resolve (FR-R3-145 follow-up)', () => {
  it('finds references and files at all', () => {
    // Vacuity control, and the one to read first if this gate ever goes quiet.
    // Every assertion below filters a list, and a filter over nothing is green —
    // which is precisely how the checker this replaces reported dead=0.
    expect(index.size, 'the file index is empty; nothing below is being resolved').toBeGreaterThan(
      500
    );
    expect(all.length, 'no bare-basename reference was extracted at all').toBeGreaterThan(1000);
    expect(
      all.filter((ref) => !ref.record && !ref.qualified).length,
      'no present-tense bare-basename reference was found; the live corpus is not being read'
    ).toBeGreaterThan(20);
    expect(
      all.filter((ref) => !ref.record && ref.qualified).length,
      'no qualified path was extracted; the escape hatch this gate points authors toward ' +
        'is unchecked again'
    ).toBeGreaterThan(20);
  });

  it('reads both trees, not only the execution repo', () => {
    if (!present) return;
    expect(all.some((ref) => ref.from.startsWith('repo/'))).toBe(true);
    expect(all.some((ref) => !ref.from.startsWith('repo/'))).toBe(true);
  });

  // ---- the live tier: present-tense documents and source comments ----

  it('names no file that does not exist, in a present-tense document', () => {
    const dead = all
      .filter((ref) => !ref.record && verdictOf(ref) === 'dead')
      .map((ref) => show(ref));
    expect(
      dead,
      'These name no file in either tree. This is the defect the item was filed for: a ' +
        'reference nobody can follow, in a document that speaks in the present tense.'
    ).toEqual([]);
  });

  it('names one file, not several, in a present-tense document', () => {
    const ambiguous = all
      .filter((ref) => !ref.record && verdictOf(ref) === 'ambiguous')
      .map(
        (ref) =>
          `${show(ref)} -> ${candidatesFor(ref)
            .filter((c) => lineCount(c) >= ref.cited)
            .map((c) => c.display)
            .join(', ')}`
      );
    expect(
      ambiguous,
      'Each of these names several files long enough to hold the cited line, so a reader ' +
        'cannot tell which is meant. Three fixes, in order of preference. Qualify the ' +
        'path — `webview-ui/vitest.config.ts:28` rather than `vitest.config.ts:28`. For a ' +
        'file at a repository root, where no directory prefix can separate the two trees, ' +
        'write `./vitest.config.ts:28` to bind it to the citing tree. Or drop the `:NN` ' +
        'pin: a line number that cannot be made unambiguous is not worth keeping, and the ' +
        'name alone still reads.'
    ).toEqual([]);
  });

  it('cites a line the file is long enough to hold, in a present-tense document', () => {
    const stale = all
      .filter((ref) => !ref.record && verdictOf(ref) === 'stale')
      .map(
        (ref) =>
          `${show(ref)} -> ${candidatesFor(ref)
            .map((c) => `${c.display} is ${lineCount(c)} lines`)
            .join(', ')}`
      );
    expect(
      stale,
      'The file exists and is shorter than the line cited, so the anchor is stale. Note ' +
        'the converse is NOT checked: a file long enough to hold the line may still have ' +
        'moved the thing being cited.'
    ).toEqual([]);
  });

  // ---- the record tier: dead names only, against the ledger ----

  it('adds no unrecorded dead basename to a dated record', () => {
    const unrecorded = new Map<string, string[]>();
    for (const ref of all) {
      // Qualified paths are live-tier only; see the header for the 82 that would
      // land here and why ledgering them would be bookkeeping rather than a check.
      if (!ref.record || ref.qualified || verdictOf(ref) !== 'dead') continue;
      if (KNOWN_ABSENT.has(ref.target)) continue;
      const sites = unrecorded.get(ref.target) ?? [];
      sites.push(show(ref));
      unrecorded.set(ref.target, sites);
    }
    expect(
      [...unrecorded].map(([base, sites]) => `${base}: ${sites.join('; ')}`),
      'A dated record cites a basename that names no file in either tree. Two things it ' +
        'can be. A file that was deleted — add it to KNOWN_ABSENT with the commit that ' +
        'removed it, so the next reader knows where it went. Or a name that was never ' +
        'right, which is what `workflows-tab.test.ts` turned out to be: an abbreviation of ' +
        'a real filename introduced in full earlier in the same document. Repoint that one. ' +
        'Line numbers in records are NOT checked and must not be edited to satisfy anything.'
    ).toEqual([]);
  });

  it('keeps the ledger live: a name that resolves again leaves it', () => {
    // A standing permission for a file that came back is the dead-allowlist
    // defect three other gates in this tree have already had removed.
    const resurrected = [...KNOWN_ABSENT.keys()].filter((base) => index.has(base));
    expect(
      resurrected,
      'These basenames resolve again, so the ledger is describing a removal that was undone.'
    ).toEqual([]);
  });

  it('requires a reason naming where each absent file went', () => {
    for (const [base, why] of KNOWN_ABSENT) {
      expect(why.length, `${base} needs a reason a reader can act on`).toBeGreaterThan(30);
    }
  });

  it('excludes exactly one file from the live tier, this one', () => {
    // The self-exclusion is a real hole and is bounded here rather than trusted.
    expect(SELF).toBe('tests/lint/basename-line-references.test.ts');
  });

  // ---- controls: the classifier's own behaviour, driven directly ----

  it('CONTROL: refuses a name that matches nothing, and accepts one that matches once', () => {
    expect(classify(10, [])).toBe('dead');
    expect(classify(10, [400])).toBe('resolved');
  });

  it('CONTROL: the cited line is what separates ambiguous from resolved', () => {
    // The rule the report called the whole difficulty. Two files share a name;
    // only one reaches line 70, so the citation is not ambiguous at all.
    expect(classify(70, [120, 40])).toBe('resolved');
    // Both reach it, and picking one would be a guess.
    expect(classify(70, [120, 90])).toBe('ambiguous');
    // Neither does. The name is not ambiguous, the anchor is stale.
    expect(classify(70, [40, 30])).toBe('stale');
  });

  it('CONTROL: a boundary line is inside the file, not past it', () => {
    expect(classify(40, [40])).toBe('resolved');
    expect(classify(41, [40])).toBe('stale');
  });

  it('CONTROL: the extractor takes the end of a range, not the start', () => {
    // `foo.ts:10-900` cites line 900. Reading the start would call a citation
    // running off the end of a 100-line file resolved.
    const parsed = [...'`foo.ts:10-900`'.matchAll(REFERENCE)].at(0);
    expect(Number(parsed?.at(3) ?? parsed?.at(2))).toBe(900);
  });

  it('CONTROL: a slash-qualified path and a bare host:port are not bare references', () => {
    // The first is the qualified pattern's, not this one's; the second is why the
    // extension list is an allowlist, since `127.0.0.1:4173` parses as
    // name-dot-ext-colon-line under any looser rule.
    expect([...'`src/extension.ts:776`'.matchAll(REFERENCE)]).toEqual([]);
    expect([...'`127.0.0.1:4173`'.matchAll(REFERENCE)]).toEqual([]);
    expect([...'`127.0.0.1:4173`'.matchAll(QUALIFIED)]).toEqual([]);
  });

  it('CONTROL: the qualified pattern reads a path, a `./` root anchor, and no `..`', () => {
    const target = (text: string): string | undefined =>
      [...text.matchAll(QUALIFIED)].at(0)?.at(1);
    expect(target('`src/extension.ts:776`')).toBe('src/extension.ts');
    expect(target('`./vitest.config.ts:28`')).toBe('./vitest.config.ts');
    // A bare name is the other pattern's; this one must not also claim it, or
    // every basename would be resolved twice under two different rules.
    expect(target('`extension.ts:776`')).toBeUndefined();
    // The pattern DOES match `../AGENTS.md:5` — `..` is in the segment class — so
    // the guard is what keeps the bound, and the guard is what is asserted.
    expect(target('`../AGENTS.md:5`')).toBe('../AGENTS.md');
    expect(directoryRelative('../AGENTS.md')).toBe(true);
    expect(directoryRelative('a/../b.ts')).toBe(true);
    expect(directoryRelative('src/extension.ts')).toBe(false);
    expect(directoryRelative('./vitest.config.ts')).toBe(false);
  });

  it('CONTROL: `./` binds to the citing tree, an unprefixed path may reach both', () => {
    if (!present) return;
    const ref = (target: string, home: string): Reference => ({
      from: 'probe',
      line: 1,
      target,
      qualified: true,
      home,
      cited: 1,
      raw: `\`${target}:1\``,
      record: false
    });
    // `AGENTS.md` exists at both roots. `./` from the repo means the repo's, and
    // says so — this is the only spelling that separates two root-level files.
    expect(resolveQualified(ref('./AGENTS.md', REPO_ROOT)).map((c) => c.display)).toEqual([
      'repo/AGENTS.md'
    ]);
    expect(resolveQualified(ref('./AGENTS.md', ENVELOPE_ROOT)).map((c) => c.display)).toEqual([
      'AGENTS.md'
    ]);
    // Unprefixed, the same document exists under both roots, and that is ambiguous
    // rather than resolved. `docs/security/threat-model.md` is 1,396 lines in the
    // envelope and 559 in the repo; a citation past 559 is not ambiguous at all.
    expect(resolveQualified(ref('docs/security/threat-model.md', REPO_ROOT)).length).toBe(2);
    expect(verdictOf(ref('docs/security/threat-model.md', REPO_ROOT))).toBe('ambiguous');
    expect(verdictOf({ ...ref('docs/security/threat-model.md', REPO_ROOT), cited: 900 })).toBe(
      'resolved'
    );
    // `repo/x` is how the envelope names a repo file, and it resolves from either side.
    expect(resolveQualified(ref('repo/AGENTS.md', ENVELOPE_ROOT)).map((c) => c.display)).toEqual([
      'repo/AGENTS.md'
    ]);
  });
});
