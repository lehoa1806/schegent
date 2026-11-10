// FR-R6-F09 (FR-002, FR-005, FR-007, FR-011, FR-012, FR-015; research R10) -- the static evidence
// a qualification record is built from.
//
// WHERE THE ROWS COME FROM.
//   - codex-cli 0.163.0 on darwin arm64: one behaviour probe on 2026-11-10, `codex sandbox -P
//     :workspace` under an emptied environment with a disposable home, local endpoints only. It
//     exercised the shell child; the file tool, hooks and external tools were not exercised, so
//     each is a residual of the cells it would touch.
//   - descendant lifetime: the host's own process-group ladder, exercised by the surviving-helper
//     test on darwin. It is version-independent: the ladder is this product's, not the CLI's.
//   - every other row: the `--help` captures of qualification doc section 7. Help text alone never
//     yields `observed-enforced` (FR-002).
//
// KEEPING IT TRUE. Qualification doc section 10 lists one table row per entry here, and
// `tests/lint/containment-effect-matrix-parity.test.ts` holds the two equal in both directions.
// `*` matches any value.

import type { BackendRunnerKind } from '../../contracts/backend-kinds';
import type {
  ContainmentEffect,
  EffectOutcome,
  EffectResidual,
  EvidenceBasis,
  ObservedComponent
} from '../../contracts/containment-qualification';
import type { BackendContainmentMechanism } from '../backend-containment-policy';

/** Matches any value in an evidence row's tuple column. */
export const ANY = '*';

export interface EvidenceRow {
  readonly backend: BackendRunnerKind;
  readonly os: string;
  readonly arch: string;
  /** `major.minor`, or `*` for evidence that does not depend on the CLI's version. */
  readonly versionMinor: string;
  readonly effect: ContainmentEffect;
  readonly outcome: EffectOutcome;
  readonly basis: EvidenceBasis;
  readonly components: readonly ObservedComponent[];
  readonly residuals: readonly EffectResidual[];
  readonly observedAt: string | null;
}

/** The date of the codex behaviour probe and of the ladder evidence this record cites. */
export const OBSERVED_AT = '2026-11-10';
/** The date of the `--help` captures (qualification doc section 7). */
export const HELP_CAPTURED_AT = '2026-10-31';

/** The effects each mechanism claims to bound. A record is qualified only when all are observed. */
export const MECHANISM_CLAIMS: Readonly<Record<BackendContainmentMechanism, readonly ContainmentEffect[]>> =
  Object.freeze({
    'codex-sandbox-workspace-write': Object.freeze(['fs-write', 'network'] as const),
    none: Object.freeze([] as const)
  });

type RowInit = Omit<EvidenceRow, 'components' | 'residuals'> & {
  readonly components?: readonly ObservedComponent[];
  readonly residuals?: readonly EffectResidual[];
};

function row(init: RowInit): EvidenceRow {
  return Object.freeze({
    ...init,
    components: Object.freeze([...(init.components ?? [])]),
    residuals: Object.freeze([...(init.residuals ?? [])])
  });
}

const CODEX_OBSERVED = { backend: 'codex', os: 'darwin', arch: 'arm64', versionMinor: '0.163' } as const;
const NOT_OS_ENFORCED_EFFECTS = ['fs-read', 'fs-write', 'network', 'credential-exposure'] as const;
const OS_MECHANISM_EFFECTS = ['fs-read', 'fs-write', 'process-creation', 'network', 'credential-exposure'] as const;

function codexRows(): EvidenceRow[] {
  const observed = { ...CODEX_OBSERVED, basis: 'observed-behavior', observedAt: OBSERVED_AT } as const;
  return [
    row({ ...observed, effect: 'fs-read', outcome: 'unsupported', components: ['shell-child'] }),
    row({
      ...observed,
      effect: 'fs-write',
      outcome: 'observed-enforced',
      components: ['shell-child'],
      residuals: ['file-tool-unobserved', 'hook-unobserved', 'external-tool-unobserved']
    }),
    row({ ...observed, effect: 'process-creation', outcome: 'unsupported', components: ['shell-child'] }),
    row({
      ...observed,
      effect: 'network',
      outcome: 'observed-enforced',
      components: ['shell-child'],
      residuals: [
        'non-loopback-destinations-unobserved',
        'dns-unobserved',
        'redirect-unobserved',
        'proxy-unobserved',
        'no-filtering-claimed'
      ]
    }),
    row({ ...observed, effect: 'credential-exposure', outcome: 'unsupported', components: ['shell-child'] }),
    ...OS_MECHANISM_EFFECTS.map((effect) =>
      row({
        backend: 'codex',
        os: ANY,
        arch: ANY,
        versionMinor: ANY,
        effect,
        outcome: 'unverified',
        basis: 'help-syntax',
        observedAt: HELP_CAPTURED_AT
      })
    )
  ];
}

function noClaimRows(backend: BackendRunnerKind): EvidenceRow[] {
  const help = { backend, os: ANY, arch: ANY, versionMinor: ANY, basis: 'help-syntax', observedAt: HELP_CAPTURED_AT } as const;
  return [
    ...NOT_OS_ENFORCED_EFFECTS.map((effect) => row({ ...help, effect, outcome: 'unsupported' })),
    row({ ...help, effect: 'process-creation', outcome: 'tool-restricted' })
  ];
}

function ladderRow(backend: BackendRunnerKind): EvidenceRow {
  return row({
    backend,
    os: 'darwin',
    arch: ANY,
    versionMinor: ANY,
    effect: 'descendant-lifetime',
    outcome: 'observed-enforced',
    basis: 'observed-behavior',
    components: ['host-ladder'],
    residuals: ['descendants-outside-group-undetectable'],
    observedAt: OBSERVED_AT
  });
}

export const EVIDENCE_MATRIX: readonly EvidenceRow[] = Object.freeze([
  ...noClaimRows('claude'),
  ...codexRows(),
  ...noClaimRows('agy'),
  ladderRow('claude'),
  ladderRow('codex'),
  ladderRow('agy')
]);
