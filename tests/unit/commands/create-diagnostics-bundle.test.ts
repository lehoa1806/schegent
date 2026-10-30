// Feature 251 (FR-R4-F04, contract T24, US7-4, US7-5, FR-035, B1, B2, B4, B7, B8) — the diagnostics bundle
// command, driven through every cancellation point and to its outcomes, over the two-Run fixture.
//
// What it pins: dismissing the Run pick, the preview, the raw warning (which returns to the preview) or the
// save dialog gives no file and no audit row; a destination inside `.schegent` is refused with one `refused`
// row and nothing written; a success gives one `evidence-exported` row of kind `diagnostics-bundle` whose
// counts include the raw choice, and a `0600` file named for the Run; and the row names no path and no Run
// content. Each "no file" claim is paired with a control: the same flow, undismissed, writes one.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  runCreateDiagnosticsBundle,
  type BundleRunChoice,
  type CreateDiagnosticsBundleDeps
} from '../../../src/commands/create-diagnostics-bundle';
import { EXPORT_TEXT } from '../../../src/commands/evidence-commands';
import { bundleRunChoices } from '../../../src/activation/evidence-commands-wiring';
import { RAW_BUNDLE_ITEMS } from '../../../src/services/diagnostics-bundle/bundle-plan';
import { buildBundleFixture, MARKERS, SELECTED_RUN, SIBLING_RUN, type BundleFixture } from '../services/diagnostics-bundle/bundle-fixture';

type Preview = CreateDiagnosticsBundleDeps['preview'];
type Row = { runId: string; eventType: string; payload: Record<string, unknown> };

const CHOICES: readonly BundleRunChoice[] = [
  { runId: SELECTED_RUN, label: 'Add a settings page (failed)', status: 'failed' },
  { runId: SIBLING_RUN, label: 'Tidy the docs (completed)', status: 'completed' }
];

let fixture: BundleFixture;
let rows: Row[];
let notices: string[];

beforeEach(async () => {
  fixture = await buildBundleFixture();
  rows = [];
  notices = [];
});

afterEach(async () => {
  await fixture.cleanup();
});

function deps(overrides: Partial<CreateDiagnosticsBundleDeps> = {}): CreateDiagnosticsBundleDeps {
  return {
    workspaceRoot: fixture.workspaceRoot,
    sources: fixture.sources,
    listRuns: () => CHOICES,
    pickRun: async (choices) => choices.find((choice) => choice.runId === SELECTED_RUN),
    preview: async () => 'create',
    confirmRaw: async () => true,
    promptForTarget: async (suggested) => ({
      scheme: 'file',
      fsPath: path.join(fixture.destinationDirectory, path.basename(suggested))
    }),
    auditWriter: {
      append: async (entry) => {
        rows.push({ runId: entry.runId, eventType: entry.eventType, payload: entry.payload as Record<string, unknown> });
        return { ...entry, id: `audit-${rows.length}`, timestamp: '2026-10-31T00:00:00.000Z' };
      }
    },
    notifier: {
      info: (message: string) => void notices.push(message),
      warn: (message: string) => {
        notices.push(message);
        return Promise.resolve(undefined);
      }
    } as unknown as CreateDiagnosticsBundleDeps['notifier'],
    homeDirectory: () => fixture.destinationDirectory,
    now: () => new Date('2026-10-31T07:08:09.000Z'),
    ...overrides
  };
}

const written = async (): Promise<string[]> => (await fs.readdir(fixture.destinationDirectory)).sort();

