// Feature 020 T028 — derive the verbose-diagnostics banner state from
// the setting × phase-dir existence permutations. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §8.
//
// Feature 203 (D5, FR-006, SC-008) — this module no longer touches the
// filesystem. It used to `stat` the phase directory for itself, which was a
// second observation of a directory the reader had already listed: two answers
// that could disagree, a race window between them, and a label chosen by
// directory existence alone. It is now a pure function of what the single
// observation found, the setting, the phase's progress and how many entries
// survived the read.
//
// The file name, the field name `verboseDiagnosticsState` and the type name
// `VerboseDiagnosticsBanner` are deliberately kept (D5). The exported function
// is not: `detect` described I/O this module no longer performs, and "verbose
// diagnostics state" described one of the eight members it can now return.

import type { IterationDiscovery } from './phase-log-iteration-discovery';
import type { PhaseProgress, VerboseDiagnosticsBanner } from './types';

interface ClassifyArgs {
  /** What the one observation of the phase directory found (D3). */
  readonly discovery: IterationDiscovery;
  readonly settingOn: boolean;
  /** Phase-level, not task-level (D7). `unknown` makes no progress claim. */
  readonly progress: PhaseProgress;
  /** Displayable entries surviving the read; 0 at every site with no record. */
  readonly entryCount: number;
}

const VERBOSE_SETTING_KEY = 'schegent.logging.verbose';

/**
 * The one place the precedence between simultaneously-true statements is
 * written down (D2). More than one of these is often true at once, and the
 * order below is the claim about which one an operator most needs.
 */
export function classifyEmptyKind(args: ClassifyArgs): VerboseDiagnosticsBanner {
  // Not an empty situation at all. Ranked first so no later rule can hide a
  // log that is on screen behind advice about why it might be missing.
  if (args.entryCount > 0) {
    return { kind: 'entries-present' };
  }

  // A record exists and produced nothing displayable. The setting is not
  // consulted here: telling an operator to switch on a setting is wrong when
  // the records are already on disk, and switching it on would not produce the
  // ones they are looking at (Q2).
  const hasRecord = args.discovery.outcome === 'listed' && args.discovery.iterations.length > 0;
  if (hasRecord) {
    return args.progress === 'running'
      ? { kind: 'phase-running-no-output' }
      : { kind: 'nothing-displayable' };
  }

  // Nothing is recorded. The setting outranks progress because it is the only
  // member whose advice a wait cannot repair — telling someone to wait for a
  // log the setting has switched off is the worst of the wrong answers here.
  if (!args.settingOn) {
    return { kind: 'diagnostics-disabled', settingKey: VERBOSE_SETTING_KEY };
  }
  if (args.progress === 'running') {
    return { kind: 'phase-running-no-output' };
  }
  // `directory-absent` and an empty listing are different situations and now
  // answer differently: the phase was never reached, versus it was reached and
  // recorded no iteration.
  return args.discovery.outcome === 'directory-absent'
    ? { kind: 'phase-not-recorded' }
    : { kind: 'no-iteration-recorded' };
}
