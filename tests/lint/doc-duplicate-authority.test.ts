import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * FR-R3-063, widened by FR-R3-066 — two documents with the same body are two
 * authorities.
 *
 * WHAT WENT WRONG WITH THE FIRST VERSION
 *
 * It hashed whole files — `createHash('sha256').update(body)` — so it detected
 * **byte-identical** pairs only, and a three-line divergence defeated it. It
 * therefore passed over `api-and-cli.md` / `feature-reference.md`: 147 of 148
 * substantive lines identical, differing only in the H1 and one intro paragraph.
 * That reproduced, one layer up, the failure the gate was built in response to —
 * it could only see duplication nobody had touched.
 *
 * Byte-identity is also the *least* likely shape for real duplicate authority.
 * Two documents sharing a body but given different framings is the normal way
 * this defect appears; two byte-identical files is the rare, degenerate case.
 *
 * WHAT THIS VERSION GUARANTEES
 *
 *   - near-duplicates are detected by substantive-line overlap, so a new title
 *     and an added paragraph no longer hide a pair;
 *   - the whole envelope is scanned, not just this repository;
 *   - every reported overlap is the exact shared-multiset count for that pair;
 *   - output is sorted, so two runs over one tree are byte-identical.
 *
 * WHAT IT DOES NOT GUARANTEE
 *
 *   - **Heading text is excluded from the comparison.** Intended — a re-framing
 *     is the defect — but it means the gate cannot tell "same body, different
 *     structure" from "same body, same structure".
 *   - **The envelope only when it is there.** `repo/` cloned on its own is a
 *     supported layout, and there the scope narrows to this repository rather
 *     than failing; the family assertions that need envelope paths skip.
 *   - **Tracked files only**, so duplication in an untracked file is invisible.
 *     Deliberate: those ship to nobody, and see `git ls-files` below for the
 *     measured reason this matters.
 *   - **Duplication, not correctness.** Two documents can be distinct and both
 *     wrong; that residual belongs to review.
 *   - It is **quadratic in the corpus**. Measured, not assumed — see
 *     `docs/operations/duplicate-authority-threshold-measurement.md`.
 */
const REPO = resolve(__dirname, '..', '..');
const ENVELOPE = resolve(REPO, '..');
const MEASUREMENT = 'docs/operations/duplicate-authority-threshold-measurement.md';

/**
 * True when `..` holds the planning envelope rather than an unrelated parent.
 *
 * `repo/` cloned on its own is a supported layout — CI checks out exactly that —
 * and there the parent directory is not a repository at all, so
 * `git -C .. ls-files` exits 128. Throwing then would report the environment as
 * a duplicate-authority failure a contributor did not cause and cannot act on.
 * So the envelope is scanned only when it is there; same predicate as
 * `scripts/check-doc-links.mjs`, for the same reason, and the same posture as
 * `agents-claude-parity.test.ts`.
 *
 * A failed enumeration of a root that IS present still fails hard — see
 * `trackedMarkdown`. Absent is not the same as unreadable.
 */
const ENVELOPE_PRESENT =
  existsSync(join(ENVELOPE, 'ARCHITECTURE.md')) &&
  existsSync(join(ENVELOPE, 'CLAUDE.md')) &&
  existsSync(join(ENVELOPE, 'docs'));

/** Roots enumerated, and the root every reported path is relative to. */
const SCAN_ROOTS: readonly string[] = ENVELOPE_PRESENT ? [ENVELOPE, REPO] : [REPO];
const DISPLAY_ROOT = ENVELOPE_PRESENT ? ENVELOPE : REPO;

/**
 * Corpus floor for `scans a substantial tree`, scaled to the scope actually
 * available: 1,248 documents above the size floor across both repositories,
 * 63 in `repo/` alone.
 */
const MIN_CORPUS = ENVELOPE_PRESENT ? 100 : 40;

/** Below this, an identical body is boilerplate rather than an authority. */
const MIN_BYTES = 2000;

