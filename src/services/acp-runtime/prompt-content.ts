/**
 * FR-R6-F13 (FR-007, FR-008, FR-019, NFR-002) — host prompt blocks to ACP content blocks.
 *
 * Every check runs before anything is written, in this order, so the refusal names the first
 * rule the prompt breaks:
 *   1. `invalid-input` — not a non-empty list of well-formed host blocks;
 *   2. `capability-missing` — an embedded resource without negotiated `embeddedContext`;
 *   3. `resource-inaccessible` — a resource link the host resolver does not accept (no resolver,
 *      or a resolver that throws, counts as no);
 *   4. `prompt-oversized` — the encoded content over the message bound.
 *
 * Zero `vscode` imports.
 */
import { ACP_RUNTIME_LIMITS, type NegotiatedCapabilities } from '../../contracts/acp-runtime';
import { operationAllowed } from './capability-negotiation';

export type PromptContentResult =
  | { readonly ok: true; readonly blocks: readonly Record<string, unknown>[] }
  | {
      readonly ok: false;
      readonly reason: 'invalid-input' | 'capability-missing' | 'resource-inaccessible' | 'prompt-oversized';
      readonly detail?: string;
    };

type WireBlock = Record<string, unknown>;

const EMBEDDED_CONTEXT_REQUIREMENT = 'embedded-context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toWireBlock(block: unknown): WireBlock | null {
  if (!isRecord(block)) return null;
  switch (block['type']) {
    case 'text':
      return typeof block['text'] === 'string' ? { type: 'text', text: block['text'] } : null;
    case 'resource-link':
      return isNonEmpty(block['uri']) && isNonEmpty(block['name'])
        ? { type: 'resource_link', uri: block['uri'], name: block['name'] }
        : null;
    case 'embedded-resource':
      return embeddedResource(block);
    default:
      return null;
  }
}

function embeddedResource(block: Record<string, unknown>): WireBlock | null {
  const mimeType = block['mimeType'];
  if (!isNonEmpty(block['uri']) || typeof block['text'] !== 'string') return null;
  if (mimeType !== undefined && typeof mimeType !== 'string') return null;
  const resource = { uri: block['uri'], text: block['text'] };
  return { type: 'resource', resource: mimeType === undefined ? resource : { ...resource, mimeType } };
}

function accessible(uri: string, verify: ((uri: string) => boolean) | undefined): boolean {
  if (verify === undefined) return false;
  try {
    return verify(uri) === true;
  } catch {
    return false;
  }
}

/** Validates and maps one prompt's blocks. */
export function buildPromptContent(
  blocks: unknown,
  capabilities: NegotiatedCapabilities,
  verifyResourceLink?: (uri: string) => boolean
): PromptContentResult {
  if (!Array.isArray(blocks) || blocks.length === 0) return { ok: false, reason: 'invalid-input' };
  const wire: WireBlock[] = [];
  for (const block of blocks as readonly unknown[]) {
    const mapped = toWireBlock(block);
    if (mapped === null) return { ok: false, reason: 'invalid-input' };
    wire.push(mapped);
  }
  const embeds = wire.some((block) => block['type'] === 'resource');
  if (embeds && !operationAllowed('prompt-embedded-resource', capabilities)) {
    return { ok: false, reason: 'capability-missing', detail: EMBEDDED_CONTEXT_REQUIREMENT };
  }
  for (const block of wire) {
    if (block['type'] === 'resource_link' && !accessible(String(block['uri']), verifyResourceLink)) {
      return { ok: false, reason: 'resource-inaccessible' };
    }
  }
  const encodedBytes = new TextEncoder().encode(JSON.stringify(wire)).byteLength;
  if (encodedBytes > ACP_RUNTIME_LIMITS.maxMessageBytes) return { ok: false, reason: 'prompt-oversized' };
  return { ok: true, blocks: wire };
}
