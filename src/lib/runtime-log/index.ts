// Feature 019 — Runtime Debug Log Service public surface.
//
// Re-exports the runtime-log module so callers can import from
// `src/lib/runtime-log/` without reaching into individual files.
//
// Module layout (per specs/019-runtime-debug-log/contracts/runtime-log-service.md):
//   - runtime-log-level.ts    — RuntimeLogLevel + severity helpers
//   - runtime-log-path.ts     — resolveRuntimeLogPath
//   - runtime-log-settings.ts — createRuntimeLogAccessor (no caching)
//   - runtime-log-sink.ts     — RuntimeLogSink (LogSink implementation)

export {
  RUNTIME_LOG_LEVELS,
  isRuntimeLogLevel,
  levelSeverity,
  shouldEmit
} from './runtime-log-level';
export type { RuntimeLogLevel } from './runtime-log-level';

export {
  resolveRuntimeLogPath,
  isAbsoluteCrossPlatform
} from './runtime-log-path';
export type {
  RuntimeLogPathResult,
  RuntimeLogPathError
} from './runtime-log-path';

export {
  createRuntimeLogAccessor,
  __resetRuntimeLogAccessorWarnCache
} from './runtime-log-settings';
export type {
  RuntimeLogAccessor,
  RuntimeLogSettings
} from './runtime-log-settings';

export { RuntimeLogSink } from './runtime-log-sink';
