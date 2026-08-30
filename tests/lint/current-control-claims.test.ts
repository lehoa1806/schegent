import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- .mjs generator, typed by use rather than by declaration
import { controlFacts, decideControlParity, CONTROLS_DOC, BLOCK_START, BLOCK_END } from '../../scripts/current-control-facts.mjs';

/**
 * FR-R3-138 (FR-011 – FR-014a) — no live page asserts, in the present tense, a
 * control this repository does not have.
 *
 * THE DEFECT. `FR-R3-099` retired every hosted workflow by operator decision and
 * deleted `.github/workflows/`. Four documents went on describing what those
 * workflows do. `./CONTRIBUTING.md:3` told a contributor the checked-in CI workflows
 * are configured for `develop`; `SECURITY.md:170` said the withdrawn scheduled audit
 * is now run by the gate, which does not run it; `RELEASE.md:380` said nothing
 * generates an SBOM, which `npm run package` does; `docs/operations/licenses.md`
 * described a dependency-review action, a weekly audit workflow and release
 * checksums, none of which exist. Four of the sites were self-contradictions — the
 * same file already stated the truth in another section.
 *
 * WHY A GATE AND NOT A CORRECTION. Correcting the pages fixes today. The same class
 * of defect arrived with `FR-R3-066`, again with `FR-R3-090` and again with
 * `FR-R3-099`: a control is withdrawn, and the documents describing it are found one
 * at a time, by a reader, later. The facts below are derived from the tree on every
 * run, so the next retirement turns the stale pages red instead of stranding them.
 *
 * THE PATTERNS ARE ASSERTION-SHAPED, NOT NOUN-SHAPED — and this is the whole
 * difficulty of the gate. `Workflow` is a Schegent domain type and `provenance` is a
 * field on `ExecutionEnvelope`; an unqualified sweep for those words returns 661
 * files, and `docs/explanation/domain-model.md`'s three hits are the product's own
 * field. Worse, `RELEASE.md` and `SECURITY.md` carry tables whose middle column
 * *describes the withdrawn control* — "`gh attestation verify --signer-workflow`",
 * "`ci.yml` on ubuntu, macOS and Windows" — beside a third column that truthfully
 * says **None**. So every pattern matches a claim being made ("the workflow runs
 * X", "nothing generates one") rather than a subject being mentioned, and every
 * pattern stops at a `|` so one table cell cannot be read as another's.
 *
 * THE SCAN SET IS THE INVENTORY (FR-002, T1533a). Rather than a prose list of paths
 * that goes stale, the scope predicate is stated here beside the code that
 * implements it, so running the gate enumerates the surfaces:
 *
 *   rg -c --hidden --glob '*.md' --glob '.npmrc' --glob 'package.json' \
 *     -e '\.github/workflows' -e 'GitHub Action' -e 'CodeQL' \
 *     -e 'dependency-review' -e 'dependency review' -e 'SBOM' -e 'checksum' \
 *     -e 'provenance' -e 'attestation' -e 'npm audit' \
 *     -e '(CI|ci\.yml|pr\.yml|full-gate\.yml|canary)[^a-z]*workflow' \
 *     -e 'workflow (run|job|file|dir)' -e 'scheduled (audit|workflow|canary)' \
 *     --glob '!node_modules' --glob '!webview-ui/node_modules' .
 *
 * `--hidden` is load-bearing: without it `rg` silently skips `.github/`, which still
 * exists — `dependabot.yml`, `CODEOWNERS`, `ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`
 * and a GitHub-standard `SECURITY.md` all survived `FR-R3-099`, and only `workflows/`
 * was deleted. A pull-request template is exactly where "CI will check this" lives,
 * so an inventory that cannot see it is not an inventory.
 *
 * DEPENDABOT IS DELIBERATELY NOT A CLAIM PATTERN. `.github/dependabot.yml` is
 * present and Dependabot is GitHub-native — it needs no workflow — so
 * `SECURITY.md:104`'s present tense is correct. It is the one control in this
 * neighbourhood a truthful page still describes as running, and a registry entry for
 * it would make this gate demand a false correction.
 *
 * WHAT THIS GATE CANNOT SEE, stated rather than discovered later. A page marked
 * `<!-- doc-class: record -->` is skipped entirely (FR-012), so a live claim written
 * onto a record page is invisible here — `docs/release/withdrawn-ci-controls.md:20`
 * was one, and was corrected by hand. The skip is per-page because the alternative
 * is a per-sentence exemption list, and this repository has removed two of those.
 *
 * HERMETIC. `readFileSync` only: no spawned binary, no network, no `git` (FR-014,
 * `FR-R3-033`).
 */
