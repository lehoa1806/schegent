/**
 * FR-R7-15 W17 (closes remaining D11 gap): spec copy-verification parity.
 *
 * `phase-control-doc-parity.test.ts` holds the operator guide table in
 * `docs/operations/phase-task-management.md` to `lifecycle-control-ipc.ts`.
 * This test extends parity to the direct UI copy quotations inside the
 * workspace `specs/` contracts and specifications that survived the webview
 * redesign port (specs 020, 061, 063, 203, 243, and 248), while explicitly
 * classifying time-specific historical quotations (including spec 265's
 * BUG-002 record of "No phase selected" and struck pre-amendment text) as
 * historical so they are never confused with active UI contracts.
 *
 * Standalone `repo/` clones (such as the Linux container unit-tier leg) do
 * not carry the master workspace's `specs/` directory, so this suite guards
 * on `existsSync(SPECS_DIR)` and skips cleanly when the envelope is absent.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FailureRecordV1 } from '../../../../src/contracts/failure-record';
import FailureRecordPanel from '../../components/FailureRecordPanel.svelte';
import PhaseLogEmptyStates from '../../components/PhaseLogFeed/PhaseLogEmptyStates.svelte';
import PhaseLogSelectors from '../../components/PhaseLogFeed/PhaseLogSelectors.svelte';
import { makeNewPhaseDraft } from '../../components/PipelineBuilderEditors/phase-catalog-state';
import {
  ACTION_COPY,
  SUPPRESSION_CHECKBOX_LABEL,
  renderActionBody,
  type ActionKey
} from '../action-copy';
import type { FailureRecordPanelState } from '../failure-record-ipc';
import { lifecycleRefusalText } from '../lifecycle-control-ipc';
import { OFF_TARGET_TITLE } from '../phase-control-titles';
import { createPhaseLogStore } from '../phase-log-store.svelte';
import * as phaseLogIpc from '../phase-log-ipc';
import type { QueueItem, QueueProjection } from '../snapshot-types';

const SPECS_DIR = resolve(__dirname, '../../../../../specs');
const HAS_SPECS_ENVELOPE = existsSync(SPECS_DIR);

/** Read a spec artifact under the workspace `specs/` directory. */
function readSpec(relativePath: string): string {
  return readFileSync(resolve(SPECS_DIR, relativePath), 'utf8');
}

/** Remove Markdown strikethrough spans (`~~...~~`) so only active contract text remains. */
function stripStrikethrough(markdown: string): string {
  return markdown.replace(/~~[\s\S]*?~~/gu, '');
}

/** Collapse consecutive whitespace to single spaces for multiline spec prose matching. */
function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** Extract body rows of the first Markdown table following `heading`. */
function parseTableAfter(markdown: string, heading: string): readonly (readonly string[])[] {
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error(`Heading "${heading}" missing from spec`);
  const lines = markdown.slice(start).split('\n');
  const firstPipe = lines.findIndex((line) => line.startsWith('|'));
  if (firstPipe < 0) throw new Error(`No Markdown table follows "${heading}"`);
  const tableLines = lines.slice(firstPipe);
  const end = tableLines.findIndex((line) => !line.startsWith('|'));
  const bodyLines = tableLines.slice(2, end < 0 ? undefined : end);
  return bodyLines.map((line) =>
    line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
  );
}

