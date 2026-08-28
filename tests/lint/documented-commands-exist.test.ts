// FR-R3-127 (FR-006a) — a document may not name a command an operator cannot run.
//
// THE FINDING. `docs/operations/evidence-retention-disclosure.md` has told
// operators, since `FR-R3-085`, to run `Schegent: Export Run Evidence` and
// `Schegent: Delete Run Evidence`. Neither command existed. `exportRunEvidence`
// and `deleteRunEvidence` were fully implemented in `src/services/`, with twenty
// unit tests between them, and had **no production caller anywhere** — no manifest
// entry, no IPC handler, no activation wiring.
//
// That is the sixth instance of the form-versus-truth class this round has closed
// (`116`, `122`, `123`, `124`, `126`), and the most operator-facing form of it: the
// reader tries to do the thing and cannot.
//
// WHILE BUILDING THIS GATE IT FOUND TWO MORE. `docs/reference/api-and-cli.md` said
// "These 19 commands appear in the Command Palette" while the manifest declared
// **20**, and the one the page omitted was `schegent.verifyAuditChain` — a command
// about audit-chain integrity, missing from the page an operator reads to find
// commands.
//
// DIRECTION IS DECIDED PER DOCUMENT, BY WHAT THE DOCUMENT CLAIMS.
//
//   * Default, everywhere: a documented title must exist. The reverse — a command
//     no document mentions — is NOT a defect, and asserting it generally would turn
//     this gate into a documentation-completeness mandate nobody asked for.
//   * Exception: `docs/reference/api-and-cli.md` asserts completeness in its own
//     words. Where a page claims to list them all, checking that it does is a check
//     rather than a mandate — so that one page is held in both directions, and its
//     count claim stops being prose.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { filesUnder } from './source-scan';
import {
  MUTATING_COMMAND_ID_LIST,
  READ_ONLY_COMMAND_ID_LIST
} from '../../src/contracts/entry-point-dispositions';

