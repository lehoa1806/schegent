import { describe, it, expect } from 'vitest';
import {
  areModelsEqual,
  initialModels,
  mergeDetectedModels,
  withModelAdded,
  withModelRemoved,
  withModelReplaced,
  withModelsDetected
} from '../PipelineBuilderEditors/model-catalog-state';

describe('initialModels', () => {
  it('seeds each backend from the configured catalog', () => {
    expect(
      initialModels({
        claude: ['claude-opus-5-5', 'claude-sonnet-5-5'],
        codex: ['gpt-5-codex'],
        agy: []
      })
    ).toEqual({
      claude: ['claude-opus-5-5', 'claude-sonnet-5-5'],
      codex: ['gpt-5-codex'],
      agy: []
    });
  });

  // "Save All Models" writes whatever this returns, so a preseed here is a
  // fabricated catalog one click away from overwriting an imported one.
  it('seeds nothing when the configured catalog is empty', () => {
    expect(initialModels({ claude: [], codex: [], agy: [] })).toEqual({
      claude: [],
      codex: [],
      agy: []
    });
  });

  it('still offers every editable backend a section when the snapshot omits the field', () => {
    expect(initialModels(undefined)).toEqual({ claude: [], codex: [], agy: [] });
  });

  it('copies rather than aliases the configured arrays', () => {
    const configured = { claude: ['claude-opus-5-5'], codex: [], agy: [] };
    const models = initialModels(configured);

    models.claude!.push('typed-by-the-operator');

    expect(configured.claude).toEqual(['claude-opus-5-5']);
  });
});

