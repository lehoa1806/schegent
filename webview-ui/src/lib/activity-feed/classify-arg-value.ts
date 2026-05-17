// Feature 029 T013 — pure classifier for tool argument values. Decides
// how the renderer should display a single arg: inline scalar, code
// block, nested object, or list. See
// specs/029-human-readable-activity-logs/research.md Decision 2.
//
// Pure function. No state, no DOM, no I/O. Safe to call from a hot
// render path and from unit tests.

import type {
  ArgValueClassification,
  ParsedToolArgument,
  ToolArgumentValue
} from './types';

const LONG_FORM_KEYS = new Set<string>([
  'content',
  'code',
  'body',
  'text',
  'patch',
  'diff',
  'query'
]);

const MULTILINE_STRING_LEN = 200;
const ARRAY_DISPLAY_CAP = 50;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

function isPlainObject(value: unknown): value is { [k: string]: ToolArgumentValue } {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function scalarDisplay(value: ToolArgumentValue): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  return safeJsonStringify(value);
}

export function classifyArgValue(
  value: ToolArgumentValue | undefined,
  key: string
): ArgValueClassification {
  if (value === undefined || value === null) {
    return { kind: 'scalar', display: scalarDisplay(value as ToolArgumentValue) };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'scalar', display: scalarDisplay(value) };
  }
  if (typeof value === 'string') {
    const isLongForm = LONG_FORM_KEYS.has(key);
    const isMultiLine = value.includes('\n');
    const isLong = value.length > MULTILINE_STRING_LEN;
    if (isMultiLine || isLong || isLongForm) {
      return {
        kind: 'multiline',
        text: value,
        lineCount: value.length === 0 ? 0 : value.split('\n').length
      };
    }
    return { kind: 'scalar', display: value };
  }
  if (Array.isArray(value)) {
    const all = value.map((child, idx): ParsedToolArgument => {
      const childKey = String(idx);
      return {
        key: childKey,
        value: child,
        classification: classifyArgValueShallow(child, childKey)
      };
    });
    if (all.length > ARRAY_DISPLAY_CAP) {
      return {
        kind: 'array',
        items: all.slice(0, ARRAY_DISPLAY_CAP),
        truncatedAt: all.length
      };
    }
    return { kind: 'array', items: all };
  }
  if (isPlainObject(value)) {
    const children: ParsedToolArgument[] = [];
    for (const [k, v] of Object.entries(value)) {
      children.push({
        key: k,
        value: v as ToolArgumentValue,
        classification: classifyArgValueShallow(v as ToolArgumentValue, k)
      });
    }
    return { kind: 'object', children };
  }
  // Fallback for unexpected shapes (functions, symbols, etc. — should
  // never happen with sanitized IPC payloads but defended anyway).
  return { kind: 'scalar', display: safeJsonStringify(value) };
}

// Single-level classifier used by `classifyArgValue` for the recursive
// step on objects/arrays. Nested objects/arrays are collapsed to a
// multiline JSON string so we never recurse beyond one level — keeps
// render cost bounded and visual depth shallow.
function classifyArgValueShallow(
  value: ToolArgumentValue | undefined,
  key: string
): ArgValueClassification {
  if (value === undefined || value === null) {
    return { kind: 'scalar', display: scalarDisplay(value as ToolArgumentValue) };
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'scalar', display: scalarDisplay(value) };
  }
  if (typeof value === 'string') {
    return classifyArgValue(value, key);
  }
  // Arrays/objects at depth > 1 → render as a JSON-formatted multiline
  // block. This keeps the visual tree shallow without losing
  // information (the operator can still inspect via the code block).
  const text = safeJsonStringify(value);
  return {
    kind: 'multiline',
    text,
    lineCount: text.length === 0 ? 0 : text.split('\n').length
  };
}
