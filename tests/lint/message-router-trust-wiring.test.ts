// Defense-in-depth lint for the MessageRouter workspace-trust gate.
//
// The production router wiring MUST pass VS Code's workspace trust state
// into RouterDeps. Router-focused tests that instantiate MessageRouter
// directly must also make the trust posture explicit unless they are
// dedicated read-only command tests.

import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXTENSION_PATH = resolve(REPO_ROOT, 'src', 'extension.ts');
const TEST_ROOT = resolve(REPO_ROOT, 'tests');

const READ_ONLY_ROUTER_TEST_ALLOWLIST: ReadonlySet<string> = new Set([
  'tests/unit/ui/sidebar/message-router-phase-log.test.ts',
  'tests/unit/ui/sidebar/message-router-read-wakeup-session-log.test.ts'
]);

function rel(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

function listMessageRouterTests(): readonly string[] {
  let out: string;
  try {
    out = execSync(`grep -rln "new MessageRouter" "${TEST_ROOT}"`, {
      encoding: 'utf8'
    });
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(rel);
}

describe('MessageRouter workspace-trust wiring', () => {
  it('production wiring passes VS Code workspace trust into RouterDeps', () => {
    const src = readFileSync(EXTENSION_PATH, 'utf8');
    expect(src).toContain('isTrusted: () => vscode.workspace.isTrusted');
  });

  it('router tests with mutating-command coverage wire trust explicitly', () => {
    const offenders: string[] = [];
    for (const file of listMessageRouterTests()) {
      if (READ_ONLY_ROUTER_TEST_ALLOWLIST.has(file)) continue;
      const src = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      if (!src.includes('isTrusted')) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      `MessageRouter tests must wire isTrusted explicitly:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});