/**
 * The overlap at which a pair is reported.
 *
 * MEASURED, not picked. Over the 1,249 tracked documents above the size floor,
 * pairs meeting each ratio (with the shared-line floor below):
 *
 *     >= 0.90 -> 21     same-content families only
 *     >= 0.85 -> 23     same-content families only
 *     >= 0.80 -> 24     same-content families only     <- chosen
 *     >= 0.70 -> 25     + 1 more skill-tree pair (0.775); still no boilerplate
 *     >= 0.60 -> 38     + 12 `speckit-taskstoissues` pairs at 0.609-0.652 whose
 *                         only shared content is the extension-hooks block every
 *                         skill file carries, + 1 more generated checklist pair
 *
 * After the consolidation this item performed the corpus is 1,248 documents and
 * the report is 23 pairs; the numbers above are the pre-change tree, so that the
 * band composition can be reproduced against the commit that chose the value.
 *
 * Boilerplate first enters the report BELOW 0.70, not below 0.80: the loosest
 * boilerplate-free value is nearer 0.66. 0.80 is therefore a deliberately
 * conservative choice, one whole band clear of the shared-hooks floor — because a
 * gate that fires on ordinary shared boilerplate is a gate switched off within a
 * round, and the margin is what keeps a new skill file from putting it there.
 * What that costs is recorded rather than hidden: the `speckit-constitution`
 * skill-tree pair sits at 0.775 and goes unreported. It is allowlisted anyway, so
 * the margin permits nothing that 0.70 would have caught — but a genuine
 * duplicate in that band would also be missed, and 0.70 is the value to reach
 * for if that ever matters.
 *
 * The threshold REPORTS; the allowlist PERMITS. It cannot separate legitimate
 * from illegitimate duplication by value, because the highest legitimate overlap
 * in this tree is 1.000 — byte-identical skill-tree files that must both exist.
 * That is the most likely misreading of this design, so it is said here.
 *
 * Full distribution and method: `MEASUREMENT`.
 */
const MIN_OVERLAP = 0.8;

/**
 * And a pair must share at least this many substantive lines.
 *
 * The ratio alone is not enough: two short documents sharing a handful of
 * boilerplate lines would score 1.000 on ratio. Both criteria together are what
 * make the report readable.
 */
const MIN_SHARED_LINES = 20;

/**
 * Duplication that is deliberate — as FAMILIES with a pair-predicate, not as
 * exact pairs.
 *
 * Pairs were the first version's shape and do not survive the widened detector.
 * Two reasons, both measured:
 *
 *   1. Every feature generates a spec-quality checklist from one fixed template,
 *      so the number of such pairs grows with the square of the feature count.
 *      Listing them individually would add an allowlist entry per feature
 *      forever — precisely the "allowlist nobody has read" this is meant to avoid.
 *   2. Some pairs cross two different legitimate families (a skill-tree copy
 *      against an extension-command copy of the same definition), so a predicate
 *      that classified single FILES would leave those pairs uncovered. Family
 *      membership is a property of the pair.
 *
 * Each entry carries its reason, and `an entry whose duplication is gone must
 * leave` below fails on a stale one.
 */
interface DuplicateFamily {
  readonly name: string;
  readonly why: string;
  readonly covers: (a: string, b: string) => boolean;
}

/** `.../skills/<name>/SKILL.md` -> `<name>`; null when the path is not one. */
function skillName(path: string): string | null {
  const m = /(?:^|\/)(?:\.agents|\.claude)\/skills\/([^/]+)\/SKILL\.md$/.exec(path);
  return m ? m[1] : null;
}

/**
 * `.agents|.claude/skills/<name>/<rest>.md` -> `<name>/<rest>.md`; null otherwise.
 *
 * The whole tree-relative path rather than only `SKILL.md`, because a skill
 * package ships `references/*.md` beside its definition and mirroring one of
 * those into both trees is the same deliberate duplication for the same reason.
 * The byte-identity version keyed this family on `/skills/` appearing in both
 * paths; narrowing it to `SKILL.md` would report such a mirror as unexplained.
 */
