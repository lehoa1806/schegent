/**
 * Feature 193 (T032, FR-001/FR-002/FR-003/FR-004/FR-009/FR-010) — parity test
 * between the host's canonical `ACTION_KEYS` tuple
 * (`src/contracts/action-keys.ts`) and the webview's generated mirror
 * (`webview-ui/src/lib/generated/action-keys.ts`), plus a full host
 * suppression-validator/store/snapshot round trip for every one of the 18
 * canonical keys.
 *
 * Per the action-key contract's invariant 3 ("two-artifact provenance"), the
 * host tuple and the webview mirror are imported here from two independently
 * resolved module paths — one under `src/`, one under
 * `webview-ui/src/lib/generated/` — so a regression that collapses back to
 * "read one authority twice" is caught by the file-identity check below, not
 * only by a set-equality assertion a vacuous re-import would also satisfy.
 *
 * The webview mirror is loaded via a dynamic `import()` rather than a static
 * one: the root project compiles `tests/**` as CommonJS (no `"type":
 * "module"` in the root `package.json`), while `webview-ui/` is ESM (`"type":
 * "module"` in `webview-ui/package.json`) — the same CJS/ESM boundary
 * `tests/parity/retry-condition-parity.test.ts` documents. A static import
 * fails `tsc` with TS1479; a dynamic import is the fix TypeScript itself
 * recommends and still names a second, independently resolved module path.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ACTION_KEYS as HOST_ACTION_KEYS } from '../../src/contracts/action-keys';
import { MessageRouter } from '../../src/ui/sidebar/message-router';
import type { RouterDeps } from '../../src/ui/sidebar/message-router';
import { StateProjector } from '../../src/ui/sidebar/state-projector';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../src/lib/logger';
import { WorkspaceStateStore, type Memento } from '../../src/state/workspace-state';
import { CMD_SET_CONFIRM_SUPPRESSION } from '../../src/ui/sidebar/messages';
import type { CommandAckMessage } from '../../src/ui/sidebar/messages';

const REPO_ROOT = path.resolve(__dirname, '../..');
const HOST_SOURCE_PATH = path.join(REPO_ROOT, 'src/contracts/action-keys.ts');
const WEBVIEW_MIRROR_PATH = path.join(REPO_ROOT, 'webview-ui/src/lib/generated/action-keys.ts');

// Local fixture, deliberately independent of `tests/integration/
// confirm-suppression-roundtrip.test.ts`'s own copy — each parity/integration
// suite owns its own minimal harness rather than sharing one across files.
class MockMemento implements Memento {
  public writes: Array<{ key: string; value: unknown }> = [];
  private map = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.map.get(key) as T | undefined;
  }
  update(key: string, value: unknown): Thenable<void> {
    this.writes.push({ key, value });
    if (value === undefined) this.map.delete(key);
    else this.map.set(key, value);
    return Promise.resolve();
  }
}

interface SetupResult {
  router: MessageRouter;
  store: WorkspaceStateStore;
  projector: StateProjector;
  acks: CommandAckMessage[];
  postAck: (msg: CommandAckMessage) => Promise<boolean>;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<SetupResult> {
  const tmpRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'schegent-actionkey-parity-'));
  const memento = new MockMemento();
  const store = new WorkspaceStateStore(memento);
  await store.initialize();
  const logger = new SanitizedLogger();
  const audit = new AuditLogWriter({ workspaceRoot: tmpRoot }, logger);
  const projector = new StateProjector({ store, audit, ownerId: 'test-owner' });

  const acks: CommandAckMessage[] = [];
  const postAck = async (msg: CommandAckMessage) => {
    acks.push(msg);
    return true;
  };

  const deps: RouterDeps = {
    executeCommand: (async () => undefined) as unknown as RouterDeps['executeCommand'],
    isPrimary: () => true,
    isTrusted: () => true,
    logger,
    setConfirmSuppression: async (actionKey, suppressed) => {
      await store.setConfirmSuppression(actionKey, suppressed);
      projector.kick();
    }
  };

  return {
    router: new MessageRouter(deps),
    store,
    projector,
    acks,
    postAck,
    cleanup: async () => {
      projector.dispose();
      await fsPromises.rm(tmpRoot, { recursive: true, force: true });
    }
  };
}

describe('ActionKey host/webview parity + suppression round trip (T032, FR-010)', () => {
  // Populated in `beforeAll` from a dynamic `import()` — see the file header
  // for why this one module is loaded dynamically rather than statically.
  let webviewActionKeys: readonly string[];

  beforeAll(async () => {
    const webviewModule = (await import(
      '../../webview-ui/src/lib/generated/action-keys.js'
    )) as { ACTION_KEYS: readonly string[] };
    webviewActionKeys = webviewModule.ACTION_KEYS;
  });

  it('the host tuple and the webview mirror are two distinct files, not one file read twice', () => {
    expect(HOST_SOURCE_PATH).not.toEqual(WEBVIEW_MIRROR_PATH);
    const hostContent = fs.readFileSync(HOST_SOURCE_PATH, 'utf8');
    const webviewContent = fs.readFileSync(WEBVIEW_MIRROR_PATH, 'utf8');
    // The mirror is a generated artifact of the host source, not the host
    // source re-exported under a second path: it carries a generation
    // banner the host file does not.
    expect(webviewContent).toContain('GENERATED FILE');
    expect(hostContent).not.toContain('GENERATED FILE');
  });

  it('the webview mirror declares exactly the 18 canonical keys, matching the host tuple', () => {
    expect(HOST_ACTION_KEYS.length).toBe(18);
    expect(webviewActionKeys.length).toBe(18);
    expect([...webviewActionKeys].sort()).toEqual([...HOST_ACTION_KEYS].sort());
  });

  describe('host suppression round trip for every canonical key', () => {
    let env: SetupResult;
    beforeEach(async () => {
      env = await setup();
    });
    afterEach(async () => {
      await env.cleanup();
    });

    it('accepts and persists a suppression write for every one of the 18 canonical keys', async () => {
      for (const actionKey of webviewActionKeys) {
        await env.router.dispatch(
          {
            type: CMD_SET_CONFIRM_SUPPRESSION,
            correlationId: `c-${actionKey}`,
            payload: { actionKey, suppressed: true }
          },
          env.postAck
        );
      }

      expect(env.acks.every((a) => a.status === 'accepted')).toBe(true);

      const persisted = env.store.getConfirmSuppression().suppressedActionKeys;
      const missingFromStore = webviewActionKeys.filter((k) => !persisted.includes(k));
      expect(missingFromStore, `missing from persisted store: ${missingFromStore.join(', ')}`).toEqual([]);

      const snap = env.projector.project();
      const snapshotKeys = snap.confirmSuppression!.suppressedActionKeys;
      const missingFromSnapshot = webviewActionKeys.filter((k) => !snapshotKeys.includes(k));
      expect(missingFromSnapshot, `missing from snapshot: ${missingFromSnapshot.join(', ')}`).toEqual([]);
    });

    // Unknown-string control (FR-003): widening the accepted set from 11 to
    // 18 must not change the shape of the rejection — an arbitrary string
    // outside the canonical set is still rejected.
    it('rejects an unrecognized action key exactly as before widening', async () => {
      await env.router.dispatch(
        {
          type: CMD_SET_CONFIRM_SUPPRESSION,
          correlationId: 'c-unknown',
          payload: { actionKey: 'not.a.real.key', suppressed: true }
        },
        env.postAck
      );
      // Asserted as the whole array rather than `env.acks[0].status`: a
      // dispatch that posted nothing would make the indexed read throw an
      // opaque TypeError, and this form additionally pins that exactly one
      // ACK came back.
      expect(env.acks).toEqual([
        expect.objectContaining({ status: 'rejected', reason: 'unknown-action-key' })
      ]);
      expect(env.store.getConfirmSuppression().suppressedActionKeys).toEqual([]);
    });

    // Duplicate/idempotent-write control: two writes for the same key
    // persist as one occurrence.
    it('is idempotent: writing the same key twice yields one persisted occurrence', async () => {
      // A named key with a membership assertion, not `webviewActionKeys[0]`:
      // the index says nothing about which key was exercised, and the
      // assertion below fails loudly if this one ever leaves the canonical set.
      const actionKey = 'queue.clean-all';
      expect(webviewActionKeys).toContain(actionKey);
      for (let i = 0; i < 2; i++) {
        await env.router.dispatch(
          {
            type: CMD_SET_CONFIRM_SUPPRESSION,
            correlationId: `c-dup-${i}`,
            payload: { actionKey, suppressed: true }
          },
          env.postAck
        );
      }
      const keys = env.store.getConfirmSuppression().suppressedActionKeys;
      expect(keys.filter((k) => k === actionKey)).toHaveLength(1);
      expect(env.acks.every((a) => a.status === 'accepted')).toBe(true);
    });
  });
});
