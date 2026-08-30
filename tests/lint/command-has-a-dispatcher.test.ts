// Lifecycle round-check of 2026-08-30 — the fourth item on that audit's
// "coverage to add" list: "a lint test that every `SidebarCommand` arm has a
// dispatcher in `webview-ui/src`, with an explicit allowlist for deliberate
// exceptions. This would have caught C, D, and E mechanically, and would keep
// catching them."
//
// WHAT WENT WRONG
//
// Findings C, D and E were three faces of one omission: a command can carry a
// handler, a validator arm, a guard, a host command and a rejection-message
// table, and be reachable by nobody. Nothing in the suite asked that question.
// Every check asked whether a command *worked*.
//
//   * Finding C — `CMD_RETRY_PHASE_NOW` had a complete vertical slice and no
//     webview dispatcher, because FR-R3-140 deleted the component that held it.
//   * Finding D — five commands had handlers and zero webview senders, dead
//     since the same deletion.
//   * Finding E — the confirm copy for C's dialog had no consumer, which is what
//     a missing dispatcher looks like one module over.
//
// `tests/lint/queue-command-reachability.test.ts` already asks this of the queue
// family and says so in its own "known bound": its set is name-shaped (`/QUEUE/`
// plus `CMD_MOVE_TASK`) and widening it "would put unrelated families under a
// queue rule and make this test churn on their changes". So this gate is the
// unrestricted form rather than an edit to that one — same question, whole
// surface, no family rule.
//
// TWO DIRECTIONS
//
//   1. Every member of `COMMAND_TYPES` is dispatched, indirectly dispatched, or
//      exempted with a reason. Catches the arm that outlives its only sender.
//   2. Every INDIRECT and EXEMPT entry is still true — the module still posts,
//      the command is still not directly dispatched, the exemption still has no
//      sender. Catches the table that keeps a name after the reason for it went,
//      which is the failure mode of every allowlist.
//
// `COMMAND_TYPES` is imported rather than re-listed. A gate that restated the
// union would pass the day someone added an arm to one copy.

import { describe, expect, it } from 'vitest';
import { COMMAND_TYPES } from '../../src/contracts/sidebar-ipc';
import { scanWebviewSources, type ScannedFile } from './webview-source-scan';

/**
 * A command dispatched through a wrapper instead of a literal
 * `postCommand(CMD_X, …)`, and the module that wraps it.
 *
 * Indirection is legitimate — it is how a family keeps one call site — but it
 * hides the command name from the direct scan, so each one is named here with
 * the module that must still post it.
 */
interface IndirectDispatch {
  readonly command: string;
  /** Repo-relative path of the module whose `postCommand` carries it. */
  readonly module: string;
  readonly why: string;
}

const INDIRECT_DISPATCH: readonly IndirectDispatch[] = [
  ...[
    'CMD_SAVE_DEFINITION_DRAFT',
    'CMD_PUBLISH_DEFINITION',
    'CMD_DEACTIVATE_DEFINITION',
    'CMD_RESTORE_DEFINITION_VERSION',
    'CMD_DISCARD_DEFINITION_DRAFT',
    'CMD_PUBLISH_PACKAGE'
  ].map((command) => ({
    command,
    module: 'webview-ui/src/lib/catalog-lifecycle.ts',
    why:
      'The six catalog-lifecycle actions share one `dispatch(type, request, postMessage)` ' +
      'wrapper, which is what correlates the ack and what keeps Pipeline and Workflow ' +
      'definitions on a single path so the two kinds cannot drift apart. The command reaches ' +
      '`postCommand` as the `type` parameter, so the direct scan cannot see it.'
  }))
];

/**
 * A command with no webview sender at all, and why that is the intended state.
 *
 * Empty, and that is the finding rather than an accident: the lifecycle
 * round-check resolved Finding D by deleting the five commands nothing sent
 * rather than by exempting them, and Finding C by rebuilding the dispatcher.
 * The mechanism stays because the next such command needs somewhere to argue
 * its case in writing, and because an allowlist that has never been used is
 * cheaper to keep honest than one invented under pressure.
 */
interface Exemption {
  readonly command: string;
  readonly why: string;
}

const EXEMPT: readonly Exemption[] = [];

const MIN_REASON_LENGTH = 40;

/** Below this the scan is broken, not the tree clean. */
const DISPATCH_FLOOR = 30;

function isProductionSource(file: ScannedFile): boolean {
  if (!/\.(ts|svelte)$/.test(file.path)) return false;
  if (/\.test\.ts$/.test(file.path)) return false;
  return !file.path.includes('/__tests__/');
}