describe('mergeDetectedModels', () => {
  it('appends what is detected and not already held, in detection order', () => {
    expect(mergeDetectedModels(['a'], ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('drops a detected id the operator already has, keeping their position', () => {
    expect(mergeDetectedModels(['b', 'a'], ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
  });

  it('dedups within the detected list itself', () => {
    expect(mergeDetectedModels([], ['a', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('is a no-op when everything detected is already held', () => {
    expect(mergeDetectedModels(['a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('never reorders or removes what the operator authored', () => {
    expect(mergeDetectedModels(['z', 'y', 'x'], ['a'])).toEqual(['z', 'y', 'x', 'a']);
  });

  it('does not mutate either input', () => {
    const current = ['a'];
    const detected = ['b'];

    mergeDetectedModels(current, detected);

    expect(current).toEqual(['a']);
    expect(detected).toEqual(['b']);
  });
});

describe('withModelAdded', () => {
  it('appends a trimmed id under its own backend, leaving the others alone', () => {
    expect(withModelAdded({ claude: ['a'], agy: ['z'] }, 'claude', '  b  ')).toEqual({
      claude: ['a', 'b'],
      agy: ['z']
    });
  });

  it('starts a backend that has no entry yet', () => {
    expect(withModelAdded({ claude: [] }, 'agy', 'a')).toEqual({ claude: [], agy: ['a'] });
  });

  // `null` is how the caller knows not to clear the input box.
  it('refuses an empty or whitespace-only id', () => {
    expect(withModelAdded({ claude: [] }, 'claude', '   ')).toBeNull();
  });

  it('refuses an id the backend already holds', () => {
    expect(withModelAdded({ claude: ['a'] }, 'claude', 'a')).toBeNull();
  });

  it('allows the same id under a different backend', () => {
    expect(withModelAdded({ claude: ['a'], agy: [] }, 'agy', 'a')).toEqual({
      claude: ['a'],
      agy: ['a']
    });
  });

  it('does not mutate the catalog it was given', () => {
    const models = { claude: ['a'] };
    withModelAdded(models, 'claude', 'b');
    expect(models).toEqual({ claude: ['a'] });
  });
});

describe('withModelRemoved', () => {
  it('drops the entry at the index for that backend only', () => {
    expect(withModelRemoved({ claude: ['a', 'b'], agy: ['a'] }, 'claude', 0)).toEqual({
      claude: ['b'],
      agy: ['a']
    });
  });

  it('is inert for a backend with no entry', () => {
    const models = { claude: ['a'] };
    expect(withModelRemoved(models, 'agy', 0)).toBe(models);
  });

  it('does not mutate the catalog it was given', () => {
    const models = { claude: ['a', 'b'] };
    withModelRemoved(models, 'claude', 1);
    expect(models).toEqual({ claude: ['a', 'b'] });
  });
});

describe('withModelReplaced', () => {
  it('retypes the entry at the index for that backend only', () => {
    expect(withModelReplaced({ claude: ['a', 'b'], agy: ['a'] }, 'claude', 1, 'c')).toEqual({
      claude: ['a', 'c'],
      agy: ['a']
    });
  });

  it('is inert for a backend with no entry', () => {
    const models = { claude: ['a'] };
    expect(withModelReplaced(models, 'agy', 0, 'c')).toBe(models);
  });

  it('does not mutate the catalog it was given', () => {
    const models = { claude: ['a'] };
    withModelReplaced(models, 'claude', 0, 'c');
    expect(models).toEqual({ claude: ['a'] });
  });
});

describe('withModelsDetected', () => {
  it('folds the detected ids into that backend alone, skipping duplicates', () => {
    expect(
      withModelsDetected({ agy: ['mine', 'shared'], claude: ['a'] }, 'agy', ['shared', 'new'])
    ).toEqual({ agy: ['mine', 'shared', 'new'], claude: ['a'] });
  });

  it('leaves the backend unchanged when nothing was detected', () => {
    expect(withModelsDetected({ claude: ['a'] }, 'claude', [])).toEqual({ claude: ['a'] });
  });

  it('does not mutate the catalog it was given', () => {
    const models = { agy: ['mine'] };
    withModelsDetected(models, 'agy', ['new']);
    expect(models).toEqual({ agy: ['mine'] });
  });
});

describe('areModelsEqual (Feature 326)', () => {
  it('returns true for identical backend maps', () => {
    expect(
      areModelsEqual(
        { claude: ['a', 'b'], codex: [], agy: ['z'] },
        { claude: ['a', 'b'], codex: [], agy: ['z'] }
      )
    ).toBe(true);
  });

  it('detects added, removed, renamed, or reordered model entries', () => {
    expect(areModelsEqual({ claude: ['a', 'b'] }, { claude: ['a'] })).toBe(false);
    expect(areModelsEqual({ claude: ['a', 'b'] }, { claude: ['b', 'a'] })).toBe(false);
    expect(areModelsEqual({ claude: ['a'] }, { claude: ['b'] })).toBe(false);
    expect(areModelsEqual({ claude: ['a'], codex: ['x'] }, { claude: ['a'] })).toBe(false);
  });

  it('treats an omitted backend key the same as an empty array for that backend', () => {
    expect(areModelsEqual({ claude: ['a'], codex: [] }, { claude: ['a'] })).toBe(true);
  });

  it('uses own-property lookups so prototype property names cannot spoof equality or pollute state', () => {
    expect(areModelsEqual({ toString: ['x'] }, {})).toBe(false);
    expect(areModelsEqual({ toString: [] }, {})).toBe(true);
    expect(withModelAdded({ claude: ['a'] }, '__proto__', 'evil')).toBeNull();
    expect(withModelAdded({ claude: ['a'] }, 'constructor', 'evil')).toBeNull();
    expect(withModelRemoved({ claude: ['a'] }, 'toString', 0)).toEqual({ claude: ['a'] });
    expect(withModelReplaced({ claude: ['a'] }, 'toString', 0, 'b')).toEqual({ claude: ['a'] });
    expect(withModelsDetected({ claude: ['a'] }, 'prototype', ['b'])).toEqual({ claude: ['a'] });
  });
});
