// Feature 103 (T079, US8 — FR-046) — history text renders as characters.
//
// Every string this surface shows about a past run arrived from outside the
// host: a description typed into the queue form, a queue an operator named, a
// definition and a Workflow named in a process document, and event fields
// written into the audit log by the CLI. None of it is HTML, and none of it is
// trusted to be.
//
// The lint next door pins the mechanism — no `{@html}` token in any
// `History*.svelte`. This file pins the consequence, which is the part an
// operator would notice: the characters `<img src=x onerror=...>` appear on
// screen as those characters, and no element by that name enters the document.
// Both are worth keeping, because the lint would still pass if a future render
// site reached for `innerHTML`, and a passing lint reads as safety.
//
// Three mounts rather than one, because the three render sites hold different
// text: the list row shows the preview and the queue, the detail adds the
// provenance labels, and the evidence panel shows fields the CLI wrote. A leak
// at any one of them is a leak.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import HistorySection from '../HistorySection.svelte';
import HistoryRunDetail from '../HistoryRunDetail.svelte';
import HistoryEvidencePanel from '../HistoryEvidencePanel.svelte';
import type { CatalogNames, HistoryRow } from '../../lib/history-rows';
import type { ResolveAuditPointerResult } from '../../lib/history-evidence-ipc';
import type { RunSummaryResult } from '../../lib/metrics-ipc';

// One payload per field, each carrying a different tag, so a failure names the
// field that leaked rather than "something rendered an image somewhere".
const MARKUP_DESCRIPTION = '<img src=x onerror="alert(1)"> ship the release';
const MARKUP_QUEUE = '<iframe src="javascript:alert(2)"></iframe> Release queue';
const MARKUP_DEFINITION = '<svg onload="alert(3)"></svg> Deploy pipeline';
const MARKUP_WORKFLOW = '<video onerror="alert(4)"></video> Nightly workflow';
const MARKUP_EVENT_TYPE = '<audio onerror="alert(5)"></audio>phase-completed';
const MARKUP_PHASE = '<object data="x"></object>implement';
const MARKUP_OUTCOME = '<embed src="x">completed';

/** Tags that must never exist as nodes. One per payload above. */
const INJECTED = 'img, iframe, svg, video, audio, object, embed, script';

// Not markup, and deliberately so: version ids are minted by the catalog store
// when a version is published, never carried in from a document. Making this
// one markup would test a value the surface cannot receive, and would say
// nothing about the fields it can.
const VERSION_ID = 'v7';

const DEFINITION_ID = 'deploy-pipeline';
const WORKFLOW_ID = 'nightly';
const RUN_ID = 'run-inert';

// The evidence panel resolves its own pointer on mount. Held in a mutable
// binding rather than a fixed return so the detail can be mounted with nothing
// to show while the panel's own case supplies records.
let nextEvidence: ResolveAuditPointerResult = { outcome: 'unaddressable' };

vi.mock('../../lib/history-evidence-ipc', () => ({
  resolveAuditPointer: (): Promise<ResolveAuditPointerResult> => Promise.resolve(nextEvidence)
}));

vi.mock('../../lib/metrics-ipc', () => ({
  readRunSummary: (): Promise<RunSummaryResult> =>
    Promise.resolve({ outcome: 'read', summary: null })
}));

vi.mock('../../lib/vscode-api', () => ({
  postCommand: vi.fn(() => ({ correlationId: 'history-inert-test' }))
}));

vi.mock('../../lib/snapshot-store.svelte', () => ({
  snapshotStore: { markPending: vi.fn(), onceAck: vi.fn(() => () => {}) }
}));

vi.mock('../../lib/use-confirm', () => ({ useConfirm: vi.fn(async () => true) }));

beforeEach(() => {
  nextEvidence = { outcome: 'unaddressable' };
});
afterEach(() => cleanup());

function row(overrides: Partial<HistoryRow> = {}): HistoryRow {
  return Object.freeze({
    runId: RUN_ID,
    queueId: 'release',
    queueName: MARKUP_QUEUE,
    source: 'recorded',
    status: 'completed',
    definitionId: DEFINITION_ID,
    catalogVersion: { kind: 'pipeline' as const, id: DEFINITION_ID, versionId: VERSION_ID },
    origin: { kind: 'workflow-member' as const, workflowId: WORKFLOW_ID },
    descriptionPreview: MARKUP_DESCRIPTION,
    descriptionLength: 512,
    orderingKey: '2026-05-10T12:00:42.000Z',
    startedAt: '2026-05-10T12:00:00.000Z',
    completedAt: '2026-05-10T12:00:42.000Z',
    durationMs: 42_000,
    ...overrides
  });
}

const catalogNames: CatalogNames = Object.freeze({
  pipelines: new Map([[DEFINITION_ID, MARKUP_DEFINITION]]),
  workflows: new Map([[WORKFLOW_ID, MARKUP_WORKFLOW]])
});

/** The two halves of the claim, asserted together everywhere they are made. */
function expectInert(container: HTMLElement, escaped: readonly string[]): void {
  expect(
    Array.from(container.querySelectorAll(INJECTED)).map((el) => el.tagName.toLowerCase()),
    'markup in operator text became elements'
  ).toEqual([]);
  for (const fragment of escaped) {
    expect(container.innerHTML, `expected escaped ${fragment}`).toContain(fragment);
  }
}

describe('Feature 103 T079 — history text renders inert (FR-046)', () => {
  it('list rows render description and queue name as characters', () => {
    const { container } = render(HistorySection, {
      props: { rows: [row()], isPrimary: true, catalogNames }
    });

    expectInert(container, ['&lt;img', '&lt;iframe']);
  });

  it('the detail renders description, queue and both provenance labels as characters', () => {
    const { container } = render(HistoryRunDetail, {
      props: { row: row(), onBack: () => {}, catalogNames }
    });

    expectInert(container, ['&lt;img', '&lt;iframe', '&lt;svg', '&lt;video']);
  });

  it('evidence records render the audit log’s own fields as characters', async () => {
    nextEvidence = {
      outcome: 'resolved',
      runId: RUN_ID,
      entries: [
        {
          id: 'e-1',
          timestamp: '2026-05-10T12:00:30.000Z',
          eventType: MARKUP_EVENT_TYPE,
          phase: MARKUP_PHASE,
          iteration: 1,
          outcome: MARKUP_OUTCOME
        }
      ],
      truncated: false,
      parseWarnings: 0
    };

    const { container, findByTestId } = render(HistoryEvidencePanel, {
      props: { runId: RUN_ID }
    });
    await findByTestId('history-evidence-entry-e-1');

    expectInert(container, ['&lt;audio', '&lt;object', '&lt;embed']);
  });
});
