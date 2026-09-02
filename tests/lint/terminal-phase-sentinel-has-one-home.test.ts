// Bug "the phase log that asked for a phase named done" (2026-09-02) — the
// terminal sentinel gets one home per side of the IPC boundary.
//
// `'done'` is a terminal *state* of the phase state machine, not a Phase
// definition (`src/controller/phase.ts` says so at the `Phase` type). Every
// consumer that turns a Run's `currentPhase` into something a phase must
// satisfy — a strip position, a phase-log tuple — has to know that. Seven sites
// across `src/ui/sidebar/` knew it independently, in four spellings:
//
//   run.currentPhase === 'done' ? null : (run.currentPhase as PhaseName)
//   run && run.currentPhase !== 'done' ? run.currentPhase : null
//   entry.phase !== 'done' && entry.phase.length > 0
//   function phaseForTail(phase) { if (phase === 'done') return null; ... }
//
// and an eighth site got it wrong: `snapshot-composer.ts` filtered
// `inFlightPhase` and not `activeRunPhase` six lines below. That put `'done'`
// on every settled Run's row, the webview built a phase-log tuple from it, and
// the host refused its own projection with `unknown-tuple` — 63 of 63 refusals
// in the reporting workspace's audit log. The Activity Feed sat empty after
// every restart because its cold-start loop skips a refused probe.
//
// A type cannot carry this rule: `PhaseName` is `string` on purpose
// (`src/contracts/phase-identity.ts` — the catalog is operator-authored at
// runtime, and a closed union would be a host claim about someone else's
// catalog). So the rule is held by one function per side, and this gate is what
// keeps a ninth spelling from appearing beside them.
//
// NOT checked: the state machine itself (`src/controller/`, `src/state/`), which
// produces the sentinel and legitimately names it; whether a home's own
// implementation is correct (`current-phase-or-null.test.ts` covers that); and
// `'done'` inside comments, which is stripped before matching so that explaining
// the rule never counts as re-implementing it.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { filesUnder } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');

const SCAN_ROOTS = [
  { root: resolve(REPO_ROOT, 'src', 'ui', 'sidebar'), extensions: ['.ts'] },
  { root: resolve(REPO_ROOT, 'webview-ui', 'src'), extensions: ['.ts', '.svelte'] }
] as const;

/**
 * The one place per side that may name the sentinel, and the reason each is the
 * home rather than an exemption.
 */
const HOMES: ReadonlyMap<string, string> = new Map([
  [
    // `phaseIndex` already refused it a tile position here, so the module
    // already owned what the sentinel means to a projection. `phaseNameOrNull`
    // and `currentPhaseOrNull` sit beside it.
    'src/ui/sidebar/phase-projector.ts',
    'host home: phaseNameOrNull / currentPhaseOrNull / phaseIndex'
  ],
  [
    // Beside the selection helpers both webview consumers already import, so
    // `PhaseLogFeed` and `RunDetailTier` agree by construction.
    'webview-ui/src/lib/activity-feed-selection.svelte.ts',
    'webview home: TERMINAL_PHASE_SENTINEL'
  ]
]);

/**
 * Files that contain the literal for a reason that has nothing to do with
 * phases. Kept separate from HOMES: these are not authorities on the rule, they
 * merely collide with its spelling.
 */
const UNRELATED: ReadonlyMap<string, string> = new Map([
  [
    'webview-ui/src/components/HistoryRunDetail.svelte',
    "copy-to-clipboard button state: $state<'idle' | 'done' | 'failed'>, never a phase"
  ]
]);

/**
 * Strip `//` line comments and `/* *\/` blocks so that a file explaining the
 * rule does not read as a file re-implementing it. Over-stripping can only make
 * this gate more permissive, which is why the vacuity control below requires
 * every listed file to still be found by the same stripped scan.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function filesNamingTheSentinel(): string[] {
  const found: string[] = [];
  for (const { root, extensions } of SCAN_ROOTS) {
    for (const file of filesUnder(root, { extensions })) {
      const rel = relative(REPO_ROOT, file);
      // Tests name the sentinel to assert on it; that is the point of them.
      if (rel.includes('__tests__') || rel.includes('.test.')) continue;
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (/'done'|"done"/.test(withoutComments(source))) found.push(rel);
    }
  }
  return found.sort();
}

describe('the terminal phase sentinel has one home per side', () => {
  it('is named nowhere in the projection layer but its home', () => {
    const offenders = filesNamingTheSentinel().filter(
      (rel) => !HOMES.has(rel) && !UNRELATED.has(rel)
    );
    expect(
      offenders,
      'These files open-code the terminal sentinel instead of calling the one ' +
        'function that owns the rule. Host: import `phaseNameOrNull` or ' +
        '`currentPhaseOrNull` from `src/ui/sidebar/phase-projector.ts`. Webview: ' +
        'import `TERMINAL_PHASE_SENTINEL` from ' +
        '`webview-ui/src/lib/activity-feed-selection.svelte.ts`.\n' +
        offenders.join('\n')
    ).toEqual([]);
  });

  // Vacuity control, in the shape `no-running-state-literal.test.ts` uses. The
  // assertion above subtracts two allowlists from a scan and expects nothing
  // left — which is exactly what a scan that found nothing produces. Every
  // listed file is an anchor: each is listed BECAUSE it contains the literal
  // outside comments, so each must come back. That makes this a staleness check
  // too — an entry that stops matching is an exemption outliving its reason.
  it('finds every listed file, so a broken scan cannot read as a clean tree', () => {
    const matched = filesNamingTheSentinel();
    expect(
      matched.length,
      'Neither scan root yielded a file naming the sentinel. The assertion above ' +
        'is passing over an empty set.'
    ).toBeGreaterThan(0);
    for (const [listed, why] of [...HOMES, ...UNRELATED]) {
      expect(
        matched,
        `${listed} is listed (${why}) but the scan did not find the literal in it. ` +
          'Either it is gone — remove the stale entry — or the scan no longer ' +
          'reaches that root.'
      ).toContain(listed);
    }
  });
});