const REPO_ROOT = resolve(__dirname, '..', '..');

/** The machine half of the currency taxonomy in `docs/README.md` (FR-012). */
const RECORD_MARKER = '<!-- doc-class: record -->';

/** Where a real marker sits: its own line, directly under the H1, on all five record pages. */
const MARKER_WINDOW = 10;

/**
 * A page is a record when it *carries* the marker, not when it *mentions* it.
 *
 * A plain `body.includes(RECORD_MARKER)` reads as obviously correct and is not: it exempts
 * `docs/README.md`, which defines the taxonomy, and it exempted this gate's own record in
 * `docs/development/gate-integrity-measurements.md` the moment that record quoted the
 * marker to explain what it does. Both mentions are inline code inside a sentence. So a
 * page could opt out of the gate by describing the opt-out — and would do it silently,
 * because a skipped page reports nothing.
 *
 * Own line, within the first ten. Every one of the five record pages puts it on line 3.
 */
function isRecordPage(body: string): boolean {
  return body
    .split('\n', MARKER_WINDOW)
    .some((line) => line.trim() === RECORD_MARKER);
}

/**
 * Floors, not decoration — the vacuity shape `tests/lint/gate-integrity/vacuity-detector.ts`
 * classifies and `scanning-gates-prove-they-scanned.test.ts` requires a control for.
 * There are three ways for the offenders assertion to pass over nothing: no pages, no
 * units carved out of those pages, and no live pattern.
 *
 * NOT A FLOOR ON MATCHES IN THE TREE, which is what this gate carried on its first
 * draft and which is wrong in a way worth recording. A count of registry hits against
 * the working tree can only be met by claims that are still there — so the floor was
 * satisfiable before the corrections in this change and unsatisfiable after them, and
 * the only way to keep it green would have been to leave defects standing. A gate whose
 * liveness proof requires the defect to persist is not a gate. The registry proves it
 * still matches against a fixture instead (`PROBES`), through the same unit-splitting
 * and qualifier path the tree goes through.
 */
// Measured 2026-08-29: 103 pages, 4997 units. Both floors sit near 60% of that — low
// enough that deleting a docs section does not fail the gate, high enough that the two
// failures worth catching do: an empty scan set, and a `unitsOf` regression that
// collapses each page to one unit (which would read ~103, the shape that let one dated
// table row discharge a whole table on this gate's first run).
const MIN_PAGES_SCANNED = 60;
const MIN_UNITS_SCANNED = 3000;

type Fact =
  | 'workflowsExist'
  | 'auditInGateClosure'
  | 'releaseReachesSbom'
  | 'emitsChecksums'
  | 'emitsIndependentProvenance'
  | 'nodeFloorIsExecuted';

interface ClaimPattern {
  readonly id: string;
  readonly pattern: RegExp;
  readonly asserts: Fact;
  /** `affirms`: the sentence says the fact is true. `denies`: it says the fact is false. */
  readonly polarity: 'affirms' | 'denies';
  readonly why: string;
  /**
   * A sentence of the shape this entry exists to catch. It is the entry's liveness
   * proof: the fixture test asserts every `probe` still matches, so a pattern that
   * decays into matching nothing fails here instead of going quiet over the tree.
   * Write it as the defect would really have been written, not as a regex read aloud.
   */
  readonly probe: string;
}

/** How each fact is read out of the tree, quoted back in the failure message. */
const DERIVATION: Readonly<Record<Fact, string>> = {
  workflowsExist: 'count of `.yml`/`.yaml` files in `.github/workflows/`',
  auditInGateClosure: 'whether any script reachable from `npm run gate` runs `npm audit`',
  releaseReachesSbom: 'whether the closure of `npm run release` reaches `sbom`',
  emitsChecksums: 'a digest-writing producer in the release closure or in `scripts/`',
  emitsIndependentProvenance: 'a cosign/sigstore/in-toto/SLSA producer in that same set',
  nodeFloorIsExecuted: '`engine-strict` in `.npmrc`, or an executed file that reads `engines`'
};

