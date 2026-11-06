// FR-R5-F19 (feature 278, T19.1, FR-003, FR-005) — the host side of "Open decision record".
//
// What the wiring must guarantee: the record is shown through a content provider under a dedicated
// scheme (a read-only document, never an untitled editable one), as plain text with no language set,
// and the provider keeps a bounded number of records. The row lookup follows the row to its Run.
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registered: Array<{ scheme: string; provider: { provideTextDocumentContent(uri: { path: string }): string } }> = [];
const opened: Array<{ scheme: string; path: string }> = [];
const shown: unknown[] = [];
const untitledOpens: unknown[] = [];
const disposeProvider = vi.fn();
let trusted = true;

vi.mock('vscode', () => ({
  Uri: {
    from: (parts: { scheme: string; path: string }) => ({ scheme: parts.scheme, path: parts.path })
  },
  workspace: {
    get isTrusted() {
      return trusted;
    },
    registerTextDocumentContentProvider: (
      scheme: string,
      provider: { provideTextDocumentContent(uri: { path: string }): string }
    ) => {
      registered.push({ scheme, provider });
      return { dispose: disposeProvider };
    },
    openTextDocument: async (arg: { scheme?: string; path?: string; content?: string }) => {
      if (arg.scheme === undefined) {
        untitledOpens.push(arg);
        return { untitled: true };
      }
      opened.push({ scheme: arg.scheme, path: arg.path ?? '' });
      return { uri: arg };
    }
  },
  window: {
    showTextDocument: async (document: unknown) => {
      shown.push(document);
    }
  }
}));

import {
  createDecisionRecordWiring,
  DECISION_RECORD_DOCUMENTS_MAX,
  DECISION_RECORD_SCHEME,
  featureDirOfRow
} from '../../../src/activation/decision-record-wiring';

type Store = Parameters<typeof featureDirOfRow>[0];

const request = (overrides: Record<string, unknown> = {}) => ({ id: 'row-1', queueId: 'q-1', runId: 'run-1', ...overrides });
const storeWith = (req: unknown, run: unknown): Store =>
  ({ getRequest: () => req, getRun: (_queueId: string) => run }) as unknown as Store;

beforeEach(() => {
  registered.length = 0;
  opened.length = 0;
  shown.length = 0;
  untitledOpens.length = 0;
  disposeProvider.mockClear();
  trusted = true;
});

describe('featureDirOfRow', () => {
  it('is not found for a row the store does not hold', () => {
    expect(featureDirOfRow(storeWith(null, null), 'row-1')).toEqual({ found: false });
  });

  it('is found with no feature directory when the row has no Run', () => {
    expect(featureDirOfRow(storeWith(request({ runId: null }), null), 'row-1')).toEqual({
      found: true,
      featureDir: null
    });
  });

  it('is found with no feature directory when the queue holds a different Run', () => {
    expect(featureDirOfRow(storeWith(request(), { id: 'run-2', featureDir: 'specs/x' }), 'row-1')).toEqual({
      found: true,
      featureDir: null
    });
  });

  it('returns the Run feature directory when the Run is the row\'s own', () => {
    expect(featureDirOfRow(storeWith(request(), { id: 'run-1', featureDir: 'specs/x' }), 'row-1')).toEqual({
      found: true,
      featureDir: 'specs/x'
    });
  });
});

describe('the presenter', () => {
  function wire(featureDir = 'specs/x') {
    return createDecisionRecordWiring({
      workspaceRoot: '/does/not/matter',
      store: storeWith(request(), { id: 'run-1', featureDir }),
      logger: { warn: vi.fn() }
    });
  }

  it('registers one content provider under the dedicated scheme and releases it on dispose', () => {
    const wiring = wire();
    expect(registered.map((entry) => entry.scheme)).toEqual([DECISION_RECORD_SCHEME]);
    wiring.disposable.dispose();
    expect(disposeProvider).toHaveBeenCalledTimes(1);
  });

  it('answers workspace-not-trusted in an untrusted workspace without opening anything', async () => {
    trusted = false;
    const wiring = wire();
    await expect(wiring.opener.open('row-1')).resolves.toEqual({ outcome: 'workspace-not-trusted' });
    expect(opened).toHaveLength(0);
    expect(untitledOpens).toHaveLength(0);
  });

  it('never opens an untitled (editable) document', async () => {
    const wiring = wire('');
    await wiring.opener.open('row-1');
    expect(untitledOpens).toHaveLength(0);
  });

  describe('over a real record', () => {
    let root = '';
    const RECORD_TEXT = '# Decisions\n\nOpen: which owner commits?\n';

    beforeEach(async () => {
      root = await fsp.mkdtemp(path.join(os.tmpdir(), 'decision-record-wiring-'));
      await fsp.mkdir(path.join(root, 'specs', 'x'), { recursive: true });
      await fsp.writeFile(path.join(root, 'specs', 'x', 'decisions.md'), RECORD_TEXT);
    });

    afterEach(async () => {
      await fsp.rm(root, { recursive: true, force: true });
    });

    const wireOver = () =>
      createDecisionRecordWiring({
        workspaceRoot: root,
        store: storeWith(request(), { id: 'run-1', featureDir: 'specs/x' }),
        logger: { warn: vi.fn() }
      });
    const contentAt = (pathOf: string): string | undefined =>
      registered.at(0)?.provider.provideTextDocumentContent({ path: pathOf });

    it('shows the record text through the provider under the dedicated scheme', async () => {
      await expect(wireOver().opener.open('row-1')).resolves.toEqual({ outcome: 'opened' });

      expect(opened).toEqual([{ scheme: DECISION_RECORD_SCHEME, path: '/decisions-1.md' }]);
      expect(contentAt('/decisions-1.md')).toBe(RECORD_TEXT);
      expect(shown).toHaveLength(1);
    });

    it('keeps a bounded number of records, oldest out first', async () => {
      const wiring = wireOver();
      const opens = DECISION_RECORD_DOCUMENTS_MAX + 2;
      for (let index = 0; index < opens; index += 1) {
        await wiring.opener.open('row-1');
      }

      expect(opened).toHaveLength(opens);
      expect(contentAt('/decisions-1.md')).toBe('');
      expect(contentAt('/decisions-2.md')).toBe('');
      expect(contentAt('/decisions-3.md')).toBe(RECORD_TEXT);
      expect(contentAt(`/decisions-${opens}.md`)).toBe(RECORD_TEXT);
    });
  });

  it('refuses a Run whose feature directory is empty, which is every drained Run today', async () => {
    const wiring = wire('');
    await expect(wiring.opener.open('row-1')).resolves.toEqual({ outcome: 'outside-root' });
    expect(opened).toHaveLength(0);
  });
});
