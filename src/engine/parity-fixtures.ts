import type {
  EngineCommandName,
  EngineEventName,
  EngineStorageResponsibility
} from './shared-engine';

export interface EngineParityFixture {
  readonly id: string;
  readonly description: string;
  readonly commands: readonly EngineCommandName[];
  readonly requiredEvents: readonly EngineEventName[];
  readonly requiredStorage: readonly EngineStorageResponsibility[];
}

export const ENGINE_PARITY_FIXTURES: readonly EngineParityFixture[] = Object.freeze([
  {
    id: 'enqueue-and-complete',
    description: 'Queue a task, run all phases, and project a completed snapshot.',
    commands: ['queue.enqueue', 'queue.start'],
    requiredEvents: ['engine.command-ack', 'engine.snapshot', 'engine.audit-tail'],
    requiredStorage: ['workspace-state', 'structured-audit-log', 'raw-transcript-sink']
  },
  {
    id: 'pause-resume',
    description: 'Pause and resume an active workflow without losing lock release semantics.',
    commands: ['phase.pause', 'phase.resume'],
    requiredEvents: ['engine.command-ack', 'engine.snapshot', 'engine.audit-tail'],
    requiredStorage: ['workspace-state', 'structured-audit-log']
  },
  {
    id: 'retry-rate-limit',
    description: 'Classify rate limit output, schedule delayed retry, and recover.',
    commands: ['workflow.retry-active'],
    requiredEvents: ['engine.command-ack', 'engine.snapshot', 'engine.telemetry'],
    requiredStorage: ['workspace-state', 'structured-audit-log']
  },
  {
    id: 'phase-breakpoint',
    description: 'Set a future phase breakpoint, pause before invocation, and resume target phase.',
    commands: ['phase.breakpoint.set', 'phase.resume'],
    requiredEvents: ['engine.command-ack', 'engine.snapshot', 'engine.audit-tail'],
    requiredStorage: ['workspace-state', 'structured-audit-log']
  },
  {
    id: 'task-deletion-cleanup',
    description: 'Remove a task and perform best-effort session artifact cleanup without deleting audit evidence.',
    commands: ['queue.remove-task'],
    requiredEvents: ['engine.command-ack', 'engine.snapshot', 'engine.audit-tail'],
    requiredStorage: ['workspace-state', 'structured-audit-log', 'raw-transcript-sink']
  },
  {
    id: 'wakeup-invocation-record',
    description: 'Record wake-up invocation metadata and expose read-only projected session data.',
    commands: ['wakeup.run-now', 'wakeup.session-log.read'],
    requiredEvents: ['engine.command-ack', 'engine.snapshot'],
    requiredStorage: ['app-global-state', 'wakeup-invocation-log', 'wakeup-session-log']
  }
]);
