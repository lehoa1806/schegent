// Feature 013 — Wave 7 (US7 / T093): monitor projection extracted from
// state-projector.ts. Pure function that maps the live monitor state
// to the snapshot shape, dropping terminal states (the snapshot only
// surfaces in-flight monitor activity).

import type { ClaudeCliMonitor } from '../../monitor/claude-cli-monitor';
import type { CliMonitorState } from './snapshot';

export function projectMonitor(
  monitor: Pick<ClaudeCliMonitor, 'getCurrentState'> | null
): CliMonitorState | null {
  if (!monitor) return null;
  const state = monitor.getCurrentState();
  if (!state) return null;
  if (
    state.status === 'completed' ||
    state.status === 'failed' ||
    state.status === 'timed_out' ||
    state.status === 'canceled'
  ) {
    return null;
  }
  return state;
}
