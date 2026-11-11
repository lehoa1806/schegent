// FR-R6-F13 T024 — host prompt blocks to ACP content blocks, refused before any write when a
// capability, resource or size rule fails (FR-007, FR-008, FR-019, NFR-002).
import { describe, expect, it } from 'vitest';

import type { NegotiatedCapabilities } from '../../../src/contracts/acp-runtime';
import { buildPromptContent } from '../../../src/services/acp-runtime/prompt-content';

const BARE: NegotiatedCapabilities = {
  protocolVersion: 1,
  loadSession: false,
  image: false,
  audio: false,
  embeddedContext: false,
  authMethodCount: 0
};
const EMBEDDED: NegotiatedCapabilities = { ...BARE, embeddedContext: true };
const MIB = 1024 * 1024;

describe('buildPromptContent', () => {
  it('maps a text block', () => {
    expect(buildPromptContent([{ type: 'text', text: 'do it' }], BARE)).toEqual({
      ok: true,
      blocks: [{ type: 'text', text: 'do it' }]
    });
  });

  it('refuses an embedded resource without embeddedContext and maps it with it', () => {
    const blocks = [{ type: 'embedded-resource', uri: 'file:///w/a.md', text: 'body', mimeType: 'text/markdown' }];
    expect(buildPromptContent(blocks, BARE)).toEqual({ ok: false, reason: 'capability-missing', detail: 'embedded-context' });
    expect(buildPromptContent(blocks, EMBEDDED)).toEqual({
      ok: true,
      blocks: [{ type: 'resource', resource: { uri: 'file:///w/a.md', text: 'body', mimeType: 'text/markdown' } }]
    });
  });

  it('maps a resource link the resolver accepts and refuses one it does not', () => {
    const blocks = [{ type: 'resource-link', uri: 'file:///w/b.md', name: 'b.md' }];
    expect(buildPromptContent(blocks, BARE, () => true)).toEqual({
      ok: true,
      blocks: [{ type: 'resource_link', uri: 'file:///w/b.md', name: 'b.md' }]
    });
    expect(buildPromptContent(blocks, BARE, () => false)).toEqual({ ok: false, reason: 'resource-inaccessible' });
    expect(buildPromptContent(blocks, BARE)).toEqual({ ok: false, reason: 'resource-inaccessible' });
  });

  it('treats a throwing resolver as inaccessible', () => {
    const blocks = [{ type: 'resource-link', uri: 'file:///w/b.md', name: 'b.md' }];
    const throwing = (): boolean => {
      throw new Error('denied');
    };
    expect(buildPromptContent(blocks, BARE, throwing)).toEqual({ ok: false, reason: 'resource-inaccessible' });
  });

  it('refuses an empty prompt and a malformed block as invalid-input', () => {
    const invalid: unknown[] = [
      [],
      'text',
      [null],
      [{ type: 'text' }],
      [{ type: 'image', data: 'AAAA' }],
      [{ type: 'resource-link', uri: '', name: 'x' }],
      [{ type: 'embedded-resource', uri: 'u', text: 3 }],
      [{ type: 'embedded-resource', uri: 'u', text: 't', mimeType: 7 }]
    ];
    for (const blocks of invalid) {
      expect(buildPromptContent(blocks, EMBEDDED, () => true)).toEqual({ ok: false, reason: 'invalid-input' });
    }
  });

  it('checks validity before capability, capability before resource access', () => {
    const embedded = { type: 'embedded-resource', uri: 'u', text: 't' };
    const link = { type: 'resource-link', uri: 'u', name: 'n' };
    expect(buildPromptContent([embedded, { type: 'text' }], BARE)).toEqual({ ok: false, reason: 'invalid-input' });
    expect(buildPromptContent([link, embedded], BARE, () => false)).toEqual({
      ok: false,
      reason: 'capability-missing',
      detail: 'embedded-context'
    });
  });

  it('refuses encoded content over 2 MiB and accepts it under', () => {
    const over = buildPromptContent([{ type: 'text', text: 'x'.repeat(2 * MIB) }], BARE);
    const under = buildPromptContent([{ type: 'text', text: 'x'.repeat(2 * MIB - 64) }], BARE);
    expect(over).toEqual({ ok: false, reason: 'prompt-oversized' });
    expect(under.ok).toBe(true);
  });
});