function skillTreePath(path: string): string | null {
  const m = /(?:^|\/)(?:\.agents|\.claude)\/skills\/(.+\.md)$/.exec(path);
  return m ? m[1] : null;
}

/** `.specify/extensions/<ext>/commands/speckit.<a>.<b>.md` -> `speckit-<a>-<b>`. */
function extensionCommandName(path: string): string | null {
  const m = /(?:^|\/)\.specify\/extensions\/[^/]+\/commands\/(.+)\.md$/.exec(path);
  return m ? m[1].split('.').join('-') : null;
}

const FAMILIES: readonly DuplicateFamily[] = [
  {
    name: 'agent skill trees',
    why:
      'The same skill definition read by two agent runtimes from two fixed paths. One file cannot serve ' +
      'both, and drift between them is a functional bug rather than a documentation one. ' +
      'RE-EXAMINED under substantive-line overlap (FR-R3-066): still live, 13 pairs at 0.822-1.000, and ' +
      'still justified for the same reason the byte-identity version gave.',
    covers: (a, b) => {
      const sa = skillTreePath(a);
      const sb = skillTreePath(b);
      // Equal tree-relative paths on two distinct files means two trees.
      return sa !== null && sa === sb;
    }
  },
  {
    name: 'extension commands against the skill trees',
    why:
      'The same workflow command definition at a THIRD fixed path, read by the Spec Kit extension loader ' +
      'rather than by an agent runtime. Same reasoning as the skill trees, and NEW: the byte-identity ' +
      'detector never surfaced these because they sit at 0.943-0.980, not 1.000. Eight pairs. Surfacing a ' +
      'duplicate family nobody had catalogued is the widened detector earning its place.',
    covers: (a, b) => {
      const pairs: ReadonlyArray<readonly [string | null, string | null]> = [
        [skillName(a), extensionCommandName(b)],
        [skillName(b), extensionCommandName(a)]
      ];
      return pairs.some(([skill, command]) => skill !== null && skill === command);
    }
  },
  {
    name: 'committed unfilled plan template',
    why:
      'Feature 068 committed the UNFILLED plan template as its plan. Recorded rather than rewritten -- ' +
      'back-filling a completed feature\'s plan now would be fabrication, and the empty template is the ' +
      'honest evidence that it was never written. RE-EXAMINED under the new detector: still live at 1.000, ' +
      'still the same judgement.',
    covers: (a, b) => {
      const key = [a, b].sort().join('|');
      return key === '.specify/templates/plan-template.md|specs/068-enhance-system-log/plan.md';
    }
  },
  {
    name: 'generated spec-quality checklists',
    why:
      'Every feature\'s `checklists/requirements.md` is generated by /speckit-specify from one fixed ' +
      'template, so identical bodies are the intended output rather than a defect. A PREDICATE and not a ' +
      'pair list, because this family grows with the square of the feature count and would otherwise ' +
      'require an allowlist entry per feature forever.',
    covers: (a, b) =>
      [a, b].every((p) => /(?:^|\/)specs\/[^/]+\/checklists\/requirements\.md$/.test(p))
  }
];

/**
 * Tracked markdown under one scan root.
 *
 * `git ls-files` and NOT a filesystem walk, and the reason is measured: the tree
 * contains a gitignored `scratch/` holding a document that scores 1.000 against
 * a tracked one. The byte-identity version survived that only because the two
 * are not byte-identical; under overlap it would fail every developer who has
 * that directory — a gate disabled on its first day. Tracked-only also scopes
 * the check to the corpus that actually ships.
 */
function trackedMarkdown(root: string): string[] {
  let stdout: string;
  try {
    // `-z`: a path git would otherwise C-quote (anything non-ASCII) arrives
    // verbatim instead of resolving to a name that does not exist and being
    // dropped by the `statSync` guard in `loadDocs` — a silent shrink of the
    // corpus, which is the one direction this must not fail in.
    stdout = execFileSync('git', ['-C', root, 'ls-files', '-z', '*.md'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });
  } catch (err) {
    // FAIL, do not fall back. A silently widened scope reports failures a
    // contributor did not cause and cannot act on; and an inconclusive check
    // must not report success.
    throw new Error(
      `doc-duplicate-authority: could not list tracked files in ${root} ` +
        `(${(err as Error).message}). Refusing to fall back to a filesystem walk: that would scan ` +
        'ignored drafts and fail on files that ship to nobody.'
    );
  }
  return stdout.split('\0').filter(Boolean).map((p) => resolve(root, p));
}

