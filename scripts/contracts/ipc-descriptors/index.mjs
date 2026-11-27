// Aggregates all 9 inbound sidebar IPC command families (71 commands) and
// 3 host-to-webview push messages.

import { QUEUE_CORE_COMMANDS } from './queue-core.mjs';
import { QUEUE_MANAGEMENT_COMMANDS } from './queue-management.mjs';
import { PHASE_CONTROL_COMMANDS } from './phase-control.mjs';
import { NAVIGATION_SETTINGS_COMMANDS } from './navigation-settings.mjs';
import { HISTORY_EVIDENCE_COMMANDS } from './history-evidence.mjs';
import { CATALOG_COMMANDS } from './catalog.mjs';
import { PHASE_LOG_COMMANDS } from './phase-log.mjs';
import { ANALYTICS_REPORTING_COMMANDS } from './analytics-reporting.mjs';
import { EXECUTION_WORKFLOW_COMMANDS } from './execution-workflow.mjs';
import {
  HOST_MESSAGES,
  HOST_MESSAGE_DEFINITIONS,
  SHARED_IPC_DEFS,
  SIDEBAR_IPC_SCHEMA_VERSION
} from './host-messages.mjs';

export const IPC_COMMAND_FAMILIES = Object.freeze([
  {
    family: 'queue-core',
    sourcePath: 'scripts/contracts/ipc-descriptors/queue-core.mjs',
    outputPath: 'src/contracts/generated/validators/queue-core.ts',
    commands: QUEUE_CORE_COMMANDS
  },
  {
    family: 'queue-management',
    sourcePath: 'scripts/contracts/ipc-descriptors/queue-management.mjs',
    outputPath: 'src/contracts/generated/validators/queue-management.ts',
    headerNotes: [
      'Concurrency cap authority: docs/architecture/local-queue-parallelism-ratification.md',
      'Enforces globalConcurrencyCap in [1, MAX_QUEUES] (MAX_QUEUES defined in src/contracts/queue-bounds.ts).'
    ],
    commands: QUEUE_MANAGEMENT_COMMANDS
  },
  {
    family: 'phase-control',
    sourcePath: 'scripts/contracts/ipc-descriptors/phase-control.mjs',
    outputPath: 'src/contracts/generated/validators/phase-control.ts',
    commands: PHASE_CONTROL_COMMANDS
  },
  {
    family: 'navigation-settings',
    sourcePath: 'scripts/contracts/ipc-descriptors/navigation-settings.mjs',
    outputPath: 'src/contracts/generated/validators/navigation-settings.ts',
    commands: NAVIGATION_SETTINGS_COMMANDS
  },
  {
    family: 'history-evidence',
    sourcePath: 'scripts/contracts/ipc-descriptors/history-evidence.mjs',
    outputPath: 'src/contracts/generated/validators/history-evidence.ts',
    commands: HISTORY_EVIDENCE_COMMANDS
  },
  {
    family: 'catalog',
    sourcePath: 'scripts/contracts/ipc-descriptors/catalog.mjs',
    outputPath: 'src/contracts/generated/validators/catalog.ts',
    commands: CATALOG_COMMANDS
  },
  {
    family: 'phase-log',
    sourcePath: 'scripts/contracts/ipc-descriptors/phase-log.mjs',
    outputPath: 'src/contracts/generated/validators/phase-log.ts',
    commands: PHASE_LOG_COMMANDS
  },
  {
    family: 'analytics-reporting',
    sourcePath: 'scripts/contracts/ipc-descriptors/analytics-reporting.mjs',
    outputPath: 'src/contracts/generated/validators/analytics-reporting.ts',
    commands: ANALYTICS_REPORTING_COMMANDS
  },
  {
    family: 'execution-workflow',
    sourcePath: 'scripts/contracts/ipc-descriptors/execution-workflow.mjs',
    outputPath: 'src/contracts/generated/validators/execution-workflow.ts',
    commands: EXECUTION_WORKFLOW_COMMANDS
  }
]);

export const ALL_IPC_COMMANDS = Object.freeze(
  IPC_COMMAND_FAMILIES.flatMap((entry) => entry.commands)
);

export { HOST_MESSAGES, HOST_MESSAGE_DEFINITIONS, SHARED_IPC_DEFS, SIDEBAR_IPC_SCHEMA_VERSION };
