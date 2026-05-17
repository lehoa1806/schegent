import type { Phase } from '../controller/phase';

export interface StatusBarItemLike {
  text: string;
  tooltip?: unknown;
  command?: string | unknown;
  show(): void;
  hide(): void;
  dispose(): void;
}

export type StatusKind =
  | 'idle'
  | 'running'
  | 'paused'
  | 'failed'
  | 'completed'
  | 'canceled'
  | 'stalled';

export interface StatusModel {
  kind: StatusKind;
  phase?: Phase;
  iteration?: number;
  iterationCap?: number;
  detail?: string;
  nextPollAt?: number;
  pendingCount?: number;
}

export class SchegentStatusBar {
  private readonly item: StatusBarItemLike;

  constructor(item: StatusBarItemLike) {
    this.item = item;
    this.item.command = 'schegent.showAuditLog';
    this.item.text = 'schegent: idle';
    this.item.show();
  }

  public update(model: StatusModel): void {
    this.item.text = formatText(model);
    this.item.tooltip = formatTooltip(model);
  }

  public dispose(): void {
    this.item.dispose();
  }
}

function formatText(model: StatusModel): string {
  switch (model.kind) {
    case 'idle':
      if (model.pendingCount && model.pendingCount > 0) {
        return `schegent: queue ${model.pendingCount}`;
      }
      return 'schegent: idle';
    case 'running':
      if (model.phase) {
        if (model.iteration && model.iterationCap) {
          return `schegent: ${model.phase} [${model.iteration}/${model.iterationCap}]`;
        }
        return `schegent: ${model.phase}`;
      }
      return 'schegent: running';
    case 'paused':
      if (model.detail) {
        return `schegent: paused (${model.detail})`;
      }
      if (model.nextPollAt) {
        const time = new Date(model.nextPollAt);
        const hh = String(time.getHours()).padStart(2, '0');
        const mm = String(time.getMinutes()).padStart(2, '0');
        return `schegent: paused (next poll ${hh}:${mm})`;
      }
      return 'schegent: paused';
    case 'stalled':
      return 'schegent: stalled';
    case 'failed':
      return 'schegent: failed';
    case 'completed':
      return 'schegent: completed';
    case 'canceled':
      return 'schegent: canceled';
  }
}

function formatTooltip(model: StatusModel): string {
  const parts: string[] = [];
  if (model.detail) parts.push(model.detail);
  if (model.phase) parts.push(`phase: ${model.phase}`);
  if (model.iteration && model.iterationCap) {
    parts.push(`iteration: ${model.iteration}/${model.iterationCap}`);
  }
  parts.push('click to view audit log');
  return parts.join(' — ');
}
