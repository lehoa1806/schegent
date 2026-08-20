// Feature 101 (US3, T039/T040) — the lifecycle actions a definition offers, and
// the gate in front of the two that take something away.
//
// The seam is drawn *below* `catalog-lifecycle.ts`, not around it. The two
// confirmations live inside the sender (feature 100, FR-049/FR-050), so a suite
// that mocked the lifecycle helpers would mock away the very thing FR-020 and
// FR-022 are about and could only assert that a button called a function. What is
// mocked here is the transport underneath — `postCommand`, the pending/ack store,
// and `useConfirm` — so "dismissal performs nothing" means the literal thing the
// requirement says: no envelope left the webview.
//
// The offer matrix is four columns, not the three in the quickstart table. Restore
// is the fourth, and it is the one whose requirement (FR-019, "only when viewing
// history") is a *negative* everywhere the operator normally is. A three-column
// matrix would pass forever with Restore wired to every row.
//
// Wire constants are bound into `WIRE` rather than referenced inline, for the same
// reason feature 100's suite does it: `tests/lint/catalog-lifecycle-dispatch.test.ts`
// scans the whole webview tree — `__tests__` included — for a lifecycle constant in
// first-argument position, and `expect(...).toBe(CMD_X)` has that exact shape.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CMD_DEACTIVATE_DEFINITION,
  CMD_DISCARD_DEFINITION_DRAFT,
  CMD_PUBLISH_DEFINITION,
  CMD_RESTORE_DEFINITION_VERSION
} from '../../../lib/messages';
import type { BuilderLifecycle, DefinitionState } from '../../../lib/snapshot-types';

const WIRE = Object.freeze({
  publish: CMD_PUBLISH_DEFINITION,
  restore: CMD_RESTORE_DEFINITION_VERSION,
  deactivate: CMD_DEACTIVATE_DEFINITION,
  discardDraft: CMD_DISCARD_DEFINITION_DRAFT
});

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

interface Envelope {
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
}

type AckListener = (ack: {
  status: 'accepted' | 'rejected';
  reason?: string;
  result?: unknown;
}) => void;

const posted: Envelope[] = [];
const ackListeners = new Map<string, AckListener>();

vi.mock('../../../lib/vscode-api', () => ({
  postCommand(type: string, payload: Record<string, unknown>): { correlationId: string } {
    const correlationId = `corr-${posted.length + 1}`;
    posted.push({ type, payload, correlationId });
    return { correlationId };
  }
}));

vi.mock('../../../lib/snapshot-store.svelte', () => ({
  snapshotStore: {
    markPending(): void {},
    onceAck(id: string, fn: AckListener): () => void {
      ackListeners.set(id, fn);
      return () => ackListeners.delete(id);
    }
  }
}));

/** Every confirmation the chain raised, and the answer it was given. */
const confirmCalls: { readonly actionKey: string; readonly context: unknown }[] = [];
let confirmAnswer = true;

vi.mock('../../../lib/use-confirm', () => ({
  useConfirm(actionKey: string, options?: { context?: unknown }): Promise<boolean> {
    confirmCalls.push({ actionKey, context: options?.context });
    return Promise.resolve(confirmAnswer);
  }
}));

const DefinitionActions = (await import('../DefinitionActions.svelte')).default;
const DefinitionLifecycleRow = (await import('../DefinitionLifecycleRow.svelte')).default;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CREATED_AT = Date.parse('2026-03-01T09:15:00.000Z');
const UPDATED_AT = Date.parse('2026-03-04T18:42:30.000Z');

const DEFINITION_ID = 'ship-it';
const DEFINITION_NAME = 'Ship It';

type Action = 'publish' | 'discard-draft' | 'deactivate' | 'restore';

const ALL_ACTIONS: readonly Action[] = ['publish', 'discard-draft', 'deactivate', 'restore'];

