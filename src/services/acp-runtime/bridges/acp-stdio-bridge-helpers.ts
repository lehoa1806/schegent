/**
 * FR-R8-02 — cohesive parsing, framing, and path-canonicalization helpers extracted from
 * `acp-stdio-bridge.ts`. Zero `vscode` or `child_process` imports.
 */
import * as path from 'node:path';
import {
  ACP_RUNTIME_LIMITS,
  type AcpBillableTokens
} from '../../../contracts/acp-runtime';
import { canonicalizePathWithTailSync } from '../../../lib/protected-path-match';
import { isSafeProviderSessionId } from '../agent-identifier';

export const MAX_BILLABLE_COST_USD = 1e12;
export const MAX_TRACKED_TERMINAL_EVENTS = 16;
export const MAX_TERMINAL_ERROR_MESSAGE_CHARS = 256;
export const MAX_OUTBOUND_TEXT_CHUNK_CHARS = 256 * 1024;
export const MAX_OUTBOUND_TEXT_CHUNK_BYTES = 1024 * 1024;
export const MAX_OUTBOUND_RAW_INPUT_BYTES = 512 * 1024;
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

const EPHEMERAL_BRIDGE_SESSION_PREFIX_RE = /^acp-(?:claude|codex|agy)-session-/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeNonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseStrictBillableTokens(raw: {
  readonly inputTokens: unknown;
  readonly outputTokens: unknown;
  readonly cacheCreationInputTokens: unknown;
  readonly cacheReadInputTokens: unknown;
}): AcpBillableTokens | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheCreationInputTokens: number | undefined;
  let cacheReadInputTokens: number | undefined;

  if (raw.inputTokens !== undefined) {
    inputTokens = safeNonNegativeInt(raw.inputTokens);
    if (inputTokens === undefined) return undefined;
  }
  if (raw.outputTokens !== undefined) {
    outputTokens = safeNonNegativeInt(raw.outputTokens);
    if (outputTokens === undefined) return undefined;
  }
  if (raw.cacheCreationInputTokens !== undefined) {
    cacheCreationInputTokens = safeNonNegativeInt(raw.cacheCreationInputTokens);
    if (cacheCreationInputTokens === undefined) return undefined;
  }
  if (raw.cacheReadInputTokens !== undefined) {
    cacheReadInputTokens = safeNonNegativeInt(raw.cacheReadInputTokens);
    if (cacheReadInputTokens === undefined) return undefined;
  }
  // Require at least one primary input/output token counter so cache-only subsets
  // (e.g. `{ cached_input_tokens: 0 }` with input/output omitted) cannot spoof a full reading.
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {})
  };
}

export function safeUsedTokens(billableTokens: AcpBillableTokens | undefined): number {
  const sum = (billableTokens?.inputTokens ?? 0) + (billableTokens?.outputTokens ?? 0);
  return Math.min(Number.MAX_SAFE_INTEGER, sum);
}

export function truncateErrorMessage(raw: string): string {
  return raw.length > MAX_TERMINAL_ERROR_MESSAGE_CHARS
    ? raw.slice(0, MAX_TERMINAL_ERROR_MESSAGE_CHARS)
    : raw;
}

export function formatBridgeCostAmount(costUsd: unknown): string | undefined {
  if (
    typeof costUsd !== 'number' ||
    !Number.isFinite(costUsd) ||
    costUsd < 0 ||
    costUsd > MAX_BILLABLE_COST_USD
  ) {
    return undefined;
  }
  const formatted = costUsd === 0 ? '0' : costUsd.toFixed(12).replace(/\.?0+$/, '');
  if (costUsd > 0 && formatted === '0') return undefined;
  return formatted;
}

