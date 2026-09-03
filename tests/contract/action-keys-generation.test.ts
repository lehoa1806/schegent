/**
 * Feature 193 (T035, negative control for T038) — asserts that
 * `npm run contracts:check` actually fails, and names the stale file, when
 * `src/contracts/action-keys.ts` loses an entry without its webview mirror
 * (`webview-ui/src/lib/generated/action-keys.ts`) being regenerated.
 *
 * Exercises the real `scripts/generate-contract-schemas.mjs --check` binary
 * against a minimal, file-exact sandbox copy of every input and output it
 * reads — not a reimplementation of its comparison logic. The sandbox lists
 * every relative path the script touches explicitly, so a mismatch here
 * would show up as a spurious failure on the unmutated control below, not as
 * a silent pass on the mutated one.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../..');
const GENERATOR_SCRIPT = 'scripts/generate-contract-schemas.mjs';
const STALE_ACTION_KEYS_MESSAGE = 'stale generated file: webview-ui/src/lib/generated/action-keys.ts';

// Every relative path the generator reads from or compares against in
// `--check` mode (see `scripts/generate-contract-schemas.mjs`'s
// `SourceExtractor` instantiations and its `generated` map).
const REQUIRED_FILES: readonly string[] = [
  GENERATOR_SCRIPT,
  'package.json',
  'src/contracts/sidebar-ipc.ts',
  'src/contracts/audit-events.ts',
  'src/state/workflow-run.ts',
  'src/contracts/state-schema.ts',
  'src/contracts/queue-snapshot.ts',
  'src/queue/feature-request.ts',
  'src/runner/invocation-result.ts',
  'src/ui/sidebar/snapshot.ts',
  'src/lib/retry-condition.ts',
  'src/lib/fatal-signature-registry.ts',
  'src/contracts/action-keys.ts',
  // Feature 195 (T006) — the second whole-file mirror
  // `generate-contract-schemas.mjs` registers alongside `action-keys.ts`. The
  // generator touches it on every `--check` run regardless of which mirror a
  // test is exercising, so it belongs in the sandbox on the same terms as
  // `action-keys.ts` above.
  'src/contracts/queue-failure-policy.ts',
  'webview-ui/src/lib/generated/queue-failure-policy.ts',
  'src/contracts/generated/boundary-contracts.ts',
  'src/contracts/generated/schemas/contract-families.json',
  'src/contracts/generated/schemas/sidebar-ipc.schema.json',
  'src/contracts/generated/schemas/audit-events.schema.json',
  'src/contracts/generated/schemas/settings.schema.json',
  'src/contracts/generated/schemas/queue.schema.json',
  'src/contracts/generated/schemas/state.schema.json',
  'src/contracts/generated/schemas/backend-runner.schema.json',
  'webview-ui/src/lib/retry-condition.ts',
  'webview-ui/src/lib/fatal-signature-registry.ts',
  'webview-ui/src/lib/generated/action-keys.ts'
];

function buildSandbox(): string {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'schegent-contracts-check-'));
  for (const relativePath of REQUIRED_FILES) {
    const destination = path.join(sandbox, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relativePath), destination);
  }
  // The generator resolves `typescript` via ordinary Node module resolution
  // from the script's own location, so a symlink is enough — no need to copy
  // node_modules to exercise `--check`.
  fs.symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(sandbox, 'node_modules'), 'dir');
  return sandbox;
}

function runCheck(sandbox: string): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [GENERATOR_SCRIPT, '--check'], {
      cwd: sandbox,
      encoding: 'utf8'
    });
    return { status: 0, output };
  } catch (err) {
    const failure = err as { status: number | null; stdout: string; stderr: string };
    return { status: failure.status ?? 1, output: `${failure.stdout}${failure.stderr}` };
  }
}

describe('action-keys generation mechanism — negative control for T038 (T035)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = buildSandbox();
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('sanity check: an unmutated sandbox passes --check', () => {
    const result = runCheck(sandbox);
    expect(result.output, result.output).not.toContain('action-keys.ts');
    expect(result.status).toBe(0);
  });

  it('fails and names the stale mirror when a source entry is dropped without regenerating', () => {
    const sourcePath = path.join(sandbox, 'src/contracts/action-keys.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const mutated = source.replace(/'backend\.grant-uncontained',?\s*/, '');
    expect(mutated, 'fixture did not match the expected ACTION_KEYS entry').not.toEqual(source);
    fs.writeFileSync(sourcePath, mutated, 'utf8');

    const result = runCheck(sandbox);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(STALE_ACTION_KEYS_MESSAGE);
  });
});
