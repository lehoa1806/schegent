import { foldLegacyRun, type LegacyRunFields } from '../../../lib/__tests__/queue-runtime-fixture';
/**
 * Feature 018 — Settings UI Hover Text coverage (structural test).
 *
 * Purpose: enforce at build time that every focusable control in the
 * four Settings tabs has a description surface, and that every entry in
 * the per-tab `*_DESCRIPTIONS` map is consumed by at least one mounted
 * hoverTextAnchor. Removing a `use:hoverTextAnchor={...}` from a control,
 * or adding a description-map entry without wiring it, must fail this
 * test (FR-012). Post-2026-05-13 hover-text redirect: the predecessor's
 * sibling `(?)`-button trigger pattern is gone; the action lives on the
 * control itself.
 *
 * What we check per tab:
 *   (a) Every focusable element (`input, button, select, textarea, [tabindex]`
 *       except `tabindex="-1"`) has EITHER an `aria-describedby` pointing
 *       to an in-DOM `<p id="desc-…">` (inline mode) OR
 *       `data-hover-text-anchored="true"` on the element itself (popover mode).
 *   (b) Every description-map entry — except the explicitly-listed
 *       header-only keys used as static text in `<h2>`/`<h3>` — is
 *       reflected by at least one anchored control in the DOM. Coverage
 *       is inferred from `[id^="desc-"]` (inline) and
 *       `[data-hover-text-anchored="true"]` + `data-hover-text-controlid`
 *       (popover) markers, mapped back to description keys via a per-tab
 *       `controlIdToKey` translator.
 *
 * The describe block iterates the 4-tab table so adding a new
 * settings tab is one entry, not a copy-pasted block.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/svelte';
import type { ComponentType } from 'svelte';

import GeneralSettingsTab from '../GeneralSettingsTab.svelte';
import FatalSignaturesTab from '../FatalSignaturesTab.svelte';
// Feature 030 (US3) — QueueSettingsTab.svelte + descriptions were
// deleted alongside the multi-queue surfaces. FR-R3-145 (T1569): those
// settings became configurable again with Feature 092, but from
// QueueConfigModal.svelte rather than from a Settings sub-tab, so the
// deleted tab is still absent and the table below still iterates the
// tabs that exist.

import { GENERAL_SETTINGS_DESCRIPTIONS } from '../GeneralSettingsTab.descriptions';
import { FATAL_SIGNATURES_DESCRIPTIONS } from '../FatalSignaturesTab.descriptions';

import type {
  GeneralSettings,
  WorkflowSnapshot
} from '../../../lib/snapshot-types';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';

// ── Snapshot fixtures ──────────────────────────────────────────────────

function buildBaseSnapshot(overrides: Partial<WorkflowSnapshot> & LegacyRunFields = {}): WorkflowSnapshot {
  const { status, activeFeature, phases, liveActivity, workflowElapsedMs, ...rest } = overrides;
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    // Feature 092 — the v3 root run singulars now hang off the queue that owns
    // the Run. `foldLegacyRun` performs that fold, so the call sites below keep
    // their v3 wording.
    queues: foldLegacyRun({
      status: status ?? 'idle',
      activeFeature: activeFeature ?? null,
      phases: phases ?? (Object.freeze([])),
      liveActivity: liveActivity ?? (Object.freeze({
      summary: null,
      category: null,
      lastEventAt: null,
      freshness: 'idle',
      staleSeconds: null
      })),
      workflowElapsedMs: workflowElapsedMs ?? null
    }),
    queue: Object.freeze({
      orderedItems: [],
      inFlight: null,
      pending: Object.freeze([]),
      recent: Object.freeze([]),
      paused: false,
      queues: Object.freeze([])
    }),
    auditTail: Object.freeze([]),
    monitor: null,
    history: Object.freeze([]),
    producedAt: '2026-05-13T00:00:00.000Z',
    availablePipelines: Object.freeze([]),
    availablePhases: Object.freeze([]),
    availableModels: Object.freeze([]),
    ...rest
  }) as unknown as unknown as WorkflowSnapshot;
}

function snapshotWithGeneralSettings(): WorkflowSnapshot {
  const generalSettings: GeneralSettings = {
    ...IDLE_GENERAL_SETTINGS,
    // Force at least one operator fatal signature row so the dynamic
    // operator-input / operator-remove hover-texts mount on FatalSignaturesTab.
    fatalSignatures: Object.freeze(['SAMPLE_FATAL_TOKEN']) as readonly string[]
  };
  return buildBaseSnapshot({ generalSettings });
}

// Feature 030 (US3) — `snapshotWithQueues` removed alongside the deleted
// QueueSettingsTab.svelte. The queue-related hover-text fixtures are no
// longer needed.


// ── Per-tab table (T036 parameterization) ──────────────────────────────

interface TabSpec {
  readonly name: string;
  readonly component: ComponentType;
  readonly buildProps: () => Record<string, unknown>;
  /**
   * Additional prop builders used by the orphan-coverage assertion only.
   * Tabs with mutually-exclusive surfaces declare each variant here so
   * the union of mounts covers every description-map entry.
   */
  readonly alternateProps?: ReadonlyArray<() => Record<string, unknown>>;
  /**
   * Description-map keys that are intentionally NOT wired with a
   * hover-text anchor — they are used as static text in `<h2>` /
   * `<h3>` / `<p>` headers. Excluded from the orphan check.
   */
  readonly headerOnlyKeys: readonly string[];
  /**
   * Keys (after the prefix and dynamic-suffix translation) that this tab
   * expects to see exercised by mounting. All other keys in the map must
   * also appear here.
   */
  readonly descriptionKeys: readonly string[];
  /**
   * Translate a DOM controlId (the value of `data-hover-text-controlid`
   * or the suffix on `id="desc-…"`) back to its description-map key.
   * For dynamic per-row hover-texts (e.g. `fatal-operator-input-0` →
   * `operator-input`) the strip-suffix logic lives here.
   */
  readonly controlIdToKey: (controlId: string) => string | null;
}

