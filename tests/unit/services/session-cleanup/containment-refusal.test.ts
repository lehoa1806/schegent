// Feature FR-R3-005 (T332) — task-deletion cleanup refuses an escaping root.
//
// The acceptance scenario this file pins:
//   Given `.schegent/sessions` resolves outside the workspace
//   When the operator deletes a task
//   Then nothing is removed, the refusal is recorded, and the operator is told
//   the cleanup did not run
//
// Two layouts, deliberately:
//   - real symlinks, so the escape is the one the kernel actually performs;
//   - the injected `filesystem` seam, so the `resolve-failed` arm can be driven
//     without asking the machine running the suite to produce an EACCES.
//
// The removals go through the `fsRm` seam so a regression is visible as a call
// that should never have been made, rather than as a temp directory that
// happens to survive.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SanitizedLogger } from '../../../../src/lib/logger';
import {
  cleanupSessionArtifacts,
  type SessionCleanupFsRm
} from '../../../../src/services/session-cleanup/session-cleanup-service';

const runId = 'run-escaping-1';

function makeLogger() {
  const logger = new SanitizedLogger([]);
  const warnSpy = vi.spyOn(logger, 'warn');
  return { logger, warnSpy };
}

/** A removal seam that would succeed, so a call is a defect and not a failure. */
function spyRm() {
  return vi.fn<SessionCleanupFsRm>().mockImplementation(async () => undefined);
}

describe('FR-R3-005 (T332) refused task-deletion cleanup', () => {
  let workspaceRoot: string;
  let outside: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-refuse-ws-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-refuse-out-'));
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(outside, { recursive: true, force: true }).catch(() => undefined);
  });

  it('removes nothing when .schegent is a symlink out of the workspace', async () => {
    // The layout an operator can arrive at without meaning to: `.schegent`
    // points at a shared evidence store, or at a directory a previous tool
    // left behind. Every path the helper assembles is lexically spotless.
    const stolen = path.join(outside, 'schegent');
    await fs.mkdir(path.join(stolen, 'sessions', runId), { recursive: true });
    const bystander = path.join(stolen, 'sessions', runId, 'stream.jsonl');
    await fs.writeFile(bystander, '{}\n', 'utf8');
    const rawFile = path.join(stolen, 'sessions', `raw-${runId}.log`);
    await fs.writeFile(rawFile, 'hello\n', 'utf8');
    await fs.symlink(stolen, path.join(workspaceRoot, '.schegent'), 'dir');

    const { logger, warnSpy } = makeLogger();
    const fsRm = spyRm();
    const outcome = await cleanupSessionArtifacts({
      workspaceRoot,
      runId,
      logger,
      fsRm
    });

    // Nothing removed — not even attempted.
    expect(fsRm).not.toHaveBeenCalled();
    await expect(fs.readFile(bystander, 'utf8')).resolves.toBe('{}\n');
    await expect(fs.readFile(rawFile, 'utf8')).resolves.toBe('hello\n');

    // Recorded, with a bounded code the audit payload can carry.
    expect(outcome).toEqual({ cleaned: false, refusal: 'not-contained' });

    // Told: one warn line, naming the reason and nothing else. The refused
    // path is the one string here that would name a location outside the
    // workspace, so it stays out of the diagnostic entirely.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('not-contained');
    expect(message).toContain('the queue entry was still removed');
    expect(message).not.toContain(outside);
    expect(message).not.toContain(workspaceRoot);
  });

  it('refuses with resolve-failed when the sessions tree cannot be resolved', async () => {
    // An unresolvable path is not a licence to fall back to the lexical
    // answer, which here would be "contained" and would remove whatever the
    // path really leads to.
    const { logger, warnSpy } = makeLogger();
    const fsRm = spyRm();
    const outcome = await cleanupSessionArtifacts({
      workspaceRoot,
      runId,
      logger,
      fsRm,
      filesystem: {
        async realpath(target: string): Promise<string> {
          if (target === path.resolve(workspaceRoot)) return target;
          const err = new Error('EACCES') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
      }
    });

    expect(fsRm).not.toHaveBeenCalled();
    expect(outcome).toEqual({ cleaned: false, refusal: 'resolve-failed' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0] ?? '')).toContain('resolve-failed');
  });

  it('reports not-contained when the two targets disagree', async () => {
    // `not-contained` is the finding an operator has to act on and
    // `resolve-failed` is its I/O-flavoured cousin, so a mixed pair reports
    // the former rather than whichever sub-op happened to run first.
    const sessionRoot = path.resolve(
      path.join(workspaceRoot, '.schegent', 'sessions', runId)
    );
    const { logger, warnSpy } = makeLogger();
    const fsRm = spyRm();
    const outcome = await cleanupSessionArtifacts({
      workspaceRoot,
      runId,
      logger,
      fsRm,
      filesystem: {
        async realpath(target: string): Promise<string> {
          if (target === path.resolve(workspaceRoot)) return target;
          // The directory escapes; the raw transcript merely will not answer.
          if (target === sessionRoot) return path.join(outside, 'sessions', runId);
          const err = new Error('EIO') as NodeJS.ErrnoException;
          err.code = 'EIO';
          throw err;
        }
      }
    });

    expect(fsRm).not.toHaveBeenCalled();
    expect(outcome).toEqual({ cleaned: false, refusal: 'not-contained' });
    // One line per cause, and containment is one cause however many sub-ops
    // it covers.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('still removes a contained sibling when only one target is refused', async () => {
    // A refusal is scoped to the target that earned it. The other target is
    // inside the workspace and the operator asked for it to go.
    const sessionRoot = path.resolve(
      path.join(workspaceRoot, '.schegent', 'sessions', runId)
    );
    const { logger } = makeLogger();
    const removed: string[] = [];
    const fsRm: SessionCleanupFsRm = async (p) => {
      removed.push(p);
    };
    const outcome = await cleanupSessionArtifacts({
      workspaceRoot,
      runId,
      logger,
      fsRm,
      filesystem: {
        async realpath(target: string): Promise<string> {
          if (target === sessionRoot) return path.join(outside, 'sessions', runId);
          return target;
        }
      }
    });

    expect(outcome).toEqual({ cleaned: false, refusal: 'not-contained' });
    expect(removed).toHaveLength(1);
    expect(removed[0]?.endsWith(`raw-${runId}.log`)).toBe(true);
  });

  it('never throws on the refusal path', async () => {
    const { logger } = makeLogger();
    let threw = false;
    try {
      await cleanupSessionArtifacts({
        workspaceRoot,
        runId,
        logger,
        fsRm: spyRm(),
        filesystem: {
          async realpath(): Promise<string> {
            throw new Error('EACCES');
          }
        }
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});
