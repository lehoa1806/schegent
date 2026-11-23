// The Settings page's Failure signatures section, as the redesign's settings page has it: one
// line on what a signature does, "Your additions" as a table of texts with "Add text" under it,
// then "Built in", marked read-only, as a plain list.
//
// What stays from Feature 011 (`contracts/fatal-signatures.md`): two labelled sections, the
// built-in list drawn from the frozen registry with no control in it, and the additions as text
// inputs with an add and a remove control. What stays from Feature 018: the first line is the
// section's one-sentence description (FR-016), and each of the two headings keeps a description
// (FR-001). The mockup draws no line under a heading, so that description is the section's
// accessible description, out of sight, and the text input's description carries the three facts
// acceptance scenario 3 asks for.
//
// The list's logic has its own tests: `FatalSignaturesTab.duplicate-key.test.ts` holds the row
// key, and `components/__tests__/SettingsSurface.test.ts` the page's Save and Revert.
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';

import { FATAL_SIGNATURES } from '../../../lib/fatal-signature-registry';
import { IDLE_GENERAL_SETTINGS } from '../../../lib/snapshot-types';
import type { GeneralSettings, WorkflowSnapshot } from '../../../lib/snapshot-types';
import { INLINE_BODY_MAX_CHARS } from '../../hover-text/hover-text-types';
import { FATAL_SIGNATURES_DESCRIPTIONS } from '../FatalSignaturesTab.descriptions';
import FatalSignaturesTab from '../FatalSignaturesTab.svelte';

afterEach(cleanup);

/** The tab reads `snapshot.generalSettings` and nothing else, so the fixture carries only that. */
function snapshotWithSignatures(fatalSignatures: readonly string[]): WorkflowSnapshot {
  const generalSettings: GeneralSettings = {
    ...IDLE_GENERAL_SETTINGS,
    fatalSignatures: Object.freeze([...fatalSignatures])
  };
  return Object.freeze({
    schemaVersion: 4,
    isPrimary: true,
    generalSettings
  }) as unknown as WorkflowSnapshot;
}

/** The mockup's one row. */
const ADDITION = 'quota exceeded for project';

function mount(fatalSignatures: readonly string[] = [ADDITION]) {
  return render(FatalSignaturesTab, {
    props: { snapshot: snapshotWithSignatures(fatalSignatures) }
  });
}

describe('FatalSignaturesTab, as the redesign draws it', () => {
  it('opens with one line on what a signature does', () => {
    const { getByTestId } = mount();

    const first = getByTestId('settings-fatal-signatures-tab').firstElementChild;
    expect(first?.tagName).toBe('P');
    expect(first?.textContent).toBe(
      'Text that marks a failure as fatal, so Schegent stops retrying.'
    );
  });

  it('puts the additions before the built-in list', () => {
    const { getByTestId } = mount();

    const sections = Array.from(getByTestId('settings-fatal-signatures-tab').children)
      .filter((child) => child.tagName === 'SECTION')
      .map((section) => section.getAttribute('data-testid'));
    expect(sections).toEqual(['fatal-operator-section', 'fatal-built-in-section']);
  });

  it('heads them "Your additions" and "Built in", the second marked read-only', () => {
    const { getByRole, getByTestId } = mount();

    const additions = getByRole('heading', { level: 3, name: 'Your additions' });
    expect(additions.id).toBe('fatal-operator-heading');
    const builtIn = getByRole('heading', { level: 3, name: 'Built in read-only' });
    expect(builtIn.id).toBe('fatal-built-in-heading');
    expect(builtIn.querySelector('.tag')?.textContent).toBe('read-only');

    // Each section is named by its heading.
    expect(getByTestId('fatal-operator-section').getAttribute('aria-labelledby')).toBe(
      additions.id
    );
    expect(getByTestId('fatal-built-in-section').getAttribute('aria-labelledby')).toBe(builtIn.id);
  });

  it('draws no line under a heading, and keeps each description as its section’s own', () => {
    const { getByTestId } = mount();

    const sections = [
      ['fatal-operator-section', 'operator-section-header'],
      ['fatal-built-in-section', 'built-in-section-header']
    ] as const;
    for (const [testId, key] of sections) {
      const section = getByTestId(testId);
      expect(
        section.querySelectorAll('p:not(.sr-only)'),
        `${testId} shows no paragraph under its heading`
      ).toHaveLength(0);

      const describedBy = section.getAttribute('aria-describedby') ?? '';
      expect(describedBy, `${testId} names its description`).not.toBe('');
      const description = section.querySelector(`[id="${describedBy}"]`);
      expect(description?.textContent.trim()).toBe(FATAL_SIGNATURES_DESCRIPTIONS[key].body);
      expect(description?.classList.contains('sr-only'), 'the description is out of sight').toBe(
        true
      );
    }
  });

  it('lists the additions in a table: a "Text to match" column and a remove column', () => {
    const { getByTestId } = mount();

    const table = getByTestId('fatal-operator-list');
    const headers = Array.from(table.querySelectorAll('th')).map((th) => th.textContent.trim());
    expect(headers).toEqual(['Text to match', 'Remove']);
    expect(table.querySelector('th .sr-only')?.textContent).toBe('Remove');

    const input = getByTestId('fatal-operator-input-0') as HTMLInputElement;
    expect(input.value).toBe(ADDITION);
    expect(input.getAttribute('aria-label')).toBe('Fatal signature 1');
  });

  it('names a remove button after its row’s text, and an empty row’s by its place', async () => {
    const { getByTestId } = mount();

    expect(getByTestId('fatal-operator-remove-0').getAttribute('aria-label')).toBe(
      `Remove ${ADDITION}`
    );

    await fireEvent.click(getByTestId('fatal-add'));
    expect(getByTestId('fatal-operator-remove-1').getAttribute('aria-label')).toBe('Remove row 2');

    await fireEvent.input(getByTestId('fatal-operator-input-1'), {
      target: { value: '  rate limited  ' }
    });
    expect(getByTestId('fatal-operator-remove-1').getAttribute('aria-label')).toBe(
      'Remove rate limited'
    );
  });

  it('adds with "Add text", under the table', () => {
    const { getByTestId } = mount();

    const add = getByTestId('fatal-add');
    expect(add.textContent.trim()).toBe('Add text');
    expect(add.previousElementSibling?.classList.contains('table-wrap')).toBe(true);
  });

  it('says how to add the first one while there are none', () => {
    const { getByTestId, queryByTestId } = mount([]);

    expect(queryByTestId('fatal-operator-list')).toBeNull();
    expect(getByTestId('fatal-operator-empty').textContent.trim()).toBe(
      'No additions yet. Choose Add text to make the first one.'
    );
    expect(getByTestId('fatal-add').textContent.trim()).toBe('Add text');
  });

  it('lists the built-in registry as plain text, with no control in it', () => {
    const { getByTestId } = mount();

    const items = Array.from(getByTestId('fatal-built-in-list').querySelectorAll('li')).map(
      (item) => item.textContent
    );
    expect(items).toEqual([...FATAL_SIGNATURES]);
    expect(
      getByTestId('fatal-built-in-section').querySelectorAll(
        'input, button, select, textarea, [tabindex]'
      )
    ).toHaveLength(0);
  });
});

