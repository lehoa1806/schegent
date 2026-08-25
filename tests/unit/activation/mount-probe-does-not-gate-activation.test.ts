import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { probeMountCapability } from '../../../src/state/mount-capability-probe';
import {
  reportMountCapability,
  resetMountCapabilityWarnings
} from '../../../src/activation/mount-capability-wiring';
import type { ExclusiveCreateObservation } from '../../../src/state/mount-capability';

/**
 * FR-R3-083 (T1131) — activation does not depend on the probe.
 *
 * "Does not prevent activation" is a claim about three separate situations, and
 * the honest way to establish it is in two halves.
 *
 * The first half is behavioural and lives below: each of the three outcomes
 * produces a verdict and a report without throwing.
 *
 * The second half cannot be observed by calling the probe at all, because the risk
 * is not in the probe -- it is at the CALL SITE. An `await` in front of it would
 * make a bounded pause into a serialized one, and worse, a future refactor that
 * dropped the rejection handler would put an unhandled rejection on the activation
 * path. So the call site is asserted directly, the same device
 * `backend-posture-emission-funnel.test.ts` uses. A test that mocked `activate()`
 * would pass with an `await` in place, because the probe returns quickly on a
 * healthy filesystem -- which is every developer machine and every CI runner, and
 * none of the mounts this feature is about.
 */
const LAUNCHER = resolve(
  __dirname, '..', '..', '..', 'src', 'activation', 'mount-capability-wiring.ts'
);
const EXTENSION = resolve(__dirname, '..', '..', '..', 'src', 'extension.ts');

describe('the mount probe does not gate activation (FR-R3-083)', () => {
  it('is called fire-and-forget, with a rejection handler', () => {
    const launcher = readFileSync(LAUNCHER, 'utf8');
    const call = launcher.slice(launcher.indexOf('void probeMountCapability('));
    expect(call.length).toBeGreaterThan(0);
    // `void`, not `await`: the launcher returns before the probe answers.
    expect(launcher).toContain('void probeMountCapability(');
    expect(launcher).not.toContain('await probeMountCapability(');
    // A rejection handler, so a throw the probe's own guard somehow missed still
    // cannot surface as an unhandled rejection during activation.
    expect(call.slice(0, 400)).toMatch(/\.then\(/);
    expect(call.slice(0, 400)).toMatch(/\(\)\s*=>\s*undefined/);
    // And activation itself neither awaits the launcher nor holds its result.
    const extension = readFileSync(EXTENSION, 'utf8');
    expect(extension).toContain('startMountCapabilityProbe(workspaceRoot, logger, notifier);');
    expect(extension).not.toMatch(/await\s+startMountCapabilityProbe/);
  });

  it.each<[string, () => Promise<ExclusiveCreateObservation>]>([
    ['throwing', () => Promise.reject(Object.assign(new Error('x'), { code: 'EIO' }))],
    ['never settling', () => new Promise<ExclusiveCreateObservation>(() => undefined)],
    ['reporting unsupported', () => Promise.resolve({ outcome: 'created' })]
  ])('completes and reports when the probe is %s', async (_label, exclusiveCreate) => {
    resetMountCapabilityWarnings();
    const notifications: string[] = [];
    const verdict = await probeMountCapability({
      workspaceRoot: '/nonexistent-root-for-this-assertion',
      timeoutMs: 20,
      exclusiveCreate
    });
    expect(() =>
      reportMountCapability(
        verdict,
        '/nonexistent-root-for-this-assertion',
        { info: () => undefined, warn: () => undefined } as any,
        { warn: (m: string) => void notifications.push(m) }
      )
    ).not.toThrow();
  });
});
