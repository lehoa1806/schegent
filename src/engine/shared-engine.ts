import type { HostServices } from '../host-services';

export const ENGINE_COMMAND_NAMES = [
  'queue.enqueue',
  'queue.start',
  'queue.pause',
  'queue.resume',
  'queue.cancel-task',
  'queue.retry-task',
  'queue.remove-task',
  'queue.reorder-task',
  'workflow.resume',
  'workflow.retry-active',
  'workflow.rerun-history',
  'workflow.reset',
  'phase.pause',
  'phase.resume',
  'phase.restart',
  'phase.skip',
  'phase.disable',
  'phase.enable',
  'phase.remove',
  'phase.breakpoint.set',
  'phase.breakpoint.clear',
  'settings.read',
  'settings.save-general',
  'settings.save-catalog',
  'settings.save-wakeup',
  'logs.audit.open',
  'logs.phase.read',
  'logs.phase.tail-start',
  'logs.phase.tail-stop',
  'logs.verbose-setting.open',
  'wakeup.run-now',
  'wakeup.session-log.read',
  'wakeup.session-log.reveal',
  'engine.snapshot.read'
] as const;

export type EngineCommandName = (typeof ENGINE_COMMAND_NAMES)[number];

export const ENGINE_EVENT_NAMES = [
  'engine.command-ack',
  'engine.snapshot',
  'engine.audit-tail',
  'engine.phase-log-entry',
  'engine.telemetry',
  'engine.lifecycle'
] as const;

export type EngineEventName = (typeof ENGINE_EVENT_NAMES)[number];

export const ENGINE_STORAGE_RESPONSIBILITIES = [
  'workspace-state',
  'app-global-state',
  'structured-audit-log',
  'raw-transcript-sink',
  'verbose-diagnostics',
  'wakeup-invocation-log',
  'wakeup-session-log'
] as const;

export type EngineStorageResponsibility = (typeof ENGINE_STORAGE_RESPONSIBILITIES)[number];

export const ENGINE_HOST_DEPENDENCIES = [
  'workspace',
  'configuration',
  'state',
  'storage',
  'notifications',
  'commands',
  'files',
  'scheduler',
  'lifecycle'
] as const satisfies readonly (keyof HostServices)[];

export interface SharedEngineCommand<TPayload = unknown> {
  readonly name: EngineCommandName;
  readonly correlationId: string;
  readonly payload?: TPayload;
}

export type EngineAckStatus = 'accepted' | 'rejected';

export interface SharedEngineCommandAck {
  readonly type: 'engine.command-ack';
  readonly correlationId: string;
  readonly commandName: EngineCommandName;
  readonly status: EngineAckStatus;
  readonly reason?: string;
}

export interface SharedEngineEvent<TPayload = unknown> {
  readonly type: EngineEventName;
  readonly correlationId?: string;
  readonly payload?: TPayload;
}

export interface EngineStoragePolicy {
  readonly id: EngineStorageResponsibility;
  readonly owner: 'workspace' | 'app-global' | 'sink';
  readonly redactionPolicy: 'sanitized' | 'unredacted-sink' | 'not-applicable';
  readonly uiExposure: 'projected' | 'never' | 'operator-requested-readonly';
}

export const ENGINE_STORAGE_POLICIES: readonly EngineStoragePolicy[] = Object.freeze([
  {
    id: 'workspace-state',
    owner: 'workspace',
    redactionPolicy: 'sanitized',
    uiExposure: 'projected'
  },
  {
    id: 'app-global-state',
    owner: 'app-global',
    redactionPolicy: 'sanitized',
    uiExposure: 'projected'
  },
  {
    id: 'structured-audit-log',
    owner: 'workspace',
    redactionPolicy: 'sanitized',
    uiExposure: 'operator-requested-readonly'
  },
  {
    id: 'raw-transcript-sink',
    owner: 'sink',
    redactionPolicy: 'unredacted-sink',
    uiExposure: 'never'
  },
  {
    id: 'verbose-diagnostics',
    owner: 'workspace',
    redactionPolicy: 'unredacted-sink',
    uiExposure: 'operator-requested-readonly'
  },
  {
    id: 'wakeup-invocation-log',
    owner: 'app-global',
    redactionPolicy: 'sanitized',
    uiExposure: 'projected'
  },
  {
    id: 'wakeup-session-log',
    owner: 'app-global',
    redactionPolicy: 'unredacted-sink',
    uiExposure: 'operator-requested-readonly'
  }
]);

export type SharedEngineListener = (event: SharedEngineEvent) => void;

export interface SharedEngine {
  dispatch(command: SharedEngineCommand): Promise<SharedEngineCommandAck>;
  subscribe(listener: SharedEngineListener): { dispose(): void };
}

export function isEngineCommandName(value: string): value is EngineCommandName {
  return (ENGINE_COMMAND_NAMES as readonly string[]).includes(value);
}
