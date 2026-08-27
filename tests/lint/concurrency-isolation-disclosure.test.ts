// FR-R3-124 (FR-004, FR-004a, FR-004b) — the shared-tree disclosure has content,
// and no live document sells a cap above one as isolation.
//
// WHAT THIS GUARDS, AND WHY IT IS NOT ALREADY GUARDED.
// `cap-authority-citation-parity.test.ts` enumerates the six sites that define
// `schegent.queue.globalConcurrencyCap`'s range or default and requires each to
// cite `docs/architecture/local-queue-parallelism-ratification.md`. It checks the
// CITATION and never the CONTENT. Every sentence in this tree that tells an
// operator concurrent Runs share one working tree could be deleted today and the
// whole gate set would stay green.
//
// That is the shape round 3 has closed four times — prose that was true when it
// was written, drifting while every gate reported green (`FR-R3-116`, `122`,
// `123`, and `126`, open beside this item). Here it sits on a setting the audit
// of 2026-08-27 named as one of three dominating risks, whose do-not-ignore row 3
// reads: do not market concurrency above one as isolation until Runs have
// separate worktrees.
//
// SO THE DISCLOSURE IS ASSERTED, AT THE PLACES A HUMAN READS IT.
//
// WHICH PLACES, AND A CORRECTION MADE WHILE IMPLEMENTING. The specification's
// clarification named "the three advertising sites" from the citation gate's
// split — `package.json`, `src/config/settings-schema.ts`,
// `src/config/general-settings.ts`. Reading them settled it differently: the two
// under `src/config/` advertise the BOUND to a schema consumer and carry a
// `docLabel` and four numbers. There is no operator-facing sentence in either, so
// a disclosure there would be text no operator ever sees, and requiring one would
// mean writing prose into a schema table to satisfy a gate. The surfaces below are
// the five places the sentence is actually read: the VS Code settings UI (from the
// manifest), the in-product dialog, the operator guide, the authority record, and
// the architecture document.
//
// THE POINT-OF-DECISION SURFACES CARRY MORE. `QueueConfigModal.svelte` and
// `docs/operations/multi-queue-concurrency.md` are where a value is chosen, so
// they must state the CONSEQUENCE (conflicting edits) and not only the fact (one
// tree). The manifest description states the consequence concretely already —
// "every run's edits land in the one shared working tree" — and is held to the
// shared-tree requirement so a future trim cannot empty it.
//
// LIMITS, STATED. The claim scan below is heuristic, in the manner of
// `gate-integrity/vacuity-detector.ts`: it reads text, it cannot parse intent, and
// a sentence that sells isolation in words it does not know will pass. What it buys
// is that the four sentences protecting this posture cannot be deleted silently,
// and that the obvious affirmative claim cannot be added silently.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { filesUnder } from './source-scan';
import { ENVELOPE_ROOT, envelopePresent } from './envelope-presence';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/**
 * "These Runs are in one tree." Written to match every spelling now in the tree
 * rather than to impose a house phrase: `share one working tree`,
 * `shared working tree`, `share the working tree`, `share one worktree`, and
 * `the same operator-owned working tree` all satisfy it.
 */
const SHARED_TREE = /(shar\w*|same)[^.]{0,90}(working tree|worktree)/i;

/** "…and that has a consequence you can hit." */
const CONFLICT = /(conflict\w*|edit the same|same (file|path|files|paths))/i;

interface Surface {
  readonly file: string;
  /** True where the operator is choosing a value, not being told a fact. */
  readonly pointOfDecision: boolean;
  readonly why: string;
}

/**
 * The five surfaces that state the shared tree to a human.
 *
 * Do not take this count from any other comment. `cap-authority-citation-parity`
 * counts SIX definition sites and it is counting a different thing — sites that
 * define the range — three of which carry no prose at all.
 */
const DISCLOSURE_SURFACES: readonly Surface[] = [
  {
    file: 'package.json',
    pointOfDecision: false,
    why: "the cap's markdownDescription is what the VS Code settings UI renders"
  },
  {
    file: 'webview-ui/src/components/QueueConfigModal.svelte',
    pointOfDecision: true,
    why: 'the dialog where the number is actually typed'
  },
  {
    file: 'docs/operations/multi-queue-concurrency.md',
    pointOfDecision: true,
    why: 'the operator guide an operator reads before raising it'
  },
  {
    file: 'docs/architecture/local-queue-parallelism-ratification.md',
    pointOfDecision: false,
    why: 'the authority record every definition site cites'
  },
  {
    file: 'ARCHITECTURE.md',
    pointOfDecision: false,
    why: 'the queue/scheduling section a reviewer reads first'
  }
];

