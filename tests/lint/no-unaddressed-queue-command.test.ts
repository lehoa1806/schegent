// Bug "there is no way to start a pending task" (2026-09-02) — a queue-lifecycle
// command posted without a `queueId` is not a command with a missing field. It
// is a command aimed at the *default* queue, because that is what the host reads
// an absent `queueId` as (`StartQueueCommand`'s own contract says so, and
// `guarded-run-service.ts` supplies the literal).
//
// Feature 092 (T061, FR-034) added `queueId` to `CMD_START_QUEUE` end to end —
// contract, validator, sidebar handler, command, service. No webview caller ever
// sent it. So the whole plumbing existed, was tested, and was unreachable: every
// Start affordance in the UI still meant "the default queue", whichever queue was
// on screen. `queue-command-reachability.test.ts` could not see it, because it
// asks whether a command *has* a call site, never whether that call site says
// which queue it means. `no-implicit-default-queue.test.ts` could not see it
// either: it scans `src/` and `tests/`, and it deliberately permits a value
// fallback at a caller that tried to name its queue and found nothing — which is
// the right carve-out for a boundary, and no help one layer above it where the
// caller never tried.
//
// So the rule is about the *webview* end of the wire, and about a property no
// type can carry: an optional field that is omitted compiles.
//
//   Every non-test `postCommand(CMD_X, …)` in `webview-ui/src`, for every
//   queue-addressed command X, names its queue.
//
// The command set is *derived* from the IPC contract — the interfaces extending
// `CommandBase<typeof CMD_…>` whose payload declares a `queueId`. A new
// queue-addressed command enters this rule the moment its contract does, rather
// than when someone remembers to list it here.
//
// `CMD_START` and the two launch ingresses are exempt, by name and with their
// reasons recorded below. They are the members of the derived set whose contracts
// state that omission is a *decision*: an unscoped submit lands on the configured
// default queue, which is the same boundary `no-implicit-default-queue.test.ts`
// names when it permits `cmd-start`'s `?? DEFAULT_QUEUE_ID`. Every other member
// acts on a queue that already exists, where "no queue named" can only mean a
// sibling's state changed.
//
// Comments are stripped before scanning: this repository documents the pre-fix
// form in prose in several places, including in the components this rule now
// governs, and the record of what was removed must not read as a violation of
// its own removal.
//
// FR-R3-150 (T1618d) — three ways the derivation used to read past a command it
// governs, each of which hid real commands:
//
//   1. It read `src/contracts/sidebar-ipc.ts` alone, and the contract is
//      fourteen files. Eleven queue-addressed commands live in
//      `sidebar-ipc/run-controls.ts` and `sidebar-ipc/queue.ts` — every Phase
//      control, both breakpoint writes, Rename and Delete Queue — and none of
//      them was enrolled.
//   2. It matched `queueId` in the *command interface body*, so a command whose
//      payload is a named type (`readonly payload: LaunchPipelineRequest;`) was
//      invisible however that type was shaped.
//   3. It anchored the member match at the start of the body, so a `queueId`
//      that was not the payload's first member did not count.
//
// Widening the derivation cannot loosen what the rules below enforce — it can
// only add commands to police — and it turned 6 governed commands into 20.
//
// The fourth blindness needs more than a wider derivation: a command that
// declares *no* `queueId` at all can never be derived, so a queue-scoped
// command shipped without one is invisible by construction. That is the census
// at the bottom of this file. Every command interface in the contract is either
// derived as queue-addressed or carries a written reason why a queue id is not
// its addressing. An unclassified command fails, so the next queue-scoped
// command cannot be added without someone stating which of the two it is.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui', 'src');
const CONTRACTS_DIR = resolve(REPO_ROOT, 'src', 'contracts');
const IPC_ROOT = resolve(CONTRACTS_DIR, 'sidebar-ipc.ts');
const IPC_MODULES = resolve(CONTRACTS_DIR, 'sidebar-ipc');

/** The shim that re-exports the constants; naming one there is not a call site. */
const MESSAGES_SHIM = 'webview-ui/src/lib/messages.ts';

/**
 * Commands in the derived set that may be posted without naming a queue, each
 * with the contract sentence that makes omission a decision rather than a slip.
 *
 * All three are submit boundaries: the operator composes work and hands it over,
 * and the surface they are reachable from has no queue selection to be faithful
 * to. The one launch site that *does* have a queue in scope — History's re-run,
 * which owes its answer to the queue the historical run used — passes it
 * (`HistoryRerunPanel.svelte`), and the exemption is per command rather than per
 * site, which is the cost of taking the contract at its word.
 *
 * An entry for a command that is no longer in the derived set fails the vacuity
 * check below, so this list cannot go stale in the direction that matters.
 */
