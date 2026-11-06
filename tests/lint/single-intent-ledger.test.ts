// FR-R5-F19 (spec 278, FR-014 and SC-004; task T033) — there is one acknowledgement ledger, and the
// Disable and Enable path uses it rather than growing a second.
//
// The brief for this feature gave Disable and Enable an acknowledgement of their own on purpose to
// avoid: a second ledger is a second answer to "is this send the same one I already made", and the
// two would disagree about a repeat click, a late answer and a retry the first time a control moved
// from one to the other. FR-R5-F10 built the ledger; this feature reuses it. What is pinned here is
// the claim that the count of ledgers is still one, in terms a scan can fail:
//
//   - `sendIntent` has exactly one production definition, in `intent-ledger.ts`;
//   - the ledger's entry table (`new Map<string, IntentEntry>`) has exactly one production
//     definition, in the same file;
//   - the two modules this feature added or changed on the Disable/Enable path hold no table of their
//     own, mint no correlation id, register no acknowledgement listener and start no timer: they
//     reach the ledger through `correlatedLifecycle` and take their wait from it.
//
// The in-flight set in `phase-selection-control.ts` is a `Set` of keys for controls whose answer has
// not arrived. It is not an acknowledgement table (it stores no id, no payload, no waiter) and it is
// there because the ledger re-posts an identical unresolved send; the per-module assertions below
// are written so that it passes and a `Map` of waiters would not.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WEBVIEW_SRC = resolve(REPO_ROOT, 'webview-ui', 'src');
const HOST_SRC = resolve(REPO_ROOT, 'src');

const LEDGER_MODULE = 'webview-ui/src/lib/intent-ledger.ts';
const CONTROL_HELPER = 'webview-ui/src/lib/phase-control.ts';
const SELECTION_RUNNER = 'webview-ui/src/lib/phase-selection-control.ts';
const LIFECYCLE_IPC = 'webview-ui/src/lib/lifecycle-control-ipc.ts';

const SEND_INTENT_DEFINITION = 'function sendIntent';
const LEDGER_TABLE_DEFINITION = 'new Map<string, IntentEntry>';

/** Production source: a test file and a `__tests__` directory both stay out of the count. */
const isProduction = (absolute: string): boolean => !absolute.includes('/__tests__/') && !/\.test\.[cm]?[jt]s$/.test(absolute);

const relative = (absolute: string): string => absolute.slice(REPO_ROOT.length + 1);

function productionFilesWith(root: string, needle: string): readonly string[] {
  return filesMatching(root, needle, { fixed: true, extensions: ['.ts', '.svelte'] })
    .filter(isProduction)
    .map(relative);
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

/** Source with line and block comments removed, so prose that names a thing does not count as using it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

describe('FR-R5-F19 FR-014 — one acknowledgement ledger', () => {
  describe('control: the scan can see a definition, and can count a second one', () => {
    it('finds both defining shapes in the ledger module, once each', () => {
      const source = read(LEDGER_MODULE);

      expect(occurrences(source, SEND_INTENT_DEFINITION)).toBe(1);
      expect(occurrences(source, LEDGER_TABLE_DEFINITION)).toBe(1);
    });

    it('counts a second definition when one is present', () => {
      const withSecond = `${read(LEDGER_MODULE)}\nexport function sendIntent2() {}\nfunction sendIntent<P>() {}\n`;

      expect(occurrences(withSecond, SEND_INTENT_DEFINITION)).toBeGreaterThan(
        occurrences(read(LEDGER_MODULE), SEND_INTENT_DEFINITION)
      );
    });
  });

  it('sendIntent has exactly one production definition, in the ledger module', () => {
    const webview = productionFilesWith(WEBVIEW_SRC, SEND_INTENT_DEFINITION);
    const host = productionFilesWith(HOST_SRC, SEND_INTENT_DEFINITION);

    expect([...webview, ...host]).toEqual([LEDGER_MODULE]);
  });

  it('the entry table has exactly one production definition, in the ledger module', () => {
    const webview = productionFilesWith(WEBVIEW_SRC, LEDGER_TABLE_DEFINITION);
    const host = productionFilesWith(HOST_SRC, LEDGER_TABLE_DEFINITION);

    expect([...webview, ...host]).toEqual([LEDGER_MODULE]);
  });

  describe('the Disable and Enable path reaches the ledger and holds none of its parts', () => {
    it.each([CONTROL_HELPER, SELECTION_RUNNER])('%s has no table, id mint, listener or timer of its own', (rel) => {
      const code = withoutComments(read(rel));

      for (const forbidden of [
        'new Map<',
        'new Map(',
        'randomUUID',
        'getRandomValues',
        'onceAck(',
        'markPending(',
        'setTimeout(',
        'sendIntent('
      ]) {
        expect(code, `${rel} contains ${forbidden}`).not.toContain(forbidden);
      }
    });

    it('control: the same forbidden parts are present where the ledger lives, so the list is not vacuous', () => {
      const ledger = withoutComments(read(LEDGER_MODULE));

      for (const present of ['new Map<', 'randomUUID', 'onceAck(', 'setTimeout(']) {
        expect(ledger, `${LEDGER_MODULE} should contain ${present}`).toContain(present);
      }
    });

    it('disablePhase and enablePhase go through correlatedLifecycle, which goes through sendIntent', () => {
      const helper = withoutComments(read(CONTROL_HELPER));
      const lifecycle = withoutComments(read(LIFECYCLE_IPC));

      expect(helper).toMatch(/correlatedLifecycle\(\s*CMD_DISABLE_PHASE/);
      expect(helper).toMatch(/correlatedLifecycle\(\s*CMD_ENABLE_PHASE/);
      expect(lifecycle).toContain('sendIntent(');
    });

    it('the selection runner takes its wait from the ledger path rather than building one', () => {
      const code = withoutComments(read(SELECTION_RUNNER));

      // It selects `disablePhase` or `enablePhase` by name and calls the chosen one with the wait.
      expect(code).toMatch(/\bdisablePhase\b/);
      expect(code).toMatch(/\benablePhase\b/);
      expect(code).toContain('dispatch(phaseId, queueId, wait)');
      expect(code).toContain('onLateOutcome');
    });
  });
});
