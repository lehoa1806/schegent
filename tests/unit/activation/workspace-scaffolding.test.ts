/**
 * Activation-time notice for a workspace that has no Spec Kit scaffolding.
 *
 * Recorded as `docs/features/bugs/no-preflight-for-missing-speckit-scaffolding.md`.
 * `assertScaffoldingPresent()` was the only code that ever stat'd `.specify/`, and
 * it lived in `GuardedRunService.startNow()`, deleted on 2026-08-15 along with its
 * only caller. Since then a workspace with no `.specify/` drained, started a Run,
 * passed the runner probe, and failed on the first `/speckit-*` phase with
 * whatever the CLI reported — so the operator saw a phase failure rather than
 * "this workspace is not initialized".
 *
 * The notice fires at activation rather than at enqueue or at Run start because
 * the condition is a property of the workspace, not of any one Run: a refusal at
 * either point would refuse the onboarding Run whose whole job is to create
 * `.specify/`. A warning cannot refuse anything, which is exactly why it is the
 * right shape here.
 *
 * Two audiences, deliberately: the runtime log carries the diagnostic detail, and
 * the operator gets one notification, because a runtime-log line alone would not
 * reach the operator whose confusion this fixes. Neither message names the
 * workspace root — the operator knows which window they are in, and keeping the
 * path out of both keeps this clear of the redaction surface entirely.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findScaffoldingDefect,
  warnIfScaffoldingMissing
} from '../../../src/activation/workspace-scaffolding';

/** A throwaway workspace root; the callback owns it for the length of the call. */
function withWorkspace(build: (root: string) => void, assert: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'schegent-scaffolding-'));
  try {
    build(root);
    assert(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface Recorded {
  readonly logged: string[];
  readonly notified: string[];
}

function recorders(): Recorded & {
  readonly logger: { warn(message: string): void };
  readonly notifier: { warn(message: string): Promise<string | undefined> };
} {
  const logged: string[] = [];
  const notified: string[] = [];
  return {
    logged,
    notified,
    logger: { warn: (message) => void logged.push(message) },
    notifier: {
      warn: (message) => {
        notified.push(message);
        return Promise.resolve(undefined);
      }
    }
  };
}

describe('findScaffoldingDefect', () => {
  it('reports no defect when .specify/ is a directory', () => {
    withWorkspace(
      (root) => mkdirSync(join(root, '.specify')),
      (root) => expect(findScaffoldingDefect(root)).toBeNull()
    );
  });

  it('reports scaffolding-missing when .specify/ is absent', () => {
    withWorkspace(
      () => undefined,
      (root) => expect(findScaffoldingDefect(root)).toBe('scaffolding-missing')
    );
  });

  it('reports scaffolding-not-directory when .specify is a file', () => {
    withWorkspace(
      (root) => writeFileSync(join(root, '.specify'), 'not a directory'),
      (root) => expect(findScaffoldingDefect(root)).toBe('scaffolding-not-directory')
    );
  });
});

describe('warnIfScaffoldingMissing', () => {
  it('says nothing when the scaffolding is present', () => {
    withWorkspace(
      (root) => mkdirSync(join(root, '.specify')),
      (root) => {
        const { logged, notified, logger, notifier } = recorders();
        warnIfScaffoldingMissing(root, logger, notifier);
        expect(logged).toEqual([]);
        expect(notified).toEqual([]);
      }
    );
  });

  it('warns the runtime log and the operator exactly once when it is absent', () => {
    withWorkspace(
      () => undefined,
      (root) => {
        const { logged, notified, logger, notifier } = recorders();
        warnIfScaffoldingMissing(root, logger, notifier);
        expect(logged).toHaveLength(1);
        expect(notified).toHaveLength(1);
        expect(logged[0]).toContain('scaffolding-missing');
        // The operator message has to name the thing to create and stay free of
        // the reason code, which is diagnostic vocabulary rather than guidance.
        expect(notified[0]).toContain('.specify');
        expect(notified[0]).not.toContain('scaffolding-missing');
      }
    );
  });

  it('distinguishes a non-directory .specify in the runtime log', () => {
    withWorkspace(
      (root) => writeFileSync(join(root, '.specify'), 'not a directory'),
      (root) => {
        const { logged, notified, logger, notifier } = recorders();
        warnIfScaffoldingMissing(root, logger, notifier);
        expect(logged[0]).toContain('scaffolding-not-directory');
        expect(notified).toHaveLength(1);
      }
    );
  });

  it('never puts the workspace root in either message', () => {
    withWorkspace(
      () => undefined,
      (root) => {
        const { logged, notified, logger, notifier } = recorders();
        warnIfScaffoldingMissing(root, logger, notifier);
        for (const message of [...logged, ...notified]) {
          expect(message).not.toContain(root);
        }
      }
    );
  });
});