const REGISTRY: readonly ClaimPattern[] = [
  {
    // CI-qualified in the phrase itself, not by a word somewhere in the paragraph.
    // `workflow` on its own is a Schegent domain noun — `workflow-run` is an event
    // name, `Workflows compose multiple Pipeline Runs` is the product's own
    // composition rule — and an unqualified verb-phrase sweep flagged thirty of
    // those before this qualifier was added.
    id: 'workflow-acts',
    pattern: /\b(?:CI|PR|pull[- ]request|release|security|weekly|scheduled|full-gate|canary|tag|GitHub|CodeQL|dependency[- ]review)\b[^.|\n]{0,25}\bworkflows?\b[^.|\n]{0,45}\b(?:runs?|fails?|says?|comments?|generates?|analyzes?|installs?|builds?|packages?|refuses?)\b/gi,
    asserts: 'workflowsExist',
    polarity: 'affirms',
    why: 'a CI workflow is described as doing something, in the present tense, and no workflow file exists',
    probe: 'The release workflow packages the extension and uploads the VSIX.'
  },
  {
    // The passive, with the subject trailing. `workflow-acts` reads verb-after-noun and
    // is blind to "is run by the … workflows", which is how `docs/operations/licenses.md:45`
    // stated it — a live false claim that survived this gate's first green run.
    id: 'workflow-acts-passive',
    pattern: /\b(?:run|executed|performed|invoked|enforced|checked|generated|built|packaged|published|scanned)\s+by\s+(?:the\s+)?[^.|\n]{0,50}\bworkflows?\b/gi,
    asserts: 'workflowsExist',
    polarity: 'affirms',
    why: 'work is described as done by a CI workflow, in the present tense, and no workflow file exists',
    probe: 'It is run by the pull-request, CI, and release workflows.'
  },
  {
    // `workflow file` and `the workflows'` are unambiguous: the product has runs and
    // controllers, never files. Both name a workflow as a live authority.
    id: 'workflow-as-authority',
    pattern: /\bworkflow files?\b|\bthe workflows'\b/gi,
    asserts: 'workflowsExist',
    polarity: 'affirms',
    why: 'a workflow file is named as a live authority, and no workflow file exists',
    probe: 'The workflow files are the authority on what runs before a merge.'
  },
  {
    id: 'github-action-live',
    pattern: /\bactions\/[\w-]+\b|\bCodeQL\b[^.|\n]{0,40}\b(?:analyzes?|runs?|scans?)\b|\bdependency[- ]review-action\b/gi,
    asserts: 'workflowsExist',
    polarity: 'affirms',
    why: 'a GitHub Action is described as running, and nothing invokes one',
    probe: 'CodeQL analyzes the host bundle on every push to `develop`.'
  },
  {
    id: 'workflow-configured',
    pattern: /\b(?:checked-in|checked in)\s+(?:\w+\s+){0,3}workflows?\b|\bworkflows?\s+(?:are|is|currently)\s+configured\b/gi,
    asserts: 'workflowsExist',
    polarity: 'affirms',
    why: 'a reader is told workflows are checked in or configured, and the directory holds none',
    // `./CONTRIBUTING.md:3`, verbatim as it stood before this change.
    probe: 'The checked-in CI workflows are configured for `develop`.'
  },
  {
    id: 'workflow-path-live',
    pattern: /\.github\/workflows\//g,
    asserts: 'workflowsExist',
    polarity: 'affirms',
    why: 'a workflow path is cited as a live location or authority, and the directory does not exist',
    probe: 'See `.github/workflows/ci.yml` for the platform matrix.'
  },
  {
    id: 'audit-in-gate',
    pattern: /\baudits?\b[^.|\n]{0,50}\b(?:run |handled |covered )?by the (?:attested )?(?:gate|chain)\b|\b(?:gate|attested chain)\b[^.|\n]{0,50}\bruns? (?:the )?(?:npm )?audit\b|\baudit\b[^.|\n]{0,40}\bstays in the attested (?:gate|chain)\b/gi,
    asserts: 'auditInGateClosure',
    polarity: 'affirms',
    why: 'the dependency audit is described as covered by the attested gate, which does not reach it',
    // `SECURITY.md:170`, verbatim as it stood before this change.
    probe: 'The dependency audit is now run by the gate instead of by a clock.'
  },
  {
    id: 'sbom-denied',
    pattern: /\bnothing generates (?:one|it|an SBOM)\b|\bno SBOM is (?:generated|produced|emitted)\b|\bemits no SBOM\b/gi,
    asserts: 'releaseReachesSbom',
    polarity: 'denies',
    why: 'a reader is told no SBOM is produced, and `npm run package` produces one on every package',
    // `RELEASE.md:380`, verbatim as it stood before this change.
    probe: 'Nothing generates one.'
  },
  {
    id: 'checksums-produced',
    pattern: /\bgenerates? (?:an? )?(?:[\w-]+ ){0,3}SBOM and checksums\b|\bchecksums? (?:are|is) (?:generated|produced|published)\b|\bpublishes? checksums\b/gi,
    asserts: 'emitsChecksums',
    polarity: 'affirms',
    why: 'checksums are described as produced, and nothing in the release closure writes a digest',
    probe: 'Checksums are published beside the VSIX on the release page.'
  },
  {
    id: 'provenance-produced',
    pattern: /\b(?:attestations?|provenance)\b[^.|\n]{0,40}\b(?:is|are) (?:published|produced|signed|generated)\b|\b(?:publishes?|produces?|signs?)\b[^.|\n]{0,30}\b(?:build provenance|signed attestation)\b/gi,
    asserts: 'emitsIndependentProvenance',
    polarity: 'affirms',
    why: 'verifiable build provenance is described as produced; the gate attestation is a local record, not a signature',
    probe: 'Build provenance for the tagged artifact is signed at release time.'
  },
  {
    id: 'node-floor-executed',
    pattern: /\b(?:CI|the gate|a job|a workflow)\b[^.|\n]{0,40}\bverif(?:ies|y)\b[^.|\n]{0,30}\bNode\b|\bNode\b[^.|\n]{0,25}\bfloor\b[^.|\n]{0,30}\b(?:is|are) (?:verified|checked|enforced)\b/gi,
    asserts: 'nodeFloorIsExecuted',
    polarity: 'affirms',
    why: 'the Node floor is described as verified by something that runs, and nothing reads it',
    probe: 'CI verifies the declared Node floor before installing.'
  }
];

