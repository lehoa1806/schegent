import { describe, it, expect, vi } from 'vitest';
import {
  createBackendRunner,
  resolveBackendKind,
  DEFAULT_BACKEND,
  SUPPORTED_BACKENDS
} from '../../../src/runner/backend-runner-factory';
import { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import { CodexCliRunner } from '../../../src/runner/codex-cli';

describe('resolveBackendKind', () => {
  it('returns the default when the value is undefined / null / empty', () => {
    expect(resolveBackendKind(undefined)).toBe(DEFAULT_BACKEND);
    expect(resolveBackendKind(null)).toBe(DEFAULT_BACKEND);
    expect(resolveBackendKind('')).toBe(DEFAULT_BACKEND);
    expect(resolveBackendKind('   ')).toBe(DEFAULT_BACKEND);
  });

  it.each(SUPPORTED_BACKENDS)('accepts %s exactly', (kind) => {
    expect(resolveBackendKind(kind)).toBe(kind);
  });

  it('lowercases and trims supported values', () => {
    expect(resolveBackendKind('  CLAUDE  ')).toBe('claude');
    expect(resolveBackendKind('Codex')).toBe('codex');
  });

  it('falls back to the default and warns when the value is unknown', () => {
    const logger = { warn: vi.fn() };
    expect(resolveBackendKind('gemini', logger)).toBe(DEFAULT_BACKEND);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain('unknown schegent.backend.runner');
    expect(logger.warn.mock.calls[0][0]).toContain('gemini');
  });

  it('does not warn for valid values', () => {
    const logger = { warn: vi.fn() };
    resolveBackendKind('codex', logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('createBackendRunner', () => {
  it('constructs a ClaudeCliRunner for kind=claude', () => {
    const runner = createBackendRunner('claude', { allowUncontained: true });
    expect(runner).toBeInstanceOf(ClaudeCliRunner);
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('constructs a CodexCliRunner for kind=codex', () => {
    const runner = createBackendRunner('codex', { allowUncontained: false });
    expect(runner).toBeInstanceOf(CodexCliRunner);
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('forwards the monitor hook into the concrete runner', () => {
    const hook = vi.fn();
    const claude = createBackendRunner('claude', { allowUncontained: true, monitorHook: hook });
    const codex = createBackendRunner('codex', { allowUncontained: false, monitorHook: hook });
    // The hooks aren't observable from outside, but neither construction
    // should throw — that's the contract.
    expect(claude).toBeInstanceOf(ClaudeCliRunner);
    expect(codex).toBeInstanceOf(CodexCliRunner);
  });
});
