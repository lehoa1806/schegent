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

export type StatusEvidenceHealth = 'healthy' | 'degraded' | 'unavailable';

// Feature 065 / FR-017a / SC-009 — transient indicator window. The
// status-bar surface MUST show a transient "scheduled start fired" hint
// for between 3000 and 5000 ms. Callers may request any non-finite or
// out-of-window value; we clamp.
const TRANSIENT_MIN_MS = 3000;
const TRANSIENT_MAX_MS = 5000;

/**
 * Feature 093 (T050) — a window has one status bar and N Runs, so the bar
 * summarizes rather than showing whichever Run wrote last.
 *
 * Keyed by **run id**, not queue id, on the T048 precedent: the key exists only
 * to stop two Runs from overwriting each other, run ids are unique across
 * queues, and every caller holds the Run while none holds its queue — a
 * queue-keyed bar would make each of the fifteen call sites resolve a queue it
 * has no other reason to know.
 *
 * Statuses a Run cannot come back from do not accumulate. A Run that reaches one
 * leaves the live map and becomes the single `lastOutcome`, which is what the bar
 * shows when nothing is live. That is both bounded and exactly the pre-feature
 * behavior for one Run: `schegent: completed` persists until something else
 * happens.
 */
const SETTLED_KINDS: ReadonlySet<StatusKind> = new Set([
  'completed',
  'failed',
  'canceled',
  // `idle` is not terminal, but a Run reporting it has nothing to contribute to
  // a summary of live work — and the pending count it carries is what the bar
  // showed before this feature when nothing was running.
  'idle'
]);

/**
 * Which condition the one line reports when several are true at once, most
 * urgent first. `running` leads because it is what the window is *doing*, and
 * `stalled` outranks `paused` because it needs an operator while a pause may be
 * a deliberate one.
 *
 * Only these three appear: every other kind is settled, so it has already left
 * the live set by the time the summary is taken.
 */
const LIVE_KIND_PRECEDENCE: readonly StatusKind[] = ['running', 'stalled', 'paused'];

export class SchegentStatusBar {
  private readonly item: StatusBarItemLike;
  private transientTimer: ReturnType<typeof setTimeout> | null = null;
  private preTransientText: string | null = null;
  /** Runs with live work to summarize, keyed by run id. */
  private readonly runs = new Map<string, StatusModel>();
  /** The last model reported by a Run as it left the live set, if any. */
  private lastOutcome: StatusModel | null = null;
  /**
   * Feature 093 (T050) — a condition true of the *window*, not of any one Run.
   *
   * Out-of-credits is the case: the CLI is unavailable to every queue at once,
   * and the next poll time is the window's, so it is not a Run's to report. It
   * outranks the aggregate because no Run's phase is the useful answer while it
   * holds. Keeping it in the same map as the Runs is what made the watchdog and
   * the drivers overwrite each other before N Runs even existed.
   */
  private windowModel: StatusModel | null = null;
  private evidenceHealth: StatusEvidenceHealth = 'healthy';

  constructor(item: StatusBarItemLike) {
    this.item = item;
    this.item.command = 'schegent.showAuditLog';
    this.item.text = 'schegent: idle';
    this.item.show();
  }

  /**
   * Report where one Run stands. `runId` identifies the reporter so a second
   * Run's update adds to the summary instead of replacing it.
   */
  public update(runId: string, model: StatusModel): void {
    if (SETTLED_KINDS.has(model.kind)) {
      this.runs.delete(runId);
      this.lastOutcome = model;
    } else {
      this.runs.set(runId, model);
    }
    this.render();
  }

  /**
   * Report a condition that holds for the whole window. Pass `null` to clear it
   * and fall back to the per-Run aggregate.
   */
  public updateWindow(model: StatusModel | null): void {
    this.windowModel = model;
    this.render();
  }

  public setEvidenceHealth(health: StatusEvidenceHealth): void {
    this.evidenceHealth = health;
    this.render();
  }

