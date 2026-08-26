// FR-R3-104 (FR-054, FR-055) — the committed qualified-version table matches the log entry that
// produced it, and the drift warning fires on exactly the right condition.
//
// WHY THE PARITY HALF EXISTS. `QUALIFIED_BACKEND_VERSIONS` ships inside the extension and is the
// only thing an installed host can compare against. A hand-maintained constant claiming a canary
// result is the exact shape this round keeps removing: text asserting a property nothing checks.
// So the constant is held to the newest entry in `docs/release/backend-qualification-log.md`,
// which is the record of an actual live turn.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  QUALIFIED_AT,
  QUALIFIED_BACKEND_VERSIONS
} from '../../../src/contracts/qualified-backend-versions';
import { cliVersionFields } from '../../../src/runner/cli-version-probe';
import { SUPPORTED_BACKENDS } from '../../../src/contracts/backend-kinds';

const LOG = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'release',
  'backend-qualification-log.md'
);

/**
 * The versions in the LAST fenced canary report in the log.
 *
 * Read from the report block the canary itself printed, not from prose around it: the block is
 * the transcript, and a sentence describing it is a claim about the transcript.
 */
function newestLoggedVersions(): Record<string, string> {
  const text = readFileSync(LOG, 'utf8');
  const blocks = [...text.matchAll(/```\n\[backend-canary\] results\n([\s\S]*?)```/g)];
  expect(blocks.length, 'the log must contain at least one canary report block').toBeGreaterThan(0);
  const newest = blocks[blocks.length - 1]![1] as string;
  const versions: Record<string, string> = {};
  for (const line of newest.split('\n')) {
    const match = /^\s*(\w+):\s*\w+\s*—\s*version\s*([0-9.]+)/.exec(line);
    if (match) versions[match[1] as string] = match[2] as string;
  }
  return versions;
}

describe('the shipped qualified-version table matches the newest live result', () => {
  it('reads a non-empty report from the log, so a broken parse cannot pass', () => {
    const logged = newestLoggedVersions();
    expect(Object.keys(logged).length).toBeGreaterThanOrEqual(3);
  });

  it('states the same version the newest canary run observed, per backend', () => {
    const logged = newestLoggedVersions();
    for (const [backend, version] of Object.entries(logged)) {
      expect(
        QUALIFIED_BACKEND_VERSIONS[backend],
        `src/contracts/qualified-backend-versions.ts says ${QUALIFIED_BACKEND_VERSIONS[backend]} ` +
          `for ${backend}; the newest log entry says ${version}. The constant ships inside the ` +
          'extension and is what an installed host compares against, so a stale value tells ' +
          'every operator the wrong thing.'
      ).toBe(version);
    }
  });

  it('covers every supported backend and nothing else', () => {
    expect(Object.keys(QUALIFIED_BACKEND_VERSIONS).sort()).toEqual([...SUPPORTED_BACKENDS].sort());
  });

  it('carries the date of the run it describes', () => {
    expect(QUALIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(readFileSync(LOG, 'utf8')).toContain(QUALIFIED_AT);
  });
});

describe('FR-055 — the drift warning fires on drift and on nothing else', () => {
  const logger = (): { warn: ReturnType<typeof vi.fn> } => ({ warn: vi.fn() });

  it('records the version with no warning when it matches', () => {
    const log = logger();
    expect(cliVersionFields(QUALIFIED_BACKEND_VERSIONS.claude!, 'claude', log)).toEqual({
      cliVersion: QUALIFIED_BACKEND_VERSIONS.claude
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns and marks the record when the installed CLI has moved', () => {
    const log = logger();
    const fields = cliVersionFields('9.9.9', 'claude', log);
    expect(fields.cliVersionDrift).toBe(true);
    expect(fields.qualifiedCliVersion).toBe(QUALIFIED_BACKEND_VERSIONS.claude);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = log.warn.mock.calls[0]![0] as string;
    // Names both versions and the remedy: a warning an operator cannot act on is noise.
    expect(message).toContain('9.9.9');
    expect(message).toContain(QUALIFIED_BACKEND_VERSIONS.claude!);
    expect(message).toContain('npm run canary');
  });

  it('says nothing when the version could not be observed', () => {
    const log = logger();
    expect(cliVersionFields(null, 'claude', log)).toEqual({});
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('does not warn about a backend this build never qualified', () => {
    // A build that never qualified a backend says nothing about it, and warning anyway would
    // teach an operator to ignore this warning.
    const log = logger();
    expect(cliVersionFields('1.0.0', 'some-future-backend', log)).toEqual({
      cliVersion: '1.0.0'
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});
