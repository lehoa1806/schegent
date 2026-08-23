import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * `audit-log-writer` imports `fs/promises` directly, and an ESM module namespace
 * is not configurable, so `vi.spyOn` cannot reach `appendFile`. The seam is a
 * hoisted module mock that delegates to the real module unless a test installs a
 * `hook`; the writer's own source is untouched by the test setup.
 */
const seam = vi.hoisted(() => ({
  hook: null as
    | ((n: number, run: () => Promise<void>) => Promise<void>)
    | null,
  calls: 0
}));

vi.mock('fs/promises', async () => {
  const real = await vi.importActual<typeof import('fs/promises')>('fs/promises');
  return {
    ...real,
    // FR-R3-053 moved the audit append off `appendFile` and onto a safe
    // `open` + `handle.write`, so the seam moved with it. Same shape: delegate
    // to the real module unless a test installs a `hook`, and wrap only the
    // write of the handle the writer actually got.
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      // Only the audit log. `ensureSchegentGitignore` also opens a handle now,
      // and wrapping that one made call #1 the gitignore write -- so the wedge
      // landed on the wrong operation and the ordering assertions stopped
      // measuring ordering. Found by re-running the revert check after moving
      // the seam.
      if (!seam.hook || !String(args[0]).endsWith('audit.log')) return handle;
      const write = handle.write.bind(handle);
      return Object.assign(handle, {
        write: (...w: unknown[]) =>
          seam.hook?.(++seam.calls, async () => {
            await (write as (...a: never[]) => Promise<unknown>)(...(w as never[]));
          })
      });
    }
  };
});

describe('a timed-out append cannot interleave (M-02)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-audit-order-'));
  });

  afterEach(async () => {
    seam.hook = null;
    seam.calls = 0;
    vi.useRealTimers();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  const entry = (id: string) =>
    ({ eventType: 'phase-start', runId: id, payload: { phase: 'implement' } }) as never;

  it('does not start a later append before a wedged one has settled', async () => {
    const events: string[] = [];
    let releaseFirst = (): void => {};

    seam.hook = async (n, run) => {
      events.push(`start:${n}`);
      if (n === 1) {
        // Wedge the first write until released. The interleaving is forced
        // rather than raced for, so the test does not depend on timing luck.
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      await run();
      events.push(`done:${n}`);
    };

    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());

    // First append wedges. Its caller must still see a bounded failure -- that is
    // asserted separately below; here we only need it in flight.
    const first = writer.append(entry('run-1')).catch(() => undefined);
    await vi.waitFor(() => expect(events).toContain('start:1'));

    // Second append is requested while the first is still wedged.
    const second = writer.append(entry('run-2')).catch(() => undefined);

    // Wait for the FIRST APPEND'S CALLER to give up. The window has to outlast
    // the caller's bound: before it expires nothing has been released yet, so a
    // shorter window reports "no interleaving" against source that interleaves --
    // a passing test that proves nothing. Settling `first` is that bound, by
    // definition, so it cannot drift out of step with the constant.
    await first;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const startedSecondEarly = events.includes('start:2') && !events.includes('done:1');

    releaseFirst();
    await Promise.allSettled([first, second]);

    // The barrier: no append may begin writing until the wedged one has settled.
    expect(startedSecondEarly).toBe(false);

    // The second write is still owed to the chain, and runs once the barrier
    // releases -- which is AFTER its own caller gave up, so it lands outside
    // `allSettled`. Waiting for it is what makes the ordering claim below real
    // rather than a comparison of two absent entries.
    await vi.waitFor(() => expect(events).toContain('done:2'), { timeout: 10_000 });
    expect(events.indexOf('done:1')).toBeLessThan(events.indexOf('start:2'));
  }, 30_000);

  it('reports a wedge to later callers rather than misplacing their writes', async () => {
    // The deliberate trade. Previously append N+1 was written DURING the wedge
    // and reported as succeeding, while its position in the log was whatever the
    // race produced. Now the wedge is reported to its caller and the write keeps
    // its place in the sequence. Audit evidence is fail-closed, so a caller told
    // the truth beats a line quietly filed in the wrong generation.
    const events: string[] = [];
    let releaseFirst = (): void => {};
    seam.hook = async (n, run) => {
      events.push(`start:${n}`);
      if (n === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      await run();
      events.push(`done:${n}`);
    };

    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const first = writer.append(entry('run-1')).then(() => 'ok', () => 'failed');
    await vi.waitFor(() => expect(events).toContain('start:1'));
    const second = writer.append(entry('run-2')).then(() => 'ok', () => 'failed');

    expect(await first).toBe('failed');
    expect(await second).toBe('failed');

    releaseFirst();
    await vi.waitFor(() => expect(events).toContain('done:2'), { timeout: 10_000 });

    // Both lines are on disk, in the order they were requested.
    const body = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    expect(body.indexOf('run-1')).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('run-1')).toBeLessThan(body.indexOf('run-2'));
  }, 30_000);

  it('still reports a bounded failure to the caller of a wedged append', async () => {
    let release = (): void => {};
    seam.hook = async (n, run) => {
      if (n === 1) await new Promise<void>((resolve) => { release = resolve; });
      await run();
    };

    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const started = Date.now();
    const outcome = await writer.append(entry('run-1')).then(
      () => 'resolved' as const,
      () => 'rejected' as const
    );
    const elapsed = Date.now() - started;
    release();

    // The caller-visible contract is unchanged: a wedged append is reported, and
    // reported on the existing bound rather than waiting for the disk.
    expect(outcome).toBe('rejected');
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('leaves a healthy append unchanged', async () => {
    const writer = new AuditLogWriter({ workspaceRoot: tmpRoot }, new SanitizedLogger());
    const one = await writer.append(entry('run-1'));
    const two = await writer.append(entry('run-2'));
    expect(one.id).toBeTruthy();
    expect(two.id).toBeTruthy();
    const body = await fs.readFile(path.join(tmpRoot, '.schegent', 'audit.log'), 'utf8');
    expect(body.indexOf('run-1')).toBeLessThan(body.indexOf('run-2'));
  }, 20_000);
});