  private render(): void {
    const summary = this.summarize();
    const text = this.withEvidenceIndicator(formatText(summary.headline, summary.runCount));
    const tooltip = this.withEvidenceTooltip(formatTooltip(summary));
    if (this.transientTimer !== null) {
      // A transient is active — let it own `item.text` and capture the
      // intended steady-state text so the restore is correct.
      this.preTransientText = text;
      this.item.tooltip = tooltip;
      return;
    }
    this.item.text = text;
    this.item.tooltip = tooltip;
  }

  /**
   * Reduce the window to one headline plus the models behind it.
   *
   * With zero or one live Run the headline *is* that Run's model and
   * `runCount` is 1, so every string the bar produced before this feature is
   * produced byte for byte. Only a second concurrent Run changes the output.
   */
  private summarize(): StatusSummary {
    if (this.windowModel) {
      return { headline: this.windowModel, runCount: 1, models: [this.windowModel] };
    }
    const models = [...this.runs.values()];
    if (models.length === 0) {
      const headline = this.lastOutcome ?? { kind: 'idle' as const };
      return { headline, runCount: 0, models: [] };
    }
    const kind =
      LIVE_KIND_PRECEDENCE.find((k) => models.some((m) => m.kind === k)) ?? models[0].kind;
    const matching = models.filter((m) => m.kind === kind);
    return { headline: matching[0], runCount: matching.length, models };
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

  private withEvidenceIndicator(text: string): string {
    if (this.evidenceHealth === 'unavailable') {
      return `$(error) ${text} · evidence unavailable`;
    }
    if (this.evidenceHealth === 'degraded') {
      return `$(warning) ${text} · evidence degraded`;
    }
    return text;
  }

  private withEvidenceTooltip(tooltip: string): string {
    if (this.evidenceHealth === 'unavailable') {
      return `structured audit evidence unavailable (fail-closed policy) — ${tooltip}`;
    }
    if (this.evidenceHealth === 'degraded') {
      return `optional execution evidence degraded — ${tooltip}`;
    }
    return tooltip;
  }
}

interface StatusSummary {
  /** The one model the headline is drawn from. */
  readonly headline: StatusModel;
  /** How many live Runs share the headline's kind. */
  readonly runCount: number;
  /** Every live Run, for the tooltip. */
  readonly models: readonly StatusModel[];
}

/**
 * Feature 093 (T050) — the plural forms.
 *
 * A count only replaces the detailed line when there is genuinely more than one
 * Run in that state, because a phase name and iteration are more useful than a
 * count and a single Run is still the common case. `2 runs` rather than naming
 * two phases: the bar is one line, and the tooltip carries the detail.
 */
function formatText(model: StatusModel, runCount: number): string {
  if (runCount > 1) {
    switch (model.kind) {
      case 'running':
        return `schegent: ${runCount} runs`;
      case 'stalled':
        return `schegent: ${runCount} stalled`;
      case 'paused':
        return `schegent: ${runCount} paused`;
      default:
        // A settled kind reached here only as a headline of one, so the
        // singular form below is the right answer.
        break;
    }
  }
  return formatOne(model);
}

function formatOne(model: StatusModel): string {
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

function formatTooltip(summary: StatusSummary): string {
  // Feature 093 (T050) — with one live Run (or none) the tooltip is what it has
  // always been. With several, each gets a line: the bar's one line cannot hold
  // four phases, and the tooltip is where an operator looks for which.
  //
  // The lines carry phase and iteration, never a queue id or an
  // operator-authored queue name. The status bar is a summary surface and has
  // no names to work from; the sidebar owns queue identification.
  if (summary.models.length > 1) {
    const lines = summary.models.map((m) => modelLine(m));
    return [...lines, 'click to view audit log'].join('\n');
  }
  const parts = modelParts(summary.headline);
  parts.push('click to view audit log');
  return parts.join(' — ');
}

function modelParts(model: StatusModel): string[] {
  const parts: string[] = [];
  if (model.detail) parts.push(model.detail);
  if (model.phase) parts.push(`phase: ${model.phase}`);
  if (model.iteration && model.iterationCap) {
    parts.push(`iteration: ${model.iteration}/${model.iterationCap}`);
  }
  return parts;
}

function modelLine(model: StatusModel): string {
  const parts = modelParts(model);
  return parts.length > 0 ? `${model.kind} — ${parts.join(' — ')}` : model.kind;
}
