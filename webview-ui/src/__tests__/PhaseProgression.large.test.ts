import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import PhaseProgression from '../components/PhaseProgression.svelte';
import type { PhaseTile } from '../lib/snapshot-types';

// Feature 093 (T080) — lifecycle controls are queue-addressed, so the component
// under test needs the queue whose Run it acts on.
const TEST_QUEUE_ID = 'q-alpha';

afterEach(() => cleanup());

function makeTile(name: string, order: number, state: PhaseTile['state'] = 'not-started'): PhaseTile {
  return Object.freeze({
    name,
    order,
    state,
    iteration: 0,
    lastResult: null,
    elapsedMs: 0,
    subProgress: null,
    loopable: false
  });
}

function makePipeline(count: number): readonly PhaseTile[] {
  const ids = Array.from({ length: count }, (_, i) => `phase-${i + 1}`);
  return Object.freeze(ids.map((id, idx) => makeTile(id, idx + 1)));
}

describe('PhaseProgression — large pipelines (T047, US3, SC-005)', () => {
  it('renders all 15 tiles in the DOM for a 15-phase pipeline', () => {
    const phases = makePipeline(15);
    const { container } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID, phases, activeFeature: null, activePipeline: null }
    });
    const tiles = container.querySelectorAll('[data-testid^="phase-progression-phase-"]');
    expect(tiles.length).toBe(15);
    for (let i = 1; i <= 15; i++) {
      expect(
        container.querySelector(`[data-testid="phase-progression-phase-${i}"]`),
        `phase-${i} tile must be in DOM`
      ).not.toBeNull();
    }
  });

  it('marks the container with data-large-pipeline="true" when phases.length >= 10', () => {
    const phases = makePipeline(12);
    const { container } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID, phases, activeFeature: null, activePipeline: null }
    });
    const list = container.querySelector('[data-testid="phase-progression-list"]');
    expect(list).not.toBeNull();
    expect(list!.getAttribute('data-large-pipeline')).toBe('true');
  });

  it('marks the container with data-large-pipeline="false" when phases.length < 10', () => {
    const phases = makePipeline(7);
    const { container } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID, phases, activeFeature: null, activePipeline: null }
    });
    const list = container.querySelector('[data-testid="phase-progression-list"]');
    expect(list).not.toBeNull();
    expect(list!.getAttribute('data-large-pipeline')).toBe('false');
  });

  it('has overflow-y: auto styling on .phase-progression-large in the component CSS', () => {
    const src = readFileSync(
      resolve(__dirname, '../components/PhaseProgression.svelte'),
      'utf8'
    );
    const styleMatch = src.match(/<style[^>]*>([\s\S]*?)<\/style>/);
    const style = styleMatch ? styleMatch[1] : '';
    expect(style).toMatch(/\.phase-progression-large\s*\{[^}]*overflow-y:\s*auto/);
  });

  it('surfaces the activePipeline.name in the header when set and not "standard"', () => {
    const phases = makePipeline(5);
    const { container } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases,
        activeFeature: { id: 'f-1', label: 'My feature', startedAt: '2026-05-10T00:00:00.000Z' },
        activePipeline: { id: 'security', name: 'Security Audit' }
      }
    });
    const header = container.querySelector('[data-testid="dashboard-phase-progression-header"]');
    expect(header).not.toBeNull();
    expect(header!.textContent).toContain('Pipeline: Security Audit');
  });

  it('hides the pipeline suffix when activePipeline is null or "standard"', () => {
    const phases = makePipeline(5);
    const { container } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID, phases, activeFeature: null, activePipeline: null }
    });
    const header = container.querySelector('[data-testid="dashboard-phase-progression-header"]');
    expect(header!.textContent).not.toContain('Pipeline:');
    cleanup();
    const { container: c2 } = render(PhaseProgression, {
      props: { queueId: TEST_QUEUE_ID,
        phases,
        activeFeature: null,
        activePipeline: { id: 'standard', name: 'Standard' }
      }
    });
    const header2 = c2.querySelector('[data-testid="dashboard-phase-progression-header"]');
    expect(header2!.textContent).not.toContain('Pipeline:');
  });
});
