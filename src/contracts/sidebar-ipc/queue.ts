// Feature 092 (US1, FR-019/FR-020) — the multi-queue mutation wire contract.
//
// Lives in a sub-module for the same reason `workflow-run.ts` and
// `run-launcher.ts` do: the barrel is at its LOC ceiling, and only the five
// mandatory registration edits per command belong there (the literal, the
// `COMMAND_TYPES` entry, the type re-export, the `SidebarCommand`
// member, and the `COMMAND_GUARDS` entry). See
// specs/092-multi-queue-concurrency/contracts/queue-registry-and-migration.md.
//
// These seven commands are the surface feature 030 removed for the single-queue
// collapse and this feature reinstates. The command literals are imported
// `import type` — a value import would close the cycle feature 085 recorded, so
// the guards that need them as runtime values stay in the barrel.
//
// Three rules govern every shape below:
//
//   * **A queue is addressed by identifier, never by name.** Names are
//     operator-authored; the host resolves them for display and the audit log
//     never learns them (FR-023a, FR-038a). `CMD_CREATE_QUEUE` and
//     `CMD_RENAME_QUEUE` carry a name because supplying one is the whole point
//     of those two commands.
//   * **No bound is declared here.** These are transport shapes; the length and
//     format bounds are `src/contracts/validators/queue.ts`'s, which is the
//     ingress gate, and restating one here would create a second oracle that
//     drifts.
//   * **No filesystem path crosses this boundary**, in either direction — the
//     same rule the process-YAML and connected-run families hold.

// Queue command interfaces are generated from
// `scripts/contracts/ipc-descriptors/queue-management.mjs` into
// `src/contracts/generated/sidebar-ipc-types.ts`. Re-exported here so existing
// imports from `src/contracts/sidebar-ipc/queue` remain stable.
export type {
  CreateQueueCommand,
  RenameQueueCommand,
  DeleteQueueCommand,
  SaveQueueSettingsCommand,
  MoveTaskCommand,
  SetQueueFailurePolicyCommand,
  AttestTaskCompletedCommand
} from '../generated/sidebar-ipc-types';
