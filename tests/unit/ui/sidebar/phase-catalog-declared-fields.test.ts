// The Builder cannot save back a declaration it was never shown.
//
// WHY THIS EXISTS. `projectPhaseDefinition` named thirteen of the twenty-one
// fields in `AUTHORED_PHASE_FIELDS`. The eight it omitted were not refused —
// six of them reached the webview anyway, by accident, because
// `recognizedDisplay` copies every authored scalar onto `display` and
// `projectDisplay` passes strings and numbers through. That accident is the only
// reason `sideEffects` survived a Builder round trip at all.
//
// `capabilities` is the one it could not carry. It is the sole array-valued
// authored field, and `recognizedDisplay` admits `string | number | boolean |
// null` — so a Phase that narrowed its authority arrived in the Builder with no
// `capabilities` at all, and the save body could not forward a field the row had
// never received. Omission means EVERY capability (`DEFAULT_CAPABILITY_SET`, and
// `PhaseDefinitionBase.capabilities` says so at the declaration), so opening a
// narrowed Phase and saving an unrelated edit silently restored full authority —
// on a save the operator was told succeeded.
//
// So this gate asserts the definition carries what an author declared, DERIVED
// from `AUTHORED_PHASE_FIELDS` rather than listed, and does not rely on the
// `display` fallback to cover the difference. `display` exists for a row that
// FAILED validation, where there is no definition to read; a valid row's
// declarations belong on the definition.
import { describe, expect, it } from 'vitest';

import { AUTHORED_PHASE_FIELDS } from '../../../../src/config/process-definition-validator';
import { resolvePhaseCatalog } from '../../../../src/config/process-catalog';
import { composePhaseCatalogProjection } from '../../../../src/ui/sidebar/phase-catalog-projection';

const identity = (value: string): string => value;
const MODELS = { claude: ['claude-opus-5'], codex: [], agy: [] } as const;

/**
 * One row declaring every authored field, each with a distinctive non-default
 * value so a dropped field shows as absent rather than as coincidentally right.
 *
 * `id` and `skill` are absent on purpose: `phaseId` is the portable spelling and
 * a row carrying both is `identity-ambiguous`, and `skill` is exclusive-or with
 * `instruction`.
 */
const EVERY_FIELD_ROW = {
  phaseId: 'declares-everything',
  name: 'Declares Everything',
  description: 'A phase that declares every authored field.',
  version: 3,
  instruction: 'Do the work.',
  model: 'claude-opus-5',
  effort: 'high',
  timeoutSeconds: 45,
  spendBoundUsd: 5.5,
  spendBoundTokens: 100_000,
  loopable: true,
  retryCondition: 'attempts < 2',
  isRequired: false,
  forceContinueOnRetryCap: true,
  // Not the `claude` default, and Git-capable: `sideEffects: 'git'` is refused on
  // `codex`, whose workspace-write keeps `.git` read-only.
  runner: 'agy',
  sideEffects: 'git',
  evidencePolicy: 'best-effort',
  hostVerification: 'exit-code',
  capabilities: ['workspace-write']
} as const;

/** The projected record for a single row, definition and display alike. */
function projectOne(row: unknown): {
  readonly definition: Readonly<Record<string, unknown>> | null;
  readonly display: Readonly<Record<string, unknown>>;
} {
  const catalog = resolvePhaseCatalog({ rows: [row], revision: 'rev-declared' });
  const payload = composePhaseCatalogProjection(catalog, {
    sanitize: identity,
    availableModels: MODELS,
    defaultRunnerKind: 'claude'
  }) as unknown as {
    readonly records: readonly {
      readonly definition: Readonly<Record<string, unknown>> | null;
      readonly display: Readonly<Record<string, unknown>>;
    }[];
  };
  expect(payload.records.length, 'the fixture must project exactly one record').toBe(1);
  // `.at` rather than `[0]`: it is typed `| undefined` on its own, so the guard
  // below is necessary to eslint as well as to `noUncheckedIndexedAccess`, and
  // both ratchets stay where they are.
  const record = payload.records.at(0);
  if (record === undefined) throw new Error('the fixture projected no record');
  return record;
}

describe('the Phase catalog projection carries every authored declaration', () => {
  it('accepts the fixture as a valid Phase — the control', () => {
    // Without this the assertions below could pass against a rejected row whose
    // definition is null for a reason that has nothing to do with projection.
    const { definition } = projectOne(EVERY_FIELD_ROW);
    expect(definition, 'the fixture did not validate; the rest of this file is vacuous').not.toBe(
      null
    );
  });

  it('projects every authored field the fixture declares onto the definition', () => {
    const { definition } = projectOne(EVERY_FIELD_ROW);
    const missing = Object.keys(EVERY_FIELD_ROW).filter(
      (field) => definition !== null && !(field in definition)
    );
    expect(
      missing,
      'These authored fields were declared on the row and did not reach the projected ' +
        'definition. The Builder reads the definition to fill its editor and serialises the ' +
        'result back, so a field that does not arrive cannot be saved: it is dropped on a ' +
        'successful save. Project it here.'
    ).toEqual([]);
  });

  it('forwards each declared value unchanged', () => {
    const { definition } = projectOne(EVERY_FIELD_ROW);
    for (const [field, value] of Object.entries(EVERY_FIELD_ROW)) {
      expect(definition?.[field], `${field} was reshaped in projection`).toEqual(value);
    }
  });

  it('carries a narrowed capability set on the definition, not via the fallback', () => {
    // The field with the security consequence, called out on its own: omission means
    // EVERY capability, so a narrowed set that fails to survive projection restores
    // full authority on the next save.
    //
    // `display` now carries scalar lists too — an invalid row's `capabilities` had to
    // reach the Builder somehow, and `tests/unit/config/authored-display-carries-arrays.test.ts`
    // pins that half. So this asserts the VALID row's channel specifically: a reader
    // that never looks at `display` still sees the declaration, which is what the
    // Builder's save path does.
    const { definition } = projectOne(EVERY_FIELD_ROW);
    expect(definition?.capabilities, 'a narrowed authority must survive projection').toEqual([
      'workspace-write'
    ]);
    expect(definition, 'a valid row must not need the invalid-row fallback read at all').not.toBeNull();
  });

  it('covers every authored field, so the next one is not silently uncovered', () => {
    // Derived: this file needs no edit when a field is added to the authored set,
    // only a value in EVERY_FIELD_ROW — and it fails until one is there.
    const drivenElsewhere = ['id', 'skill'];
    const uncovered = [...AUTHORED_PHASE_FIELDS].filter(
      (field) => !drivenElsewhere.includes(field) && !(field in EVERY_FIELD_ROW)
    );
    expect(
      uncovered,
      `authored fields this file does not declare: ${uncovered.join(', ')}. ` +
        'Add each to EVERY_FIELD_ROW with a distinctive non-default value.'
    ).toEqual([]);
  });

  it('omits an authored field the row does not declare', () => {
    // The complement: projecting a default would make an absent declaration
    // indistinguishable from a declared one, and `sideEffects` omitted is exactly
    // what the resolver reads as `workspace`.
    const { definition } = projectOne({
      phaseId: 'declares-nothing',
      name: 'Declares Nothing',
      version: 1,
      instruction: 'Go.'
    });
    for (const field of ['sideEffects', 'capabilities', 'evidencePolicy', 'hostVerification']) {
      expect(definition !== null && field in definition, `${field} was invented by projection`).toBe(
        false
      );
    }
  });
});
