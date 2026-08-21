/**
 * Feature 111 (T694, FR-015, SC-010) — an over-long `retryCondition` already in the
 * store is refused, not repaired.
 *
 * The lifecycle posture this pins is the one the catalog has always had: the store
 * holds what an operator put there, resolution decides whether it is runnable, and
 * nothing in between rewrites a body to make it fit. Adding a bound is the kind of
 * change that invites the opposite — truncate on read, and the row becomes valid
 * again without anyone deciding that. So the assertion is on the resolver's own
 * output, where the body either survives byte for byte or does not.
 *
 * Two surfaces, deliberately different, which is why this file asserts both:
 *
 *   resolver   — the body is carried verbatim into the source record, and the row
 *                is excluded from `effective`. This is FR-015.
 *   projection — the body is truncated to the bound before it crosses to the
 *                webview. This is FR-014, and it is not a contradiction: the
 *                projection is derived state, never persisted and never audited,
 *                so bounding it costs nothing an operator can lose.
 *
 * Modelled on `catalog-record-key-bound.test.ts`, which builds rows the same way.
 * There is no file in this path: `resolvePhaseCatalog` takes rows in memory, so
 * "the store is not rewritten" is a statement about what the resolver returns.
 */

import { describe, expect, it } from 'vitest';

import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { PHASE_RETRY_CONDITION_MAX_LEN } from '../../../../src/contracts/process-definitions';
import { composePhaseCatalogProjection } from '../../../../src/ui/sidebar/phase-catalog-projection';

/**
 * 88 characters past the bound. A real over-long condition rather than a repeated
 * character, so nothing here passes because the string was degenerate.
 */
const OVER_LONG = `a > 0 or ${'b'.repeat(PHASE_RETRY_CONDITION_MAX_LEN - 13)} > 0 or extra_signal > 0`;

const REVISION = 'rev-no-rewrite';
const identity = (value: string): string => value;
const MODELS = { claude: ['claude-opus-5'], codex: [], agy: [] } as const;

const ROWS: readonly unknown[] = [
  { phaseId: 'over-long', name: 'Over long', version: 1, instruction: 'Do the work', retryCondition: OVER_LONG },
  { phaseId: 'within-bound', name: 'Within bound', version: 1, instruction: 'Do the work', retryCondition: 'a > 0' }
];

describe('an over-long retryCondition is refused, not rewritten (111, FR-015)', () => {
  it('carries the stored body into the source record byte for byte', () => {
    expect(OVER_LONG.length, 'fixture must exceed the bound').toBeGreaterThan(
      PHASE_RETRY_CONDITION_MAX_LEN
    );
    const resolved = resolvePhaseCatalog({ rows: ROWS, revision: REVISION });
    const record = resolved.records.find((r) => r.phaseId === 'over-long');
    expect(record, 'the row must be retained as a record, not dropped').toBeDefined();
    expect(record?.display.retryCondition).toBe(OVER_LONG);
    expect((record?.display.retryCondition as string).length).toBe(OVER_LONG.length);
  });

  it('excludes the row from the runnable set and reports a length', () => {
    const resolved = resolvePhaseCatalog({ rows: ROWS, revision: REVISION });
    const record = resolved.records.find((r) => r.phaseId === 'over-long');
    expect(record?.status).toBe('invalid');
    expect(record?.definition).toBeNull();
    expect(record?.errors.map((e) => e.code)).toContain('invalid-length');
    expect(resolved.effective.map((d) => d.phaseId)).toEqual(['within-bound']);
  });

  it('truncates only on the projection, which is derived state (FR-014)', () => {
    const resolved = resolvePhaseCatalog({ rows: ROWS, revision: REVISION });
    const projection = composePhaseCatalogProjection(resolved, {
      sanitize: identity,
      availableModels: MODELS,
      defaultRunnerKind: 'claude'
    }) as {
      readonly records: readonly {
        readonly phaseId: string;
        readonly display: Readonly<Record<string, unknown>>;
      }[];
    };
    const projected = projection.records.find((r) => r.phaseId === 'over-long');
    expect(projected?.display.retryCondition).toHaveLength(PHASE_RETRY_CONDITION_MAX_LEN);
    // The bound, not the old `INSTRUCTION_MAX` of 8192, which would have let this
    // whole string through untouched.
    expect(projected?.display.retryCondition).toBe(OVER_LONG.slice(0, PHASE_RETRY_CONDITION_MAX_LEN));
  });
});