/** A fence opener/closer, either marker. `~~~` counts: one tracked audit uses it. */
const FENCE = /^(?:`{3,}|~{3,})/;

/**
 * Fenced spans, resolved by finding each opener's MATCHING closer.
 *
 * A running `inFence = !inFence` toggle was the first shape and it fails two ways
 * that both SHRINK the corpus silently, which is the one direction a duplicate
 * detector must not fail in:
 *
 *   - An unterminated fence swallows the rest of the document. Not theoretical:
 *     `specs/014-wake-up/contracts/daemon-registration.md` has fifteen markers,
 *     so its tail was being dropped from every comparison. Taken further — a
 *     stray marker near the top — `substantiveLines` returns nothing, `loadDocs`
 *     skips the document, and a duplicate involving it is invisible while the
 *     gate reports success.
 *   - A ``` line inside a ~~~ block (or a longer fence) inverted the toggle for
 *     everything after it.
 *
 * So an opener with no closer is NOT a fence: the span stays in the comparison,
 * and only the marker lines themselves are dropped. Erring toward comparing too
 * much can only produce a reported pair a human then reads; erring toward
 * comparing too little produces a green run that proves nothing.
 */
function fencedSpans(lines: readonly string[]): boolean[] {
  const fenced = new Array<boolean>(lines.length).fill(false);
  let open: { marker: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!FENCE.test(line)) continue;
    if (open === null) {
      // The marker's ACTUAL run length, not a normalised three. A closer must
      // be at least as long as its opener, so a ``` line inside a ```` block is
      // content; normalising to three closed the span early and dropped the
      // prose after it — the same corpus-shrinking failure the toggle had.
      open = { marker: FENCE.exec(line)?.[0] ?? line, start: i };
      continue;
    }
    // Only the same marker closes; a ``` inside a ~~~ block is content.
    if (!line.startsWith(open.marker)) continue;
    for (let j = open.start; j <= i; j += 1) fenced[j] = true;
    open = null;
  }
  return fenced;
}

/**
 * The comparison unit. Trimmed, and dropping what is not an authority claim:
 * blank lines, headings, source-marker comments, fence markers, and everything
 * inside a closed fenced block (two documents sharing an example are not two
 * authorities).
 */
function substantiveLines(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split('\n');
  const fenced = fencedSpans(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (fenced[i]) continue;
    const line = lines[i].trim();
    if (line.length === 0) continue;
    if (FENCE.test(line)) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('<!--') && line.endsWith('-->')) continue;
    out.push(line);
  }
  return out;
}

interface Doc {
  readonly rel: string;
  readonly total: number;
  readonly counts: Map<string, number>;
}

/**
 * Counts built ONCE per document, then compared against the smaller of each
 * pair. Measured: 1163 ms over 779,376 pairs. Rebuilding counts per pair costs
 * 5804 ms, and a shared-line candidate index — written and discarded — costs
 * 2789 ms, because one boilerplate line is shared by 456 documents and generates
 * ~104k candidates by itself. The simple version is both fastest and smallest.
 */
function loadDocs(): Doc[] {
  const paths = [...new Set(SCAN_ROOTS.flatMap((root) => trackedMarkdown(root)))].sort();
  const docs: Doc[] = [];
  for (const path of paths) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      continue; // listed but absent: a stale index entry, not this gate's business
    }
    if (size < MIN_BYTES) continue;
    const lines = substantiveLines(path);
    if (lines.length === 0) continue;
    const counts = new Map<string, number>();
    for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
    docs.push({
      rel: relative(DISPLAY_ROOT, path).split(/[/\\]/).join('/'),
      total: lines.length,
      counts
    });
  }
  return docs;
}

