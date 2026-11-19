// FR-R7-06 — unit tests for the generated self-contained webview BackendDescriptor mirror.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS,
  WEBVIEW_BACKEND_DESCRIPTORS,
  WEBVIEW_BACKEND_LIST,
  findWebviewBackendDescriptor,
  getWebviewBackendDescriptor,
  isBackendRunnerKind,
  isUnsupportedEffortForBackend,
  mapBackends,
  mapMutableBackends,
  spendDenominationOf,
  type BackendRunnerKind
} from '../generated/backend-descriptors';

const MIRROR_SOURCE = readFileSync(
  resolve(__dirname, '../generated/backend-descriptors.ts'),
  'utf8'
);

function assertDeepFrozenData(value: unknown, path: string): void {
  expect(typeof value, `${path} must not be a function`).not.toBe('function');
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value), `${path} must be frozen`).toBe(true);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertDeepFrozenData(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertDeepFrozenData(child, `${path}.${key}`);
  }
}

describe('FR-R7-06 — generated webview backend-descriptors mirror', () => {
  it('carries zero imports (self-contained webview projection)', () => {
    expect(MIRROR_SOURCE).not.toMatch(/^\s*import\s+/m);
  });

  it('deeply freezes all descriptor data and maintains canonical backend order', () => {
    expect(DEFAULT_BACKEND).toBe('claude');
    expect(SUPPORTED_BACKENDS).toEqual(['claude', 'codex', 'agy']);
    expect(WEBVIEW_BACKEND_LIST.map((d) => d.kind)).toEqual([...SUPPORTED_BACKENDS]);
    assertDeepFrozenData(WEBVIEW_BACKEND_DESCRIPTORS, 'WEBVIEW_BACKEND_DESCRIPTORS');
    assertDeepFrozenData(WEBVIEW_BACKEND_LIST, 'WEBVIEW_BACKEND_LIST');
  });

  it('rejects unknown, non-string, and prototype-chain keys without falling back', () => {
    const unknowns: readonly unknown[] = [
      '',
      'unknown',
      'CLAUDE',
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      null,
      undefined,
      42,
      {},
      []
    ];
    for (const bad of unknowns) {
      expect(isBackendRunnerKind(bad)).toBe(false);
      expect(findWebviewBackendDescriptor(bad)).toBeUndefined();
      expect(() => getWebviewBackendDescriptor(bad as BackendRunnerKind)).toThrow(TypeError);
    }
    for (const kind of SUPPORTED_BACKENDS) {
      expect(isBackendRunnerKind(kind)).toBe(true);
      expect(findWebviewBackendDescriptor(kind)).toBe(WEBVIEW_BACKEND_DESCRIPTORS[kind]);
      expect(getWebviewBackendDescriptor(kind)).toBe(WEBVIEW_BACKEND_DESCRIPTORS[kind]);
    }
  });

  it('constructs frozen and mutable maps, spend denominations, and effort checks', () => {
    const labels = mapBackends((d) => d.displayLabel);
    expect(Object.isFrozen(labels)).toBe(true);
    expect(labels).toEqual({ claude: 'Claude', codex: 'Codex', agy: 'Agy' });

    const mutable = mapMutableBackends(() => [] as string[]);
    mutable.agy.push('gemini');
    expect(mutable).toEqual({ claude: [], codex: [], agy: ['gemini'] });

    expect(spendDenominationOf('claude')).toBe('usd');
    expect(spendDenominationOf('codex')).toBe('tokens');
    expect(spendDenominationOf('agy')).toBe('tokens');

    expect(isUnsupportedEffortForBackend('agy', 'max')).toBe(true);
    expect(isUnsupportedEffortForBackend('claude', 'max')).toBe(false);
    expect(isUnsupportedEffortForBackend('unknown', 'max')).toBe(false);
  });
});
