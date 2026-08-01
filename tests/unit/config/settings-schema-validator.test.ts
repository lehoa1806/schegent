// Feature 056 follow-on — activation-time settings drift guard.
//
// Mirrors the host wiring at `src/extension.ts`:
//   validateWorkspaceSettings(config, logger, observedKeys)
//
// Behaviors under test:
//   1. A schema-compliant value emits NO drift.
//   2. A wrong-typed value emits `type-mismatch` and warns.
//   3. An out-of-range integer emits `out-of-range` and warns.
//   4. An out-of-enum string emits `invalid-enum` and warns.
//   5. A pattern-violating string (e.g. wakeUp.chronologicalTime
//      `25:00`) emits `pattern-mismatch` and warns.
//   6. An observed key that is NOT in the schema emits `unknown-key`.
//   7. Multiple layers (workspaceFolder, workspace, global) of the
//      same key are each inspected independently.

import { describe, it, expect } from 'vitest';
import {
  validateWorkspaceSettings,
  type SettingsConfigReader
} from '../../../src/config/settings-schema-validator';
import { SanitizedLogger, type LogSink } from '../../../src/lib/logger';

class CapturingSink implements LogSink {
  public readonly lines: string[] = [];
  appendLine(line: string): void {
    this.lines.push(line);
  }
}

function makeReader(
  values: Record<string, {
    workspaceFolderValue?: unknown;
    workspaceValue?: unknown;
    globalValue?: unknown;
  }>
): SettingsConfigReader {
  return {
    inspect<T>(key: string) {
      const v = values[key];
      if (!v) return undefined;
      return v as {
        defaultValue?: T;
        globalValue?: T;
        workspaceValue?: T;
        workspaceFolderValue?: T;
      };
    }
  };
}

function makeLogger(): { logger: SanitizedLogger; sink: CapturingSink } {
  const sink = new CapturingSink();
  return { logger: new SanitizedLogger([sink]), sink };
}

describe('validateWorkspaceSettings', () => {
  it('emits no drift when every layer matches the schema', () => {
    const { logger, sink } = makeLogger();
    const reader = makeReader({
      'loop.maxIterations': { workspaceValue: 10 },
      'logging.runtimeLogLevel': { workspaceValue: 'INFO' }
    });
    const drift = validateWorkspaceSettings(reader, logger, new Set());
    expect(drift).toEqual([]);
    expect(sink.lines).toEqual([]);
  });

  it('reports a type-mismatch on a string given where boolean is expected', () => {
    const { logger, sink } = makeLogger();
    const reader = makeReader({
      'logging.verbose': { workspaceValue: 'yes' }
    });
    const drift = validateWorkspaceSettings(reader, logger, new Set());
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      key: 'schegent.logging.verbose',
      kind: 'type-mismatch',
      layer: 'workspace'
    });
    expect(sink.lines.some((l) => l.includes('schegent.logging.verbose'))).toBe(true);
  });

  it('reports out-of-range for an integer beyond the declared max', () => {
    const { logger, sink } = makeLogger();
    const reader = makeReader({
      'retry.maxAttempts': { workspaceValue: 99 }
    });
    const drift = validateWorkspaceSettings(reader, logger, new Set());
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      key: 'schegent.retry.maxAttempts',
      kind: 'out-of-range'
    });
    expect(sink.lines[0]).toMatch(/out-of-range/);
  });

  it('reports invalid-enum for an unrecognized enum value', () => {
    const { logger, sink } = makeLogger();
    const reader = makeReader({
      'logging.runtimeLogLevel': { workspaceValue: 'TRACE' }
    });
    const drift = validateWorkspaceSettings(reader, logger, new Set());
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      key: 'schegent.logging.runtimeLogLevel',
      kind: 'invalid-enum'
    });
    expect(sink.lines[0]).toMatch(/invalid-enum/);
  });

  it('rejects environment allowlist entries that contain values or shell syntax', () => {
    const { logger, sink } = makeLogger();
    const reader = makeReader({
      'cli.environmentAllowlist': {
        globalValue: ['HTTPS_PROXY', 'TOKEN=secret', 'BAD-NAME']
      }
    });

    const drift = validateWorkspaceSettings(reader, logger, new Set());

    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      key: 'schegent.cli.environmentAllowlist',
      kind: 'type-mismatch',
      layer: 'global'
    });
    expect(sink.lines.join('\n')).not.toContain('secret');
  });

  it('reports pattern-mismatch for a chronological time outside HH:MM', () => {
    const { logger, sink } = makeLogger();
    const reader = makeReader({
      'wakeUp.chronologicalTime': { globalValue: '25:00' }
    });
    const drift = validateWorkspaceSettings(reader, logger, new Set());
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      key: 'schegent.wakeUp.chronologicalTime',
      kind: 'pattern-mismatch',
      layer: 'global'
    });
    expect(sink.lines[0]).toMatch(/pattern-mismatch/);
  });

  it('reports unknown-key for observed keys not in the schema', () => {
    const { logger, sink } = makeLogger();
    const observed = new Set([
      'schegent.unknown.future.setting',
      'schegent.loop.maxIterations'
    ]);
    const drift = validateWorkspaceSettings(makeReader({}), logger, observed);
    const unknown = drift.filter((d) => d.kind === 'unknown-key');
    expect(unknown).toHaveLength(1);
    expect(unknown[0].key).toBe('schegent.unknown.future.setting');
    expect(sink.lines.some((l) => l.includes('unknown.future.setting'))).toBe(true);
  });

  it('inspects every layer independently for the same key', () => {
    const { logger } = makeLogger();
    const reader = makeReader({
      'loop.maxIterations': {
        workspaceFolderValue: 0,
        workspaceValue: 10,
        globalValue: 999
      }
    });
    const drift = validateWorkspaceSettings(reader, logger, new Set());
    expect(drift.filter((d) => d.layer === 'workspaceFolder')).toHaveLength(1);
    expect(drift.filter((d) => d.layer === 'workspace')).toHaveLength(0);
    expect(drift.filter((d) => d.layer === 'global')).toHaveLength(1);
  });
});
