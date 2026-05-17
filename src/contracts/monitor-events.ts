export const MONITOR_SNAPSHOT_EVENT_TYPES = [
  'monitor.started',
  'monitor.tick',
  'monitor.completed'
] as const;

export type MonitorEventType = (typeof MONITOR_SNAPSHOT_EVENT_TYPES)[number];

export interface MonitorEvent {
  readonly eventType: MonitorEventType;
  readonly correlationId: string;
  readonly timestamp: string;
  readonly summary: string;
}

export interface MonitorSnapshot {
  readonly correlationId: string;
  readonly events: readonly MonitorEvent[];
  readonly lastUpdated: string;
}

export const DEFAULT_MONITOR_TAIL_LIMIT = 200 as const;