/**
 * The negative control, and the reason the patterns look the way they do.
 *
 * Every sentence here is the product talking about itself: `Workflow` is a Schegent
 * domain type, `workflow-run` a domain event, `provenance` a field on
 * `ExecutionEnvelope`. An earlier draft of this registry flagged thirty passages of
 * exactly this shape across `ARCHITECTURE.md`, `glossary.md`, `domain-model.md`,
 * `api-and-cli.md`, `threat-model.md` and `whitepaper.md`. A gate that cries wolf over
 * the domain model gets a blanket exemption bolted onto it within a release, and the
 * exemption is what actually fails — so the discrimination is asserted, not hoped for.
 */
const PRODUCT_VOCABULARY = [
  'Workflows compose multiple Pipeline Runs, and each Run belongs to exactly one Workflow.',
  'The `workflow-run` domain event carries `provenance` on its `ExecutionEnvelope`.',
  'The Run projection surfaces that provenance field to the webview without rewriting it.',
  'A Workflow definition is inert until a controller schedules it.'
].join('\n\n');

/**
 * What makes an occurrence something other than a live claim: historical, or
 * hypothetical.
 *
 * The hypothetical half is one word and it earns its place. `SECURITY.md:102`
 * describes the workflow-pin check as covering "any workflow file that reappears" —
 * a latent guard, correctly stated, and the only true sentence in this repository
 * that has to name a workflow file in the present tense. Without `reappear` the gate
 * would demand it be falsified.
 *
 * Deliberately NOT the qualifier list in `actions-retirement-claims.test.ts`, and
 * not a shared one. That gate asks whether a *negative* claim is dated enough to be
 * a record, so a citation of the terminal record discharges it. This gate asks
 * whether a *positive* claim is still true, and a citation discharges nothing —
 * `docs/operations/licenses.md` cites `actions-terminal-record.md` beside three
 * false present-tense claims, and reusing that list would have exempted exactly the
 * defect this gate was written to catch. A bare date is likewise not a qualifier
 * here. Only words that mark the claim itself as no longer holding.
 */
const QUALIFIERS: readonly RegExp[] = [
  /\bretired\b/i,
  /\bwithdrawn\b/i,
  /\bsuperseded\b/i,
  /\bno longer\b/i,
  /\bused to\b/i,
  /\bdeleted\b/i,
  /\bdoes not exist\b/i,
  /\bformerly\b/i,
  /\bhistorical(?:ly)?\b/i,
  /\bwas false\b/i,
  /\breappear(?:s|ed|ing)?\b/i
];