const UNSCOPED_BY_CONTRACT: ReadonlyMap<string, string> = new Map([
  [
    'CMD_START',
    'StartCommand: "Missing `queueId` resolves to the configured default queue" — ' +
      'the submit boundary, where an operator who names no queue means the default one.'
  ],
  [
    'CMD_LAUNCH_PIPELINE',
    'LaunchPipelineRequest.queueId: "Additive and optional: absent means the default queue, ' +
      'decided by `scheduleOrEnqueue` as it always has been" — the Runs surface carries no ' +
      'queue selection, and the seam spreads the key only when it has one.'
  ],
  [
    'CMD_LAUNCH_WORKFLOW',
    'LaunchWorkflowPayload.queueId: "Additive and optional: absent means the default queue, ' +
      'which is what every pre-092 launch meant" — and the host forwards the absence rather ' +
      'than resolving it, so the enqueue seam stays the one site that decides.'
  ]
]);

/**
 * Commands the derived set must contain. Without them a reshaped contract would
 * empty the derivation and pass every assertion below trivially. One from each
 * of the three files that hold queue-addressed commands, so losing a whole file
 * from the scan fails here rather than passing quietly.
 */
const ANCHORS = ['CMD_START_QUEUE', 'CMD_PAUSE_PHASE', 'CMD_DELETE_QUEUE'] as const;

/**
 * The reasons a command is not queue-addressed. Three of them, because there are
 * three ways to reach the right queue without carrying its id — from the task,
 * from the run, or because there is no queue in the question at all. None is a
 * defect; being unclassified is.
 */
const TASK_ADDRESSED =
  'task-addressed: the payload names the task, and the host resolves its queue from the row ' +
  '(`QueueManager.queueIdForTask`). A queue id on the wire would be a second source of truth ' +
  'for the same fact, and the row is the one that decides where the task actually is.';
const RUN_ADDRESSED =
  'run-addressed: the payload names the run (or a session minted by an addressed command), and ' +
  'a run is bound to its queue for its whole life. Naming a queue here could only disagree with ' +
  'that binding, or rebind it.';
const WORKSPACE_SCOPED =
  'workspace-scoped: acts on workspace configuration, navigation, or the catalog, none of which ' +
  'is per-queue state. There is no queue for this command to be wrong about.';

/**
 * Every command interface whose payload declares no `queueId`, with the reason
 * that is not the defect this gate exists for.
 *
 * This is the census the derivation cannot produce: a queue-scoped command
 * shipped with no queue id is exactly what "derive the set from the contracts
 * that declare one" cannot see. An entry here is a claim, reviewable and dated
 * by its commit; an unclassified command is a claim nobody made.
 */
