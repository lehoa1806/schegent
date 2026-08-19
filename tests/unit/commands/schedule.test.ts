// Feature 098 (T044, US6) — the schedule picker treats every Pipeline alike.
//
// FR-035, and supporting evidence for SC-014. The picker used to give one id —
// `speckit-new-feature`, the Pipeline the built-in layer supplied — a `$(zap)`
// prefix on its label, a `[BuiltIn]` detail line, and a place ahead of every
// other Pipeline in the sort. None of that describes a property of the row: it
// described where the row came from, in a product where one origin was
// privileged. With the catalog empty every Pipeline arrives the same way, so a
// badge on that one id would mark an operator's own definition as "built in"
// purely because of the name they chose.
//
// `pickPipelineId` is module-private, so the picker is exercised through
// `runSchedule` and observed at the `showQuickPick` boundary — which is also
// where an operator observes it.
//
// The picker lives in `src/commands/schedule.ts` and had no test file before
// this one.

import { describe, it, expect, vi, beforeEach } from 'vitest';

interface QuickPickItem {
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  readonly picked?: boolean;
  readonly pipelineId: string;
}

interface QuickPickCall {
  readonly items: readonly QuickPickItem[];
  readonly options: { readonly title?: string; readonly placeHolder?: string };
}

const mocks = vi.hoisted(() => ({
  quickPickCalls: [] as QuickPickCall[],
  /** Which item the operator picks, by index. `null` means they dismissed it. */
  choose: 0 as number | null
}));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: async (
      items: readonly QuickPickItem[],
      options: { title?: string; placeHolder?: string }
    ) => {
      mocks.quickPickCalls.push({ items, options });
      return mocks.choose === null ? undefined : items[mocks.choose];
    },
    showInputBox: async () => 'A feature to schedule'
  }
}));

import { runSchedule } from '../../../src/commands/schedule';
import { buildCatalog, type PipelineDef } from '../../../src/config/pipeline-config';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * The id that used to be badged and hoisted. It is named explicitly rather than
 * left to a generic fixture: the point of the case is that *this* id gets no
 * special treatment, and a fixture of neutral ids would pass whether the rule
 * had been deleted or merely never triggered.
 */
const FORMERLY_BUILT_IN = 'speckit-new-feature';

const NO_MODELS = { claude: [], codex: [], agy: [] };

function pipeline(id: string, name: string): PipelineDef {
  return { id, name, version: 1, phases: ['draft'] } as unknown as PipelineDef;
}

/** Alphabetically last, so a built-in-first sort would be visible as a hoist. */
const PIPELINES: readonly PipelineDef[] = [
  pipeline('alpha-flow', 'Alpha Flow'),
  pipeline('mid-flow', 'Mid Flow'),
  pipeline(FORMERLY_BUILT_IN, 'Zulu Flow')
];

function makeCtx(defaultPipelineId: string) {
  const scheduleOrEnqueue = vi.fn(async () => ({ outcome: 'enqueued', queueItemId: 'q-1' }));
  const ctx = {
    guardedRunService: { scheduleOrEnqueue },
    getCatalog: () =>
      buildCatalog(
        [{ id: 'draft', name: 'Draft', version: 1, instruction: 'Draft.' }] as never,
        PIPELINES,
        NO_MODELS,
        defaultPipelineId
      ),
    notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logger: new SanitizedLogger()
  } as unknown as Parameters<typeof runSchedule>[1];
  return { ctx, scheduleOrEnqueue };
}

/** The one call the picker made, failing loudly rather than reading `undefined`. */
function onlyQuickPick(): QuickPickCall {
  expect(mocks.quickPickCalls, 'the picker did not open').toHaveLength(1);
  return mocks.quickPickCalls[0]!;
}

beforeEach(() => {
  mocks.quickPickCalls.length = 0;
  mocks.choose = 0;
  vi.spyOn(SanitizedLogger.prototype, 'error').mockImplementation(() => undefined);
});

