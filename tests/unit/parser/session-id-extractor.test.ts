import { describe, it, expect } from 'vitest';
import { extractCliSessionId } from '../../../src/parser/session-id-extractor';

describe('extractCliSessionId', () => {
  // ── happy paths ──────────────────────────────────────────────

  it('returns session_id from a top-level field in a stream-json line', () => {
    const stdout = [
      '{"type":"system","session_id":"abc-123-def-456","subtype":"init"}',
      '{"type":"text_delta","text":"Hello"}'
    ].join('\n');
    expect(extractCliSessionId(stdout)).toBe('abc-123-def-456');
  });

  it('returns session_id from an init event type', () => {
    const stdout = '{"type":"init","session_id":"sess-001"}';
    expect(extractCliSessionId(stdout)).toBe('sess-001');
  });

  it('returns the first session_id when multiple lines contain one', () => {
    const stdout = [
      '{"type":"system","session_id":"first-session"}',
      '{"type":"system","session_id":"second-session"}'
    ].join('\n');
    expect(extractCliSessionId(stdout)).toBe('first-session');
  });

  it('handles UUID-format session IDs', () => {
    const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const stdout = `{"session_id":"${uuid}","type":"system"}`;
    expect(extractCliSessionId(stdout)).toBe(uuid);
  });

  // ── nested session_id ────────────────────────────────────────

  it('extracts session_id nested inside a "conversation" object', () => {
    const stdout = '{"type":"init","conversation":{"session_id":"nested-conv-id"}}';
    expect(extractCliSessionId(stdout)).toBe('nested-conv-id');
  });

  it('extracts session_id nested inside a "session" object', () => {
    const stdout = '{"type":"init","session":{"session_id":"nested-sess-id"}}';
    expect(extractCliSessionId(stdout)).toBe('nested-sess-id');
  });

  it('prefers top-level session_id over nested', () => {
    const stdout =
      '{"type":"init","session_id":"top-level","conversation":{"session_id":"nested"}}';
    expect(extractCliSessionId(stdout)).toBe('top-level');
  });

  // ── no session_id ────────────────────────────────────────────

  it('returns null for empty string', () => {
    expect(extractCliSessionId('')).toBeNull();
  });

  it('returns null for plain text (non-stream-json) stdout', () => {
    const stdout = 'Analyzing codebase...\nReading files...\nDone.';
    expect(extractCliSessionId(stdout)).toBeNull();
  });

  it('returns null for JSON without session_id', () => {
    const stdout = '{"type":"text_delta","text":"Hello world"}';
    expect(extractCliSessionId(stdout)).toBeNull();
  });

  it('returns null for empty session_id string', () => {
    const stdout = '{"type":"init","session_id":""}';
    expect(extractCliSessionId(stdout)).toBeNull();
  });

  it('returns null for non-string session_id', () => {
    const stdout = '{"type":"init","session_id":12345}';
    expect(extractCliSessionId(stdout)).toBeNull();
  });

  it('returns null for null session_id', () => {
    const stdout = '{"type":"init","session_id":null}';
    expect(extractCliSessionId(stdout)).toBeNull();
  });

  // ── edge cases ───────────────────────────────────────────────

  it('handles mixed plain text and JSON lines', () => {
    const stdout = [
      'Initializing...',
      '{"type":"system","session_id":"mixed-id"}',
      'Processing...',
      '{"type":"text_delta","text":"result"}'
    ].join('\n');
    expect(extractCliSessionId(stdout)).toBe('mixed-id');
  });

  it('skips malformed JSON lines gracefully', () => {
    const stdout = [
      '{malformed json with session_id:"bad"}',
      '{"type":"system","session_id":"good-id"}'
    ].join('\n');
    expect(extractCliSessionId(stdout)).toBe('good-id');
  });

  it('handles \\r\\n line endings', () => {
    const stdout = '{"type":"init","session_id":"crlf-id"}\r\nother line';
    expect(extractCliSessionId(stdout)).toBe('crlf-id');
  });

  it('rejects session IDs exceeding 256 characters', () => {
    const longId = 'x'.repeat(257);
    const stdout = `{"type":"init","session_id":"${longId}"}`;
    expect(extractCliSessionId(stdout)).toBeNull();
  });

  it('accepts session IDs at the 256 character boundary', () => {
    const id256 = 'y'.repeat(256);
    const stdout = `{"type":"init","session_id":"${id256}"}`;
    expect(extractCliSessionId(stdout)).toBe(id256);
  });

  it('handles stdout with session_id deep in the output', () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      `{"type":"text_delta","text":"chunk ${i}"}`
    );
    lines.push('{"type":"system","session_id":"deep-session"}');
    expect(extractCliSessionId(lines.join('\n'))).toBe('deep-session');
  });

  it('returns null for very short input (fast path)', () => {
    expect(extractCliSessionId('x')).toBeNull();
    expect(extractCliSessionId('{}')).toBeNull();
  });

  it('session_id substring in a non-JSON context does not parse', () => {
    // The sigil check passes but JSON.parse fails — should return null
    const stdout = 'session_id is mentioned in plain text but not JSON';
    expect(extractCliSessionId(stdout)).toBeNull();
  });
});
