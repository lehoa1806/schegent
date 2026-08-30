// FR-R3-112 (FR-123) — every bound on an unattended run, in one place, DERIVED.
//
// WHY THIS DOCUMENT EXISTS AT ALL. The 2026-08-26 review's finding was not that any
// one bound was missing; it was that the bounds were **all of one shape**. Iterations,
// retries, idle time and wall-clock time were bounded; spend was recorded and never
// read. An operator reading four caps could reasonably conclude their run was bounded,
// and be wrong about the one bound that costs money. So the disclosure lists the whole
// set — including the newest one and including what each does NOT bound.
//
// WHY DERIVED AND NOT WRITTEN. Same reason as `retention-disclosure.ts`, and the same
// class of defect this round keeps finding: operator-facing text asserting a property
// nothing checks. Every figure here is read from the constant or the manifest default
// that enforces it, and `tests/lint/autonomy-bounds-disclosure-parity.test.ts` fails
// if the document and these values disagree.
//
// WHY THE DENOMINATION COLUMN IS NOT OPTIONAL. A spend bound whose unit depended on
// the backend and said so nowhere would be the same defect wearing a new hat: an
// operator who set a dollar bound and then invoked `codex` would have set nothing. The
// column states which figure applies where, and the value comes from the same
// vocabulary table the usage parser reads.
import { DELAYED_RETRY_CAP } from '../contracts/retry-bounds';
import { SUPPORTED_BACKENDS } from '../contracts/backend-kinds';
import {
  SPEND_BOUND_KEY_BY_DENOMINATION,
  spendDenominationOf,
  type SpendDenomination
} from '../contracts/backend-spend-denomination';
import { KEY_SPECS } from '../config/general-settings';
import { SETTINGS_SCHEMA } from '../config/settings-schema';

export interface AutonomyBoundEntry {
  /** What runs away if this bound is absent. */
  readonly risk: string;
  /** The bound in force by default, in the reader's words. */
  readonly bound: string;
  /** What crossing it does. Only one of these ends a run. */
  readonly onCrossing: string;
  /** Where the number comes from, so a reader can check it. */
  readonly source: string;
}

const numberDefault = (key: keyof typeof KEY_SPECS): number =>
  KEY_SPECS[key].defaultValue as number;

const schemaDefault = (key: string): number | null => {
  // `hasOwnProperty` rather than a truthiness check on the index read: the schema is typed as
  // total over its keys, so an index read reads as always-present while a renamed setting is
  // genuinely absent — and this function's whole job is to fail loudly on that.
  // Read through a lookup that is TYPED as partial, which is what satisfies both ratchets at once:
  // `noUncheckedIndexedAccess` wants the absence handled, and `no-unnecessary-condition` calls the
  // handling dead whenever the index read claims to be total. Making the type honest — a partial
  // record, because a renamed setting genuinely is not there — leaves the guard meaningful to
  // both. Same resolution the eslint baseline's own note records: fix the type, keep the guard.
  const schema: Partial<Record<string, { readonly default?: unknown }>> = SETTINGS_SCHEMA;
  const entry = schema[key];
  if (entry === undefined) throw new Error(`autonomy disclosure: unknown setting ${key}`);
  return entry.default as number | null;
};

const seconds = (value: number): string =>
  value >= 3600 ? `${(value / 3600).toFixed(1)} h` : `${Math.round(value / 60)} min`;

