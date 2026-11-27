/**
 * FR-R7-07 — Pure Queue Registry shapes and helper functions relocated to
 * `src/contracts/queue-registry.ts` so `src/state/` depends only on leaf
 * contracts rather than value-importing `src/queue/`.
 *
 * Re-exported here verbatim so every existing caller keeps its import path.
 */
export {
  MIN_QUEUE_NAME_LENGTH,
  QueueRegistryViolation,
  createQueue,
  deleteQueue,
  findQueue,
  isValidQueueId,
  isValidQueueName,
  makeDefaultRegistry,
  projectQueueRegistry,
  renameQueue,
  setQueueSchedule,
  validateQueueRegistry,
  type ProjectedQueueRegistry,
  type ProjectedQueueRegistryEntry,
  type QueuePauseSource,
  type QueuePauseView,
  type QueueRegistry,
  type QueueRegistryEntry,
  type QueueRegistryError,
  type QueueRegistryState,
  type QueueSchedule
} from '../contracts/queue-registry';