interface Unit {
  readonly text: string;
  readonly startLine: number;
}

/**
 * The unit is a paragraph plus an immediately-following block quote.
 *
 * The same unit `actions-retirement-claims.test.ts` settled on, for the same reason:
 * a claim and its qualifier wrap, so a line-based rule is defeated by reflowing the
 * prose, and this repository's convention for annotating a falsified statement is a
 * `>` block placed after it rather than an edit inside it.
 *
 * EXCEPT a table row, which is its own unit. The wrapping argument is about prose; a
 * row does not wrap, and both `RELEASE.md` §"what was withdrawn" and `SECURITY.md`'s
 * substitute table are tables whose *first* rows carry a date. Treating the table as
 * one unit let one dated row discharge every other row in it, and that is precisely
 * how `RELEASE.md:380` ("nothing generates one") and `SECURITY.md:170` ("run by the
 * gate instead of by a clock") survived — two of the four defects this gate exists
 * for went unreported on the first run until the unit was narrowed.
 *
 * `.npmrc` is not Markdown, so its `#` prefixes are stripped first and a bare `#`
 * line counts as the blank line it visually is. Without that the whole 25-line header
 * is one unit, and "With scripts off it no longer runs" — a true statement about
 * `postinstall` — would discharge the false workflow claim eighteen lines above it.
 */