/**
 * Sites that name the cap and are exempt from carrying a disclosure, each with
 * the reason. Two classes:
 *
 *  - ENFORCING — they refuse a value outside the range. A sentence about the
 *    working tree in a validator is read by no operator.
 *  - CARRIES NO PROSE — contract surfaces, generated artifacts, command
 *    handlers, projections, and the two schema tables. They carry the value or
 *    the bound across a boundary and say nothing to anyone.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ['src/state/workspace-state.ts', 'enforces the bound; no operator-facing prose'],
  ['src/queue/queue-manager.ts', 'enforces the bound; no operator-facing prose'],
  ['src/contracts/validators/queue-management.ts', 'enforces the bound; no operator-facing prose'],
  ['src/config/settings-schema.ts', 'schema table: docLabel and four numbers, no prose'],
  ['src/config/general-settings.ts', 'typed accessor table, no prose'],
  ['src/contracts/sidebar-ipc.ts', 'contract surface, carries the field'],
  ['src/contracts/sidebar-ipc/queue.ts', 'contract surface, carries the field'],
  ['src/contracts/generated/boundary-contracts.ts', 'generated from the schema'],
  ['src/contracts/generated/schemas/settings.schema.json', 'generated from the schema'],
  ['src/ui/sidebar/commands/router-types.ts', 'router types, carries the field'],
  ['src/ui/sidebar/snapshot.ts', 'idle projection, carries the value'],
  ['src/commands/cancel.ts', 'passes an already-validated value through'],
  ['src/ui/sidebar/commands/cmd-cancel.ts', 'passes an already-validated value through'],
  ['src/ui/sidebar/commands/cmd-save-queue-settings.ts', 'passes an already-validated value through'],
  ['webview-ui/src/lib/queue-control-ipc.ts', 'posts the value, states no bound'],
  ['webview-ui/src/lib/snapshot-types.ts', 'mirrored contract types, carries the field']
]);

/** Every non-test file naming the cap, by repo-relative path. */
function capMentioningFiles(): string[] {
  const roots = ['src', 'webview-ui/src'];
  const pattern = /globalConcurrencyCap|GlobalConcurrencyCap|GLOBAL_CONCURRENCY_CAP/;
  const found: string[] = ['package.json'];
  for (const root of roots) {
    for (const abs of filesUnder(resolve(REPO_ROOT, root), {
      extensions: ['.ts', '.svelte', '.json']
    })) {
      const rel = relative(REPO_ROOT, abs).split('\\').join('/');
      if (rel.includes('__tests__') || rel.endsWith('.test.ts')) continue;
      if (pattern.test(readFileSync(abs, 'utf8'))) found.push(rel);
    }
  }
  return found.sort();
}

