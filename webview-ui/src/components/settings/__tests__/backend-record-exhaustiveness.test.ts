// FR-R3-144 (T027, FR-001) — the tab cannot draw a partial set of backends.
//
// WHY THIS IS A TYPE-LEVEL TEST. The defect this feature removes is not that the
// tab drew the wrong backend; it is that nothing could tell. `BACKEND_FIELDS[i]`
// was paired with `RUNNERS[i]` by POSITION, so the two lists agreed only because
// they happened to be written in the same order, and a backend added to one and
// not the other was a surface that rendered fine and lied. A runtime assertion
// over today's three backends does not discharge that: it passes on the day the
// fourth backend is added and fails on the day someone notices.
//
// `Readonly<Record<BackendRunnerKind, BackendSection>>` moves the check to the
// compiler. A member added to `BackendRunnerKind` breaks the tab's declaration
// AT the declaration, before any test runs — which is the property asserted
// below, in the only form that survives the enumeration changing: the two
// `@ts-expect-error` directives FAIL THE TYPECHECK if the errors stop happening.
// Widen the record to a `Partial`, or swap it for a `Map` or an array, and this
// file stops compiling. Nothing here renders; that the compiler's guarantee
// reaches the DOM is asserted in `backend-surface.test.ts` (T029/T030), which
// mounts the tab and reads the sections back out of `SUPPORTED_BACKENDS`.
import { describe, expect, it } from 'vitest';
// The same import the tab itself uses: the enumeration is a host contract, and
// `src/contracts/` is the one host directory the webview may value-import from.
import type { BackendRunnerKind } from '../../../../../src/contracts/backend-kinds';
import { SUPPORTED_BACKENDS } from '../../../../../src/contracts/backend-kinds';
import type { BackendSection } from '../general/field-types';

const SECTION: BackendSection = {
  label: 'Any',
  path: { key: 'cliPath', ipcKey: 'cli.path', label: 'Any CLI Path', kind: 'string' },
  specific: []
};

/**
 * Stands in for the tab's `BACKENDS` declaration — same type, so the same rules.
 *
 * The tab's own record is deliberately not exported: its `key:`/`ipcKey:`
 * literals must stay inside the `.svelte` file, which is all the settings
 * coverage gate scans. What is under test here is the TYPE, and this shares it.
 */
function acceptRecord(record: Readonly<Record<BackendRunnerKind, BackendSection>>): number {
  return Object.keys(record).length;
}

describe('FR-R3-144 T027 — a backend without a section is a compile error', () => {
  it('rejects a record that omits a supported backend', () => {
    // @ts-expect-error — `agy` is absent. If this directive is ever reported as
    // unused, the record has been widened (a `Partial`, an index signature, a
    // `Map`) and the tab can once again render two backends out of three with
    // every test green.
    expect(acceptRecord({ claude: SECTION, codex: SECTION })).toBe(2);
  });

  it('rejects an id the product does not support', () => {
    // @ts-expect-error — `gemini` is not a `BackendRunnerKind`. The other half of
    // the same guarantee: a section for a backend nothing can run is a control
    // that writes a value the host refuses.
    expect(acceptRecord({ claude: SECTION, codex: SECTION, agy: SECTION, gemini: SECTION })).toBe(4);
  });

  it('accepts exactly the enumerated backends', () => {
    expect(acceptRecord({ claude: SECTION, codex: SECTION, agy: SECTION })).toBe(
      SUPPORTED_BACKENDS.length
    );
  });
});
