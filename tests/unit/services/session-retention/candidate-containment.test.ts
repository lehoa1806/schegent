// Feature FR-R3-005 (T333) — a symlinked candidate inside a contained root.
//
// The acceptance scenario this file pins:
//   Given the sessions root is legitimately contained but one run directory
//   inside it is a symlink pointing outside
//   When retention prunes
//   Then that candidate is skipped and recorded; siblings are still pruned
//
// Feature 098's root check passes here — `<ws>/.schegent/sessions` really is
// inside `<ws>` — which is exactly why the root check alone was not enough.
// Real symlinks, not a faked `realpath`: the escape being tested is the one
// the kernel performs, and a fake would be testing the mock's arithmetic.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionArtifactRetentionService } from '../../../../src/services/session-retention/session-artifact-retention-service';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('FR-R3-005 (T333) per-candidate containment', () => {
  let workspaceRoot: string;
  let outside: string;
  const now = new Date('2026-08-01T00:00:00.000Z');

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-candidate-ws-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-candidate-out-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function sessionsDir(): string {
    return path.join(workspaceRoot, '.schegent', 'sessions');
  }

  async function age(target: string, days: number): Promise<void> {
    const stamp = new Date(now.getTime() - days * DAY_MS);
    await fs.utimes(target, stamp, stamp);
  }

  /**
   * `utimes` follows the link and stamps its target; `measure()` reads the
   * candidate with `lstat`, which reports the link's own times. Ageing a link
   * with `utimes` therefore leaves it looking brand new and it never becomes a
   * candidate at all — which would make every assertion below vacuously pass.
   */
  async function ageLink(target: string, days: number): Promise<void> {
    const stamp = new Date(now.getTime() - days * DAY_MS);
    await fs.lutimes(target, stamp, stamp);
  }

  /** An ordinary expired run group: `raw-<id>.log` plus `<id>/`. */
  async function writeRunGroup(runId: string, days: number): Promise<void> {
    const dir = path.join(sessionsDir(), runId);
    await fs.mkdir(dir, { recursive: true });
    const raw = path.join(sessionsDir(), `raw-${runId}.log`);
    await fs.writeFile(raw, 'r'.repeat(32));
    await fs.writeFile(path.join(dir, 'stream.jsonl'), 'd'.repeat(32));
    await age(path.join(dir, 'stream.jsonl'), days);
    await age(dir, days);
    await age(raw, days);
  }

  function service(append = vi.fn()) {
    const warn = vi.fn();
    return {
      warn,
      append,
      value: new SessionArtifactRetentionService({
        workspaceRoot,
        now: () => now,
        policy: () => ({ maxAgeMs: 30 * DAY_MS, maxBytes: 1024 * 1024 }),
        logger: { warn },
        audit: { append } as never
      })
    };
  }

  it('skips a run directory that is a symlink out of the workspace and prunes its siblings', async () => {
    await writeRunGroup('honest-run', 40);
    // The escaping candidate: a directory entry inside a legitimately
    // contained sessions root whose name is indistinguishable from a real run.
    const stolen = path.join(outside, 'evidence');
    await fs.mkdir(stolen, { recursive: true });
    await fs.writeFile(path.join(stolen, 'keep-me.txt'), 'not the host to delete');
    const link = path.join(sessionsDir(), 'escaping-run');
    await fs.symlink(stolen, link, 'dir');
    await ageLink(link, 40);

    const { value, warn, append } = service();
    const result = await value.sweep();

    // Skipped: the link is still there and so is everything behind it.
    await expect(fs.lstat(link)).resolves.toBeDefined();
    await expect(fs.readFile(path.join(stolen, 'keep-me.txt'), 'utf8'))
      .resolves.toBe('not the host to delete');

    // Siblings still pruned.
    await expect(fs.access(path.join(sessionsDir(), 'honest-run'))).rejects.toBeDefined();
    await expect(fs.access(path.join(sessionsDir(), 'raw-honest-run.log'))).rejects.toBeDefined();
    expect(result.removedArtifactCount).toBe(1);

    // Recorded: a bounded reason in the runtime log and in the audit payload,
    // and neither names the path.
    expect(result.lastSweepFailures).toBeGreaterThan(0);
    const warned = JSON.stringify(warn.mock.calls);
    expect(warned).toContain('not-contained');
    expect(warned).not.toContain(outside);
    expect(warned).not.toContain(workspaceRoot);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'session-retention-applied',
      outcome: 'failure',
      payload: expect.objectContaining({ containmentRefusals: ['not-contained'] })
    }));
    const appended = JSON.stringify(append.mock.calls);
    expect(appended).not.toContain(outside);
    expect(appended).not.toContain(workspaceRoot);
  });

  it('prunes a symlink that stays inside the sessions root, which is not an escape', async () => {
    // Containment is about where the path leads, not about whether a symlink
    // was used to get there. A link that lands back inside the tree retention
    // owns is the host's to remove, and `rm` removes the link, not the target.
    await writeRunGroup('target-run', 40);
    const link = path.join(sessionsDir(), 'linked-run');
    await fs.symlink(path.join(sessionsDir(), 'target-run'), link, 'dir');
    await ageLink(link, 40);

    const { value, warn } = service();
    const result = await value.sweep();

    await expect(fs.lstat(link)).rejects.toBeDefined();
    expect(result.lastSweepFailures).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('not-contained');
  });

  it('leaves the sweep clean and the audit refusal list empty when nothing escapes', async () => {
    await writeRunGroup('a-run', 40);
    await writeRunGroup('b-run', 40);

    const { value, append } = service();
    const result = await value.sweep();

    expect(result.removedArtifactCount).toBe(2);
    expect(result.lastSweepFailures).toBe(0);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'success',
      payload: expect.objectContaining({ containmentRefusals: [] })
    }));
  });
});
