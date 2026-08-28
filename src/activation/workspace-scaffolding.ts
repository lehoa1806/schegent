// FR-R3-136 (T1525a) — TRUST CLASSIFICATION: NO PRODUCER ACT.
// A `statSync`, a log line and a notification. It reports that `.specify/` is
// absent and deliberately does not create it — the header below says why the
// warning cannot refuse anything either.

import { statSync } from 'node:fs';
import { join } from 'node:path';

import type { SanitizedLogger } from '../lib/logger';
import type { Notifier } from '../ui/notifications';

/** Directory every `/speckit-*` phase reads its templates, scripts, and memory from. */
const SCAFFOLDING_DIRECTORY = '.specify';

/** The vocabulary the withdrawn `assertScaffoldingPresent()` used, kept for continuity. */
export type ScaffoldingDefect = 'scaffolding-missing' | 'scaffolding-not-directory';

/**
 * `null` when the scaffolding is present, and also when the check could not
 * answer. An unreadable `.specify` is a different problem from an absent one,
 * and reporting it as missing would send the operator to create a directory
 * that is already there.
 */
export function findScaffoldingDefect(workspaceRoot: string): ScaffoldingDefect | null {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(join(workspaceRoot, SCAFFOLDING_DIRECTORY), { throwIfNoEntry: false });
  } catch {
    return null;
  }
  if (stats === undefined) return 'scaffolding-missing';
  return stats.isDirectory() ? null : 'scaffolding-not-directory';
}

/**
 * Tell the operator at activation that this workspace is not initialized.
 *
 * The notice belongs here rather than at enqueue or at Run start because the
 * condition is a property of the workspace, not of any one Run — a refusal at
 * either point would refuse the onboarding Run whose whole job is to create
 * `.specify/`. A warning cannot refuse anything, which is what makes it the
 * right shape: the defect being fixed is diagnosability, not permissiveness.
 *
 * Both audiences are addressed, because a runtime-log line alone would not
 * reach the operator whose confusion this exists to prevent. The log carries
 * the defect code and the notification carries the guidance. Neither names the
 * workspace root: the operator knows which window they are in, and leaving the
 * path out keeps this clear of the redaction surface altogether.
 */
export function warnIfScaffoldingMissing(
  workspaceRoot: string,
  logger: Pick<SanitizedLogger, 'warn'>,
  notifier: Pick<Notifier, 'warn'>
): void {
  const defect = findScaffoldingDefect(workspaceRoot);
  if (defect === null) return;
  logger.warn(
    `speckit scaffolding check failed (${defect}); this workspace has no .specify/ directory, ` +
      'so /speckit-* phases will fail on whatever the CLI reports when a Run reaches them'
  );
  void notifier.warn(
    'Schegent: this workspace has no .specify/ directory, so Spec Driven Development phases ' +
      'will fail when a Run reaches them. Initialize the workspace with Spec Kit before queueing work.'
  );
}