function unitsOf(body: string, isComment: boolean): readonly Unit[] {
  const lines = (isComment ? body.replaceAll(/^#[ \t]?/gm, '') : body).split('\n');
  const blocks: Unit[] = [];
  let current: string[] = [];
  let start = 1;
  const flush = () => {
    if (current.length > 0) blocks.push({ text: current.join('\n'), startLine: start });
    current = [];
  };
  lines.forEach((line, index) => {
    if (line.trim() === '') {
      flush();
      start = index + 2;
      return;
    }
    if (line.trimStart().startsWith('|')) {
      flush();
      blocks.push({ text: line, startLine: index + 1 });
      start = index + 2;
      return;
    }
    if (current.length === 0) start = index + 1;
    current.push(line);
  });
  flush();

  return blocks.map((block, i) => {
    const next = blocks.at(i + 1);
    if (next === undefined || !next.text.trimStart().startsWith('>')) return block;
    return { text: `${block.text}\n\n${next.text}`, startLine: block.startLine };
  });
}

/** Markdown under `dir`, skipping `node_modules` and dot-directories. */
function markdownFiles(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) markdownFiles(full, out);
    else if (entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** The scan set the predicate in the docblock describes. */
function scanned(): readonly string[] {
  const rootMarkdown = readdirSync(REPO_ROOT)
    .filter((name) => name.endsWith('.md'))
    .map((name) => resolve(REPO_ROOT, name));
  const githubDir = resolve(REPO_ROOT, '.github');
  const githubMarkdown = (() => {
    try {
      return readdirSync(githubDir)
        .filter((name) => name.endsWith('.md'))
        .map((name) => join(githubDir, name));
    } catch {
      return [];
    }
  })();
  const issueTemplates = (() => {
    try {
      const dir = join(githubDir, 'ISSUE_TEMPLATE');
      return readdirSync(dir).map((name) => join(dir, name));
    } catch {
      return [];
    }
  })();
  return [
    ...new Set([
      ...markdownFiles(resolve(REPO_ROOT, 'docs')),
      ...rootMarkdown,
      ...githubMarkdown,
      ...issueTemplates,
      resolve(REPO_ROOT, '.npmrc'),
      resolve(REPO_ROOT, 'webview-ui', '.npmrc')
    ])
  ];
}

function factValue(facts: Record<string, unknown>, fact: Fact): boolean {
  if (fact === 'workflowsExist') return Number(facts.workflowFileCount) > 0;
  return facts[fact] === true;
}

interface Match {
  readonly claim: ClaimPattern;
  readonly where: string;
  readonly text: string;
}

/**
 * The generated block is not prose and is not scanned as prose.
 *
 * `current-release-controls.md` states the facts, so its block necessarily contains
 * their negatives — "holds no workflow file", "no CodeQL scan" — written by the same
 * derivation these patterns are checked against. Reading it back through them is
 * circular twice over: `renderControlBlock` would have to phrase its output around
 * this file's regexes, and rewording a true negative would turn the page red for
 * saying something correct. The block is checked by the exact-parity assertion at the
 * bottom of this file, which is strictly stronger — it compares the whole block,
 * character for character, against a fresh render of the facts.
 *
 * Blanked rather than removed, so reported line numbers still point at the real line.
 */
function withoutDerivedBlock(body: string): string {
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (start === -1 || end === -1 || end < start) return body;
  const stop = end + String(BLOCK_END).length;
  return body.slice(0, start) + body.slice(start, stop).replaceAll(/[^\n]/g, '') + body.slice(stop);
}

interface Scan {
  readonly units: number;
  readonly matches: readonly Match[];
}

/**
 * One document, from text to matches. The fixture and the tree both go through here,
 * so a probe proves the whole path is live — unit splitting, qualifier skip, registry
 * — and not merely that a regex literal still compiles.
 */
function scanBody(where: string, body: string, isComment = false): Scan {
  const found: Match[] = [];
  const units = unitsOf(body, isComment);
  for (const unit of units) {
    if (QUALIFIERS.some((q) => q.test(unit.text))) continue;
    // Matched against the unit with its newlines flattened to spaces, because this
    // repository hard-wraps its prose and every pattern stops at `\n`. Unflattened, the
    // registry can only see a claim that happens to fit on one source line —
    // `docs/operations/licenses.md:45` ("is run by the pull-request, CI,\nand release
    // workflows") is a real defect that survived the first green run for no reason but
    // where the line broke. `\n` → ' ' is length-preserving, so `hit.index` still indexes
    // the original and the reported line number is the real one.
    const flat = unit.text.replaceAll('\n', ' ');
    for (const claim of REGISTRY) {
      for (const hit of flat.matchAll(claim.pattern)) {
        const line = unit.startLine + unit.text.slice(0, hit.index).split('\n').length - 1;
        found.push({ claim, where: `${where}:${line}`, text: hit[0] });
      }
    }
  }
  return { units: units.length, matches: found };
}

/** Every registry match on a live page, defect or not. */
function scanTree(files: readonly string[]): Scan {
  const found: Match[] = [];
  let units = 0;
  for (const file of files) {
    let body: string;
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (isRecordPage(body)) continue;
    const scan = scanBody(relative(REPO_ROOT, file), withoutDerivedBlock(body), file.endsWith('.npmrc'));
    units += scan.units;
    found.push(...scan.matches);
  }
  return { units, matches: found };
}

describe('FR-R3-138 — live pages state the controls this repository actually has', () => {
  const files = scanned();
  const facts = controlFacts(REPO_ROOT);
  const tree = scanTree(files);

  it('scanned a non-empty set of pages, carved into a non-empty set of units', () => {
    expect(files.length).toBeGreaterThan(MIN_PAGES_SCANNED);
    // Files read is not text examined: `unitsOf` is where a page becomes claims, and a
    // bug there would leave the assertion below iterating an empty list over a full
    // scan set. This counts what the registry was actually offered.
    expect(tree.units).toBeGreaterThan(MIN_UNITS_SCANNED);
  });

  it('every registry entry still matches the claim shape it was written for', () => {
    // The liveness half. A pattern is only a gate while it still fires, and nothing in
    // the working tree can prove that once the tree is correct — which, after this
    // change, it is. Each probe goes through the same `scanBody` path the tree does.
    const dead = REGISTRY.filter(
      (claim) => !scanBody('probe', claim.probe).matches.some((hit) => hit.claim.id === claim.id)
    ).map((claim) => `${claim.id} no longer matches its own probe: "${claim.probe}"`);
    expect(
      dead,
      'A claim pattern stopped matching the defect it exists to catch. Either the pattern ' +
        'was narrowed past its purpose while chasing a false positive, or the probe was ' +
        'reworded to something the entry was never meant to catch. Fix the pattern; do not ' +
        'rewrite the probe to suit it.'
    ).toEqual([]);
  });

  it('the product’s own vocabulary is not a claim about CI', () => {
    // The specificity half, and the more expensive of the two to get wrong.
    const falsePositives = scanBody('domain-prose', PRODUCT_VOCABULARY).matches.map(
      (hit) => `${hit.where} [${hit.claim.id}] "${hit.text}"`
    );
    expect(
      falsePositives,
      'A claim pattern matched Schegent’s domain vocabulary. `Workflow` is a product type ' +
        'and `provenance` an envelope field; a pattern broad enough to flag them will flag ' +
        'the architecture docs, and the exemption someone adds to quiet it is what fails ' +
        'next. Qualify the pattern with a CI-specific word inside the matched phrase.'
    ).toEqual([]);
  });

  it('no live page asserts a control the tree does not have', () => {
    const offenders = tree.matches
      .filter((hit) => (hit.claim.polarity === 'affirms') !== factValue(facts, hit.claim.asserts))
      .map(
        (hit) =>
          `${hit.where} [${hit.claim.id}] "${hit.text}" — ${hit.claim.why}. ` +
          `${hit.claim.asserts}=${String(factValue(facts, hit.claim.asserts))}, derived from ${DERIVATION[hit.claim.asserts]}`
      );
    expect(
      offenders,
      'A page states, in the present tense, a control this repository does not have — or denies ' +
        'one it does. The tree is the authority. Correct the page, or, if it is a historical ' +
        'record, mark it `<!-- doc-class: record -->` and give it a dated withdrawal banner. ' +
        `The current state of every control is generated into ${CONTROLS_DOC}.`
    ).toEqual([]);
  });

  it('the generated controls page states exactly what the facts derive (FR-014a)', () => {
    const page = (() => {
      try {
        return readFileSync(resolve(REPO_ROOT, CONTROLS_DOC), 'utf8');
      } catch {
        return '';
      }
    })();
    // `decideControlParity`, not a second comparison written here. The generator already
    // owns the question "does the page state the facts", and the CLI's `--write`-less mode
    // asks it the same way; re-implementing the comparison in the test is the duplicate
    // authority C1 refused when it declined to write a second closure walker.
    const verdict = decideControlParity(page, facts);
    expect(
      verdict.ok,
      `${verdict.reason ?? ''}: ${verdict.message ?? ''} This import is also what keeps the ` +
        'generator from becoming a script nobody runs.'
    ).toBe(true);
  });

  /**
   * `nodeFloorIsExecuted` is the one fact whose true value asserts a control, so it is
   * the one whose false positive is expensive: the generated page would tell a reader
   * the Node floor is enforced by something. `controlFacts` takes `root` precisely so
   * this can be answered against a built tree rather than argued about.
   *
   * The near miss is not hypothetical. `engines.vscode` is read in
   * `tests/integration/runTest.ts`, `tests/lint/vscode-floor-claim.test.ts` and
   * `tests/lint/asserted-counts.test.ts`; a `scripts/` file doing the same is one
   * refactor away, and it enforces a floor on the editor, not on Node.
   */
  describe('the Node-floor fact reads the node key, not the word `engines`', () => {
    // Composed rather than written out, and deliberately: these trees are built under
    // `mkdtemp`, so the id below is not a path in this repository. Spelling it as one
    // string literal would make `lint-anchor-grounding.test.ts` read it as a claim about
    // a `scripts/` file that does not exist — correctly, on the evidence it has.
    const PROBE_FILE = 'probe.mjs';
    const PROBE_ID = `scripts/${PROBE_FILE}`;

    function treeWith(scriptSource: string): string {
      const root = mkdtempSync(join(tmpdir(), 'control-facts-'));
      mkdirSync(join(root, 'scripts'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ scripts: { release: 'echo release' }, engines: { node: '^22 || ^24' } })
      );
      writeFileSync(join(root, 'scripts', PROBE_FILE), scriptSource);
      return root;
    }

    it('does not flip on a read of `engines.vscode`', () => {
      const facts = controlFacts(treeWith('const range = manifest.engines?.vscode;\n'));
      expect(facts.nodeFloorIsExecuted, `evidence: ${facts.evidence.nodeFloor.join(', ')}`).toBe(
        false
      );
    });

    it('flips on a read of `engines.node`, so it is a measurement and not a constant', () => {
      const facts = controlFacts(treeWith('const floor = pkg.engines.node;\n'));
      expect(facts.nodeFloorIsExecuted).toBe(true);
      expect(facts.evidence.nodeFloor).toContain(PROBE_ID);
    });

    it('reads the declared floor out of the range it was given', () => {
      // `^22 || ^24` is 22, and `>=22.11.0` is 22 rather than the 0 a minimum over every
      // digit in the string returns. The second is what the first implementation did.
      const facts = controlFacts(treeWith('// nothing\n'));
      expect(facts.nodeFloor).toBe('22');
    });
  });
});
