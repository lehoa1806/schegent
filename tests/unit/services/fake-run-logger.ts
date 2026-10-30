// Feature 251 (FR-R4-F04, C1) — the logger double the RunDriver tests inject.
//
// `RunDriver.drive()` now takes a per-drive child logger from `deps.logger.withContext({ runId })`, so a double
// has to answer it. This one returns ITSELF, so every assertion these tests make on `warn`, `error`, `info` or
// `debug` still sees each call: the child is the same object, and what a real child adds (the Run id on the
// line) is pinned by `tests/unit/lib/run-log-context.test.ts`, not here.

import { vi } from 'vitest';

export interface FakeRunLogger {
  readonly warn: ReturnType<typeof vi.fn>;
  readonly error: ReturnType<typeof vi.fn>;
  readonly info: ReturnType<typeof vi.fn>;
  readonly debug: ReturnType<typeof vi.fn>;
  readonly withContext: () => FakeRunLogger;
}

export function fakeRunLogger(): FakeRunLogger {
  const logger: FakeRunLogger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    withContext: () => logger
  };
  return logger;
}