/** Exact shared-multiset size. Never an estimate. */
function sharedLineCount(a: Doc, b: Doc): number {
  const [smaller, larger] = a.total <= b.total ? [a, b] : [b, a];
  let shared = 0;
  for (const [line, n] of smaller.counts) {
    const m = larger.counts.get(line);
    if (m !== undefined) shared += Math.min(n, m);
  }
  return shared;
}

interface Overlap {
  readonly a: string;
  readonly b: string;
  readonly shared: number;
  readonly ratio: number;
}

function findOverlaps(docs: readonly Doc[]): Overlap[] {
  const found: Overlap[] = [];
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const a = docs[i];
      const b = docs[j];
      const smallerTotal = Math.min(a.total, b.total);
      // Cannot reach the absolute floor even under total containment.
      if (smallerTotal < MIN_SHARED_LINES) continue;
      const shared = sharedLineCount(a, b);
      if (shared < MIN_SHARED_LINES) continue;
      const ratio = shared / smallerTotal;
      if (ratio < MIN_OVERLAP) continue;
      const [x, y] = [a.rel, b.rel].sort();
      found.push({ a: x, b: y, shared, ratio });
    }
  }
  // Sorted, so two runs over one tree produce byte-identical output.
  return found.sort((p, q) => `${p.a}|${p.b}`.localeCompare(`${q.a}|${q.b}`));
}

const describeOverlap = (o: Overlap): string =>
  `${o.a} == ${o.b} (${o.shared} shared substantive lines, ${(o.ratio * 100).toFixed(1)}% of the smaller)`;

