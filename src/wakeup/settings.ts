// Feature 014 — Wake up settings reader/writer.
//
// The four `schegent.wakeUp.*` keys persist at Global (user) scope so the
// daemon registration applies per-user, not per-workspace. The host's
// save-handler is the only call site for `writeSettings`; everything
// else (`readSettings`) is a pure projection over the
// `vscode.WorkspaceConfiguration` slice.
//
// Per data-model.md:
//   - enabled            boolean       default false
//   - schedulerType      'chronological' | 'periodic'  default 'chronological'
//   - chronologicalTime  /^([01]\d|2[0-3]):[0-5]\d$/   default '04:00'
//   - periodicInterval   /^Every (\d+)(m|h)$/          default 'Every 4h'
//                        with everyMs ≥ 60_000 (1-minute floor).
//
// The save-handler's reject-reason vocabulary is enumerated in
// specs/014-wake-up/contracts/wakeup-settings-ipc.md §Reject-reason vocabulary.

export const CONFIGURATION_TARGET_GLOBAL = 1;

export type SchedulerType = 'chronological' | 'periodic';

/**
 * Feature 031 §FR-002 / data-model §1 — closed registry of Claude
 * model identifiers selectable from the Wake-up Settings dropdown.
 * Code-resident, immutable at runtime; extension requires a code change
 * + PR review. The sentinel `'runner-default'` (NOT a member of this
 * registry) means "let the runner choose; do not pass `--model` to the
 * CLI." Together the registry + sentinel form `WakeUpModelSelection`.
 */
export type WakeUpModelId =
  | 'claude-fable-5'
  | 'claude-opus-4-7'
  | 'claude-opus-4-8'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-6';

export const WAKEUP_SUPPORTED_MODELS: ReadonlyArray<WakeUpModelId> = Object.freeze([
  'claude-fable-5',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-6'
] as const);

/** Canonical sentinel for "runner picks the default". */
export const RUNNER_DEFAULT_MODEL = 'runner-default' as const;
export type RunnerDefaultModel = typeof RUNNER_DEFAULT_MODEL;

/** Union the dropdown and settings mirror persist. */
export type WakeUpModelSelection = WakeUpModelId | RunnerDefaultModel;

export interface WakeUpSettings {
  readonly enabled: boolean;
  readonly schedulerType: SchedulerType;
  readonly chronologicalTime: string;
  readonly periodicInterval: string;
  /**
   * Feature 031 §FR-002. The operator's selection of the Claude model the
   * runner should invoke. Defaults to `RUNNER_DEFAULT_MODEL` when absent
   * or unparsable on read (e.g. legacy settings mirrors without the
   * field). The save-path always writes a member of `WakeUpModelSelection`.
   */
  readonly model: WakeUpModelSelection;
}

/**
 * Closed set of reject reasons the save-handler can emit. Mirrors
 * `contracts/wakeup-settings-ipc.md §Reject-reason vocabulary`. The
 * `daemon-install-failed:<redacted>` suffix is appended by the
 * save-handler (NOT here) since it depends on the platform installer.
 *
 * Feature 031 (data-model §2) adds `'invalid-model'` for save payloads
 * carrying a model identifier outside the closed registry above.
 */
export type WakeUpRejectReason =
  | 'unknown-key'
  | 'invalid-scheduler-type'
  | 'invalid-chronological-time'
  | 'invalid-periodic-interval'
  | 'periodic-interval-below-minimum'
  | 'invalid-model'
  | 'config-write-failed';

export class SettingsValidationError extends Error {
  public readonly reason: WakeUpRejectReason;
  constructor(reason: WakeUpRejectReason, message?: string) {
    super(message ?? reason);
    this.name = 'SettingsValidationError';
    this.reason = reason;
  }
}

/**
 * Minimal slice of `vscode.WorkspaceConfiguration` this surface needs.
 * Mirrors the pattern in `src/config/general-settings.ts` so unit tests
 * never have to import `vscode`.
 */
export interface WakeUpConfig {
  get<T>(key: string, defaultValue: T): T;
  // `PromiseLike<void>` is the structural superset of `vscode.Thenable<void>`
  // and avoids dragging the VS Code global type declaration into webview-side
  // typechecks that resolve this file from `tests/unit/.../test.ts` imports.
  update(key: string, value: unknown, target: number): Promise<void> | PromiseLike<void>;
}

const DEFAULTS: Readonly<WakeUpSettings> = Object.freeze({
  enabled: false,
  schedulerType: 'chronological',
  chronologicalTime: '04:00',
  periodicInterval: 'Every 4h',
  model: RUNNER_DEFAULT_MODEL
});

const CHRONO_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PERIODIC_RE = /^Every (\d+)(m|h)$/;

/**
 * Feature 031 — coerce an unknown value (from config OR from the
 * settings-mirror file) into a `WakeUpModelSelection`. Returns the
 * sentinel when the value is absent, malformed, or outside the closed
 * registry — i.e., legacy mirrors and corrupted mirrors collapse to
 * the same safe default at read time. Save-side validation is stricter
 * (see `validateSettings`).
 */