const ACTION_LABEL: Readonly<Record<Action, string>> = Object.freeze({
  publish: 'Publish',
  'discard-draft': 'Discard draft',
  deactivate: 'Deactivate',
  restore: 'Restore this version'
});

function lifecycle(state: DefinitionState, overrides: Partial<BuilderLifecycle> = {}) {
  const activeVersionId = state === 'draft' ? undefined : 'v3';
  return Object.freeze({
    state,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    ...(activeVersionId === undefined ? {} : { activeVersionId }),
    expectedDraftVersion: state === 'active' ? 'no-draft' : 'v4',
    versions: Object.freeze([]),
    ...overrides
  }) satisfies BuilderLifecycle;
}

interface ActionsOpts {
  state?: DefinitionState;
  lifecycle?: BuilderLifecycle;
  surface?: 'row' | 'history';
  versionId?: string;
}

function renderActions(opts: ActionsOpts = {}) {
  return render(DefinitionActions, {
    props: {
      kind: 'pipeline' as const,
      definitionId: DEFINITION_ID,
      definitionName: DEFINITION_NAME,
      lifecycle: opts.lifecycle ?? lifecycle(opts.state ?? 'active-with-draft'),
      ...(opts.surface === undefined ? {} : { surface: opts.surface }),
      ...(opts.versionId === undefined ? {} : { versionId: opts.versionId })
    }
  });
}

function actionButton(
  container: HTMLElement,
  action: Action,
  handle = DEFINITION_ID
): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    `[data-testid="definition-action-${action}-${handle}"]`
  );
}