describe('no two documents share a body (FR-R3-063, widened by FR-R3-066)', () => {
  const docs = loadDocs();
  const overlaps = findOverlaps(docs);
  const covered = (o: Overlap): DuplicateFamily | undefined =>
    FAMILIES.find((f) => f.covers(o.a, o.b));

  it('scans a substantial tree', () => {
    // Guards the whole file: a scan that reached nothing would report no
    // duplicates and look like a pass.
    expect(docs.length).toBeGreaterThan(MIN_CORPUS);
  });

  it('has no unexplained near-duplicate', () => {
    const unexplained = overlaps.filter((o) => covered(o) === undefined).map(describeOverlap);
    expect(
      unexplained,
      `${unexplained.join('\n  ')}\n\nTwo documents above ${MIN_OVERLAP * 100}% substantive-line ` +
        'overlap are two authorities for one subject. Consolidate them, or add a reasoned family to ' +
        `FAMILIES in this file. The threshold's measurement is in ${MEASUREMENT}.`
    ).toEqual([]);
  });

  // Envelope-only: every allowed family lives at an envelope path, so with
  // `repo/` alone there is no pair to credit and every entry would read stale.
  it.skipIf(!ENVELOPE_PRESENT)('keeps every family live: one whose duplication is gone must leave', () => {
    // EVERY family a pair matches is credited, not just `covered`'s first hit.
    // Two families can legitimately cover one pair -- move a skill definition
    // under `.specify/extensions/*/commands/` and both skill-tree predicates
    // match it -- and crediting only the first would report the second stale
    // while its subject is still in the tree, pushing a contributor to delete a
    // live entry.
    const used = new Set<string>();
    for (const overlap of overlaps) {
      for (const family of FAMILIES) {
        if (family.covers(overlap.a, overlap.b)) used.add(family.name);
      }
    }
    const stale = FAMILIES.filter((f) => !used.has(f.name)).map((f) => f.name);
    expect(
      stale,
      `${stale.join(', ')} no longer matches any pair in the tree. An allowlist entry that outlives its ` +
        'subject is an entry nobody has checked against the rule now in force.'
    ).toEqual([]);
  });

  it('requires a reason for every family', () => {
    for (const family of FAMILIES) {
      expect(family.why.length, `${family.name} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('covers the generated-checklist family by predicate, not by pair', () => {
    // So a new feature's generated checklist needs no allowlist edit. Asserted
    // against synthetic paths rather than today's tree, which is the point: it
    // must hold for features that do not exist yet.
    const family = FAMILIES.find((f) => f.name === 'generated spec-quality checklists');
    expect(family).toBeDefined();
    expect(
      family?.covers(
        'specs/999-a-feature-that-does-not-exist/checklists/requirements.md',
        'specs/998-nor-does-this-one/checklists/requirements.md'
      )
    ).toBe(true);
    // And it must not swallow unrelated pairs under specs/.
    expect(
      family?.covers('specs/999-x/checklists/requirements.md', 'specs/999-x/spec.md')
    ).toBe(false);
  });

  // Envelope-only for the same reason: `repo/` alone has no allowed overlap to
  // verify a reported count against.
  it.skipIf(!ENVELOPE_PRESENT)('reports the exact shared count, not an estimate', () => {
    // Recomputed independently from the files, so the printed number cannot be
    // an artefact of how the pair was found.
    expect(
      overlaps.length,
      'expected at least one allowed overlap to verify the reported count against'
    ).toBeGreaterThan(0);
    const sample = overlaps[0];
    const read = (rel: string): string[] => substantiveLines(resolve(DISPLAY_ROOT, rel));
    const a = read(sample.a);
    const b = read(sample.b);
    const ca = new Map<string, number>();
    for (const l of a) ca.set(l, (ca.get(l) ?? 0) + 1);
    let expected = 0;
    const cb = new Map<string, number>();
    for (const l of b) cb.set(l, (cb.get(l) ?? 0) + 1);
    for (const [l, n] of cb) {
      const m = ca.get(l);
      if (m !== undefined) expected += Math.min(n, m);
    }
    expect(sample.shared).toBe(expected);
    expect(sample.ratio).toBeCloseTo(expected / Math.min(a.length, b.length), 10);
  });

  it('produces deterministic output', () => {
    // The whole pipeline, not `findOverlaps(docs)` twice. That form asserted a
    // pure function returns the same thing for the same argument, which is true
    // by construction; the order that could vary is the enumeration inside
    // `loadDocs`, so that is what is re-run.
    const again = findOverlaps(loadDocs());
    expect(again.map(describeOverlap)).toEqual(overlaps.map(describeOverlap));
  });

  it('does not scan ignored files', () => {
    // The measured reason for tracked-only enumeration: a gitignored document in
    // this tree scores 1.000 against a tracked one. If it were scanned, this gate
    // would fail for every developer who has that directory.
    const scanned = new Set(docs.map((d) => d.rel));
    const ignored = [...scanned].filter((rel) => rel.startsWith('scratch/'));
    expect(
      ignored,
      `${ignored.join(', ')} is gitignored but was scanned. Enumerate with git ls-files.`
    ).toEqual([]);
  });

  it('records its threshold where the number lives', () => {
    // A threshold guessed rather than measured is a gate disabled in its first
    // month. The measurement must be reachable from the number.
    //
    // The first version of this test asserted that THIS FILE contains the string
    // `MEASUREMENT`, which is a literal declared at the top of this same file --
    // true by construction, and unfalsifiable. It therefore never checked what it
    // is named for. What follows asserts the enforced numbers against the
    // document instead, so changing `MIN_OVERLAP` without re-measuring fails.
    const own = readFileSync(resolve(__dirname, 'doc-duplicate-authority.test.ts'), 'utf8');
    expect(own).toContain('MEASURED, not picked');

    let record: string;
    try {
      record = readFileSync(resolve(REPO, MEASUREMENT), 'utf8');
    } catch (err) {
      throw new Error(
        `${MEASUREMENT} is missing or unreadable (${(err as Error).message}). It holds the measured ` +
          'distribution behind MIN_OVERLAP; without it the threshold is a guess.'
      );
    }
    const chosen = `ratio ≥ ${MIN_OVERLAP.toFixed(2)} AND at least ${MIN_SHARED_LINES} shared substantive lines`;
    expect(
      record,
      `${MEASUREMENT} does not state the enforced threshold as "${chosen}". The number in this file and ` +
        'the number in its measurement have diverged; re-measure and record, rather than editing one side.'
    ).toContain(chosen);
  });
});
