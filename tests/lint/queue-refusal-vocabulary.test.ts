// Feature 095 follow-up (bulk-0 review) — a refusal vocabulary written from the
// spec's names instead of the host's codes.
//
// `queue-control-ipc.ts` carries `REFUSAL_TEXT`, FR-013's "one refusal
// vocabulary for all four control groups". Its first version keyed on
// `default-queue`, `in-flight-task`, `unknown-queue`, `connected-run-child`,
// `invalid-expression` and `out-of-range` — the refusals as the spec *names*
// them. Not one of those six is a code the host emits. `cmd-delete-queue.ts`
// acks `impact.reason` verbatim, so the commonest refusal in the feature reached
// the operator as "The host refused: default-queue-undeletable".
//
// Nothing failed. `refusalText` falls through to the raw code by design, so a
// wrong key is not an error anywhere — it is prose the operator never sees,
// replaced by prose no operator can act on. The ack plumbing tests passed
// because they assert the *reason travels*, never that it *reads*.
//
// So this test derives the codes from the emitting sites and compares. Two
// directions, because each catches a different half:
//
//   A1 — every derived code has an entry. A new host refusal with no text is a
//        raw code in the UI, which is the defect above in its next form.
//   A2 — every entry is a derived code (or one of the two the webview
//        synthesises). This is the direction that would have caught the
//        original: the six invented keys were all *additions*, and A1 alone
//        passes happily while they sit there.
//
// Derivation is by method slice, not a whole-file scan: `QueueManager` answers
// refusals for a dozen commands and only five are posted from this module.
// Pulling all of them in would put create, rename, cancel and modify under a
// rule about controls that do not post them, and the test would churn on
// changes it has no opinion about.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

const read = (...parts: string[]): string =>
  readFileSync(resolve(REPO_ROOT, ...parts), 'utf8');

/**
 * The body of one method, from its signature to the next member at the same
 * indent. Good enough for these five: none of them nests a member declaration,
 * and a slice that over-reaches shows up as an extra derived code, which fails
 * loudly rather than silently narrowing the set.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `method not found: ${signature}`).toBeGreaterThan(-1);
  const rest = source.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:public|private|protected|\/\*\*)/);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every `'kebab-code'` appearing as a `reason:`, `code:` or thrown-rejection argument. */
function codesIn(body: string): readonly string[] {
  const found = new Set<string>();
  const patterns = [
    /\breason:\s*'([a-z][a-z0-9-]*)'/g,
    /\bcode:\s*'([a-z][a-z0-9-]*)'/g,
    /QueueMutationRejected\(\s*'([a-z][a-z0-9-]*)'/g,
    /\bfail\(\s*'([a-z][a-z0-9-]*)'/g
  ];
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) found.add(match[1]);
  }
  return [...found];
}

const QUEUE_MANAGER = read('src', 'queue', 'queue-manager.ts');
const WORKSPACE_STATE = read('src', 'state', 'workspace-state.ts');
const SCHEDULE_PARSER = read('src', 'lib', 'schedule-parser.ts');
const VALIDATORS = read('src', 'contracts', 'validators', 'queue-management.ts');
const IPC_MODULE = read('webview-ui', 'src', 'lib', 'queue-control-ipc.ts');

/**
 * `taskErrorReason` renames exactly one code on its way out. Applied here so the
 * derived set is what the *webview* receives rather than what the store throws —
 * the distinction that makes `unknown-task-id` correct and `task-not-found` wrong.
 */
const HOST_RENAMES: Readonly<Record<string, string>> = { 'task-not-found': 'unknown-task-id' };

/**
 * Refusals the transport answers before any handler runs. Literals rather than a
 * derivation: they are single tokens in seven `cmd-*.ts` guards and in
 * `commands/constants.ts`, with no shape a scan could key on that would not also
 * match unrelated strings.
 */
const TRANSPORT_CODES: readonly string[] = [
  'unsupported',
  'secondary-window-readonly',
  'operation-rejected'
];

/** Synthesised by `correlated()` itself; no host site emits either. */
const WEBVIEW_SYNTHESISED: readonly string[] = ['timeout', 'unexpected-accept'];

/**
 * `invalid-queue-name` is emitted by the create and rename validators, which
 * this module does not post — `CMD_CREATE_QUEUE` and `CMD_RENAME_QUEUE` keep
 * their pre-existing call sites (see the module header). Named here so its
 * absence is a recorded decision rather than an oversight A1 has to allow.
 */
const NOT_POSTED_FROM_THIS_MODULE: readonly string[] = ['invalid-queue-name'];

function derivedCodes(): readonly string[] {
  const raw = [
    ...codesIn(methodBody(QUEUE_MANAGER, 'public queueDeletionImpact(')),
    ...codesIn(methodBody(QUEUE_MANAGER, 'public async moveTask(')),
    ...codesIn(methodBody(QUEUE_MANAGER, 'public async saveQueueSettings(')),
    ...codesIn(methodBody(WORKSPACE_STATE, 'public async movePendingRequest(')),
    ...codesIn(SCHEDULE_PARSER),
    ...codesIn(VALIDATORS),
    ...TRANSPORT_CODES
  ];
  const mapped = raw.map((code) => HOST_RENAMES[code] ?? code);
  return [...new Set(mapped)].filter((code) => !NOT_POSTED_FROM_THIS_MODULE.includes(code)).sort();
}

/** The keys of `REFUSAL_TEXT`, read from source rather than imported. */
function mappedCodes(): readonly string[] {
  const start = IPC_MODULE.indexOf('const REFUSAL_TEXT');
  expect(start, 'REFUSAL_TEXT not found').toBeGreaterThan(-1);
  const end = IPC_MODULE.indexOf('});', start);
  const body = IPC_MODULE.slice(start, end);
  const keys = new Set<string>();
  for (const match of body.matchAll(/^\s*'([a-z][a-z0-9-]*)':/gm)) keys.add(match[1]);
  // Unquoted keys — `unsupported` needs no quotes and so is written without them.
  for (const match of body.matchAll(/^\s*([a-z][a-zA-Z0-9]*):/gm)) keys.add(match[1]);
  return [...keys].sort();
}

describe('queue refusal vocabulary', () => {
  it('derives a non-trivial set from the host — a broken slice fails here first', () => {
    const derived = derivedCodes();
    expect(derived.length).toBeGreaterThanOrEqual(15);
    // Spot-checks across four different emitting layers. If a `methodBody` slice
    // silently returns nothing, the count above may still pass on the two
    // whole-file sources; these four cannot.
    expect(derived).toContain('default-queue-undeletable');
    expect(derived).toContain('task-bound-to-connected-run');
    expect(derived).toContain('unrecognized-format');
    expect(derived).toContain('invalid-concurrency-cap');
  });

  it('A1 — every host refusal code has operator-facing text', () => {
    const mapped = new Set(mappedCodes());
    const unmapped = derivedCodes().filter((code) => !mapped.has(code));
    expect(unmapped, `host codes with no entry in REFUSAL_TEXT: ${unmapped.join(', ')}`).toEqual(
      []
    );
  });

  it('A2 — every entry corresponds to a code something actually emits', () => {
    const known = new Set([...derivedCodes(), ...WEBVIEW_SYNTHESISED]);
    const stale = mappedCodes().filter((code) => !known.has(code));
    expect(stale, `REFUSAL_TEXT entries no host site emits: ${stale.join(', ')}`).toEqual([]);
  });
});