/** Let the confirmation microtask, the dispatch, and the re-render all land. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

async function click(node: HTMLElement | null): Promise<void> {
  expect(node, 'expected the action button to be rendered').not.toBeNull();
  await fireEvent.click(node as HTMLElement);
  await flush();
}

function fireAck(
  correlationId: string,
  ack: { status: 'accepted' | 'rejected'; reason?: string; result?: unknown }
): void {
  const listener = ackListeners.get(correlationId);
  expect(listener, `no ack listener registered for ${correlationId}`).toBeDefined();
  listener?.(ack);
}

beforeEach(() => {
  posted.length = 0;
  confirmCalls.length = 0;
  ackListeners.clear();
  confirmAnswer = true;
});

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// T039 — the offer matrix (FR-016 – FR-019)
// ---------------------------------------------------------------------------

describe('Feature 101 T039 — which actions a row offers (FR-016 – FR-019)', () => {
  const MATRIX: readonly { state: DefinitionState; offered: readonly Action[] }[] = [
    { state: 'draft', offered: ['publish', 'discard-draft'] },
    { state: 'active', offered: ['deactivate'] },
    { state: 'active-with-draft', offered: ['publish', 'discard-draft', 'deactivate'] }
  ];

  for (const { state, offered } of MATRIX) {
    // Every cell of the row, offered and withheld alike. Asserting only the
    // offered ones would pass on a row that offers all four.
    for (const action of ALL_ACTIONS) {
      const expected = offered.includes(action);
      it(`${state} ${expected ? 'offers' : 'withholds'} ${ACTION_LABEL[action]}`, () => {
        const { container } = renderActions({ state });
        const button = actionButton(container, action);
        if (expected) {
          expect(button, `${state} must offer ${ACTION_LABEL[action]}`).not.toBeNull();
          expect(button?.textContent?.trim()).toBe(ACTION_LABEL[action]);
        } else {
          expect(button, `${state} must not offer ${ACTION_LABEL[action]}`).toBeNull();
        }
      });
    }
  }

  it('offers Restore this version from history, and nothing else there (FR-019)', () => {
    const { container } = renderActions({
      state: 'active-with-draft',
      surface: 'history',
      versionId: 'v2'
    });
    const handle = `${DEFINITION_ID}-v2`;
    expect(actionButton(container, 'restore', handle)).not.toBeNull();
    expect(actionButton(container, 'restore', handle)?.textContent?.trim()).toBe(
      'Restore this version'
    );
    for (const action of ['publish', 'discard-draft', 'deactivate'] as const) {
      expect(
        actionButton(container, action, handle),
        `history must not offer ${ACTION_LABEL[action]}`
      ).toBeNull();
    }
  });

  it('offers Restore from history in every state, and from a row in none', () => {
    // The two halves of FR-019 as one claim: history is what decides, not state.
    for (const state of ['draft', 'active', 'active-with-draft'] as const) {
      const history = renderActions({ state, surface: 'history', versionId: 'v1' });
      expect(
        actionButton(history.container, 'restore', `${DEFINITION_ID}-v1`),
        `history must offer Restore for ${state}`
      ).not.toBeNull();
      cleanup();

      const row = renderActions({ state });
      expect(
        actionButton(row.container, 'restore'),
        `a ${state} row must never offer Restore`
      ).toBeNull();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// T039 — the gate on the two destructive actions (FR-020, FR-022, SC-003)
// ---------------------------------------------------------------------------

describe('Feature 101 T039 — the two destructive actions are gated (FR-020, FR-022)', () => {
  it('posts nothing when Discard draft is dismissed', async () => {
    confirmAnswer = false;
    const { container } = renderActions({ state: 'active-with-draft' });
    await click(actionButton(container, 'discard-draft'));

    expect(confirmCalls.map((call) => call.actionKey)).toEqual(['catalog.discard-draft']);
    expect(posted, 'a dismissed confirmation must post no command').toEqual([]);
  });

  it('posts nothing when Deactivate is dismissed', async () => {
    confirmAnswer = false;
    const { container } = renderActions({ state: 'active' });
    await click(actionButton(container, 'deactivate'));

    expect(confirmCalls.map((call) => call.actionKey)).toEqual([
      'catalog.deactivate-definition'
    ]);
    expect(posted, 'a dismissed confirmation must post no command').toEqual([]);
  });

  it('posts the discard once the confirmation is accepted', async () => {
    const { container } = renderActions({ state: 'active-with-draft' });
    await click(actionButton(container, 'discard-draft'));

    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe(WIRE.discardDraft);
    expect(posted[0]?.payload).toEqual({
      kind: 'pipeline',
      id: DEFINITION_ID,
      expectedDraftVersion: 'v4'
    });
  });

  it('posts the deactivation once the confirmation is accepted', async () => {
    const { container } = renderActions({ state: 'active' });
    await click(actionButton(container, 'deactivate'));

    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe(WIRE.deactivate);
    expect(posted[0]?.payload).toEqual({
      kind: 'pipeline',
      id: DEFINITION_ID,
      expectedDraftVersion: 'no-draft'
    });
  });

  it('tells the discard prompt which of the two losses it is (FR-030)', async () => {
    // A draft-only definition has no active version behind it, so discarding
    // removes the entry outright rather than an edit to it. The prompt says
    // different things for the two, and the flag is what picks.
    const draft = renderActions({ state: 'draft' });
    await click(actionButton(draft.container, 'discard-draft'));
    expect(confirmCalls[0]?.context).toMatchObject({
      definitionId: DEFINITION_ID,
      definitionName: DEFINITION_NAME,
      removesEntry: true
    });
    cleanup();

    confirmCalls.length = 0;
    posted.length = 0;
    const withDraft = renderActions({ state: 'active-with-draft' });
    await click(actionButton(withDraft.container, 'discard-draft'));
    expect(confirmCalls[0]?.context).toMatchObject({ removesEntry: false });
  });

  it('names the definition in the deactivate prompt, not just its id', async () => {
    const { container } = renderActions({ state: 'active' });
    await click(actionButton(container, 'deactivate'));
    expect(confirmCalls[0]?.context).toMatchObject({
      definitionName: DEFINITION_NAME,
      definitionId: DEFINITION_ID,
      kindLabel: 'Pipeline'
    });
  });

  it('reports nothing to the operator when they dismissed the prompt themselves', async () => {
    confirmAnswer = false;
    const { container } = renderActions({ state: 'active' });
    await click(actionButton(container, 'deactivate'));
    expect(
      container.querySelector(`[data-testid="definition-action-refusal-${DEFINITION_ID}"]`),
      'a declined confirmation is not a failure to report back'
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T039 — the three additive actions are ungated (FR-021, SC-003)
// ---------------------------------------------------------------------------

describe('Feature 101 T039 — the additive actions ask nothing (FR-021, SC-003)', () => {
  it('publishes with no confirmation', async () => {
    const { container } = renderActions({ state: 'active-with-draft' });
    await click(actionButton(container, 'publish'));

    expect(confirmCalls, 'Publish is additive and must not be gated').toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe(WIRE.publish);
    expect(posted[0]?.payload).toEqual({
      kind: 'pipeline',
      id: DEFINITION_ID,
      expectedDraftVersion: 'v4'
    });
  });

  it('restores with no confirmation, naming the version it copies', async () => {
    const { container } = renderActions({
      state: 'active-with-draft',
      surface: 'history',
      versionId: 'v2'
    });
    await click(actionButton(container, 'restore', `${DEFINITION_ID}-v2`));

    expect(confirmCalls, 'Restore only writes a draft and must not be gated').toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe(WIRE.restore);
    expect(posted[0]?.payload).toEqual({
      kind: 'pipeline',
      id: DEFINITION_ID,
      expectedDraftVersion: 'v4',
      fromVersionId: 'v2'
    });
  });

  it('leaves all three additive senders ungated in the one module that could gate them', () => {
    // The third additive action — a package publish — is raised by the import
    // flow, not by a definition row, so it has no button here to click. Its half
    // of FR-021 is still assertable in the only place a gate could be added: the
    // sender. Behaviour for all four ungated operations is covered in
    // `lib/__tests__/catalog-lifecycle.test.ts`; this pins that a confirmation
    // cannot be slipped into one of them without turning something red.
    const source = readFileSync(resolve(__dirname, '../../../lib/catalog-lifecycle.ts'), 'utf8');

    function bodyOf(name: string): string {
      const start = source.search(new RegExp(`export (async )?function ${name}\\b`));
      expect(start, `expected ${name} to be exported from catalog-lifecycle.ts`).toBeGreaterThan(
        -1
      );
      const rest = source.slice(start);
      const next = rest.slice(1).search(/\nexport [a-z]/);
      return next < 0 ? rest : rest.slice(0, next + 1);
    }

    for (const additive of [
      'publishDefinition',
      'restoreDefinitionVersion',
      'publishDefinitionPackage'
    ]) {
      expect(
        bodyOf(additive),
        `${additive} is additive (FR-021) and must not raise a confirmation`
      ).not.toContain('useConfirm(');
    }

    // The complement, so the check above cannot pass by finding nothing anywhere.
    for (const gated of ['deactivateDefinition', 'discardDefinitionDraft']) {
      expect(bodyOf(gated), `${gated} must raise a confirmation (FR-020)`).toContain(
        'useConfirm('
      );
    }
  });
});

// ---------------------------------------------------------------------------
// T040 — a refused publish reports every defect at once (FR-023)
// ---------------------------------------------------------------------------

describe('Feature 101 T040 — a refused publish reports all defects (FR-023)', () => {
  const DEFECTS = [
    {
      kind: 'pipeline',
      id: DEFINITION_ID,
      field: 'phaseIds[0]',
      code: 'unknown-phase',
      message: 'No active Phase named lint-it.'
    },
    {
      kind: 'pipeline',
      id: DEFINITION_ID,
      field: 'phaseIds[1]',
      code: 'unknown-phase',
      message: 'No active Phase named type-it.'
    },
    {
      kind: 'pipeline',
      id: DEFINITION_ID,
      field: 'phaseIds[2]',
      code: 'unknown-phase',
      message: 'No active Phase named ship-it-good.'
    }
  ] as const;

  const REFUSAL = {
    reason: 'validation-failed',
    current: {
      kind: 'pipeline',
      id: DEFINITION_ID,
      state: 'active-with-draft',
      draftVersionId: 'v4',
      activeVersionId: 'v3',
      expectedDraftVersion: 'v4'
    },
    legalActions: ['save-draft', 'publish', 'deactivate', 'restore', 'discard-draft'],
    defects: DEFECTS
  };

  async function publishAndRefuse(container: HTMLElement): Promise<void> {
    await click(actionButton(container, 'publish'));
    expect(posted).toHaveLength(1);
    fireAck(posted[0]!.correlationId, {
      status: 'rejected',
      reason: 'validation-failed',
      result: REFUSAL
    });
    await flush();
  }

  it('reports every defect together, not the first one', async () => {
    const { container } = renderActions({ state: 'active-with-draft' });
    await publishAndRefuse(container);

    const panel = container.querySelector(
      `[data-testid="definition-action-refusal-${DEFINITION_ID}"]`
    );
    expect(panel, 'a refused publish must report back').not.toBeNull();
    const text = panel?.textContent ?? '';
    for (const defect of DEFECTS) {
      expect(text, `defect ${defect.field} must be reported`).toContain(defect.message);
      expect(text, `defect ${defect.field} must say where it is`).toContain(defect.field);
    }
    // Three defects, one report — not one defect, fix, publish again.
    expect(panel?.querySelectorAll('[data-testid^="definition-action-defect-"]')).toHaveLength(
      DEFECTS.length
    );
  });

  it('posts nothing further and leaves the row Active at its prior version', async () => {
    const { container } = render(DefinitionLifecycleRow, {
      props: {
        kind: 'pipeline' as const,
        definitionId: DEFINITION_ID,
        definitionName: DEFINITION_NAME,
        lifecycle: lifecycle('active-with-draft'),
        validity: 'effective' as const,
        defects: []
      }
    });

    await publishAndRefuse(container);

    expect(posted, 'a refusal is not a retry').toHaveLength(1);
    expect(
      container
        .querySelector(`[data-testid="definition-row-active-version-${DEFINITION_ID}"]`)
        ?.textContent?.trim()
    ).toBe('v3');
    expect(
      container
        .querySelector(`[data-testid="definition-row-state-${DEFINITION_ID}"]`)
        ?.textContent?.trim()
    ).toBe('Active with draft');
  });

  it('clears the previous refusal when the next attempt is accepted', async () => {
    const { container } = renderActions({ state: 'active-with-draft' });
    await publishAndRefuse(container);
    expect(
      container.querySelector(`[data-testid="definition-action-refusal-${DEFINITION_ID}"]`)
    ).not.toBeNull();

    await click(actionButton(container, 'publish'));
    fireAck(posted[1]!.correlationId, { status: 'accepted' });
    await flush();

    expect(
      container.querySelector(`[data-testid="definition-action-refusal-${DEFINITION_ID}"]`),
      'a stale refusal describes a state the definition is no longer in'
    ).toBeNull();
  });

  it('reports a refusal that carries no defect list without inventing one', async () => {
    const { container } = renderActions({ state: 'active-with-draft' });
    await click(actionButton(container, 'publish'));
    fireAck(posted[0]!.correlationId, { status: 'rejected', reason: 'stale-draft' });
    await flush();

    const panel = container.querySelector(
      `[data-testid="definition-action-refusal-${DEFINITION_ID}"]`
    );
    expect(panel, 'every refusal reaches the operator, defects or not').not.toBeNull();
    expect(panel?.querySelectorAll('[data-testid^="definition-action-defect-"]')).toHaveLength(0);
    expect(panel?.textContent ?? '').not.toContain('undefined');
  });
});