/** The disclosure as data; rendering is separate so one set of facts serves both. */
export function autonomyBounds(): readonly AutonomyBoundEntry[] {
  const usd = schemaDefault('schegent.spend.maxUsdPerRun');
  const tokens = schemaDefault('schegent.spend.maxTokensPerRun');
  return Object.freeze([
    {
      risk: 'A phase that never converges',
      bound: `${numberDefault('loop.maxIterations')} iterations`,
      onCrossing: 'force-advance or fail, per the phase',
      source: '`schegent.loop.maxIterations`'
    },
    {
      risk: 'A failure that repeats',
      bound: `${DELAYED_RETRY_CAP} delayed retries`,
      onCrossing: 'pause, resumable by the operator',
      source: '`DELAYED_RETRY_CAP` in src/contracts/retry-bounds.ts'
    },
    {
      risk: 'A child that stops producing output',
      bound: `${seconds(numberDefault('invocation.idleTimeoutSeconds'))} idle`,
      onCrossing: 'the invocation is terminated',
      source: '`schegent.invocation.idleTimeoutSeconds`'
    },
    {
      risk: 'A chatty child the idle window never catches',
      bound: `${seconds(numberDefault('invocation.maxDurationSeconds'))} wall clock`,
      onCrossing: 'the invocation is terminated',
      source: '`schegent.invocation.maxDurationSeconds`'
    },
    {
      // The row this disclosure was written for. Its default is deliberately "no
      // bound", and saying so is the point: a reader who assumes spend is bounded
      // because four other things are is exactly who this row is for.
      risk: 'Spend, on a backend that reports cost',
      bound: usd === null ? 'no bound by default; USD, per run' : `$${usd} per run`,
      onCrossing: 'pause, resumable; **never** a terminal transition',
      source: '`schegent.spend.maxUsdPerRun`, or `spendBoundUsd` on a Phase'
    },
    {
      risk: 'Spend, on a backend that reports tokens and no cost',
      bound:
        tokens === null ? 'no bound by default; tokens, per run' : `${tokens} tokens per run`,
      onCrossing: 'pause, resumable; **never** a terminal transition',
      source: '`schegent.spend.maxTokensPerRun`, or `spendBoundTokens` on a Phase'
    }
  ]);
}

/**
 * Which denomination applies to which backend, derived from what each backend
 * actually reports rather than from a list kept here.
 *
 * `claude` reports `total_cost_usd`; `codex` and `agy` report tokens and no cost,
 * because FR-R3-098 left cost ABSENT there rather than derived from a rate card
 * nobody published. So the bound in force follows the report, and this table is a
 * projection of that fact rather than a second opinion about it.
 *
 * FR-R3-144 (T036) — it is now literally a projection. The three rows were written
 * out by hand here, which made this the second hand-kept copy of "which backend
 * reports a cost"; the settings tab needed a third, and needing a third is how you
 * find out you should have had none. `contracts/backend-spend-denomination.ts` is
 * the one copy, the rows below are rendered from it, and a backend added to the
 * platform appears in this document without an edit here.
 */
export interface BackendDenomination {
  readonly backend: string;
  readonly reports: string;
  readonly boundInForce: string;
}

/** What a backend reports, in the reader's words, given what it is bounded in. */
const REPORTS_BY_DENOMINATION: Readonly<Record<SpendDenomination, string>> = Object.freeze({
  usd: 'cost and tokens',
  tokens: 'tokens only'
});

/** The unit as it is written in this document's third column. */
const UNIT_BY_DENOMINATION: Readonly<Record<SpendDenomination, string>> = Object.freeze({
  usd: 'USD',
  tokens: 'tokens'
});

export function backendDenominations(): readonly BackendDenomination[] {
  return Object.freeze(
    SUPPORTED_BACKENDS.map((backend) => {
      const denomination = spendDenominationOf(backend);
      return {
        backend,
        reports: REPORTS_BY_DENOMINATION[denomination],
        boundInForce:
          '`schegent.' +
          `${SPEND_BOUND_KEY_BY_DENOMINATION[denomination]}\` (${UNIT_BY_DENOMINATION[denomination]})`
      };
    })
  );
}

export function renderAutonomyBounds(): string {
  const rows = autonomyBounds()
    .map((e) => `| ${e.risk} | ${e.bound} | ${e.onCrossing} | ${e.source} |`)
    .join('\n');
  return ['| Runaway | Default bound | On crossing | Derived from |', '|---|---|---|---|', rows].join(
    '\n'
  );
}

export function renderBackendDenominations(): string {
  const rows = backendDenominations()
    .map((e) => `| \`${e.backend}\` | ${e.reports} | ${e.boundInForce} |`)
    .join('\n');
  return ['| Backend | Reports | Spend bound in force |', '|---|---|---|', rows].join('\n');
}