const NOT_QUEUE_ADDRESSED: ReadonlyMap<string, string> = new Map([
  ['CMD_CANCEL', TASK_ADDRESSED],
  ['CMD_REMOVE_QUEUE_ITEM', TASK_ADDRESSED],
  ['CMD_RETRY_QUEUE_ITEM', TASK_ADDRESSED],
  // Feature 195 (T064, FR-025) — the sibling of the retry above, and addressed
  // the same way for the reason that matters most here: the halt belongs to
  // whichever queue holds the failed row, so letting the wire name a queue is
  // exactly how the halt's owner and the attestation's target could disagree.
  ['CMD_ATTEST_TASK_COMPLETED', TASK_ADDRESSED],
  ['CMD_MOVE_QUEUE_ITEM_UP', TASK_ADDRESSED],
  ['CMD_MOVE_QUEUE_ITEM_DOWN', TASK_ADDRESSED],
  ['CMD_MODIFY_TASK', TASK_ADDRESSED],
  ['CMD_REORDER_TASK', TASK_ADDRESSED],
  ['CMD_REMOVE_TASK_PHASE', TASK_ADDRESSED],
  ['CMD_RESTART_CANCELED_TASK', TASK_ADDRESSED],
  [
    'CMD_MOVE_TASK',
    `${TASK_ADDRESSED} The destination is the one queue it cannot resolve that way, and it ` +
      'names that one explicitly as `targetQueueId`.'
  ],
  ['CMD_RERUN_FROM_HISTORY', RUN_ADDRESSED],
  ['CMD_OPEN_HISTORY_ITEM_DETAILS', RUN_ADDRESSED],
  ['CMD_RESOLVE_HISTORY_DESCRIPTION', RUN_ADDRESSED],
  ['CMD_RESOLVE_AUDIT_POINTER', RUN_ADDRESSED],
  [
    'CMD_CONTINUE_WORKFLOW',
    `${RUN_ADDRESSED} ContinueWorkflowPayload says so directly: "There is no counterpart on ` +
      '`ContinueWorkflowPayload`, because the binding is fixed at start and a continuation that ' +
      'could name a queue would be a rebind."'
  ],
  [
    'CMD_STOP_PHASE_LOG_TAIL',
    `${RUN_ADDRESSED} The session id was minted by CMD_START_PHASE_LOG_TAIL, whose own selection ` +
      'names the queue, so the tail is addressed by the thing the addressed command created.'
  ],
  ['CMD_OPEN_AUDIT_LOG', WORKSPACE_SCOPED],
  ['CMD_OPEN_DASHBOARD', WORKSPACE_SCOPED],
  ['CMD_OPEN_VERBOSE_SETTING', WORKSPACE_SCOPED],
  ['CMD_OPEN_TRUST_SETTINGS', WORKSPACE_SCOPED],
  ['CMD_DISMISS_MIGRATION_NOTICE', WORKSPACE_SCOPED],
  ['CMD_SET_CONFIRM_SUPPRESSION', WORKSPACE_SCOPED],
  ['CMD_SAVE_MODELS', WORKSPACE_SCOPED],
  ['CMD_SAVE_GENERAL_SETTINGS', WORKSPACE_SCOPED],
  ['CMD_PING_BACKEND', WORKSPACE_SCOPED],
  ['CMD_READ_METRICS', WORKSPACE_SCOPED],
  ['CMD_SET_UNCONTAINED_BACKEND_GRANT', WORKSPACE_SCOPED],
  ['CMD_EXPORT_PROCESS_YAML', WORKSPACE_SCOPED],
  ['CMD_PREFLIGHT_PROCESS_YAML', WORKSPACE_SCOPED],
  ['CMD_READ_DEFINITION_VERSION', WORKSPACE_SCOPED],
  ['CMD_SAVE_DEFINITION_DRAFT', WORKSPACE_SCOPED],
  ['CMD_PUBLISH_DEFINITION', WORKSPACE_SCOPED],
  ['CMD_DEACTIVATE_DEFINITION', WORKSPACE_SCOPED],
  ['CMD_RESTORE_DEFINITION_VERSION', WORKSPACE_SCOPED],
  ['CMD_DISCARD_DEFINITION_DRAFT', WORKSPACE_SCOPED],
  ['CMD_PUBLISH_PACKAGE', WORKSPACE_SCOPED],
  [
    'CMD_CREATE_QUEUE',
    `${WORKSPACE_SCOPED} A create has no id to name yet; the registry mints it.`
  ],
  [
    'CMD_SAVE_QUEUE_SETTINGS',
    `${WORKSPACE_SCOPED} Its \`defaultQueueId\` is the value being saved, not the queue being ` +
      'written to — the write is to workspace settings.'
  ]
]);

/**
 * Commands whose payload declares `queueId` below its top level, with why the
 * top-level call-site rule does not reach them.
 *
 * Both are Phase-log reads whose `selection.queueId` is **required**, so `tsc`
 * already refuses a call that omits it — which is the enforcement this gate is
 * a substitute for, and a stronger one. They stay out of the governed set
 * rather than being exempted from it: an exemption says omission is permitted,
 * and here it does not compile.
 */
const NESTED_ADDRESSING: ReadonlyMap<string, string> = new Map([
  [
    'CMD_READ_PHASE_LOG',
    'ReadPhaseLogRequest.selection.queueId is required — omitting it does not compile.'
  ],
  [
    'CMD_START_PHASE_LOG_TAIL',
    'StartPhaseLogTailRequest.selection.queueId is required — omitting it does not compile.'
  ]
]);

/** Where a command's payload declares its queue, if anywhere. */
type Addressing = 'top-level' | 'nested' | 'none';

interface CommandContract {
  readonly command: string;
  readonly file: string;
  /** `'inline'` for an object literal, else the named payload type resolved. */
  readonly payloadType: string;
  readonly addressing: Addressing;
}

