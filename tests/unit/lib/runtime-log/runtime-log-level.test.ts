// Feature 019 — Severity helpers for the runtime debug log service.

import { describe, it, expect } from 'vitest';
import {
  RUNTIME_LOG_LEVELS,
  isRuntimeLogLevel,
  levelSeverity,
  shouldEmit,
  type RuntimeLogLevel
} from '../../../../src/lib/runtime-log/runtime-log-level';

describe('RUNTIME_LOG_LEVELS', () => {
  it('enumerates the four canonical levels in order', () => {
    expect(RUNTIME_LOG_LEVELS).toEqual(['DEBUG', 'INFO', 'WARN', 'ERROR']);
  });
});

describe('isRuntimeLogLevel', () => {
  it.each(['DEBUG', 'INFO', 'WARN', 'ERROR'])(
    'returns true for canonical level %s',
    (value) => {
      expect(isRuntimeLogLevel(value)).toBe(true);
    }
  );

  it.each(['debug', 'info', 'warn', 'error', 'TRACE', 'FATAL', '', null, undefined, 42])(
    'returns false for non-canonical input %p',
    (value) => {
      expect(isRuntimeLogLevel(value)).toBe(false);
    }
  );
});

describe('levelSeverity', () => {
  it('orders DEBUG < INFO < WARN < ERROR strictly', () => {
    expect(levelSeverity('DEBUG')).toBeLessThan(levelSeverity('INFO'));
    expect(levelSeverity('INFO')).toBeLessThan(levelSeverity('WARN'));
    expect(levelSeverity('WARN')).toBeLessThan(levelSeverity('ERROR'));
  });
});

describe('shouldEmit — 16-pair truth table', () => {
  // Row = record level, Col = configured filter level
  const TRUTH: Record<RuntimeLogLevel, Record<RuntimeLogLevel, boolean>> = {
    DEBUG: { DEBUG: true, INFO: false, WARN: false, ERROR: false },
    INFO: { DEBUG: true, INFO: true, WARN: false, ERROR: false },
    WARN: { DEBUG: true, INFO: true, WARN: true, ERROR: false },
    ERROR: { DEBUG: true, INFO: true, WARN: true, ERROR: true }
  };

  for (const record of RUNTIME_LOG_LEVELS) {
    for (const configured of RUNTIME_LOG_LEVELS) {
      const expected = TRUTH[record][configured];
      it(`record=${record} configured=${configured} → ${expected}`, () => {
        expect(shouldEmit(record, configured)).toBe(expected);
      });
    }
  }
});