/** Strip outer matching backticks or straight double quotes from a contract cell. */
function unquoteCell(cell: string): string {
  const active = stripStrikethrough(cell)
    .replace(/\*\([^)]*\)\*/gu, '')
    .trim();
  const backtick = /`([^`]+)`/u.exec(active);
  if (backtick) return backtick[1];
  const quoted = /"([^"]+)"/u.exec(active);
  if (quoted) return quoted[1];
  return active;
}

function makeInFlightItem(): QueueItem {
  return {
    id: 'run-1',
    label: 'active task',
    enqueuedAt: '2026-11-23T07:59:00.000Z',
    startedAt: '2026-11-23T08:00:00.000Z',
    updatedAt: '2026-11-23T08:00:00.000Z',
    completedAt: null,
    queueId: 'default',
    status: 'in-flight',
    retryCount: 0,
    lastErrorSummary: null,
    pausedReason: null,
    currentPhase: 'speckit-plan',
    currentPipelineId: 'standard',
    position: 0
  } as QueueItem;
}

function makeQueue(inFlight: QueueProjection['inFlight']): QueueProjection {
  return {
    inFlight,
    pending: [],
    recent: [],
    orderedItems: inFlight ? [inFlight] : [],
    queues: [
      {
        id: 'default',
        name: 'Default',
        position: 0,
        state: 'active',
        pauseSource: null,
        schedule: null,
        taskCount: inFlight ? 1 : 0,
        failurePolicy: 'halt-on-failure',
        failurePolicyOverride: null
      }
    ],
    paused: false
  };
}

function makeFailureRecord(issueState: FailureRecordV1['issueState']): FailureRecordV1 {
  return {
    recordVersion: 1,
    queueId: 'default',
    taskId: 'run-1',
    runId: 'run-1',
    failedAt: '2026-11-23T08:00:00.000Z',
    suffix: '0a1b2c3d',
    cause: 'last_phase_issues_remain',
    phase: 'speckit-plan',
    iteration: 1,
    iterationCap: 3,
    issueState,
    entries: [],
    omittedIssueCount: 0,
    metrics: [],
    omittedMetricCount: 0
  };
}

/**
 * Historical quotations inventory (W17):
 * These spec passages deliberately retain time-specific pre-amendment or superseded wording
 * inside dated bug reports, measurements, research notes, or struck `~~...~~` spans.
 * They are NOT active UI contracts and must remain clearly labeled as historical.
 */
const HISTORICAL_QUOTATION_INVENTORY = [
  {
    spec: '265-workflow-launch-visibility/spec.md',
    quotation: 'No phase selected',
    marker: 'BUG-002',
    reason: 'Dated 2026-11-09 BUG-002 record quoting the pre-commit-104 empty-card title'
  },
  {
    spec: '020-phase-level-logs/research.md',
    quotation: 'No in-flight phase',
    marker: 'Phase 0 Research',
    reason: 'Original research note predating commit 104 product-noun capitalization'
  },
  {
    spec: '061-phase-name-editing/bugs/BUG-001.md',
    quotation: 'Describe the phase objective here.',
    marker: '# Bug Report:',
    reason: 'Historical bug report predating BUG-017 starter-text capitalization'
  },
  {
    spec: '063-clean-all-confirmations/contracts/action-copy-table.md',
    quotation: 'Wipes all Schegent state for this workspace',
    marker: 'Authoritative for v1',
    reason:
      'v1 workspace.reset body later expanded by FR-R3-006 (multi-queue/transcript preservation); queue.clean-all and queue.clear-done bodies likewise gained {queueName}/{scheduleSummary} in feature 092'
  }
] as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.skipIf(!HAS_SPECS_ENVELOPE)(
  'W17 (D11) — current spec contract quotations match emitting webview controls',
  () => {
    it('spec 020 FR-028a unknown-tuple refusal matches phase-log-store.svelte.ts', async () => {
      const specText = normalizeWhitespace(
        stripStrikethrough(readSpec('020-phase-level-logs/spec.md'))
      );
      const match = /FR-028a[\s\S]*?"(This selection does not match [^"]+)"/u.exec(specText);
      expect(match, 'FR-028a active quotation present in spec 020').not.toBeNull();
      const specSentence = match![1];

      vi.spyOn(phaseLogIpc, 'readPhaseLog').mockResolvedValue({
        outcome: 'failure',
        reason: 'unknown-tuple'
      });
      const store = createPhaseLogStore();
      store.setSelection(
        {
          queueId: 'default',
          taskId: 'run-missing',
          pipelineId: 'standard',
          phaseId: 'speckit-plan',
          iterationN: 1
        },
        { origin: 'manual' }
      );
      await store.reload();
      expect(store.state.errorReason).toBe(specSentence);
    });

    it('spec 020 BUG-003/BUG-006 Live button caption and tooltips match PhaseLogSelectors.svelte', () => {
      const tasksText = normalizeWhitespace(
        stripStrikethrough(readSpec('020-phase-level-logs/tasks.md'))
      );
      const specText = normalizeWhitespace(
        stripStrikethrough(readSpec('020-phase-level-logs/spec.md'))
      );

      expect(specText).toContain('"Live"');
      const disabledTooltipMatch = /"(No in-flight Phase \(click to enable Live Mode\))"/u.exec(
        tasksText
      );
      const activeTooltipMatch = /"(Jump to the currently executing Phase)"/u.exec(tasksText);
      expect(disabledTooltipMatch).not.toBeNull();
      expect(activeTooltipMatch).not.toBeNull();

      const emptyRender = render(PhaseLogSelectors, {
        props: {
          snapshot: { queue: makeQueue(null), history: [] },
          selection: {
            queueId: null,
            taskId: null,
            pipelineId: null,
            phaseId: null,
            iterationN: null
          },
          iterations: [],
          onSelectQueue: vi.fn(),
          onSelectTask: vi.fn(),
          onSelectPhase: vi.fn(),
          onJumpToCurrent: vi.fn()
        }
      });
      const disabledBtn = emptyRender.getByTestId('phase-log-jump-current') as HTMLButtonElement;
      expect(disabledBtn.textContent.trim()).toBe('Live');
      expect(disabledBtn.title).toBe(disabledTooltipMatch![1]);
      cleanup();

      const activeRender = render(PhaseLogSelectors, {
        props: {
          snapshot: {
            queue: makeQueue(makeInFlightItem()),
            history: []
          },
          selection: {
            queueId: 'default',
            taskId: 'run-1',
            pipelineId: 'standard',
            phaseId: 'speckit-plan',
            iterationN: 1
          },
          iterations: [1],
          onSelectQueue: vi.fn(),
          onSelectTask: vi.fn(),
          onSelectPhase: vi.fn(),
          onJumpToCurrent: vi.fn()
        }
      });
      const activeBtn = activeRender.getByTestId('phase-log-jump-current') as HTMLButtonElement;
      expect(activeBtn.textContent.trim()).toBe('Live');
      expect(activeBtn.title).toBe(activeTooltipMatch![1]);
    });

    it('spec 020 and spec 203 empty-state card titles match PhaseLogEmptyStates.svelte', () => {
      const spec020 = normalizeWhitespace(
        stripStrikethrough(readSpec('020-phase-level-logs/spec.md'))
      );
      const spec203 = normalizeWhitespace(
        stripStrikethrough(readSpec('203-phase-log-kinds-of-nothing/spec.md'))
      );

      expect(spec020).toContain('"This Phase has not run"');
      expect(spec203).toContain('"No Phase selected"');
      expect(spec203).toContain('"This Phase has not run"');

      const noPhase = render(PhaseLogEmptyStates, {
        props: { banner: null, noPhaseSelected: true }
      });
      expect(noPhase.getByTestId('phase-log-empty-no-phase').querySelector('.title')?.textContent).toBe(
        'No Phase selected'
      );
      cleanup();

      const notRecorded = render(PhaseLogEmptyStates, {
        props: { banner: { kind: 'phase-not-recorded' } }
      });
      expect(
        notRecorded.getByTestId('phase-log-empty-phase-not-recorded').querySelector('.title')
          ?.textContent
      ).toBe('This Phase has not run');
    });

    it('spec 061 FR-014 new-Phase starter instruction matches makeNewPhaseDraft', () => {
      const spec061 = normalizeWhitespace(
        stripStrikethrough(readSpec('061-phase-name-editing/spec.md'))
      );
      const match = /FR-014[\s\S]*?'(Describe the Phase objective here\.)'/u.exec(spec061);
      expect(match, 'FR-014 active starter text present in spec 061').not.toBeNull();
      expect(makeNewPhaseDraft([]).instruction).toBe(match![1]);
    });

    it('spec 063 action-copy-table.md current contract rows, {runSummary} clause, and checkbox label match action-copy.ts', () => {
      const contract = readSpec('063-clean-all-confirmations/contracts/action-copy-table.md');
      const rows = parseTableAfter(contract, '## Authoritative copy (v1, English)');
      expect(rows.length).toBe(11);

      // Keys whose v1 bodyTemplate was later expanded by feature 092 (multi-queue) or FR-R3-006
      // (transcript preservation); their title and confirmLabel remain current contract text.
      const supersededBodyKeys = new Set<string>([
        'queue.clean-all',
        'queue.clear-done',
        'workspace.reset'
      ]);

      for (const row of rows) {
        const key = unquoteCell(row[0]) as ActionKey;
        const specTitle = unquoteCell(row[2]);
        const specBody = unquoteCell(row[3]);
        const specConfirm = unquoteCell(row[4]);

        const live = ACTION_COPY[key];
        expect(live.title, `${key} title`).toBe(specTitle);
        expect(live.confirmLabel, `${key} confirmLabel`).toBe(specConfirm);
        if (!supersededBodyKeys.has(key)) {
          expect(live.bodyTemplate, `${key} bodyTemplate`).toBe(specBody);
        }
      }

      const activeContract = stripStrikethrough(contract);
      const runSummaryMatch = /`\{runSummary\}`:[\s\S]*?If `hasActiveRun` is true:\s*`([^`]+)`/u.exec(
        activeContract
      );
      expect(runSummaryMatch, 'active {runSummary} clause present in spec 063').not.toBeNull();
      const renderedCleanAll = renderActionBody('queue.clean-all', {
        queueId: 'default',
        queueName: 'Default',
        pendingCount: 1,
        completedCount: 0,
        failedCount: 0,
        canceledCount: 0,
        inflightTitle: null,
        pauseSource: null,
        hasActiveRun: true,
        hasSchedule: false
      });
      expect(renderedCleanAll).toContain(runSummaryMatch![1]);

      const checkboxMatch = /SUPPRESSION_CHECKBOX_LABEL\s*=\s*"([^"]+)"/u.exec(contract);
      expect(checkboxMatch).not.toBeNull();
      expect(SUPPRESSION_CHECKBOX_LABEL).toBe(checkboxMatch![1]);
    });

    it('spec 243 failure-panel.md P3 answer rows and issueState lines match FailureRecordPanel.svelte', () => {
      const contract = readSpec('243-retained-failure-diagnostics/contracts/failure-panel.md');
      const rows = parseTableAfter(contract, '| Answer | Panel content |');
      const expectedByAnswer = new Map<string, string>();
      for (const row of rows) {
        const answer = unquoteCell(row[0]);
        if (answer === 'available') continue;
        expectedByAnswer.set(answer, unquoteCell(row[1]));
      }
      expect([...expectedByAnswer.keys()]).toEqual([
        'loading',
        'none',
        'expired',
        'unavailable',
        'malformed',
        'failure'
      ]);

      const address = { queueId: 'default', taskId: 'run-1' };
      const nonAvailableStates: ReadonlyArray<readonly [string, FailureRecordPanelState]> = [
        ['loading', { kind: 'loading' }],
        ['failure', { kind: 'failed' }],
        ['none', { kind: 'answer', answer: { outcome: 'none', ...address } }],
        ['expired', { kind: 'answer', answer: { outcome: 'expired', ...address } }],
        ['unavailable', { kind: 'answer', answer: { outcome: 'unavailable', ...address } }],
        ['malformed', { kind: 'answer', answer: { outcome: 'malformed', ...address, recordCount: 1 } }]
      ];

      for (const [key, state] of nonAvailableStates) {
        const { getByTestId } = render(FailureRecordPanel, {
          props: { itemId: 'run-1', label: 'Task 1', state }
        });
        expect(getByTestId('failure-record-panel-run-1').textContent.trim(), key).toBe(
          expectedByAnswer.get(key)
        );
        cleanup();
      }

      const activeContract = normalizeWhitespace(stripStrikethrough(contract));
      const issueStates: readonly FailureRecordV1['issueState'][] = [
        'none-reported',
        'unparsed',
        'not-applicable'
      ];
      for (const issueState of issueStates) {
        const re = new RegExp(`- \`${issueState}\`:\\s*\`([^\`]+)\``, 'u');
        const match = re.exec(activeContract);
        expect(match, `active ${issueState} line in spec 243`).not.toBeNull();
        const { getByTestId } = render(FailureRecordPanel, {
          props: {
            itemId: 'run-1',
            label: 'Task 1',
            state: {
              kind: 'answer',
              answer: {
                outcome: 'available',
                ...address,
                record: makeFailureRecord(issueState),
                recordCount: 1
              }
            }
          }
        });
        expect(getByTestId('failure-record-panel-run-1').textContent).toContain(match![1]);
        cleanup();
      }
    });

    it('spec 248 webview.md W3 refusal sentences and W4 OFF_TARGET_TITLE match live modules', () => {
      const contract = readSpec('248-failed-run-skip-contract/contracts/webview.md');
      const rows = parseTableAfter(contract, '## W3. Refusal sentences');
      expect(rows.length).toBe(3);

      for (const row of rows) {
        const code = unquoteCell(row[0]);
        const sentence = unquoteCell(row[2]);
        expect(lifecycleRefusalText(code), code).toBe(sentence);
      }

      const titleMatch = /export const OFF_TARGET_TITLE\s*=\s*'([^']+)'/u.exec(contract);
      expect(titleMatch, 'OFF_TARGET_TITLE present in spec 248').not.toBeNull();
      expect(OFF_TARGET_TITLE).toBe(titleMatch![1]);
    });

    it('classifies time-specific historical quotations (including spec 265 BUG-002) explicitly as historical', () => {
      expect(HISTORICAL_QUOTATION_INVENTORY.length).toBeGreaterThanOrEqual(4);

      const spec265 = readSpec('265-workflow-launch-visibility/spec.md');
      const linesQuotingOldEmptyTitle = spec265
        .split('\n')
        .filter((line) => line.includes('No phase selected'));
      expect(linesQuotingOldEmptyTitle.length).toBeGreaterThan(0);
      for (const line of linesQuotingOldEmptyTitle) {
        expect(
          line,
          'spec 265 quotes "No phase selected" strictly inside dated BUG-002 historical context'
        ).toContain('BUG-002');
      }

      for (const item of HISTORICAL_QUOTATION_INVENTORY) {
        const text = readSpec(item.spec);
        expect(text, `${item.spec} still records historical quotation`).toContain(item.quotation);
        expect(text, `${item.spec} still carries historical marker "${item.marker}"`).toContain(
          item.marker
        );
      }
    });
  }
);

