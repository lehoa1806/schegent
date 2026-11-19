/**
 * Feature 193 (T035, negative control for T038) & FR-R7-05 (T025, SC-006) —
 * asserts that `npm run contracts:check` fails, and names both the stale
 * generated file and its source descriptor, when a source contract or
 * generated file is mutated without regenerating.
 *
 * Exercises the real `scripts/generate-contract-schemas.mjs --check` binary
 * against a minimal, file-exact sandbox copy of every input and output it
 * reads — not a reimplementation of its comparison logic.
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
// `--check` mode (see `scripts/generate-contract-schemas.mjs`).
const REQUIRED_FILES: readonly string[] = [
  GENERATOR_SCRIPT,
  'package.json',
  // FR-R7-05 declarative descriptor modules & emitters
  'scripts/contracts/canonical-enums.mjs',
  'scripts/contracts/descriptor-dsl.mjs',
  'scripts/contracts/emit-backend-descriptors.mjs',
  'scripts/contracts/emit-json-schema.mjs',
  'scripts/contracts/emit-types.mjs',
  'scripts/contracts/emit-validators.mjs',
  'scripts/contracts/emit-webview-mirror.mjs',
  'scripts/contracts/snapshot-descriptors.mjs',
  'scripts/contracts/ipc-descriptors/analytics-reporting.mjs',
  'scripts/contracts/ipc-descriptors/catalog.mjs',
  'scripts/contracts/ipc-descriptors/execution-workflow.mjs',
  'scripts/contracts/ipc-descriptors/history-evidence.mjs',
  'scripts/contracts/ipc-descriptors/host-messages.mjs',
  'scripts/contracts/ipc-descriptors/index.mjs',
  'scripts/contracts/ipc-descriptors/navigation-settings.mjs',
  'scripts/contracts/ipc-descriptors/phase-control.mjs',
  'scripts/contracts/ipc-descriptors/phase-log.mjs',
  'scripts/contracts/ipc-descriptors/queue-core.mjs',
  'scripts/contracts/ipc-descriptors/queue-management.mjs',
  // Canonical enum sources read by canonical-enums.mjs and emit-backend-descriptors.mjs
  'src/contracts/backend-kinds.ts',
  'src/contracts/backend-descriptors.ts',
  'src/contracts/backend-runner.ts',
  'src/config/settings-schema.ts',
  'src/contracts/catalog-store.ts',
  'src/contracts/pipeline-definitions.ts',
  'src/contracts/command-outcome.ts',
  'src/contracts/sidebar-ipc/workflow-run.ts',
  // Existing AST extraction inputs
  'src/contracts/sidebar-ipc.ts',
  'src/contracts/audit-events.ts',
  'src/state/workflow-run.ts',
  'src/contracts/state-schema.ts',
  'src/contracts/decision-results.ts',
  'src/contracts/workflow-controls.ts',
  'src/contracts/recovery-envelope.ts',
  'src/contracts/backend-availability.ts',
  'src/contracts/queue-snapshot.ts',
  'src/queue/feature-request.ts',
  'src/runner/invocation-result.ts',
  'src/ui/sidebar/snapshot.ts',
  'src/lib/retry-condition.ts',
  'src/lib/fatal-signature-registry.ts',
  'src/contracts/action-keys.ts',
  'src/contracts/queue-failure-policy.ts',
  // Generated outputs
  'webview-ui/src/lib/generated/backend-descriptors.ts',
  'webview-ui/src/lib/generated/queue-failure-policy.ts',
  'webview-ui/src/lib/generated/action-keys.ts',
  'webview-ui/src/lib/generated/snapshot-mirror.ts',
  'src/contracts/generated/boundary-contracts.ts',
  'src/contracts/generated/sidebar-ipc-types.ts',
  'src/contracts/generated/snapshot-types.ts',
  'src/contracts/generated/validators/analytics-reporting.ts',
  'src/contracts/generated/validators/catalog.ts',
  'src/contracts/generated/validators/execution-workflow.ts',
  'src/contracts/generated/validators/history-evidence.ts',
  'src/contracts/generated/validators/navigation-settings.ts',
  'src/contracts/generated/validators/phase-control.ts',
  'src/contracts/generated/validators/phase-log.ts',
  'src/contracts/generated/validators/queue-core.ts',
  'src/contracts/generated/validators/queue-management.ts',
  'src/contracts/generated/schemas/contract-families.json',
  'src/contracts/generated/schemas/sidebar-ipc.schema.json',
  'src/contracts/generated/schemas/audit-events.schema.json',
  'src/contracts/generated/schemas/settings.schema.json',
  'src/contracts/generated/schemas/queue.schema.json',
  'src/contracts/generated/schemas/state.schema.json',
  'src/contracts/generated/schemas/backend-runner.schema.json',
  'webview-ui/src/lib/retry-condition.ts',
  'webview-ui/src/lib/fatal-signature-registry.ts'
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

describe('contract generation freshness — negative controls (T035 & FR-R7-05 / SC-006)', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = buildSandbox();
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('sanity check: an unmutated sandbox passes --check', () => {
    const result = runCheck(sandbox);
    expect(result.output, result.output).not.toContain('stale generated file:');
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

  it('fails and names both the stale mirror and its descriptor when snapshot-mirror.ts is hand-edited', () => {
    const mirrorPath = path.join(sandbox, 'webview-ui/src/lib/generated/snapshot-mirror.ts');
    const original = fs.readFileSync(mirrorPath, 'utf8');
    fs.writeFileSync(mirrorPath, `${original}\n// hand-edit drift\n`, 'utf8');

    const result = runCheck(sandbox);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('stale generated file: webview-ui/src/lib/generated/snapshot-mirror.ts');
    expect(result.output).toContain('scripts/contracts/snapshot-descriptors.mjs');
  });

  it('fails and names both the stale validator and its descriptor when an IPC descriptor changes without regenerating', () => {
    const descriptorPath = path.join(sandbox, 'scripts/contracts/ipc-descriptors/queue-core.mjs');
    const original = fs.readFileSync(descriptorPath, 'utf8');
    const mutated = original.replace('const DESCRIPTION_MAX = 4096;', 'const DESCRIPTION_MAX = 2048;');
    expect(mutated, 'fixture did not match DESCRIPTION_MAX in queue-core.mjs').not.toEqual(original);
    fs.writeFileSync(descriptorPath, mutated, 'utf8');

    const result = runCheck(sandbox);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('stale generated file: src/contracts/generated/validators/queue-core.ts');
    expect(result.output).toContain('scripts/contracts/ipc-descriptors/queue-core.mjs');
  });
});
