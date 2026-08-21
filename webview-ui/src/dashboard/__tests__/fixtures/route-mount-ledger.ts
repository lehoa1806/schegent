// Feature 105 (T587) — the observable surface for route-loading tests.
//
// The tests do not observe the loader — they observe what the loader causes:
// which fixture component mounted, how many times, and when its module finished
// importing. This module is the ledger those fixtures write to and the gate the
// mocked module factories await.
//
// Why a mutable module-level singleton rather than props: the components under
// test are reached through `import()` inside `RouteOutlet.svelte`, so a test has
// no way to hand them anything. The ledger is the only channel that exists.
// (T588h moved the loader itself out to `route-loader.ts`, which is directly
// callable. The components it loads are not, which is what this is for.)

export type LedgerRoute = 'operations' | 'system' | 'metrics' | 'history' | 'builder';

type Gate = {
  readonly promise: Promise<void>;
  readonly open: () => void;
};

function makeGate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The message the real bug produced, verbatim from the pre-fix observation in
 * `docs/operations/built-artifact-route-diagnosis.md`, so the diagnostic
 * assertions check a realistic string rather than the word "boom".
 */
const MOUNT_FAILURE_MESSAGE = "Cannot read properties of undefined (reading 'localeCompare')";

class RouteMountLedger {
  private mounts = new Map<LedgerRoute, number>();
  private imports = new Map<LedgerRoute, number>();
  private throwAlways = new Map<LedgerRoute, string>();
  private throwOnce = new Map<LedgerRoute, string>();
  private gates = new Map<LedgerRoute, Gate>();
  private propViolations: LedgerRoute[] = [];

  reset(): void {
    this.mounts.clear();
    this.imports.clear();
    this.throwAlways.clear();
    this.throwOnce.clear();
    this.propViolations = [];
    // Gates are deliberately NOT cleared: a mocked module factory runs once per
    // file (vitest caches the mocked module), so a gate can only be closed
    // before its route's first import. Clearing it between tests would suggest
    // a second test could use the same gate, which is not true — each gated
    // route serves exactly one test, and that is why there are several.
  }

  /**
   * Called from a fixture component's init. Throws when the test asked this
   * route to fail, which is a throw during mount — the failure mode the whole
   * feature exists to contain.
   */
  mount(route: LedgerRoute): void {
    this.mounts.set(route, this.mountCount(route) + 1);
    const once = this.throwOnce.get(route);
    if (once !== undefined) {
      this.throwOnce.delete(route);
      throw new TypeError(once);
    }
    const always = this.throwAlways.get(route);
    if (always !== undefined) throw new TypeError(always);
  }

  recordImport(route: LedgerRoute): void {
    this.imports.set(route, this.importCount(route) + 1);
  }

  /**
   * A render that arrived without a prop the outlet is supposed to pass this
   * route. Separate from `mounts` because the two failures read differently: an
   * extra mount says the outlet re-created the subtree, and a violation says it
   * re-created it *as a different route*.
   */
  recordPropViolation(route: LedgerRoute): void {
    this.propViolations.push(route);
  }

  violations(): readonly LedgerRoute[] {
    return this.propViolations;
  }

  mountCount(route: LedgerRoute): number {
    return this.mounts.get(route) ?? 0;
  }

  importCount(route: LedgerRoute): number {
    return this.imports.get(route) ?? 0;
  }

  failEveryMount(route: LedgerRoute, message: string = MOUNT_FAILURE_MESSAGE): void {
    this.throwAlways.set(route, message);
  }

  failNextMount(route: LedgerRoute, message: string = MOUNT_FAILURE_MESSAGE): void {
    this.throwOnce.set(route, message);
  }

  /** Hold this route's module import until `openGate` is called. */
  closeGate(route: LedgerRoute): void {
    if (!this.gates.has(route)) this.gates.set(route, makeGate());
  }

  openGate(route: LedgerRoute): void {
    this.gates.get(route)?.open();
  }

  /** Awaited inside the mocked module factory. Open unless a test closed it. */
  async gate(route: LedgerRoute): Promise<void> {
    await this.gates.get(route)?.promise;
  }
}

export const ledger = new RouteMountLedger();