export function coerceWakeUpModel(value: unknown): WakeUpModelSelection {
  if (typeof value !== 'string') return RUNNER_DEFAULT_MODEL;
  if (value === RUNNER_DEFAULT_MODEL) return RUNNER_DEFAULT_MODEL;
  if ((WAKEUP_SUPPORTED_MODELS as readonly string[]).includes(value)) {
    return value as WakeUpModelId;
  }
  return RUNNER_DEFAULT_MODEL;
}

export function readSettings(config: WakeUpConfig): WakeUpSettings {
  const enabledRaw = config.get<unknown>('wakeUp.enabled', DEFAULTS.enabled);
  const schedulerTypeRaw = config.get<unknown>('wakeUp.schedulerType', DEFAULTS.schedulerType);
  const chronologicalTimeRaw = config.get<unknown>('wakeUp.chronologicalTime', DEFAULTS.chronologicalTime);
  const periodicIntervalRaw = config.get<unknown>('wakeUp.periodicInterval', DEFAULTS.periodicInterval);
  const modelRaw = config.get<unknown>('wakeUp.model', DEFAULTS.model);

  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : DEFAULTS.enabled;
  const schedulerType: SchedulerType =
    schedulerTypeRaw === 'chronological' || schedulerTypeRaw === 'periodic'
      ? schedulerTypeRaw
      : DEFAULTS.schedulerType;
  const chronologicalTime =
    typeof chronologicalTimeRaw === 'string' && CHRONO_RE.test(chronologicalTimeRaw)
      ? chronologicalTimeRaw
      : DEFAULTS.chronologicalTime;
  const periodicInterval =
    typeof periodicIntervalRaw === 'string' && isValidPeriodic(periodicIntervalRaw)
      ? periodicIntervalRaw
      : DEFAULTS.periodicInterval;
  const model = coerceWakeUpModel(modelRaw);

  return { enabled, schedulerType, chronologicalTime, periodicInterval, model };
}

/**
 * Validates the proposed settings *atomically* — every invariant from
 * data-model.md must hold. The save-handler should call this BEFORE
 * any `update()` call so an invalid payload does not partially write.
 *
 * @throws {SettingsValidationError} if any invariant is violated.
 */
export function validateSettings(proposed: WakeUpSettings): void {
  if (proposed.schedulerType !== 'chronological' && proposed.schedulerType !== 'periodic') {
    throw new SettingsValidationError('invalid-scheduler-type');
  }
  if (typeof proposed.chronologicalTime !== 'string' || !CHRONO_RE.test(proposed.chronologicalTime)) {
    throw new SettingsValidationError('invalid-chronological-time');
  }
  const periodic = parsePeriodic(proposed.periodicInterval);
  if (!periodic) {
    throw new SettingsValidationError('invalid-periodic-interval');
  }
  if (periodic.everyMs < 60_000) {
    throw new SettingsValidationError('periodic-interval-below-minimum');
  }
  // Feature 031 — model field validation. Strict check at write time:
  // anything outside `{RUNNER_DEFAULT_MODEL} ∪ WAKEUP_SUPPORTED_MODELS`
  // is rejected with `'invalid-model'`. Reads are lenient and collapse
  // to the sentinel (see `coerceWakeUpModel`).
  if (
    proposed.model !== RUNNER_DEFAULT_MODEL
    && !(WAKEUP_SUPPORTED_MODELS as readonly string[]).includes(proposed.model)
  ) {
    throw new SettingsValidationError('invalid-model');
  }
}

/**
 * Transactional write. Validates first; only if all invariants hold
 * does it attempt the four `config.update()` calls. If any underlying
 * write throws, the error is wrapped as `config-write-failed`.
 */
export async function writeSettings(
  config: WakeUpConfig,
  proposed: WakeUpSettings
): Promise<void> {
  validateSettings(proposed);
  try {
    await Promise.resolve(
      config.update('wakeUp.enabled', proposed.enabled, CONFIGURATION_TARGET_GLOBAL)
    );
    await Promise.resolve(
      config.update('wakeUp.schedulerType', proposed.schedulerType, CONFIGURATION_TARGET_GLOBAL)
    );
    await Promise.resolve(
      config.update('wakeUp.chronologicalTime', proposed.chronologicalTime, CONFIGURATION_TARGET_GLOBAL)
    );
    await Promise.resolve(
      config.update('wakeUp.periodicInterval', proposed.periodicInterval, CONFIGURATION_TARGET_GLOBAL)
    );
    await Promise.resolve(
      config.update('wakeUp.model', proposed.model, CONFIGURATION_TARGET_GLOBAL)
    );
  } catch (err) {
    throw new SettingsValidationError('config-write-failed', (err as Error).message);
  }
}

export function getDefaults(): WakeUpSettings {
  return DEFAULTS;
}

function isValidPeriodic(input: string): boolean {
  const parsed = parsePeriodic(input);
  return parsed !== null && parsed.everyMs >= 60_000;
}

interface ParsedPeriodic {
  readonly everyMs: number;
  readonly unit: 'm' | 'h';
  readonly count: number;
}

export function parsePeriodic(input: string): ParsedPeriodic | null {
  const match = PERIODIC_RE.exec(input);
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  const unit = match[2] as 'm' | 'h';
  if (!Number.isFinite(count) || count <= 0) return null;
  const everyMs = unit === 'h' ? count * 60 * 60 * 1000 : count * 60 * 1000;
  return { everyMs, unit, count };
}
