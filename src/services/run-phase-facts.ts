/**
 * What one finished phase invocation teaches its Run, recorded on the driver's in-memory Run before the
 * sequencer decides. The NEXT transition carries it to the store (`DRIVER_OWNED_RUN_FIELDS`).
 *
 * Two facts:
 *
 * - The backend session (FR-R3-209): `lastCliSessionId`, its runner kind and its cost, together.
 * - FR-R5-F19 follow-up (spec 278, U1): the Run's feature directory. A queue row carries none, so a
 *   drained Run is admitted with `featureDir: ''`. A phase reports it as the `SCHEGENT_FEATURE_DIR` entry
 *   of its own `phase-message.env`. The first value that is a plain relative path is kept; a later phase
 *   cannot move the Run to another feature. `.specify/feature.json` is not read: it is workspace-wide and
 *   can name another Run's feature.
 *
 * THE REPORTED DIRECTORY IS UNTRUSTED TEXT. It is model output. It is refused unless every segment is
 * a plain name in a narrow character set, because it is later printed into every prompt of the Run and
 * read as a path under the workspace root by the decision-record opener.
 */
import type { PhaseRunOutput } from '../controller/phase-runner';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import type { WorkflowRun } from '../state/workflow-run';
import { featureDirSegments } from './decision-record/decision-record-open';

/** The sidecar key a phase writes its feature directory under. */
export const FEATURE_DIR_MESSAGE_KEY = 'SCHEGENT_FEATURE_DIR';

/** Longest accepted feature directory, in characters. */
export const MAX_FEATURE_DIR_LENGTH = 256;

const PLAIN_SEGMENT = /^[A-Za-z0-9._-]+$/;
const TRAILING_SLASHES = /\/+$/;

/** The feature directory a phase reported, or `null` when there is none or it is not a plain relative path. */
export function reportedFeatureDir(message: PhaseRunOutput['phaseMessage']): string | null {
  const raw = message?.entries[FEATURE_DIR_MESSAGE_KEY];
  if (raw === undefined) return null;
  const candidate = raw.trim().replace(TRAILING_SLASHES, '');
  if (candidate.length > MAX_FEATURE_DIR_LENGTH) return null;
  const segments = featureDirSegments(candidate);
  if (segments === null) return null;
  return segments.every((segment) => PLAIN_SEGMENT.test(segment)) ? candidate : null;
}

/** The Run with what this invocation taught it. The same object when it taught nothing. */
export function withPhaseOutputFacts(
  run: WorkflowRun,
  output: PhaseRunOutput,
  runnerKind: BackendRunnerKind
): WorkflowRun {
  let next = run;
  if (output.cliSessionId !== undefined) {
    next = {
      ...next,
      lastCliSessionId: output.cliSessionId,
      lastCliSessionRunnerKind: runnerKind,
      lastCliSessionCostUsd: output.cliSessionCostUsd
    };
  }
  if (next.featureDir === '') {
    const featureDir = reportedFeatureDir(output.phaseMessage);
    if (featureDir !== null) next = { ...next, featureDir };
  }
  return next;
}
