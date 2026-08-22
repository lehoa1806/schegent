// FR-R3-040 — an arbitration failure keeps the filesystem's own error code.
//
// The whole fence rests on one platform property: `open(2)` with
// `O_CREAT|O_EXCL` either creates the file or fails `EEXIST`, and cannot do
// both. That is a property of the FILESYSTEM, not of Node. The design documents
// say where it is not guaranteed — NFSv2, some SMB, and the 9p, virtiofs and
// network-home mounts ordinary remote development puts a workspace on.
//
// On such a mount the operator's symptom is "no window is primary". Flattening
// every failure to `io-error` discarded the one datum that separates a full disk
// from a permissions problem from a mount that does not implement the primitive:
// `ENOTSUP`, `EPERM`, `EROFS` and `ENOSYS` each point somewhere different.
//
// This is deliberately NOT a detector. Whether the primitive degrades on any
// specific mount was never measured, and a warning built on an unmeasured risk
// would cry wolf on working setups or miss the ones that matter. Keeping the
// cause helps exactly when the problem is in front of someone, and claims
// nothing when it is not.
import { describe, expect, it } from 'vitest';
import { OwnershipRegistry, type OwnershipFs } from '../../../src/state/ownership-registry';

/** An `OwnershipFs` whose every operation fails with a chosen errno. */
function failingFs(code: string | undefined): OwnershipFs {
  const fail = (): never => {
    const err = new Error(`synthetic ${code ?? 'codeless'} failure`) as NodeJS.ErrnoException;
    if (code !== undefined) err.code = code;
    throw err;
  };
  return new Proxy({} as OwnershipFs, { get: () => fail });
}

describe('FR-R3-040 — arbitration failure keeps its cause', () => {
  // The errnos a mount that cannot honour exclusive create plausibly returns,
  // alongside the ordinary ones, because the point is telling them apart.
  for (const code of ['ENOTSUP', 'ENOSYS', 'EPERM', 'EROFS', 'ENOSPC']) {
    it(`reports \`${code}\` rather than flattening it to io-error`, async () => {
      const registry = new OwnershipRegistry(failingFs(code), '/nonexistent/.schegent/ownership');
      const outcome = await registry.acquire('primacy', 'owner-a', 1_000, 30_000);

      expect(outcome.outcome).toBe('unavailable');
      expect(
        outcome.outcome === 'unavailable' ? outcome.cause : undefined,
        `an arbitration failure carrying ${code} reported no cause. The fence's stated limit is ` +
          `about mounts that do not implement exclusive create, and the errno is the only thing ` +
          `that distinguishes such a mount from a full disk or a permissions problem.`
      ).toBe(code);
    });
  }

  it('still reports io-error when the failure carried no code', async () => {
    // A cause is added when there is one, never invented. An absent code is a
    // real state and must not become a misleading one.
    const registry = new OwnershipRegistry(failingFs(undefined), '/nonexistent/ownership');
    const outcome = await registry.acquire('primacy', 'owner-a', 1_000, 30_000);

    expect(outcome.outcome).toBe('unavailable');
    expect(outcome.outcome === 'unavailable' ? outcome.reason : undefined).toBe('io-error');
    expect(
      outcome.outcome === 'unavailable' ? outcome.cause : 'unset',
      'a failure with no errno must report no cause rather than a placeholder'
    ).toBeUndefined();
  });

  it('keeps `reason` stable, so existing consumers are unaffected', async () => {
    // `cause` is additive. Anything branching on `reason === "io-error"` must
    // keep working, or this diagnostic would have cost behaviour to buy detail.
    const registry = new OwnershipRegistry(failingFs('ENOTSUP'), '/nonexistent/ownership');
    const outcome = await registry.acquire('primacy', 'owner-a', 1_000, 30_000);
    expect(outcome.outcome === 'unavailable' ? outcome.reason : undefined).toBe('io-error');
  });
});