interface Dispatch {
  readonly file: string;
  readonly line: number;
  readonly command: string;
  /** The payload argument as written, or null when the call passed none. */
  readonly payload: string | null;
}

/** Blank out comments, preserving newlines so line numbers still line up. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (line) => line.replace(/[^\n]/g, ' '));
}

/**
 * The argument list opening at `open`, or null when the source ends first. Depth
 * tracks `()`, `[]` and `{}` only; an unclosed generic can only make a list look
 * like it has more top-level commas, never fewer.
 */
function argumentList(text: string, open: number): string | null {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return null;
}

/** Split on depth-0 occurrences of any of `separators`. */
function splitDepthZero(text: string, separators: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (separators.includes(char) && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function splitTopLevel(args: string): readonly string[] {
  return splitDepthZero(args, ',');
}

/**
 * A type body's own members. Interface members end in `;` and object-literal
 * members may end in either, so both separate.
 */
function typeMembers(body: string): readonly string[] {
  return splitDepthZero(body, ';,');
}

/**
 * Whether `payload` declares `queueId` as one of its own keys.
 *
 * Depth-0 only, and only inside the outermost object literal: a `queueId` nested
 * in some other field would name a queue to the *host's* reading of that field,
 * not to the command. `{ queueId }` shorthand and `{ queueId: q }` both match.
 */
function namesQueueAtTopLevel(payload: string): boolean {
  const open = payload.indexOf('{');
  if (open === -1) return false;
  const body = argumentList(payload, open);
  if (body === null) return false;
  return splitTopLevel(body).some((entry) => /^(\.\.\.)?queueId\b/.test(entry));
}

function typescriptFiles(dir: string, into: string[]): readonly string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      typescriptFiles(abs, into);
      continue;
    }
    if (entry.endsWith('.ts')) into.push(abs);
  }
  return into;
}

function webviewFiles(dir: string, into: string[]): readonly string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) {
      webviewFiles(abs, into);
      continue;
    }
    if (/\.(ts|svelte)$/.test(entry)) into.push(abs);
  }
  return into;
}

/** A test posts to a mock; it is not an operator, and it may assert the old shape. */
function isTestFile(rel: string): boolean {
  return rel.includes('__tests__/') || rel.endsWith('.test.ts');
}

/** The files that declare command interfaces: the IPC root and its modules. */
const CONTRACT_FILES: readonly string[] = [
  IPC_ROOT,
  ...readdirSync(IPC_MODULES)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(IPC_MODULES, entry))
    .sort()
];

/**
 * Every `.ts` under `src/contracts`, for resolving a named payload type. Wider
 * than the command files on purpose: a payload type may be declared beside the
 * concept it describes rather than beside the command that carries it.
 */
const RESOLUTION_SOURCES: readonly string[] = typescriptFiles(CONTRACTS_DIR, []).map((file) =>
  stripComments(readFileSync(file, 'utf8'))
);

/** The body of `interface`/`type` `name`, or null when it is not a type we can read. */
function namedTypeBody(name: string): string | null {
  for (const code of RESOLUTION_SOURCES) {
    const declaration = new RegExp(`\\b(?:interface|type)\\s+${name}\\b[^{;]*`).exec(code);
    if (declaration === null) continue;
    const brace = code.indexOf('{', declaration.index);
    if (brace === -1) continue;
    const body = argumentList(code, brace);
    if (body !== null) return body;
  }
  return null;
}

/**
 * The payload type of a command interface, resolved through one level of naming.
 *
 * Returns the type's members and how they were reached. One level is enough for
 * today's contract and the honest limit of a regex: an unresolved name reports
 * itself as `UNRESOLVED:<name>`, which the vacuity check below fails on rather
 * than silently classifying the command as carrying no queue id.
 */
function resolvePayload(interfaceBody: string): { readonly body: string; readonly via: string } {
  const declared = /readonly\s+payload\s*\??\s*:/.exec(interfaceBody);
  if (declared === null) return { body: '', via: 'no-payload' };
  const rest = interfaceBody.slice(declared.index + declared[0].length);
  const firstChar = rest.search(/\S/);
  if (firstChar === -1) return { body: '', via: 'no-payload' };
  if (rest[firstChar] === '{') {
    return { body: argumentList(rest, firstChar) ?? '', via: 'inline' };
  }
  const named = /^\s*([A-Za-z0-9_]+)/.exec(rest);
  if (named === null) return { body: '', via: 'no-payload' };
  const body = namedTypeBody(named[1]!);
  return body === null
    ? { body: '', via: `UNRESOLVED:${named[1]!}` }
    : { body, via: named[1]! };
}

