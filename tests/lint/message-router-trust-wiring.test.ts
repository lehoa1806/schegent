// Defense-in-depth lint for the MessageRouter workspace-trust gate.
//
// The production router wiring MUST pass VS Code's workspace trust state
// into RouterDeps. Router-focused tests that instantiate MessageRouter
// directly must also make the trust posture explicit unless they are
// dedicated read-only command tests.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { filesMatching } from './source-scan';

const REPO_ROOT = resolve(__dirname, '..', '..');
const EXTENSION_PATH = resolve(REPO_ROOT, 'src', 'extension.ts');
const TEST_ROOT = resolve(REPO_ROOT, 'tests');

const READ_ONLY_ROUTER_TEST_ALLOWLIST: ReadonlySet<string> = new Set([
  'tests/unit/ui/sidebar/message-router-phase-log.test.ts'
]);

function rel(abs: string): string {
  return abs.startsWith(REPO_ROOT + '/') ? abs.slice(REPO_ROOT.length + 1) : abs;
}

function listMessageRouterTests(): readonly string[] {
  let out: string;
  try {
    out = filesMatching(TEST_ROOT, "new MessageRouter", { fixed: true }).join('\n');
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1 && (!e.stdout || e.stdout.trim() === '')) {
      return [];
    }
    throw err;
  }
  return (
    out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(rel)
      // The lint tests themselves match on the constructor name appearing as a
      // `grep` argument, not on a construction, so they are not router tests and
      // have no trust posture to state. Excluded by directory rather than by an
      // allowlist entry, which would read as tolerating a violation.
      //
      // Until FR-R3-024 this file was the only `tests/lint/` match and it
      // happened to satisfy itself, because a gate that asserts on `isTrusted`
      // necessarily contains the word. Its sibling
      // `message-router-primacy-wiring.test.ts` does not, which is what made the
      // missing exclusion visible.
      .filter((file) => !file.startsWith('tests/lint/'))
  );
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

  // Vacuity control. The assertion above iterates the scan and pushes offenders;
  // an empty scan produces an empty offender list and a green test. `new
  // MessageRouter` no longer matching, or TEST_ROOT moving, both look exactly
  // like "every router test wires trust correctly".
  //
  // The read-only allowlist is the anchor. It names a file that constructs a
  // MessageRouter, so the scan must find it — and if that file is ever deleted
  // or renamed, this fails and points at the stale allowlist entry, which is the
  // other thing worth knowing.
  it('finds the router tests it filters, including the allowlisted one', () => {
    const found = listMessageRouterTests();
    expect(
      found.length,
      'The scan found no `new MessageRouter` sites under tests/. Either the ' +
        'constructor was renamed or TEST_ROOT has moved — in both cases the ' +
        'trust-wiring assertion above is passing over an empty set.'
    ).toBeGreaterThan(1);
    for (const allowed of READ_ONLY_ROUTER_TEST_ALLOWLIST) {
      expect(
        found,
        `${allowed} is allowlisted as a read-only router test but the scan did not ` +
          `find it. Either it no longer constructs a MessageRouter — in which case ` +
          `remove the stale allowlist entry — or the scan is broken.`
      ).toContain(allowed);
    }
  });
});
