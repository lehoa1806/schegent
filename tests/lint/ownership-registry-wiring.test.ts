// Feature FR-R3-003 — the production wiring stays the authoritative one.
//
// The store constructs a `Memento`-backed ownership adapter in its constructor,
// because it is built in activation stage 1, before a workspace folder is known.
// That fallback is correct for exactly one host and arbitrates *nothing* between
// two — it is the surface the feature exists to stop depending on. Activation
// stage 2 replaces it with the disk adapter rooted under the workspace.
//
// The failure this guards is silent in a way no other check catches. Delete the
// `useOwnershipStorage()` call, or hand it the memento adapter, and every test
// still passes, `npm run typecheck` still passes, and a single-window operator
// sees nothing wrong — because a single window contending with nobody wins every
// acquisition either way. The defect only appears with two windows open on one
// workspace, which is the case that cannot be covered from inside a vitest
// worker. So the wiring is pinned as a shape rule on the source.
//
// Four rules, each naming the specific regression it forbids:
//
//   1. `extension.ts` calls `useOwnershipStorage` exactly once, and passes
//      `createDiskOwnershipFs()`. Once, because a second call would repoint the
//      registry after managers have taken fences from the first, silently
//      invalidating every live claim.
//   2. The memento adapter is constructed only where it is the documented
//      pre-stage-2 default or a test-double fallback. Anywhere else it is an
//      authoritative-looking registry that is per-host.
//   3. Neither lease manager decides an acquisition from its mirror. The mirror
//      readers stay (they are synchronous and projection paths need them), but
//      `tryAcquire` must reach the registry and must not read `getLock()` or
//      `getExecutionLeases()` to make its decision — that read-decide-write is
//      the defect REL-01 reported.
//   4. Both point-of-effect checks exist and are `async`. A synchronous
//      `hasPrimacy()`/`hasLease()` could not consult the record at all, so it
//      would necessarily be a mirror read wearing the name of a fenced one.
//
// Scope is `src/`. Tests construct the memento adapter freely and are meant to.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

const EXTENSION = 'src/extension.ts';
const LOCK = 'src/state/lock.ts';
const LEASE = 'src/state/execution-lease.ts';

/**
 * Where a `Memento`-backed ownership adapter may be constructed, and why.
 *
 * `ownership-fs.ts` defines it. `workspace-state.ts` uses it as the documented
 * stage-1 default. `ownership-registry.ts` uses it for `fallbackOwnershipRegistry`,
 * which serves hand-rolled doubles of the narrow `ExecutionLeaseStore` port.
 */
const MEMENTO_ADAPTER_ALLOWLIST = [
  'src/state/ownership-fs.ts',
  'src/state/workspace-state.ts',
  'src/state/ownership-registry.ts'
] as const;

function read(file: string): string {
  return readFileSync(resolve(REPO_ROOT, file), 'utf8');
}

/** Blank out comments, preserving offsets so line numbers still line up. */
function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let cursor = 0;
  while (cursor < text.length) {
    const pair = text.slice(cursor, cursor + 2);
    if (pair === '//') {
      const newline = text.indexOf('\n', cursor);
      const stop = newline === -1 ? text.length : newline;
      blank(cursor, stop);
      cursor = stop;
    } else if (pair === '/*') {
      const close = text.indexOf('*/', cursor + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(cursor, stop);
      cursor = stop;
    } else {
      cursor += 1;
    }
  }
  return out.join('');
}

/**
 * The body of a method, from its signature to the next member at the same
 * indent. Crude on purpose: it only has to be tight enough that a mirror read
 * inside `tryAcquire` cannot hide in a sibling method, and a slice that ran long
 * would over-report rather than under-report.
 */
function methodBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} must be present`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + signature.length);
  const next = rest.search(/\n {2}(?:public|private|protected|\/\*\*)/);
  return next === -1 ? rest : rest.slice(0, next);
}

const EXTENSION_SOURCE = stripComments(read(EXTENSION));

/**
 * The expression that produces the ownership directory.
 *
 * `useOwnershipStorage(createDiskOwnershipFs(x), x)` names the directory
 * through a binding, so the composition to check lives at that binding's
 * initializer rather than in the argument list. An inline composition is still
 * accepted and returns unchanged, so this reads the call site as written
 * instead of mandating one of the two shapes.
 */
function ownershipDirectoryExpression(args: string): string {
  // FR-R3-069 — the adapter takes { workspaceRoot, <dir> }; the directory to
  // follow is the second shorthand property. The bare-identifier form is kept
  // so the helper still reads the pre-152 shape if it ever returns.
  const identifier =
    /^\s*createDiskOwnershipFs\s*\(\s*\{\s*workspaceRoot,\s*(\w+)\s*\}\s*\)/.exec(args)?.[1] ??
    /^\s*createDiskOwnershipFs\s*\(\s*(\w+)\s*\)/.exec(args)?.[1];
  if (identifier === undefined) return args;
  const binding = new RegExp(`\\bconst\\s+${identifier}\\s*=([^;]*);`).exec(EXTENSION_SOURCE);
  expect(binding, `the ${identifier} binding must be readable in ${EXTENSION}`).not.toBeNull();
  return binding![1]!;
}
const LOCK_SOURCE = stripComments(read(LOCK));
const LEASE_SOURCE = stripComments(read(LEASE));

describe('FR-R3-003 — ownership arbitration is wired to the authoritative storage', () => {
  it('points the store at the disk adapter exactly once, during activation', () => {
    const calls = [...EXTENSION_SOURCE.matchAll(/useOwnershipStorage\s*\(/g)];
    expect(
      calls.length,
      `${EXTENSION} must call useOwnershipStorage exactly once; a second call ` +
        'would repoint the registry after managers hold fences from the first'
    ).toBe(1);
    // The adapter and the call are asserted together: the call is only load-bearing
    // if it hands over the disk one.
    expect(
      /useOwnershipStorage\s*\(\s*createDiskOwnershipFs\s*\(/.test(EXTENSION_SOURCE),
      `${EXTENSION} must pass createDiskOwnershipFs() to useOwnershipStorage`
    ).toBe(true);
    expect(
      EXTENSION_SOURCE.includes('createMementoOwnershipFs'),
      `${EXTENSION} must not construct the per-host memento adapter`
    ).toBe(false);
  });

  it('roots ownership records under the workspace, not anywhere else', () => {
    const call = /useOwnershipStorage\s*\(([\s\S]*?)\)\s*;/.exec(EXTENSION_SOURCE);
    expect(call, 'the useOwnershipStorage call must be readable').not.toBeNull();
    const args = call![1]!;
    // A record must be reachable by both hosts and must be covered by the
    // `.schegent/` self-`.gitignore`, so the directory is derived from the
    // canonical workspace root and named `.schegent/ownership`.
    //
    // Read through the binding when the call site uses one. FR-R3-005 hoisted
    // the directory into a `const` so the adapter's containment root and the
    // registry's directory are one expression read twice; requiring the
    // composition to sit inline here would push those two back apart, which is
    // the opposite of what either rule wants. The property being checked is
    // unchanged — only where the expression is written.
    expect(ownershipDirectoryExpression(args)).toContain('workspaceRoot');
    expect(ownershipDirectoryExpression(args)).toContain("'.schegent'");
    expect(ownershipDirectoryExpression(args)).toContain("'ownership'");
  });

  it('constructs the memento adapter only where it is the documented default', () => {
    const offenders = MEMENTO_ADAPTER_ALLOWLIST.filter(
      (file) => !stripComments(read(file)).includes('createMementoOwnershipFs')
    );
    expect(
      offenders,
      'every allowlisted file must still use the adapter, or the allowlist is stale'
    ).toEqual([]);
  });

  it('decides primacy acquisition from the registry, never from the mirror', () => {
    const body = methodBody(LOCK_SOURCE, 'public async tryAcquire()');
    expect(body, 'lock tryAcquire must reach the fenced registry').toContain(
      'ownership.acquire('
    );
    expect(
      body.includes('getLock()'),
      'lock tryAcquire must not read the KEYS.lock mirror to decide; that is the ' +
        'read-decide-write REL-01 reported'
    ).toBe(false);
  });

  it('decides execution-lease acquisition from the registry, never from the mirror', () => {
    const body = methodBody(LEASE_SOURCE, 'public async tryAcquire(queueId: string)');
    expect(body, 'lease tryAcquire must reach the fenced registry').toContain('.acquire(');
    expect(
      body.includes('getExecutionLeases()'),
      'lease tryAcquire must not read the KEYS.executionLeases mirror to decide'
    ).toBe(false);
  });

  it('keeps both point-of-effect checks asynchronous', () => {
    expect(LOCK_SOURCE).toContain('public async hasPrimacy(): Promise<boolean>');
    expect(LEASE_SOURCE).toContain('public async hasLease(queueId: string): Promise<boolean>');
  });

  it('gates the synchronous mirror readers on holding a fence', () => {
    // The mirror readers are synchronous because projection paths cannot
    // await — but a superseded window must read `false` from its own mirror
    // rather than the stale `true` the mirror alone would give.
    //
    // FR-R3-024 — `WorkspaceLockManager.isHeld` has no host callers now; every
    // decision moved to `hasPrimacy()`. The fence gate is still asserted
    // because the mirror is still read, by `isForeignLockHeld()`, and because
    // `isHeld` is the shape the ordering invariant is stated in.
    expect(methodBody(LOCK_SOURCE, 'public isHeld()')).toContain('this.fence');
    expect(methodBody(LEASE_SOURCE, 'public isHeld(queueId: string)')).toContain('this.fences');
  });
});