describe('cancellation gives no file and no row (B8, US7-4)', () => {
  it('writes one file and one row when nothing is dismissed (the control)', async () => {
    await runCreateDiagnosticsBundle(deps());

    expect(await written()).toEqual([`schegent-diagnostics-${SELECTED_RUN}-20261031T070809Z.json`]);
    expect(rows).toHaveLength(1);
  });

  it('at the Run pick', async () => {
    await runCreateDiagnosticsBundle(deps({ pickRun: async () => undefined }));
    expect(await written()).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('at the preview', async () => {
    await runCreateDiagnosticsBundle(deps({ preview: async () => 'cancel' }));
    expect(await written()).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('at the raw warning: it returns to the preview, and a cancel there ends with nothing', async () => {
    const answers: Array<Awaited<ReturnType<Preview>>> = ['include-raw', 'cancel'];
    const preview = vi.fn<Preview>(async () => answers.shift() ?? 'cancel');
    await runCreateDiagnosticsBundle(deps({ preview, confirmRaw: async () => false }));

    expect(preview, 'declining the warning shows the preview again').toHaveBeenCalledTimes(2);
    expect(await written()).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('at the save dialog', async () => {
    await runCreateDiagnosticsBundle(deps({ promptForTarget: async () => undefined }));
    expect(await written()).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('says so, and writes nothing, when no Run has evidence', async () => {
    await runCreateDiagnosticsBundle(deps({ listRuns: () => [] }));
    expect(await written()).toEqual([]);
    expect(rows).toEqual([]);
    expect(notices.join(' ')).toMatch(/no Runs/i);
  });
});

describe('a destination inside the evidence store is refused (E3, B7)', () => {
  it('records one refused row and writes nothing', async () => {
    const inside = path.join(fixture.workspaceRoot, '.schegent', 'bundle.json');
    await runCreateDiagnosticsBundle(deps({ promptForTarget: async () => ({ scheme: 'file', fsPath: inside }) }));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.eventType).toBe('evidence-exported');
    expect(rows[0]!.payload).toMatchObject({ kind: 'diagnostics-bundle', outcome: 'refused', refusal: 'destination-in-evidence-store', included: 0 });
    await expect(fs.stat(inside)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await written()).toEqual([]);
    expect(notices.join(' ')).toContain(EXPORT_TEXT.refusal['destination-in-evidence-store']);
  });

  it('refuses a destination that is not a local file', async () => {
    await runCreateDiagnosticsBundle(deps({ promptForTarget: async () => ({ scheme: 'vscode-remote', fsPath: '/remote/x.json' }) }));
    expect(rows[0]!.payload).toMatchObject({ outcome: 'refused', refusal: 'destination-not-local-file' });
    expect(await written()).toEqual([]);
  });
});

describe('a bundle that is written (FR-035, B7)', () => {
  it('records one exported row counting the items written and the raw items left out', async () => {
    await runCreateDiagnosticsBundle(deps());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: SELECTED_RUN, eventType: 'evidence-exported' });
    expect(rows[0]!.payload).toEqual({
      kind: 'diagnostics-bundle',
      outcome: 'exported',
      included: 5,
      omitted: RAW_BUNDLE_ITEMS.length
    });
  });

  it('counts the raw items as included once the operator accepts the warning', async () => {
    const answers: Array<Awaited<ReturnType<Preview>>> = ['include-raw', 'create'];
    await runCreateDiagnosticsBundle(deps({ preview: async () => answers.shift() ?? 'cancel', confirmRaw: async () => true }));

    expect(rows[0]!.payload).toEqual({ kind: 'diagnostics-bundle', outcome: 'exported', included: 8, omitted: 0 });
    const [name] = await written();
    const text = await fs.readFile(path.join(fixture.destinationDirectory, name!), 'utf8');
    expect(text).toContain(MARKERS.rawTranscript);
    expect(JSON.parse(text).manifest.rawConversationIncluded).toBe(true);
  });

  it('writes the file owner-only and names no path or content in the row', async () => {
    await runCreateDiagnosticsBundle(deps());

    const [name] = await written();
    if (process.platform !== 'win32') {
      const mode = (await fs.stat(path.join(fixture.destinationDirectory, name!))).mode & 0o777;
      expect(mode.toString(8)).toBe('600');
    }
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(fixture.destinationDirectory);
    expect(serialized).not.toContain(fixture.workspaceRoot);
    expect(serialized).not.toContain(MARKERS.newestLog);
    expect(Object.keys(rows[0]!.payload).sort()).toEqual(['included', 'kind', 'omitted', 'outcome']);
  });

  it('keeps the file and says it was not recorded when the audit append fails (E6)', async () => {
    await runCreateDiagnosticsBundle(
      deps({
        auditWriter: {
          append: async () => {
            throw new Error('audit unavailable');
          }
        }
      })
    );

    expect(await written()).toHaveLength(1);
    expect(notices.join(' ')).toContain(EXPORT_TEXT.notRecorded);
  });
});

// B1 — the pick lists Runs with evidence in this workspace, not only Runs a queue request still names. A Run
// whose request was removed keeps its history row, failure record and audit rows, and must still be pickable.
describe('the Run pick (B1)', () => {
  const request = (runId: string, description: string, status: string, updatedAt: number) =>
    ({ runId, description, status, updatedAt, retryCount: 0 }) as const;
  const history = (runId: string, descriptionPreview: string, terminalStatus: string, completedAt: string) =>
    ({ runId, descriptionPreview, terminalStatus, completedAt, queueId: 'q1' }) as const;
  const inputs = (requests: readonly object[], records: readonly object[]) =>
    ({
      store: { getQueueStates: () => ({ q1: { requests } }) },
      historyStore: { list: () => records },
      logger: { sanitize: (text: string) => text }
    }) as unknown as Parameters<typeof bundleRunChoices>[0];

  it('lists a Run that only history names, newest first among the requests', () => {
    const choices = bundleRunChoices(
      inputs(
        [request(SIBLING_RUN, 'Tidy the docs', 'completed', Date.parse('2026-10-30T00:00:00.000Z'))],
        [history(SELECTED_RUN, 'Add a settings page', 'failed', '2026-10-31T00:00:00.000Z')]
      )
    );

    expect(choices.map((choice) => choice.runId)).toEqual([SELECTED_RUN, SIBLING_RUN]);
    expect(choices[0]).toMatchObject({ label: 'Add a settings page (failed)', status: 'failed' });
  });

  it('lists a Run once when both a request and history name it, labelled from the request', () => {
    const choices = bundleRunChoices(
      inputs(
        [request(SELECTED_RUN, 'Add a settings page', 'failed', Date.parse('2026-10-31T00:00:00.000Z'))],
        [history(SELECTED_RUN, 'Add a settings', 'failed', '2026-10-31T00:00:01.000Z')]
      )
    );

    expect(choices).toEqual([{ runId: SELECTED_RUN, label: 'Add a settings page (failed)', status: 'failed' }]);
  });
});
