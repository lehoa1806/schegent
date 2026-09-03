// Feature 195 (T045, SC-010) — the workspace failure-policy default must read
// identically in three places: the setting's own declaration, the operator
// documentation, and the closure record. FR-016 requires the same literal
// string in all three; this gate re-derives each of the three readings from
// its source and compares them, rather than trusting that a future edit to
// any one of them remembers the other two.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { envelopePresent } from './envelope-presence';

const REPO_ROOT = resolve(__dirname, '..', '..');
const WORKSPACE_ROOT = resolve(REPO_ROOT, '..');

const PACKAGE_JSON = resolve(REPO_ROOT, 'package.json');
const CONFIGURATION_DOC = resolve(REPO_ROOT, 'docs/operations/configuration.md');
const CLOSURE_RECORD = resolve(
  WORKSPACE_ROOT,
  'docs/features/round_3/DONE_156_FR-R3-156_a_failed_task_must_be_able_to_stop_its_queue.md'
);

const SETTING_KEY = 'schegent.queue.haltOnTaskFailure';

/** Reads the `default` declared for `SETTING_KEY` in the contribution manifest. */
function manifestDefault(): string | null {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
    contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
  };
  const declared = manifest.contributes?.configuration?.properties?.[SETTING_KEY];
  return typeof declared?.default === 'string' ? declared.default : null;
}

/** The first backtick-quoted `halt-on-failure`/`continue` literal in a body of prose. */
function firstPolicyLiteral(body: string): string | null {
  const match = /`(halt-on-failure|continue)`/.exec(body);
  return match === null ? null : match[1];
}

// The closure record lives one level above `repo/`, in the planning envelope
// (FR-R3-118). A standalone execution-repository clone has no such envelope,
// and an unguarded read there raises ENOENT — which takes `vitest run`, and
// therefore `test:host`/`verify:all`/`gate`, down with it. Same guard as
// `agents-rule-index.test.ts`, whose rule set lives at the same level.
describe.skipIf(!envelopePresent())(
  'the queue failure-policy default reads identically in package.json, the operator doc, and the closure record',
  () => {
    it('the contribution manifest still declares a default for the setting', () => {
      expect(
        manifestDefault(),
        `${PACKAGE_JSON} no longer declares a string default for ${SETTING_KEY}. If the setting was ` +
          'renamed or its type changed, update this gate in the same change.'
      ).not.toBeNull();
    });

    it('the operator documentation states the same default', () => {
      const doc = readFileSync(CONFIGURATION_DOC, 'utf8');
      expect(
        doc.includes(SETTING_KEY),
        `${CONFIGURATION_DOC} no longer mentions ${SETTING_KEY}. T043 documented it there; if it ` +
          'moved, update this gate to read the new location.'
      ).toBe(true);
      const docDefault = firstPolicyLiteral(doc.slice(doc.indexOf(SETTING_KEY)));
      expect(docDefault).toBe(manifestDefault());
    });

    it('the closure record states the same default', () => {
      const closure = readFileSync(CLOSURE_RECORD, 'utf8');
      const closureDefault = firstPolicyLiteral(closure.slice(closure.indexOf('## 8. Closure')));
      expect(
        closureDefault,
        `${CLOSURE_RECORD} does not name a policy literal in its Closure section.`
      ).toBe(manifestDefault());
    });

    it('the default is one of the two declared policy values', () => {
      expect(['halt-on-failure', 'continue']).toContain(manifestDefault());
    });

    // The four checks above pass on the tree as it stands, which says nothing
    // about whether they can fail. Drive the parser with synthetic input so
    // the mismatch verdict is observed directly.
    describe('the gate detects a mismatch', () => {
      it('finds no literal when the prose carries neither policy value', () => {
        expect(firstPolicyLiteral('no policy literal here')).toBeNull();
      });

      it('reads the first policy literal in the prose', () => {
        expect(firstPolicyLiteral('defaults to `continue` today')).toBe('continue');
      });
    });
  }
);
