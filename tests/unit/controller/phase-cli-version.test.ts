// FR-R3-104 (FR-054) — the running CLI's version reaches the record, and its PATH does not.
//
// WHY BOTH HALVES ARE ONE TEST. The value is useful because it identifies the binary's protocol
// surface, and it is safe because it is not the binary's location. `cliPath` is documented as
// never routed into an audit payload (`InvocationRequest.command` carries it and says so), and
// the easiest way to record a version is to record the string the CLI printed — which on some
// tools includes the install path. Asserting the presence without asserting the absence would let
// a future `--version` banner leak a home directory into the evidence record.
import { describe, expect, it, vi } from 'vitest';
import {
  CLI_VERSION_MAX_LEN,
  CLI_VERSION_TTL_MS,
  createCliVersionProbe,
  normalizeCliVersion,
  observedVersionOf
} from '../../../src/runner/cli-version-probe';

describe('normalizing a --version answer', () => {
  it('reduces each backend\'s real answer to its version token', () => {
    // The three observed on 2026-08-26, verbatim from the canary's own log entry.
    expect(normalizeCliVersion('2.1.246 (Claude Code)')).toBe('2.1.246');
    expect(normalizeCliVersion('codex-cli 0.149.0')).toBe('0.149.0');
    expect(normalizeCliVersion('1.1.20')).toBe('1.1.20');
  });

  it('keeps an unparsed first line rather than discarding it, bounded', () => {
    // An unparsed answer is still more than no answer; an unbounded one is a payload inflator.
    expect(normalizeCliVersion('some-cli (nightly)')).toBe('some-cli (nightly)');
    expect(normalizeCliVersion('x'.repeat(200))?.length).toBe(CLI_VERSION_MAX_LEN);
  });

  it('answers null for nothing at all', () => {
    expect(normalizeCliVersion('')).toBeNull();
    expect(normalizeCliVersion('\n\n')).toBeNull();
  });

  it('reads only the FIRST line, so a chatty CLI cannot smuggle a path in', () => {
    const chatty = '2.1.246 (Claude Code)\ninstalled at /Users/someone/.local/bin/claude';
    const version = normalizeCliVersion(chatty);
    expect(version).toBe('2.1.246');
    expect(version).not.toContain('/Users/');
  });
});

describe('the probe spends at most one process per path per window', () => {
  it('caches an observed version for the TTL and probes again after it', async () => {
    let clock = 0;
    const probe = vi.fn().mockResolvedValue('2.1.246 (Claude Code)');
    const versions = createCliVersionProbe({ probe, monotonicNow: () => clock });

    expect(await versions.observe('claude')).toBe('2.1.246');
    expect(await versions.observe('claude')).toBe('2.1.246');
    expect(probe, 'a second read inside the window must not spawn').toHaveBeenCalledTimes(1);

    clock += CLI_VERSION_TTL_MS - 1;
    await versions.observe('claude');
    expect(probe).toHaveBeenCalledTimes(1);

    // Past the window: a mid-session upgrade is what this exists to notice.
    clock += 2;
    await versions.observe('claude');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent first reads into one probe', async () => {
    // Twenty phases starting together must not spawn twenty processes for one answer.
    let release: (value: string) => void = () => undefined;
    const probe = vi.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );
    const versions = createCliVersionProbe({ probe, monotonicNow: () => 0 });
    const reads = [versions.observe('codex'), versions.observe('codex'), versions.observe('codex')];
    // The probe body runs on a microtask (a synchronously-throwing probe must not escape), so
    // its resolver is assigned one turn after `observe` is called.
    await Promise.resolve();
    release('codex-cli 0.149.0');
    expect(await Promise.all(reads)).toEqual(['0.149.0', '0.149.0', '0.149.0']);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('caches a FAILED probe too, so a missing CLI is not probed every phase', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const versions = createCliVersionProbe({ probe, monotonicNow: () => 0 });
    expect(await versions.observe('nope')).toBeNull();
    expect(await versions.observe('nope')).toBeNull();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('never throws out of a phase, whatever the probe does', async () => {
    const versions = createCliVersionProbe({
      probe: () => {
        throw new Error('exploded synchronously');
      },
      monotonicNow: () => 0
    });
    await expect(versions.observe('boom')).resolves.toBeNull();
    await expect(observedVersionOf(null, 'anything')).resolves.toBeNull();
    await expect(
      observedVersionOf(
        {
          observedCliVersion: () => {
            throw new Error('registry exploded');
          }
        },
        'anything'
      )
    ).resolves.toBeNull();
  });
});

describe('what the payload records', () => {
  it('carries the version and never the path', async () => {
    // The end-to-end claim, checked on the payload construction path rather than on intent:
    // `phase-runner.ts` reads `this.observedCliVersion` into both records, and the value it holds
    // came through `normalizeCliVersion`, which cannot return a path unless the CLI printed one
    // on its first line ahead of its version — and the case above pins that too.
    const probe = vi.fn().mockResolvedValue('2.1.246 (Claude Code)');
    const versions = createCliVersionProbe({ probe, monotonicNow: () => 0 });
    const observed = await versions.observe('/Users/someone/.local/bin/claude');
    expect(observed).toBe('2.1.246');
    expect(observed).not.toContain('/');
  });
});
