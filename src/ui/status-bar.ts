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

// Feature 065 / FR-017a / SC-009 — transient indicator window. The
// status-bar surface MUST show a transient "scheduled start fired" hint
// for between 3000 and 5000 ms. Callers may request any non-finite or
// out-of-window value; we clamp.
const TRANSIENT_MIN_MS = 3000;
const TRANSIENT_MAX_MS = 5000;

export class SchegentStatusBar {
  private readonly item: StatusBarItemLike;
  private transientTimer: ReturnType<typeof setTimeout> | null = null;
  private preTransientText: string | null = null;

  constructor(item: StatusBarItemLike) {
    this.item = item;
    this.item.command = 'schegent.showAuditLog';
    this.item.text = 'schegent: idle';
    this.item.show();
  }

  public update(model: StatusModel): void {
    const nextText = formatText(model);
    if (this.transientTimer !== null) {
      // A transient is active — let it own `item.text` and capture the
      // intended steady-state text so the restore is correct.
      this.preTransientText = nextText;
      this.item.tooltip = formatTooltip(model);
      return;
    }
    this.item.text = nextText;
    this.item.tooltip = formatTooltip(model);
  }

  // Feature 065 (T049b) — transient indicator for `scheduled-start-fired`.
  // The duration is clamped to the FR-017a 3000..5000 ms window. The
  // callsite in extension wiring uses 4000 ms — the chosen mid-point.
  public showTransient(text: string, durationMs: number): void {
    const clamped = Math.min(
      TRANSIENT_MAX_MS,
      Math.max(TRANSIENT_MIN_MS, Number.isFinite(durationMs) ? durationMs : TRANSIENT_MIN_MS)
    );
    if (this.transientTimer !== null) {
      clearTimeout(this.transientTimer);
      this.transientTimer = null;
    } else {
      this.preTransientText = this.item.text;
    }
    this.item.text = text;
    this.transientTimer = setTimeout(() => {
      this.transientTimer = null;
      if (this.preTransientText !== null) {
        this.item.text = this.preTransientText;
        this.preTransientText = null;
      }
    }, clamped);
  }

  public dispose(): void {
    if (this.transientTimer !== null) {
      clearTimeout(this.transientTimer);
      this.transientTimer = null;
    }
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