function fitJsonTextPrefix(text: string, offset: number, maxJsonBytes: number): number {
  let end = Math.min(text.length, offset + MAX_OUTBOUND_TEXT_CHUNK_CHARS);
  if (end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  if (end <= offset) end = Math.min(text.length, offset + 1);
  // Fast path: even at worst-case 6x JSON escape expansion (\u001b), check serialized UTF-8 bytes.
  let slice = text.slice(offset, end);
  if (Buffer.byteLength(JSON.stringify(slice), 'utf8') <= maxJsonBytes) {
    return end;
  }
  let lo = offset + 1;
  let hi = end;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    slice = text.slice(offset, mid);
    if (Buffer.byteLength(JSON.stringify(slice), 'utf8') <= maxJsonBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  if (lo < text.length && lo > offset + 1) {
    const code = text.charCodeAt(lo - 1);
    if (code >= 0xd800 && code <= 0xdbff) lo -= 1;
  }
  return Math.max(offset + 1, lo);
}

export function chunkTextForFrame(text: string): readonly string[] {
  if (
    text.length <= MAX_OUTBOUND_TEXT_CHUNK_CHARS &&
    Buffer.byteLength(JSON.stringify(text), 'utf8') <= MAX_OUTBOUND_TEXT_CHUNK_BYTES
  ) {
    return [text];
  }
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    const end = fitJsonTextPrefix(text, offset, MAX_OUTBOUND_TEXT_CHUNK_BYTES);
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function truncateTextForJsonFrame(text: string, maxJsonBytes = MAX_OUTBOUND_TEXT_CHUNK_BYTES): string {
  if (Buffer.byteLength(JSON.stringify(text), 'utf8') <= maxJsonBytes) return text;
  const end = fitJsonTextPrefix(text, 0, maxJsonBytes);
  return text.slice(0, end);
}

export function boundRawInputForFrame(rawInput: unknown): unknown {
  if (rawInput === undefined) return undefined;
  try {
    const serialized = JSON.stringify(rawInput);
    if (typeof serialized !== 'string') return undefined;
    const bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes <= MAX_OUTBOUND_RAW_INPUT_BYTES) return rawInput;
    return { _truncated: true, originalBytes: bytes };
  } catch {
    return undefined;
  }
}

export function canonicalizeBridgeCwd(rawCwd: string): string | null {
  if (rawCwd.includes('\0')) return null;
  const resolved = path.resolve(rawCwd);
  const canonical = canonicalizePathWithTailSync(resolved);
  return canonical.ok ? canonical.canonical : null;
}

export function isValidBridgeProviderSessionId(backend: string, value: unknown): value is string {
  return (
    isSafeProviderSessionId(value) &&
    !value.startsWith(`acp-${backend}-session-`) &&
    !EPHEMERAL_BRIDGE_SESSION_PREFIX_RE.test(value)
  );
}

export function renderPromptBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const parts: string[] = [];
  for (const raw of blocks as readonly unknown[]) {
    if (!isRecord(raw) || typeof raw['type'] !== 'string') return null;
    if (raw['type'] === 'text') {
      if (typeof raw['text'] !== 'string') return null;
      parts.push(raw['text']);
    } else if (raw['type'] === 'resource_link') {
      if (!isNonEmptyString(raw['uri']) || !isNonEmptyString(raw['name'])) return null;
      parts.push(`[Resource Link: ${raw['name']} (${raw['uri']})]`);
    } else if (raw['type'] === 'resource') {
      const resource = raw['resource'];
      if (!isRecord(resource) || !isNonEmptyString(resource['uri']) || typeof resource['text'] !== 'string') {
        return null;
      }
      const mime = typeof resource['mimeType'] === 'string' ? ` (${resource['mimeType']})` : '';
      parts.push(`<embedded-resource uri="${resource['uri']}"${mime}>\n${resource['text']}\n</embedded-resource>`);
    } else {
      return null;
    }
  }
  const combined = parts.join('\n\n');
  if (Buffer.byteLength(combined, 'utf8') > ACP_RUNTIME_LIMITS.maxMessageBytes) return null;
  return combined;
}

