// Feature 103 (T083, US8 — FR-050) — Runs starts work; History looks back.
//
// The two surfaces sit next to each other and want the same things. History
// knows a run's queue, its description, its frozen version and its inputs, and
// each of those is one field short of being able to start something. FR-050 is
// the rule that keeps the shortfall: this feature may read the run path, the
// queue model and the audit writer, and may change none of them.
//
// "Unchanged" is not a claim a test can make about history — a test sees only
// the present. What it can do is *pin* the three things, so the change that
// alters one to serve History has to say so out loud, in this file, next to the
// requirement forbidding it. That is the whole design here: three pins and the
// scan that keeps the surface away from the primitives.
//
// The complementary half is `tests/contract/history-rerun-uses-launch-path.test.ts`,
// which shows the one sanctioned start — re-run — going through the ordinary
// launch path. This file shows there is no other.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

import { ALL_AUDIT_EVENT_TYPES } from '../../src/contracts/audit-events';

const REPO_ROOT = path.join(__dirname, '../..');
const WEBVIEW_COMPONENTS = path.join(REPO_ROOT, 'webview-ui/src/components');

function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function read(relative: string): string {
  return withoutComments(readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
}

// ---------------------------------------------------------------------------
// 1. The run path
// ---------------------------------------------------------------------------

/**
 * The History surface, minus the one module allowed to start something.
 *
 * `cmd-rerun-from-history.ts` is deliberately excluded: re-run is the sanctioned
 * start and it is *supposed* to reach the launch path. Its own suite asserts it
 * reaches that path and no other. Everything else on this list answers questions
 * about runs that already happened, and none of it has any business naming a
 * start primitive.
 */
function surfaceWithoutRerun(): readonly string[] {
  const components = readdirSync(WEBVIEW_COMPONENTS)
    .filter((name) => name.startsWith('History') && name.endsWith('.svelte'))
    .map((name) => path.join('webview-ui/src/components', name))
    .sort();

  expect(components.length, 'no History*.svelte components found').toBeGreaterThanOrEqual(7);

  return [
    'src/ui/sidebar/history-projector.ts',
    'src/services/history-recorder.ts',
    'src/services/history/audit-pointer-resolver.ts',
    'src/services/history/history-evidence-service.ts',
    'src/services/history/history-description-store.ts',
    'src/ui/sidebar/commands/cmd-resolve-audit-pointer.ts',
    'src/ui/sidebar/commands/cmd-open-history-item-details.ts',
    'src/state/history-entry.ts',
    'src/state/history-store.ts',
    'webview-ui/src/lib/history-filters.ts',
    'webview-ui/src/lib/history-rows.ts',
    'webview-ui/src/lib/history-evidence-ipc.ts',
    ...components
  ];
}

/**
 * The primitives that start work, named exactly as `no-direct-run-start.test.ts`
 * names them, because that lint is the repo's standing definition of the start
 * path and two definitions would drift.
 */
const START_PRIMITIVES: readonly RegExp[] = [
  /\bqueue\.enqueue\s*\(/,
  /\bcontroller\.startNew\s*\(/,
  /\bstartPipelineRun\s*\(/,
  /\bGuardedRunService\b/
];

describe('History reaches no start primitive (T083, FR-050)', () => {
  it('no module of the surface names one', () => {
    const offenders: string[] = [];

    for (const file of surfaceWithoutRerun()) {
      const source = read(file);
      for (const primitive of START_PRIMITIVES) {
        if (primitive.test(source)) offenders.push(`${file}: ${primitive}`);
      }
    }

    expect(
      offenders,
      'History looks back. Re-run is the one start, and it is a different module.'
    ).toEqual([]);
  });

  it('the primitives are spelled the way the start path actually spells them', () => {
    // Non-vacuity. If `GuardedRunService` were renamed and this file not
    // updated, the scan above would pass by matching nothing anywhere.
    const service = read('src/services/guarded-run-service.ts');
    const matched = START_PRIMITIVES.filter((primitive) => primitive.test(service));

    expect(matched.length, 'no start primitive matches the guarded service itself').toBeGreaterThan(
      0
    );
  });

  it('re-run is excluded from the scan because it is the sanctioned start', () => {
    // The exclusion is load-bearing, so it is asserted rather than assumed: the
    // module left out of the list above must be the one that really does reach
    // the launch path. An exclusion covering a module that starts nothing would
    // be quietly hiding the wrong file.
    const rerun = read('src/ui/sidebar/commands/cmd-rerun-from-history.ts');

    expect(rerun).toMatch(/prefill|rerun|Rerun/);
  });
});

// ---------------------------------------------------------------------------
// 2. The queue model
// ---------------------------------------------------------------------------

/**
 * The declared fields of an interface, by name.
 *
 * Textual, because `FeatureRequest` is an interface and erases at runtime —
 * there is no value to enumerate. The parse is narrow on purpose: it reads the
 * one brace-delimited block after the declaration and takes each line's leading
 * identifier, so a nested object literal or a multi-line union would confuse it.
 * `FeatureRequest` has neither, and the exact-set assertion below fails loudly
 * if that ever stops being true.
 */
function declaredFields(relative: string, interfaceName: string): readonly string[] {
  const source = read(relative);
  const start = source.indexOf(`export interface ${interfaceName} {`);
  expect(start, `${interfaceName} not found in ${relative}`).toBeGreaterThanOrEqual(0);

  const body = source.slice(start + source.slice(start).indexOf('{') + 1);
  const end = body.indexOf('\n}');
  expect(end, `unterminated ${interfaceName}`).toBeGreaterThan(0);

  return body
    .slice(0, end)
    .split('\n')
    .map((line) => /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

describe('the queue model is unchanged by this feature (T083, FR-050)', () => {
  it('FeatureRequest carries exactly the fields it carried before', () => {
    // Pinned as an exact set rather than a count, so the failure names the field
    // that appeared. A History surface that needed one more thing on a queue
    // item — a recorded version, an origin, a re-run marker — would land here,
    // and the right resolution is to keep it on the history record instead.
    expect(declaredFields('src/queue/feature-request.ts', 'FeatureRequest')).toEqual([
      'completedAt',
      'createdAt',
      'description',
      'enqueuedAt',
      'id',
      'lastError',
      'pauseCause',
      'pausedReason',
      'pipelineId',
      'position',
      'queueId',
      'rerun',
      'retryCount',
      'runId',
      // Feature 102's frozen plan, and the field History would most plausibly
      // want to widen: `catalogVersion` lives on it, and History reads that.
      // Reading it is the whole point; adding to it is what FR-050 forbids.
      'runPlan',
      'startedAt',
      'status',
      'updatedAt'
    ]);
  });

  it('no module of the History surface declares a queue-model field', () => {
    // The other direction: the model could also grow by History defining its
    // own extension of it. Nothing on the surface may name the type at all
    // except to read one.
    const offenders = surfaceWithoutRerun().filter((file) =>
      /\b(?:interface|type)\s+\w*FeatureRequest\w*\b/.test(read(file))
    );

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. The audit writer
// ---------------------------------------------------------------------------

describe('the audit writer is unchanged by this feature (T083, FR-050)', () => {
  it('the event-type vocabulary did not grow', () => {
    // Pinned by count. This feature reads the audit corpus — that is what the
    // evidence panel does — and reading may not add a word to the vocabulary.
    expect(ALL_AUDIT_EVENT_TYPES).toHaveLength(103);
  });

  it('added no event type for the History surface', () => {
    // The two that mention history predate this feature and are about repairing
    // and re-attributing stored records, not about a surface reading them.
    expect(ALL_AUDIT_EVENT_TYPES.filter((type) => /histor/i.test(type)).sort()).toEqual([
      'history-entries-unattributed',
      'history-record-repaired'
    ]);
  });

  it('the writer knows nothing about History', () => {
    // Coupling in the direction that would matter. A writer that imported a
    // history module would make the audit log a function of what the surface
    // wanted to show, which is the inversion FR-050 rules out.
    const auditDir = path.join(REPO_ROOT, 'src/audit');
    const offenders = readdirSync(auditDir)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => /\bhistory\b/i.test(read(path.join('src/audit', name))));

    expect(offenders).toEqual([]);
  });

  it('the recorder writes no audit entry', () => {
    // And the reverse direction. Recording that a run finished is a state write,
    // not an audited event: the run's own lifecycle events are already in the
    // log, and a second entry saying the same thing would double-count every
    // completion for anything reading the corpus.
    const recorder = read('src/services/history-recorder.ts');

    expect(recorder).not.toMatch(/AuditLogWriter|auditWriter|\baudit\.(?:append|write)\s*\(/);
  });
});
