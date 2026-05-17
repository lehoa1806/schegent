import { describe, expect, it } from 'vitest';
import { ClaudeCliRunner } from '../../../src/runner/claude-cli';
import type { BackendRunner } from '../../../src/contracts';

describe('BackendRunner contract (US6 / T095)', () => {
  it('ClaudeCliRunner satisfies the BackendRunner interface', () => {
    const runner: BackendRunner = new ClaudeCliRunner();
    expect(typeof runner.invoke).toBe('function');
    expect(typeof runner.cancelActive).toBe('function');
    expect(runner.hasActiveProcess).toBe(false);
  });

  it('cancelActive is a no-op when no process is running', () => {
    const runner = new ClaudeCliRunner();
    expect(runner.cancelActive()).toBe(false);
    expect(runner.hasActiveProcess).toBe(false);
  });
});