/**
 * Comments removed, so a command named in prose is not a call site.
 *
 * `queue-command-reachability` makes the same move and says why: three files
 * discuss these commands in doc comments, and counting those as reachability
 * would let the original gap pass the very test written to catch it. This file
 * carries several such comments itself.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PRODUCTION = scanWebviewSources()
  .filter(isProductionSource)
  .map((file) => ({ path: file.path, code: stripComments(file.contents) }));

/** Commands passed to `postCommand` by name, anywhere in production webview code. */
function directlyDispatched(): ReadonlySet<string> {
  const found = new Set<string>();
  for (const { code } of PRODUCTION) {
    for (const command of COMMAND_TYPES) {
      // `postCommand<T>(` and a newline between the paren and the argument are
      // both live formatting in this tree, so neither is assumed away.
      const call = new RegExp(`postCommand\\s*(?:<[^>]*>)?\\s*\\(\\s*${command}\\b`);
      if (call.test(code)) found.add(command);
    }
  }
  return found;
}

/** Production files naming `command` as a bare identifier. */
function filesNaming(command: string): readonly string[] {
  const identifier = new RegExp(`\\b${command}\\b`);
  return PRODUCTION.filter(({ code }) => identifier.test(code)).map(({ path }) => path);
}

describe('every command the host accepts has a webview dispatcher', () => {
  const dispatched = directlyDispatched();

  it('finds dispatchers at all (the scan is not broken)', () => {
    // Without this, a renamed `postCommand` would empty the set and turn every
    // assertion below into a report about a file list nobody read.
    expect(PRODUCTION.length).toBeGreaterThan(0);
    expect(dispatched.size).toBeGreaterThan(DISPATCH_FLOOR);
  });

  it('does not count a command named only in a comment', () => {
    // The positive control for `stripComments`. This gate's whole value rests on
    // prose not counting as reachability, and the two files that document these
    // commands most thoroughly are the ones a broken stripper would credit.
    const commented = stripComments(
      ['// postCommand(CMD_START, {});', '/* postCommand(CMD_CANCEL, {}); */', 'const x = 1;'].join(
        '\n'
      )
    );
    expect(commented).not.toMatch(/postCommand/);
    expect(commented).toContain('const x = 1;');
  });

  it('dispatches, wraps, or exempts every member of COMMAND_TYPES', () => {
    const wrapped = new Set(INDIRECT_DISPATCH.map((e) => e.command));
    const exempt = new Set(EXEMPT.map((e) => e.command));
    const unreachable = COMMAND_TYPES.filter(
      (command) => !dispatched.has(command) && !wrapped.has(command) && !exempt.has(command)
    );
    expect(
      unreachable,
      `These commands have a host handler and no webview sender. Every one is a ` +
        `vertical slice — validator arm, guard, handler, host command — that no ` +
        `operator can reach, which is what the lifecycle round-check of 2026-08-30 ` +
        `found in five commands at once. Either give it a dispatcher, delete the ` +
        `arm, or add it to EXEMPT with a reason:\n${unreachable.join('\n')}`
    ).toEqual([]);
  });

  it('keeps every INDIRECT_DISPATCH entry true', () => {
    for (const entry of INDIRECT_DISPATCH) {
      expect(COMMAND_TYPES as readonly string[], `${entry.command} is no longer a command`).toContain(
        entry.command
      );
      const module = PRODUCTION.find((file) => file.path === entry.module);
      expect(module, `${entry.module} (named for ${entry.command}) is not in the scan`).toBeDefined();
      expect(module!.code, `${entry.module} no longer calls postCommand`).toMatch(/postCommand\s*\(/);
      expect(module!.code, `${entry.module} no longer names ${entry.command}`).toMatch(
        new RegExp(`\\b${entry.command}\\b`)
      );
      expect(
        entry.why.trim().length,
        `${entry.command} needs a reason saying why its dispatch is indirect`
      ).toBeGreaterThan(MIN_REASON_LENGTH);
    }
  });

  it('drops an INDIRECT_DISPATCH entry once the command is dispatched directly', () => {
    // The stale half. A wrapper that was inlined leaves an entry here that is
    // no longer carrying anything, and an entry that carries nothing is an
    // exemption waiting to cover a real gap.
    const redundant = INDIRECT_DISPATCH.filter((e) => dispatched.has(e.command)).map(
      (e) => e.command
    );
    expect(
      redundant,
      `These are dispatched directly now, so their INDIRECT_DISPATCH entries no ` +
        `longer describe anything:\n${redundant.join('\n')}`
    ).toEqual([]);
  });

  it('keeps every EXEMPT entry true, and substantive', () => {
    for (const entry of EXEMPT) {
      expect(COMMAND_TYPES as readonly string[], `${entry.command} is no longer a command`).toContain(
        entry.command
      );
      expect(
        filesNaming(entry.command),
        `${entry.command} is exempted as unreachable but production webview code names it. ` +
          `Either it gained a sender — remove the exemption — or the name is a leftover.`
      ).toEqual([]);
      expect(
        entry.why.trim().length,
        `${entry.command} needs a reason saying why no operator route is the intended state`
      ).toBeGreaterThan(MIN_REASON_LENGTH);
    }
  });
});