describe('Feature 098 (T044) — the schedule picker badges no Pipeline as built in', () => {
  it('gives the formerly built-in id no badge, no detail line, and no icon', async () => {
    const { ctx } = makeCtx('');

    await runSchedule(undefined, ctx);

    const { items } = onlyQuickPick();
    const formerly = items.find((item) => item.pipelineId === FORMERLY_BUILT_IN);
    expect(formerly, `no item for ${FORMERLY_BUILT_IN}`).toBeDefined();
    expect(formerly!.label).toBe('Zulu Flow');
    expect(formerly!.detail).toBeUndefined();
    // Asserted across every row, not just that one: the rule is that no origin
    // is marked, so a badge moved to a different id is the same defect.
    for (const item of items) {
      expect(item.label, `${item.pipelineId} carries an icon`).not.toContain('$(');
      expect(item.detail, `${item.pipelineId} carries a detail line`).toBeUndefined();
    }
  });

  it('sorts alphabetically when no default is set, hoisting no id', async () => {
    // With the setting unset there is nothing to hoist *for a legitimate
    // reason*, which is what makes this the case that isolates the built-in
    // rule: any deviation from alphabetical order here is origin-based.
    const { ctx } = makeCtx('');

    await runSchedule(undefined, ctx);

    expect(onlyQuickPick().items.map((item) => item.label)).toEqual([
      'Alpha Flow',
      'Mid Flow',
      'Zulu Flow'
    ]);
  });

  it('still sorts the operator default first, so the ordering rule is narrowed and not deleted', async () => {
    // The companion assertion. Without it, "no built-in-first ordering" would
    // also be satisfied by a picker that stopped ordering meaningfully at all.
    // The default is a choice the operator made; built-in-ness was not.
    const { ctx } = makeCtx('mid-flow');

    await runSchedule(undefined, ctx);

    const { items } = onlyQuickPick();
    expect(items[0]!.pipelineId).toBe('mid-flow');
    expect(items[0]!.picked).toBe(true);
  });
});

describe('Feature 098 (T044) — the picker treats the empty default as "no default"', () => {
  it('preselects nothing and offers no row for the unset id', async () => {
    // FR-033a. `''` is not a Pipeline, so it is neither preselected nor listed;
    // `PIPELINE_ID_PATTERN` guarantees no row can ever carry it, which is why
    // this needs no guard in the picker itself.
    const { ctx } = makeCtx('');

    await runSchedule(undefined, ctx);

    const { items } = onlyQuickPick();
    expect(items.some((item) => item.picked === true)).toBe(false);
    expect(items.some((item) => item.pipelineId === '')).toBe(false);
  });

  it('does not advertise an empty default in the placeholder', async () => {
    // The placeholder read `Default: ${defaultPipelineId}`, which with an unset
    // setting renders as a sentence that trails off into nothing.
    const { ctx } = makeCtx('');

    await runSchedule(undefined, ctx);

    const placeHolder = onlyQuickPick().options.placeHolder ?? '';
    expect(placeHolder).not.toMatch(/Default:\s*$/);
    expect(placeHolder.length).toBeGreaterThan(0);
  });

  it('names the missing id to the launch path when the catalog holds one Pipeline and no default', async () => {
    // FR-033b. With a single Pipeline the picker does not open at all, and the
    // old code answered the unset default — which then travelled to the launch
    // path as an id nothing resolves. One Pipeline and no default has exactly
    // one thing the operator could have meant, so that is what is scheduled.
    const scheduleOrEnqueue = vi.fn(async (_request: { pipelineId: string }) => ({
      outcome: 'enqueued',
      queueItemId: 'q-1'
    }));
    const ctx = {
      guardedRunService: { scheduleOrEnqueue },
      getCatalog: () =>
        buildCatalog(
          [{ id: 'draft', name: 'Draft', version: 1, instruction: 'Draft.' }] as never,
          [pipeline('only-flow', 'Only Flow')],
          NO_MODELS,
          ''
        ),
      notifier: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      logger: new SanitizedLogger()
    } as unknown as Parameters<typeof runSchedule>[1];

    await runSchedule(undefined, ctx);

    expect(mocks.quickPickCalls).toHaveLength(0);
    expect(scheduleOrEnqueue).toHaveBeenCalledTimes(1);
    expect(scheduleOrEnqueue.mock.calls[0]![0]).toMatchObject({ pipelineId: 'only-flow' });
  });

  it('carries the empty id through to the launch path when the catalog is empty', async () => {
    // FR-033b's other half, and the reason the picker does not short-circuit:
    // returning `undefined` here would make `runSchedule` return early, which is
    // the silent no-op the requirement rules out. The empty id reaches
    // `scheduleOrEnqueue`, where the FR-023 refusal names it.
    const scheduleOrEnqueue = vi.fn(async (_request: { pipelineId: string }) => ({
      outcome: 'rejected-validation',
      reason: 'pipeline-not-found'
    }));
    const notifier = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      guardedRunService: { scheduleOrEnqueue },
      getCatalog: () => buildCatalog([], [], NO_MODELS, ''),
      notifier,
      logger: new SanitizedLogger()
    } as unknown as Parameters<typeof runSchedule>[1];

    await runSchedule(undefined, ctx);

    expect(mocks.quickPickCalls).toHaveLength(0);
    expect(scheduleOrEnqueue).toHaveBeenCalledTimes(1);
    expect(scheduleOrEnqueue.mock.calls[0]![0]).toMatchObject({ pipelineId: '' });
    expect(notifier.warn).toHaveBeenCalledTimes(1);
  });
});