const REPO_ROOT = resolve(__dirname, '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/** The page that claims to list every palette command. */
const COMPLETENESS_PAGE = 'docs/reference/api-and-cli.md';

/**
 * A command title as a document writes it.
 *
 * Anchored on the product prefix because that is how every contributed title is
 * spelled in `package.json`, and because an unanchored "Title Case" scan over prose
 * would report headings.
 *
 * THE FIRST VERSION OF THIS PATTERN WAS WRONG AND THE WAY IT WAS WRONG IS WORTH
 * KEEPING. It required every word to be capitalised, so it truncated every real
 * title containing a connector or a hyphen — `Schegent: Resume Paused or Failed
 * Workflow` came back as `Schegent: Resume Paused`, `Schegint: Export
 * Metadata-Only Audit` as `Schegent: Export Metadata` — and reported nine false
 * offenders on its first run. A gate that cries wolf about real titles is a gate
 * someone deletes. It now runs to a delimiter and keeps the title whole.
 *
 * The FIRST word after the colon must be capitalised, and that is not cosmetic:
 * without it the pattern swallowed notification text — `Schegent: enqueued as
 * <id>`, `Schegent: no audit log yet` — which is this product prefixing a MESSAGE,
 * not naming a command. Later words may be lowercase because real titles contain
 * connectors.
 */
const TITLE = /(Schegent: [A-Z][A-Za-z0-9-]*(?: [A-Za-z0-9][A-Za-z0-9-]*)*)/g;

/**
 * Prose shorthand is not a false promise.
 *
 * `docs/operations/autonomy-bounds-disclosure.md` writes `Schegent: Resume` for
 * `Schegent: Resume Paused or Failed Workflow`. An operator typing that into the
 * palette gets the command — VS Code matches on substring — so a documented PREFIX
 * of a real title names something reachable. `Schegent: Delete Run Evidence` named
 * nothing, which is the difference this gate exists to see.
 */
const namesSomething = (documented: string, titles: ReadonlySet<string>): boolean => {
  if (titles.has(documented)) return true;
  for (const title of titles) if (title.startsWith(documented)) return true;
  return false;
};

interface ManifestCommand {
  readonly command: string;
  readonly title: string;
}

function manifestCommands(): readonly ManifestCommand[] {
  const manifest = JSON.parse(read('package.json')) as {
    contributes?: { commands?: readonly ManifestCommand[] };
  };
  return manifest.contributes?.commands ?? [];
}

/** Every documentation file under `docs/`, plus the two READMEs an operator meets. */
function operatorDocuments(): readonly string[] {
  const out: string[] = [];
  for (const abs of filesUnder(resolve(REPO_ROOT, 'docs'), { extensions: ['.md'] })) {
    out.push(abs.slice(REPO_ROOT.length + 1).split('\\').join('/'));
  }
  for (const rel of ['README.md', 'RELEASE.md', 'CONTRIBUTING.md']) out.push(rel);
  return out;
}

describe('a document may not name a command that does not exist (FR-R3-127)', () => {
  const commands = manifestCommands();
  const titles = new Set(commands.map((entry) => entry.title));
  const documents = operatorDocuments();

  it('finds the manifest commands and the documents it governs', () => {
    // Vacuity control, and it is the control that matters here: every assertion
    // below is "the offender list is empty", so a matcher that stopped matching, or
    // a walk that found no documents, would report green over exactly the defect
    // that shipped.
    expect(commands.length, 'the manifest must declare commands').toBeGreaterThan(15);
    expect(documents.length, 'the documentation walk found nothing').toBeGreaterThan(40);
    const named = documents.flatMap((rel) => [...read(rel).matchAll(TITLE)].map((m) => m[1]!));
    expect(
      new Set(named).size,
      'no `Schegent: <Title>` occurrence was found in any document — the matcher no longer ' +
        'recognises how this project writes a command title, so this gate is comparing nothing'
    ).toBeGreaterThan(5);
  });

  it('every documented command title exists in the manifest', () => {
    const offenders: string[] = [];
    for (const rel of documents) {
      const body = read(rel);
      body.split('\n').forEach((line, index) => {
        for (const match of line.matchAll(TITLE)) {
          const title = match[1]!;
          if (!namesSomething(title, titles)) offenders.push(`${rel}:${index + 1}: '${title}'`);
        }
      });
    }
    expect(
      offenders,
      'These documents tell an operator to run a command the manifest does not contribute. The ' +
        'reader tries it, the palette has nothing, and the document was wrong — which is worse ' +
        'than silence because they now doubt the rest of the page. Either contribute the command ' +
        '(the capability may already exist unwired, as it did for the evidence commands in ' +
        'FR-R3-127) or stop naming it.'
    ).toEqual([]);
  });

  it('the page that claims to list every command lists every command', () => {
    // The one place completeness is claimed, so the one place it is checked.
    const body = read(COMPLETENESS_PAGE);
    const missing = commands.filter((entry) => !body.includes(entry.command));
    expect(
      missing.map((entry) => entry.command),
      `${COMPLETENESS_PAGE} says it lists the palette commands and does not. An operator looking ` +
        'for one of these finds the page silent about it. `schegent.verifyAuditChain` was omitted ' +
        'this way until FR-R3-127.'
    ).toEqual([]);
  });

  it('the count that page asserts is the count the manifest declares', () => {
    // A number in prose about a set the manifest owns. It read 19 against a
    // manifest of 20 until FR-R3-127, which is the smallest possible version of
    // this whole class.
    const body = read(COMPLETENESS_PAGE);
    const claim = /These (\d+) commands appear in the Command Palette/.exec(body);
    expect(
      claim,
      `${COMPLETENESS_PAGE} no longer carries the count sentence this gate reads. If the sentence ` +
        'was removed deliberately, remove this assertion in the same change.'
    ).not.toBeNull();
    expect(Number(claim![1])).toBe(commands.length);
  });

  it('every count the reference page asserts about the command set is derived, not remembered', () => {
    // FR-R3-136 (T1528d-2) — CLOSING THE CLASS, not the instance.
    //
    // The assertion above reads one sentence on one page, and its own comment
    // records the failure it caught: 19 against a manifest of 20. That is a class,
    // and a gate scoped to a single sentence leaves every other count in the corpus
    // exactly as unchecked as that one was. `api-and-cli.md` carried "the other 26
    // commands require successful workspace-bound Stage 2 initialization" while the
    // tree registered 29 — wrong by three, on the page that calls itself the
    // exhaustive reference, and nothing noticed.
    //
    // Every number below is derived from the tree. `ui-wiring.ts` is Stage 2 and
    // `extension.ts` is Stage 1, which is the split the sentence describes; the
    // registration/declaration parity behind these counts is
    // `tests/lint/command-trust-dispositions.test.ts`.
    const guardedIn = (rel: string): number =>
      read(rel).split('registerGuardedCommand(').length - 1;
    const stage2 = guardedIn('src/activation/ui-wiring.ts');
    const stage1 = guardedIn('src/extension.ts');
    expect(stage1, 'Stage 1 registers no command through the guard helper').toBeGreaterThan(0);
    expect(stage2, 'Stage 2 registers no command through the guard helper').toBeGreaterThan(15);

    const total = MUTATING_COMMAND_ID_LIST.length + READ_ONLY_COMMAND_ID_LIST.length;
    expect(
      stage1 + stage2,
      'the guarded call sites and the disposition maps disagree, so the counts below would be ' +
        'derived from the wrong denominator'
    ).toBe(total);

    const body = read(COMPLETENESS_PAGE);
    const claims: readonly { readonly pattern: RegExp; readonly actual: number }[] = [
      { pattern: /the other (\d+) commands require successful workspace-bound Stage 2/, actual: stage2 },
      { pattern: /All (\d+) go through `registerGuardedCommand`/, actual: total },
      { pattern: /registers the (\d+) read-only IDs unwrapped/, actual: READ_ONLY_COMMAND_ID_LIST.length },
      { pattern: /wraps each of the (\d+) mutating ones/, actual: MUTATING_COMMAND_ID_LIST.length },
      { pattern: /every one of the (\d+) registrations goes through `registerGuardedCommand`/, actual: total },
      { pattern: /The (\d+) `mutating` IDs are/, actual: MUTATING_COMMAND_ID_LIST.length },
      { pattern: /The (\d+) `read-only` IDs are registered unwrapped/, actual: READ_ONLY_COMMAND_ID_LIST.length }
    ];

    const offenders: string[] = [];
    for (const claim of claims) {
      const match = claim.pattern.exec(body);
      if (match === null) {
        offenders.push(`${claim.pattern} matches nothing on the page`);
        continue;
      }
      if (Number(match[1]) !== claim.actual) {
        offenders.push(`"${match[0]}" against a tree of ${claim.actual}`);
      }
    }
    expect(
      offenders,
      `${COMPLETENESS_PAGE} makes a numeric claim about the command set that the tree does not ` +
        'support. A count in prose is the one kind of documentation defect that arrives without ' +
        'anybody editing the sentence — someone adds a command, and the number is silently wrong ' +
        'on the page a reviewer trusts most. If a sentence was deliberately reworded, update the ' +
        'pattern here in the same change; a pattern that matches nothing fails too, so this gate ' +
        'cannot rot into silence.'
    ).toEqual([]);
  });

  it('catches a title the manifest lacks and spares one it has — proved', () => {
    // Driven against the two titles that were actually false, and against a real
    // one, so the matcher is shown to discriminate rather than to accept or reject
    // everything.
    const wasFalse = 'Schegent: Delete Run Evidence';
    const line = `| Remove what is held for a Run | \`${wasFalse}\` — reports what it removed |`;
    const found = [...line.matchAll(TITLE)].map((m) => m[1]!);
    expect(found, 'the matcher must find a title written in a table cell').toContain(wasFalse);

    // Whole, not truncated: this is the bug the first pattern had.
    const hyphenated = 'run `Schegent: Export Metadata-Only Audit` from the palette';
    expect([...hyphenated.matchAll(TITLE)].map((m) => m[1]!)).toContain(
      'Schegent: Export Metadata-Only Audit'
    );
    const connector = 'use **Schegent: Resume Paused or Failed Workflow** for that case';
    expect([...connector.matchAll(TITLE)].map((m) => m[1]!)).toContain(
      'Schegent: Resume Paused or Failed Workflow'
    );

    // And the prefix rule discriminates: shorthand for a real title is reachable,
    // a title nothing matches is not.
    expect(namesSomething('Schegent: Resume', titles)).toBe(true);
    expect(namesSomething('Schegent: No Such Command', titles)).toBe(false);
    expect(namesSomething(commands[0]!.title, titles)).toBe(true);
  });
});