describe('the shared-tree disclosure has content (FR-R3-124)', () => {
  it('names five disclosure surfaces and finds every one of them on disk', () => {
    // Vacuity control, and the only one that matters here: every assertion below
    // reads a file from this list, so a list that silently shrank — a rename, a
    // moved document — would assert over nothing and pass. The length is pinned
    // and every path is resolved.
    expect(DISCLOSURE_SURFACES).toHaveLength(5);
    const missing = DISCLOSURE_SURFACES.map((s) => s.file).filter(
      (file) => !existsSync(resolve(REPO_ROOT, file))
    );
    expect(
      missing,
      'a disclosure surface moved or was deleted. Point this gate at where the sentence ' +
        'now lives, or explain why the surface no longer needs it.'
    ).toEqual([]);
  });

  it('states, at every surface, that concurrent Runs share one working tree', () => {
    const silent = DISCLOSURE_SURFACES.filter((s) => !SHARED_TREE.test(read(s.file))).map(
      (s) => `${s.file} (${s.why})`
    );
    expect(
      silent,
      'these surfaces no longer say that concurrent Runs share one working tree. The audit of ' +
        '2026-08-27 named shared-tree parallelism as one of three dominating risks, and its ' +
        'do-not-ignore row 3 forbids presenting a cap above one as isolation. Restore a sentence ' +
        'saying the Runs are in ONE tree — any spelling of "share/shared/same … working tree|' +
        'worktree" satisfies this. Do not delete it because it reads as a caveat; it is the ' +
        'caveat, and per-Run isolation is gated by ' +
        'docs/architecture/run-isolation-decision.md, not shipped.'
    ).toEqual([]);
  });

  it('states the consequence, not only the fact, where the value is chosen', () => {
    const factOnly = DISCLOSURE_SURFACES.filter((s) => s.pointOfDecision)
      .filter((s) => !CONFLICT.test(read(s.file)))
      .map((s) => `${s.file} (${s.why})`);
    expect(
      factOnly,
      'these surfaces are where an operator picks a cap, so "one working tree" is not enough — ' +
        'they must also say what it costs: conflicting or interleaved edits to the same paths.'
    ).toEqual([]);
  });

  it('classifies every file that names the cap, so a sixth surface cannot appear silently', () => {
    const files = capMentioningFiles();
    // Vacuity control for the sweep: 17 files name the cap today. A pattern or a
    // walk that stopped matching would produce an empty set and a green gate.
    expect(
      files.length,
      'no file was found naming the concurrency cap — the sweep no longer matches how this ' +
        'tree spells the setting, so it is comparing nothing to nothing'
    ).toBeGreaterThan(12);

    const disclosing = new Set(DISCLOSURE_SURFACES.map((s) => s.file));
    const unclassified = files.filter((file) => !disclosing.has(file) && !EXEMPT.has(file));
    expect(
      unclassified,
      'these files name the concurrency cap and are neither a disclosure surface nor exempt. ' +
        'Decide which: if the file shows an operator the cap, add it to DISCLOSURE_SURFACES and ' +
        'give it the sentence; if it carries the value or enforces the bound without prose, add ' +
        'it to EXEMPT with the reason. Leaving it unclassified is how a new UI surface gets the ' +
        'cap and not the caveat.'
    ).toEqual([]);

    const gone = [...EXEMPT.keys()].filter((file) => !existsSync(resolve(REPO_ROOT, file)));
    expect(gone, 'EXEMPT names files that no longer exist').toEqual([]);
  });

  it('is red without the disclosure and green with it — proved, not assumed', () => {
    // FR-004a. Every assertion above is "this string is present", and the way that
    // fails silently is a matcher that matches anything. Both matchers are driven
    // against real text from this tree with the disclosure removed.
    const realModalIntent = 'Concurrent Runs share one working tree; semantic conflicts are possible.';
    const strippedModal = 'Concurrent runs. Range 1 to 20.';
    expect(SHARED_TREE.test(realModalIntent)).toBe(true);
    expect(CONFLICT.test(realModalIntent)).toBe(true);
    expect(SHARED_TREE.test(strippedModal)).toBe(false);
    expect(CONFLICT.test(strippedModal)).toBe(false);

    // And against the manifest's real sentence, minus the clause. Parsed rather than
    // regex-sliced: the first version matched the cap block by its indentation, which
    // would have failed on a reformat with a message about the gate rather than about
    // the manifest.
    const manifest = JSON.parse(read('package.json')) as {
      contributes?: {
        configuration?: { properties?: Record<string, { markdownDescription?: string }> };
      };
    };
    const capText =
      manifest.contributes?.configuration?.properties?.['schegent.queue.globalConcurrencyCap']
        ?.markdownDescription;
    expect(
      capText,
      'the cap setting is no longer at contributes.configuration.properties in the manifest'
    ).toBeTypeOf('string');
    expect(SHARED_TREE.test(capText!)).toBe(true);
    expect(SHARED_TREE.test(capText!.replace(/working tree/g, 'queue'))).toBe(false);
  });
});

/**
 * FR-004b — the claim scan.
 *
 * WHAT IT REFUSES TO READ, and this is a decision rather than a gap: `specs/**`
 * and `docs/features/**` under the envelope, plus `docs/audits/**`. Those are
 * dated records of what was true when they were written. `FR-R3-123` settled that
 * they are not rewritten to match today's tree, and `check-doc-links.mjs` states
 * the same rule for moved link targets. A scan that walked them would either fail
 * on true historical sentences or grow an exception list until it meant nothing.
 * Three roots, enumerated, with the reason — not an allowlist.
 */
