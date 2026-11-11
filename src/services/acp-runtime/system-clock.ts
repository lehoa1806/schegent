/**
 * FR-R6-F13 (research R3) — the clock the runtime uses when the host injects none: wall time
 * for observation stamps, `setTimeout` for deadlines and bounds. Zero `vscode` imports.
 */
import type { AcpClock } from '../../contracts/acp-runtime';

export const SYSTEM_CLOCK: AcpClock = Object.freeze({
  nowUtc: (): string => new Date().toISOString(),
  setTimer: (callback: () => void, delayMs: number) => {
    const handle = setTimeout(callback, delayMs);
    return { cancel: (): void => clearTimeout(handle) };
  }
});
