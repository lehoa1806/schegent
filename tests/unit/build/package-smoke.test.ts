import { describe, expect, it } from 'vitest';

/**
 * FR-R4-F09 (FR-001, SC-001 source half; contract RP6, test T11) -- the smoke package path writes
 * its own SBOM and inspects what it packaged.
 *
 * WHAT WAS WRONG. `npm run package:smoke` packaged whatever `schegent-sbom.cdx.json` an EARLIER
 * run had left at the repository root, and failed on a tracked-files-only checkout, where there is
 * none: the archive then lacked an entry the allowlist requires. The smoke also never checked that
 * the SBOM it packaged came from the build beside it. `smokePackage` is the function that does
 * both, in a fixed order -- freshness, SBOM, package, inspect the bytes, compare SBOM to archive,
 * remove the temporary directory -- and a refusal at any step stops every later one.
 *
 * Every step is injected, so the order and the stopping are assertions about calls and no
 * `vsce`, build or SBOM runs here. Loaded dynamically for the same TS1479 reason its siblings
 * record.
 */
async function loadSmoke() {
  return import('../../../scripts/package-vsix-smoke.mjs');
}

const TEMP = '/tmp/schegent-vsix-smoke-test';
const VSIX = `${TEMP}/schegent-smoke.vsix`;
const BYTES = Buffer.from('the packaged archive');

type Step =
  | 'fresh'
  | 'sbom'
  | 'tempdir'
  | 'vsce'
  | 'read'
  | 'inspect'
  | 'agreement'
  | 'remove';

/** A full set of fakes that records the order of calls, with one step made to fail. */
function fakes(failAt: Step | null = null) {
  const calls: string[] = [];
  const seen: { vsceOut?: string; inspected?: Buffer; compared?: Buffer; removed?: string } = {};
  const step = (name: Step, action?: () => void) => {
    calls.push(name);
    if (failAt === name) throw new Error(`refused at ${name}`);
    action?.();
  };
  return {
    calls,
    seen,
    deps: {
      assertFresh: () => step('fresh'),
      writeSbom: () => step('sbom'),
      makeTempDir: async () => {
        step('tempdir');
        return TEMP;
      },
      runVsce: async (outPath: string) => {
        step('vsce', () => {
          seen.vsceOut = outPath;
        });
      },
      readFile: (path: string) => {
        step('read');
        expect(path).toBe(VSIX);
        return BYTES;
      },
      inspectVsixBytes: (bytes: Buffer, label: string) => {
        step('inspect', () => {
          seen.inspected = bytes;
          expect(label).toBe(VSIX);
        });
      },
      assertSbomMatchesArchive: (bytes: Buffer, label: string) => {
        step('agreement', () => {
          seen.compared = bytes;
          expect(label).toBe(VSIX);
        });
        return {};
      },
      removeDir: async (path: string) => {
        step('remove', () => {
          seen.removed = path;
        });
      }
    }
  };
}

describe('smokePackage', () => {
  it('runs freshness, the SBOM writer, vsce, the inspection, the agreement check and the cleanup, in that order', async () => {
    const { smokePackage } = await loadSmoke();
    const { calls, deps } = fakes();
    await smokePackage(deps);
    expect(calls).toEqual(['fresh', 'sbom', 'tempdir', 'vsce', 'read', 'inspect', 'agreement', 'remove']);
  });

  it('packages into the temporary directory and inspects the very bytes it read once', async () => {
    const { smokePackage } = await loadSmoke();
    const { seen, deps } = fakes();
    await smokePackage(deps);
    expect(seen.vsceOut).toBe(VSIX);
    expect(seen.inspected).toBe(BYTES);
    expect(seen.compared).toBe(BYTES);
    expect(seen.removed).toBe(TEMP);
  });

  it.each<[Step, Step[]]>([
    ['fresh', ['fresh']],
    ['sbom', ['fresh', 'sbom']],
    ['tempdir', ['fresh', 'sbom', 'tempdir']],
    ['vsce', ['fresh', 'sbom', 'tempdir', 'vsce', 'remove']],
    ['read', ['fresh', 'sbom', 'tempdir', 'vsce', 'read', 'remove']],
    ['inspect', ['fresh', 'sbom', 'tempdir', 'vsce', 'read', 'inspect', 'remove']],
    ['agreement', ['fresh', 'sbom', 'tempdir', 'vsce', 'read', 'inspect', 'agreement', 'remove']]
  ])('a refusal at %s stops every later step', async (failAt, expected) => {
    const { smokePackage } = await loadSmoke();
    const { calls, deps } = fakes(failAt);
    await expect(smokePackage(deps)).rejects.toThrow(`refused at ${failAt}`);
    expect(calls).toEqual(expected);
  });

  it('removes the temporary directory after a refusal at vsce or later, and not before it exists', async () => {
    const { smokePackage } = await loadSmoke();
    for (const failAt of ['fresh', 'sbom'] as const) {
      const { calls, deps } = fakes(failAt);
      await expect(smokePackage(deps)).rejects.toThrow();
      expect(calls).not.toContain('remove');
    }
    for (const failAt of ['vsce', 'read', 'inspect', 'agreement'] as const) {
      const { calls, deps } = fakes(failAt);
      await expect(smokePackage(deps)).rejects.toThrow();
      expect(calls.at(-1)).toBe('remove');
    }
  });

  it('keeps the refusal that stopped it when the cleanup also fails', async () => {
    const { smokePackage } = await loadSmoke();
    const { deps } = fakes('inspect');
    const failing = {
      ...deps,
      removeDir: async () => {
        throw new Error('could not remove');
      }
    };
    await expect(smokePackage(failing)).rejects.toThrow('refused at inspect');
  });
});