/**
 * Every command interface in the contract, with where its payload declares a
 * queue.
 *
 * `top-level` is what the call-site rules police, because that is the shape an
 * omission compiles in. `nested` is recorded rather than policed (see
 * `NESTED_ADDRESSING`). `none` must be classified in the census.
 */
function readCommandContracts(): readonly CommandContract[] {
  const found: CommandContract[] = [];
  for (const file of CONTRACT_FILES) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const match of code.matchAll(/extends\s+CommandBase<typeof\s+(CMD_[A-Z0-9_]+)>/g)) {
      const brace = code.indexOf('{', match.index + match[0].length);
      if (brace === -1) continue;
      const interfaceBody = argumentList(code, brace);
      if (interfaceBody === null) continue;
      const { body, via } = resolvePayload(interfaceBody);
      const topLevel = typeMembers(body).some((member) =>
        /^(readonly\s+)?queueId\??\s*:/.test(member)
      );
      const anywhere = /\bqueueId\??\s*:/.test(body);
      found.push({
        command: match[1]!,
        file: relative(REPO_ROOT, file),
        payloadType: via,
        addressing: topLevel ? 'top-level' : anywhere ? 'nested' : 'none'
      });
    }
  }
  return found;
}

function dispatchesIn(file: string): readonly Dispatch[] {
  const raw = readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const found: Dispatch[] = [];
  for (const match of code.matchAll(/\bpostCommand\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const args = argumentList(code, open);
    if (args === null) continue;
    const parts = splitTopLevel(args);
    // `.at` rather than `[0]`: a `postCommand()` with no arguments at all is a
    // shape this scan has to survive, and indexing would type it as present.
    const command = parts.at(0);
    if (command === undefined || !/^CMD_[A-Z0-9_]+$/.test(command)) continue;
    const line = raw.slice(0, match.index).split('\n').length;
    found.push({
      file: relative(REPO_ROOT, file),
      line,
      command,
      payload: parts.at(1) ?? null
    });
  }
  return found;
}

const CONTRACTS = readCommandContracts();

const QUEUE_ADDRESSED: readonly string[] = CONTRACTS.filter(
  (contract) => contract.addressing === 'top-level'
).map((contract) => contract.command);

const DISPATCHES: readonly Dispatch[] = webviewFiles(WEBVIEW_SRC, [])
  .map((file) => ({ file, rel: relative(REPO_ROOT, file) }))
  .filter(({ rel }) => !isTestFile(rel) && rel !== MESSAGES_SHIM)
  .flatMap(({ file }) => dispatchesIn(file));

const GOVERNED = DISPATCHES.filter(
  (site) => QUEUE_ADDRESSED.includes(site.command) && !UNSCOPED_BY_CONTRACT.has(site.command)
);

describe('every webview queue-lifecycle command names its queue', () => {
  it('derived the command set from the IPC contract, so the scan is not vacuous', () => {
    for (const anchor of ANCHORS) {
      expect(
        QUEUE_ADDRESSED,
        `${anchor} declares a queueId in the IPC contract and must be derived`
      ).toContain(anchor);
    }
    expect(
      GOVERNED.length,
      'no governed postCommand call sites were found in webview-ui/src — the scan is reading nothing'
    ).toBeGreaterThan(0);
  });

  it('reads every file that declares a command interface', () => {
    // The derivation used to read `sidebar-ipc.ts` alone and miss eleven
    // queue-addressed commands in its sibling modules. A module added to
    // `sidebar-ipc/` is picked up by the directory read; a module *renamed away*
    // would shrink this count, which is what these floors are for.
    const files = new Set(CONTRACTS.map((contract) => contract.file));
    expect(files.size, 'files contributing a command interface').toBeGreaterThanOrEqual(10);
    expect(CONTRACTS.length, 'command interfaces derived').toBeGreaterThanOrEqual(55);
    expect(QUEUE_ADDRESSED.length, 'queue-addressed commands derived').toBeGreaterThanOrEqual(18);
  });

  it('resolved every named payload type, so no command is classified by a failed lookup', () => {
    const unresolved = CONTRACTS.filter((contract) =>
      contract.payloadType.startsWith('UNRESOLVED:')
    ).map((contract) => `${contract.file}  ${contract.command}  ${contract.payloadType}`);
    expect(
      unresolved,
      'a payload type this scan cannot read is a command it cannot classify, and it would be ' +
        'silently filed as carrying no queue id — the exact blindness this derivation was widened ' +
        'to remove. Declare the type where the scan can find it, or inline the payload'
    ).toEqual([]);
  });

  it('carries no exemption for a command outside the derived set', () => {
    const stale = [...UNSCOPED_BY_CONTRACT.keys()].filter(
      (command) => !QUEUE_ADDRESSED.includes(command)
    );
    expect(
      stale,
      'an exemption for a command whose contract no longer declares a queueId should be ' +
        'deleted with it; otherwise this list outlives the reason it was written'
    ).toEqual([]);
  });

  it('posts no queue-lifecycle command without a payload', () => {
    const offenders = GOVERNED.filter((site) => site.payload === null).map(
      (site) => `${site.file}:${site.line}  postCommand(${site.command})`
    );
    expect(
      offenders,
      'a bare post is read by the host as the default queue, so this acts on whichever queue is ' +
        'default rather than the one on screen; pass { queueId }'
    ).toEqual([]);
  });

  it('names queueId among the top-level keys of every queue-lifecycle payload', () => {
    const offenders = GOVERNED.filter(
      (site) => site.payload !== null && !namesQueueAtTopLevel(site.payload)
    ).map((site) => `${site.file}:${site.line}  postCommand(${site.command}, ${site.payload})`);
    expect(
      offenders,
      'omitting queueId does not omit a queue — it selects the default one. Write the payload ' +
        'inline with a queueId key, or record an exemption with the contract sentence that makes ' +
        'omission a decision'
    ).toEqual([]);
  });
});

describe('FR-R3-150 (T1618d) — every command states whether a queue addresses it', () => {
  it('classifies every command that declares no queueId', () => {
    const unclassified = CONTRACTS.filter(
      (contract) =>
        contract.addressing === 'none' && !NOT_QUEUE_ADDRESSED.has(contract.command)
    ).map((contract) => `${contract.file}  ${contract.command}`);
    expect(
      unclassified,
      'a queue-scoped command that declares no queueId cannot be derived, so it can only be ' +
        'caught here. Add it to NOT_QUEUE_ADDRESSED with the reason a queue id is not its ' +
        'addressing — task-addressed, run-addressed, or workspace-scoped — or give its contract ' +
        'a queueId and let the rules above police its call sites'
    ).toEqual([]);
  });

  it('classifies every command whose queueId is nested', () => {
    const unclassified = CONTRACTS.filter(
      (contract) => contract.addressing === 'nested' && !NESTED_ADDRESSING.has(contract.command)
    ).map((contract) => `${contract.file}  ${contract.command}  via ${contract.payloadType}`);
    expect(
      unclassified,
      'a queueId below the payload s top level is out of reach of the call-site rules above. ' +
        'Record it in NESTED_ADDRESSING with what does enforce it (a required field is enforced ' +
        'by tsc), or lift it to the top level'
    ).toEqual([]);
  });

  it('carries no census entry for a command that is now addressed, or gone', () => {
    const declared = new Map(CONTRACTS.map((contract) => [contract.command, contract.addressing]));
    const stale: string[] = [];
    for (const [command, expectedAddressing] of [
      ...[...NOT_QUEUE_ADDRESSED.keys()].map((c) => [c, 'none'] as const),
      ...[...NESTED_ADDRESSING.keys()].map((c) => [c, 'nested'] as const)
    ]) {
      const actual = declared.get(command);
      if (actual === undefined) stale.push(`${command}: no such command interface`);
      else if (actual !== expectedAddressing)
        stale.push(`${command}: classified ${expectedAddressing}, contract declares ${actual}`);
    }
    expect(
      stale,
      'this census is expected to shrink as commands become addressed; an entry for a command ' +
        'that now declares a queueId, or no longer exists, should be deleted with the change ' +
        'that made it so'
    ).toEqual([]);
  });

  it('accounts for every command interface exactly once', () => {
    // The three classifications partition the contract. Without this, a
    // reshaped derivation that reported every command as `top-level` would pass
    // both census assertions above by having nothing to classify.
    const counted =
      QUEUE_ADDRESSED.length + NOT_QUEUE_ADDRESSED.size + NESTED_ADDRESSING.size;
    expect(counted, 'derived + census entries should cover every command interface').toBe(
      CONTRACTS.length
    );
  });
});