describe('no live document sells a cap above one as isolation (FR-R3-124)', () => {
  const CONCURRENCY = /concurren|parallel|cap above one|globalConcurrencyCap/i;

  /**
   * An AFFIRMATIVE isolation claim, not the mere co-occurrence of two words.
   *
   * The first draft of this scan matched `concurren…` and `isolat…` on one line and
   * relied on the negation list below to spare the honest sentences. It reported
   * four lines of the decision record on its first run and **three of the four were
   * filenames** — `concurrent-run-isolation-measurement.md`,
   * `concurrency-isolation-disclosure.test.ts`. A path is not a claim, and a scan
   * that cannot tell them apart would be silenced with an exception list within a
   * week. So: code spans are stripped before matching (below), and a claim now
   * needs a verb that asserts the isolation rather than two nouns in a row.
   *
   * The fourth was this record's own sentence describing what the gate forbids —
   * prose *about* the claim, which the verb requirement also spares.
   */
  const CLAIMS_ISOLATION =
    /\b(is|are|becomes?|gets?|gives?|give|provides?|creates?|means?|delivers?|yields?|ensures?|guarantees?|has|have|runs? in|executes? in)\b(?:\s+\S+){0,4}\s+\S*isolat/i;

  /** Inline code, fenced code, HTML comments and link targets are not prose. */
  function proseOnly(line: string): string {
    return line
      .replace(/`[^`]*`/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\]\([^)]*\)/g, '] ')
      .replace(/\bhttps?:\/\/\S+/g, ' ');
  }

  /**
   * Words that make an isolation sentence a DENIAL of isolation rather than a
   * claim of it. Every honest sentence in this tree carries at least one, which is
   * what makes the heuristic usable: the shape being forbidden is an affirmative
   * co-occurrence with no negation anywhere near it.
   */
  const NEGATED =
    /\b(not|no|never|cannot|can't|without|lack|absence|absent|until|unsafe|forbid\w*|gated|share\w*|instead|rather than|does not|do not|refus\w*|declin\w*|unless|would|before)\b/i;

  function liveProseFiles(): string[] {
    const out: string[] = [];
    for (const abs of filesUnder(resolve(REPO_ROOT, 'docs'), { extensions: ['.md'] })) {
      out.push(abs);
    }
    for (const rel of ['ARCHITECTURE.md', 'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'RELEASE.md']) {
      const abs = resolve(REPO_ROOT, rel);
      if (existsSync(abs)) out.push(abs);
    }
    if (envelopePresent()) {
      for (const rel of ['ARCHITECTURE.md', 'README.md', 'PRODUCT.md', 'DESIGN.md']) {
        const abs = resolve(ENVELOPE_ROOT, rel);
        if (existsSync(abs)) out.push(abs);
      }
      // Envelope decision records are live; `specs/`, `docs/features/` and
      // `docs/audits/` are dated records and are not read. See the docblock.
      const envelopeArchitecture = resolve(ENVELOPE_ROOT, 'docs', 'architecture');
      if (existsSync(envelopeArchitecture)) {
        for (const abs of filesUnder(envelopeArchitecture, { extensions: ['.md'] })) out.push(abs);
      }
    }
    return out;
  }

  const files = liveProseFiles();

  it('reads a non-trivial corpus of live prose', () => {
    // Vacuity control. The assertion below is "the offender list is empty", and an
    // empty corpus satisfies it perfectly.
    expect(
      files.length,
      'the live-prose corpus is empty or nearly so — the walk no longer finds the ' +
        'documentation it is meant to read'
    ).toBeGreaterThan(40);
  });

  it('contains no affirmative claim that concurrency above one is isolated', () => {
    const offenders: string[] = [];
    for (const abs of files) {
      const lines = readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const prose = proseOnly(line);
        if (!CONCURRENCY.test(prose) || !CLAIMS_ISOLATION.test(prose)) return;
        if (NEGATED.test(prose)) return;
        offenders.push(`${relative(REPO_ROOT, abs)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(
      offenders,
      'these lines put concurrency and isolation together with no denial between them. Per-Run ' +
        'isolation does not exist in this product — the shape is decided in ' +
        'docs/architecture/run-isolation-decision.md and gated there. Say what is true: Runs ' +
        'above a cap of one share one working tree.'
    ).toEqual([]);
  });

  it('catches the claim, spares the denial, and spares a filename — proved on all three', () => {
    // FR-004a for the scan half, and the third case is here because it is the one
    // this scan actually got wrong on its first run.
    const reports = (line: string): boolean => {
      const prose = proseOnly(line);
      return CONCURRENCY.test(prose) && CLAIMS_ISOLATION.test(prose) && !NEGATED.test(prose);
    };

    expect(reports('Raising the concurrency cap gives each Run an isolated checkout.')).toBe(true);
    expect(reports('At cap 4 each concurrent Run is isolated from its siblings.')).toBe(true);
    expect(
      reports('Raising the concurrency cap does not give each Run an isolated checkout.')
    ).toBe(false);
    expect(
      reports('the concurrency measurement (`docs/operations/concurrent-run-isolation-x.md`) ran'),
      'a filename that happens to contain both words is not a claim'
    ).toBe(false);
    expect(
      reports('a live document must not present a cap above one as isolation'),
      'prose ABOUT the prohibition is not the prohibited claim'
    ).toBe(false);
  });
});
