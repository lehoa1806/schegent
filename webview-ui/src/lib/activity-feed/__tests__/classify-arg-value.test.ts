// Feature 029 T010 — classifyArgValue: maps a tool argument value to a
// rendering classification. See specs/029-human-readable-activity-logs/
// research.md Decision 2.

import { describe, expect, it } from 'vitest';
import { classifyArgValue } from '../classify-arg-value';

describe('Feature 029 T010 — classifyArgValue', () => {
  it('classifies short single-line strings as scalar', () => {
    expect(classifyArgValue('hello', 'name').kind).toBe('scalar');
    expect(classifyArgValue('src/foo.ts', 'file_path').kind).toBe('scalar');
  });

  it('classifies multi-line strings as multiline', () => {
    const c = classifyArgValue('line 1\nline 2\nline 3', 'something');
    expect(c.kind).toBe('multiline');
    if (c.kind === 'multiline') {
      expect(c.text).toBe('line 1\nline 2\nline 3');
      expect(c.lineCount).toBe(3);
    }
  });

  it('classifies strings longer than 200 chars as multiline', () => {
    const long = 'x'.repeat(201);
    const c = classifyArgValue(long, 'note');
    expect(c.kind).toBe('multiline');
  });

  it('classifies the long-form key allowlist as multiline even when short', () => {
    for (const key of ['content', 'code', 'body', 'text', 'patch', 'diff', 'query']) {
      const c = classifyArgValue('short', key);
      expect(c.kind).toBe('multiline');
    }
  });

  it('classifies null/undefined as scalar', () => {
    expect(classifyArgValue(null, 'x').kind).toBe('scalar');
    expect(classifyArgValue(undefined as unknown as null, 'x').kind).toBe('scalar');
  });

  it('classifies numbers and booleans as scalar', () => {
    expect(classifyArgValue(42, 'count').kind).toBe('scalar');
    expect(classifyArgValue(3.14, 'ratio').kind).toBe('scalar');
    expect(classifyArgValue(true, 'enabled').kind).toBe('scalar');
    expect(classifyArgValue(false, 'disabled').kind).toBe('scalar');
  });

  it('classifies arrays as array with recursively-classified children', () => {
    const c = classifyArgValue(['a', 'b', 'c'], 'items');
    expect(c.kind).toBe('array');
    if (c.kind === 'array') {
      expect(c.items.length).toBe(3);
      for (const child of c.items) {
        expect(child.classification.kind).toBe('scalar');
      }
    }
  });

  it('caps arrays at 50 items with a truncatedAt marker', () => {
    const big = Array.from({ length: 75 }, (_, i) => `i-${i}`);
    const c = classifyArgValue(big, 'list');
    expect(c.kind).toBe('array');
    if (c.kind === 'array') {
      expect(c.items.length).toBe(50);
      expect(c.truncatedAt).toBe(75);
    }
  });

  it('classifies plain objects as object with one level of children', () => {
    const c = classifyArgValue({ a: 1, b: 'hi' }, 'obj');
    expect(c.kind).toBe('object');
    if (c.kind === 'object') {
      expect(c.children.length).toBe(2);
      expect(c.children[0].key).toBe('a');
      expect(c.children[1].key).toBe('b');
    }
  });

  it('returns scalar JSON display for deeply-nested objects beyond depth 1', () => {
    // The classifier only recurses ONE level; deeper objects fall back
    // to a JSON-string scalar representation so the renderer collapses
    // them into a single inline value rather than infinite recursion.
    const c = classifyArgValue({ outer: { inner: { leaf: 'x' } } }, 'tree');
    expect(c.kind).toBe('object');
    if (c.kind === 'object') {
      const inner = c.children[0];
      // The inner value is an object, but we don't recurse beyond one
      // level — its classification should be 'multiline' (JSON.stringify
      // produces a readable string) NOT 'object'.
      expect(inner.classification.kind).toBe('multiline');
    }
  });

  it('preserves insertion order of object keys', () => {
    const c = classifyArgValue({ z: 1, a: 2, m: 3 }, 'ord');
    if (c.kind === 'object') {
      expect(c.children.map((ch) => ch.key)).toEqual(['z', 'a', 'm']);
    }
  });
});