describe('FatalSignaturesTab, its control descriptions (Feature 018)', () => {
  it('keeps each one a popover, so none adds a line to the layout', () => {
    for (const key of ['operator-add', 'operator-input', 'operator-remove'] as const) {
      expect(
        FATAL_SIGNATURES_DESCRIPTIONS[key].body.length,
        `${key} is longer than the inline limit`
      ).toBeGreaterThan(INLINE_BODY_MAX_CHARS);
    }

    const { container } = mount();
    expect(container.querySelector('.hover-text-inline-help')).toBeNull();
  });

  it('says on the text input what acceptance scenario 3 asks the list to say', () => {
    const body = FATAL_SIGNATURES_DESCRIPTIONS['operator-input'].body;

    expect(body, 'additions add to the built-in list').toContain('add to the built-in list');
    expect(body, 'a built-in entry cannot be removed').toContain('cannot be removed');
    expect(body, 'the audit log tells the two apart').toContain('audit log');
  });

  it('warns on the remove button that the text stops counting once saved', () => {
    const body = FATAL_SIGNATURES_DESCRIPTIONS['operator-remove'].body;

    expect(body).toContain('Warning:');
    expect(body, 'built-in entries are untouched').toContain('Built-in entries');
  });

  it('associates aria-describedby and supports keyboard focus and Escape on Add text and Remove controls (W10)', async () => {
    const { getByTestId } = mount();

    const addButton = getByTestId('fatal-add');
    expect(addButton.textContent.trim()).toBe('Add text');
    expect(addButton.getAttribute('data-hover-text-anchored')).toBe('true');

    await fireEvent.focus(addButton);
    expect(addButton.getAttribute('aria-describedby')).toBe('hover-text-fatal-add');
    expect(document.getElementById('hover-text-fatal-add')?.textContent).toContain(
      FATAL_SIGNATURES_DESCRIPTIONS['operator-add'].body
    );

    await fireEvent.keyDown(addButton, { key: 'Escape' });
    expect(document.getElementById('hover-text-fatal-add')).toBeNull();
    expect(addButton.hasAttribute('aria-describedby')).toBe(false);

    const removeButton = getByTestId('fatal-operator-remove-0');
    expect(removeButton.getAttribute('data-hover-text-anchored')).toBe('true');

    await fireEvent.focus(removeButton);
    expect(removeButton.getAttribute('aria-describedby')).toBe(
      'hover-text-fatal-operator-remove-0'
    );
    expect(document.getElementById('hover-text-fatal-operator-remove-0')?.textContent).toContain(
      'Warning:'
    );

    await fireEvent.keyDown(removeButton, { key: 'Escape' });
    expect(document.getElementById('hover-text-fatal-operator-remove-0')).toBeNull();
  });
});