const TAB_SPECS: readonly TabSpec[] = [
  {
    name: 'GeneralSettingsTab',
    component: GeneralSettingsTab as unknown as ComponentType,
    buildProps: () => ({ snapshot: snapshotWithGeneralSettings() }),
    headerOnlyKeys: ['tab-header'],
    descriptionKeys: Object.keys(GENERAL_SETTINGS_DESCRIPTIONS),
    controlIdToKey: (id) => (id in GENERAL_SETTINGS_DESCRIPTIONS ? id : null)
  },
  {
    name: 'FatalSignaturesTab',
    component: FatalSignaturesTab as unknown as ComponentType,
    buildProps: () => ({ snapshot: snapshotWithGeneralSettings() }),
    headerOnlyKeys: ['tab-header', 'built-in-section-header', 'operator-section-header'],
    descriptionKeys: Object.keys(FATAL_SIGNATURES_DESCRIPTIONS),
    controlIdToKey: (id) => {
      // Static buttons map fatal-add → operator-add, etc.
      if (id === 'fatal-add') return 'operator-add';
      if (id === 'fatal-save') return 'operator-save';
      if (id === 'fatal-reset') return 'operator-reset';
      // Dynamic per-row: fatal-operator-input-<N>, fatal-operator-remove-<N>.
      if (/^fatal-operator-input-\d+$/.test(id)) return 'operator-input';
      if (/^fatal-operator-remove-\d+$/.test(id)) return 'operator-remove';
      return null;
    }
  }
  // Feature 030 (US3) — QueueSettingsTab entry removed alongside the
  // deleted component. The WakeUpTab entry was removed with the Wake-up
  // capability. The 4-tab parameterized table is now a 2-tab table
  // (General, FatalSignatures).
] as const;

