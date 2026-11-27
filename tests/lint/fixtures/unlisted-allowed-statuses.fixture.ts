// FR-R7-01 — negative-control fixture for `run-allowed-statuses-census.test.ts`.
// Plants an unlisted `allowedStatuses` property on an `updateRun` payload so the census
// proves its scanner detects a new site rather than passing vacuously.
import type { WorkflowRunStatus } from '../../../src/state/workflow-run';

interface FakeStore {
  updateRun(
    queueId: string,
    update: {
      readonly runId: string;
      readonly allowedStatuses: readonly WorkflowRunStatus[];
      readonly label: string;
      readonly patch: () => Record<string, unknown>;
    }
  ): Promise<void>;
}

export async function unlistedAllowedStatusesWriter(store: FakeStore): Promise<void> {
  await store.updateRun('default', {
    runId: 'run-fixture',
    allowedStatuses: ['paused'],
    label: 'pause',
    patch: () => ({})
  });
}
