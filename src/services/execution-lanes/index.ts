/**
 * FR-R6-F10 — execution-lane service barrel.
 *
 * Zero `vscode` imports (docs/hard-rules.md rule 13).
 */

export { createExecFileGitRunner, type LaneGitRunner } from './git-runner';
export { IntegrationStore } from './integration-store';
export { LaneService, LANES_DIRECTORY, type LaneServiceDeps } from './lane-service';
export { LaneStore } from './lane-store';
export { LaneStoreCorruptError } from './lane-store-rows';