// ── Helpers ────────────────────────────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'input, button, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Resolve a focusable control's described status under the 2026-05-13
 * hover-text redirect:
 *   - `inline`  → has `aria-describedby` pointing at an in-DOM
 *                 `<p id="desc-…">` sibling (action's inline branch).
 *   - `popover` → has `data-hover-text-anchored="true"` on the element
 *                 itself (action's popover branch).
 *   - `none`    → not described.
 */
function describedStatus(el: Element, container: ParentNode): 'inline' | 'popover' | 'none' {
  const ariaDescribedBy = el.getAttribute('aria-describedby');
  if (ariaDescribedBy) {
    // FR-R3-127 — `CSS` is not defined in this test environment, and this branch had
    // never run: no control in either tab used `aria-describedby` until the privacy
    // profile buttons did, so the helper crashed rather than reporting. A latent
    // bug that only a new inline description could reveal.
    //
    // `getElementById`-by-hand rather than a polyfill: the ids here are authored
    // constants, and escaping is only needed for ids this project does not produce.
    const target = Array.from(container.querySelectorAll('[id]')).find(
      (node) => node.getAttribute('id') === ariaDescribedBy
    ) ?? null;
    if (target && target.tagName.toLowerCase() === 'p') return 'inline';
  }
  if (el.getAttribute('data-hover-text-anchored') === 'true') return 'popover';
  return 'none';
}

afterEach(() => cleanup());

// ── Parameterized suite (T036) ─────────────────────────────────────────

describe.each(TAB_SPECS)('Feature 018 — hover-text coverage on $name', (spec) => {
  it('every focusable control has either `aria-describedby` (inline) or `data-hover-text-anchored="true"` (popover)', () => {
    const { container } = render(spec.component, { props: spec.buildProps() });
    const focusable = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    expect(focusable.length, 'tab mounted no focusable controls').toBeGreaterThan(0);

    const uncovered: string[] = [];
    for (const el of focusable) {
      const status = describedStatus(el, container);
      if (status === 'none') {
        uncovered.push(
          `<${el.tagName.toLowerCase()} data-testid="${el.getAttribute('data-testid') ?? '∅'}" ` +
            `id="${el.getAttribute('id') ?? '∅'}"> has neither aria-describedby nor data-hover-text-anchored — wire use:hoverTextAnchor or add inline description`
        );
      }
    }
    expect(uncovered, `controls missing description: ${uncovered.join(', ')}`).toEqual([]);
  });

  it('every description-map entry (excluding header-only keys) is rendered at least once', () => {
    // Union the seen-keys set across the primary fixture plus any
    // alternate fixtures the spec declares. Mutually-exclusive surfaces
    // require this.
    const seenControlIds = new Set<string>();
    const builders = [spec.buildProps, ...(spec.alternateProps ?? [])];
    for (const buildProps of builders) {
      const { container } = render(spec.component, { props: buildProps() });
      container
        .querySelectorAll<HTMLElement>('[data-hover-text-anchored="true"]')
        .forEach((el) => {
          const v = el.getAttribute('data-hover-text-controlid');
          if (v) seenControlIds.add(v);
        });
      container.querySelectorAll<HTMLElement>('p[id^="desc-"]').forEach((p) => {
        const id = p.getAttribute('id');
        if (id) seenControlIds.add(id.slice('desc-'.length));
      });
      cleanup();
    }

    // Map each seen controlId back to its description key.
    const seenKeys = new Set<string>();
    for (const cid of seenControlIds) {
      const key = spec.controlIdToKey(cid);
      if (key) seenKeys.add(key);
    }

    const orphanKeys: string[] = [];
    for (const key of spec.descriptionKeys) {
      if (spec.headerOnlyKeys.includes(key)) continue;
      if (!seenKeys.has(key)) orphanKeys.push(key);
    }
    expect(
      orphanKeys,
      `description keys not rendered by ${spec.name}: ${orphanKeys.join(', ')} — wire use:hoverTextAnchor for each`
    ).toEqual([]);
  });

  it('every controlId seen in DOM maps to a real description-map key', () => {
    // Defense in depth: if an anchor is mounted with a controlId that
    // does NOT translate to a known description key, we have a dangling
    // surface — fail the test so the wiring is fixed.
    const { container } = render(spec.component, { props: spec.buildProps() });
    const danglingControlIds: string[] = [];
    container
      .querySelectorAll<HTMLElement>('[data-hover-text-anchored="true"]')
      .forEach((el) => {
        const v = el.getAttribute('data-hover-text-controlid');
        if (!v) return;
        if (spec.controlIdToKey(v) === null) danglingControlIds.push(v);
      });
    container.querySelectorAll<HTMLElement>('p[id^="desc-"]').forEach((p) => {
      const id = p.getAttribute('id');
      if (!id) return;
      const controlId = id.slice('desc-'.length);
      if (spec.controlIdToKey(controlId) === null) danglingControlIds.push(controlId);
    });
    expect(
      danglingControlIds,
      `controlIds without description-map keys: ${danglingControlIds.join(', ')}`
    ).toEqual([]);
  });
});

// ── Feature 019 T028: runtime-log control hover-text content checks ────

describe('Feature 019 — runtime-log hover-text content & anchor coverage', () => {
  function collectAnchoredControlIds(): Set<string> {
    const { container } = render(GeneralSettingsTab as unknown as ComponentType, {
      props: { snapshot: snapshotWithGeneralSettings() }
    });
    const ids = new Set<string>();
    container
      .querySelectorAll<HTMLElement>('[data-hover-text-anchored="true"]')
      .forEach((el) => {
        const v = el.getAttribute('data-hover-text-controlid');
        if (v) ids.add(v);
      });
    container.querySelectorAll<HTMLElement>('p[id^="desc-"]').forEach((p) => {
      const id = p.getAttribute('id');
      if (id) ids.add(id.slice('desc-'.length));
    });
    return ids;
  }

  it('mounts hover-text anchors for runtimeLogLevel input + save + reset', () => {
    const seen = collectAnchoredControlIds();
    expect(seen.has('runtimeLogLevel')).toBe(true);
    expect(seen.has('runtimeLogLevel-save')).toBe(true);
    expect(seen.has('runtimeLogLevel-reset')).toBe(true);
  });

  it('mounts hover-text anchors for runtimeLogFilePath input + save + reset', () => {
    const seen = collectAnchoredControlIds();
    expect(seen.has('runtimeLogFilePath')).toBe(true);
    expect(seen.has('runtimeLogFilePath-save')).toBe(true);
    expect(seen.has('runtimeLogFilePath-reset')).toBe(true);
  });

  it('runtimeLogLevel description covers default + per-emit read semantics', () => {
    const entry = GENERAL_SETTINGS_DESCRIPTIONS['runtimeLogLevel'];
    const body = entry.body.toLowerCase();
    // Default value (per contracts/runtime-log-settings-ipc.md §6a):
    expect(body).toContain('info');
    // Severity floor semantics:
    expect(body).toContain('debug');
    expect(body).toContain('error');
    // Per-emit read semantics — no reload required.
    expect(body).toMatch(/next (log )?emission|no reload/);
  });

  it('runtimeLogFilePath description covers default + accepted formats + redaction + suppression', () => {
    const entry = GENERAL_SETTINGS_DESCRIPTIONS['runtimeLogFilePath'];
    const body = entry.body.toLowerCase();
    // Default value:
    expect(body).toContain('.schegent/syslog');
    // Accepted formats:
    expect(body).toContain('absolute path');
    expect(body).toContain('workspace-relative');
    // Traversal-rejection:
    expect(body).toContain('..');
    // Redaction guarantee:
    expect(body).toContain('redacted');
    // Suppression-clears-on-save semantics:
    expect(body).toMatch(/suppress|until you save/);
  });
});
