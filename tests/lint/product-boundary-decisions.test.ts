import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const read = (path: string): string => readFileSync(resolve(ROOT, path), 'utf8');

describe('accepted product-boundary decisions', () => {
  it('keeps offline execution outside the current promise and visible before submission', () => {
    const decision = read('docs/concepts/local-first-not-offline.md');
    const composer = read('webview-ui/src/components/QueueInputForm.svelte');
    expect(decision).toContain('Offline AI execution is not a supported promise');
    expect(decision).toContain('Capability-discovery prototype');
    expect(decision).toContain('Queue-only/no-execution behavior');
    expect(composer).toContain('data-testid="dashboard-network-dependence-note"');
    expect(composer).toContain('Local-first, not offline');
  });

  it('keeps remote, multi-user, and parallel execution behind the architecture gate', () => {
    const gate = read('docs/architecture/remote-multi-user-expansion-gate.md');
    for (const section of [
      'Authentication and authorization',
      'Tenant and workspace isolation',
      'Durable scheduling and execution',
      'Distributed locking and idempotency',
      'Secret brokering',
      'Evidence, retention, and privacy',
      'Prompt-injection and tool policy',
      'Rollout and rollback',
      'Required threat model',
      'Exit criteria'
    ]) {
      expect(gate).toContain(section);
    }
    expect(gate).toContain('The concurrency cap remains pinned at one');
    expect(read('ARCHITECTURE.md')).toContain('expansion architecture gate');
  });
});
