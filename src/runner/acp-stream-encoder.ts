/**
 * Feature 020 BUG-004 (T089, FR-012b) — bounded coalescing JSONL encoder for live ACP
 * `AcpNormalizedEvent` display observations.
 *
 * Native ACP servers (`agy acp --stdio`) emit fine-grained `agent_message_chunk` (`message`) and
 * `agent_thought_chunk` (`status`) text deltas alongside `tool_call`, `tool_call_update`, and
 * `plan` updates. Writing one JSONL record per delta splits words across separate Phase Log cards;
 * dropping non-`message` kinds hides tool/plan/thought activity andstarves liveness monitoring.
 *
 * Zero `vscode` or `child_process` imports.
 */
import type { AcpNormalizedEvent } from '../services/phase-log/acp-live-projection';

export const MAX_COALESCED_ACP_TEXT_BYTES = 65_536;

type BufferedTextKind = 'message' | 'status';

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;

function encodeMessageLine(text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] }
  })}\n`;
}

function encodeSystemLine(subtype: 'acp-plan' | 'acp-status', summary: string): string {
  return `${JSON.stringify({
    type: 'system',
    subtype,
    summary
  })}\n`;
}

function encodeToolCallLine(event: AcpNormalizedEvent): string {
  const block: Record<string, unknown> = {
    type: 'tool_use',
    ...(event.sourceEventId !== null ? { id: event.sourceEventId } : {}),
    name: event.toolName ?? 'tool',
    ...('toolArgs' in event && event.toolArgs !== undefined ? { input: event.toolArgs } : {})
  };
  return `${JSON.stringify({
    type: 'assistant',
    message: { content: [block] }
  })}\n`;
}

function encodeToolResultLine(event: AcpNormalizedEvent): string {
  const block: Record<string, unknown> = {
    type: 'tool_result',
    ...(event.sourceEventId !== null ? { tool_use_id: event.sourceEventId } : {}),
    content: event.text ?? '',
    is_error: false
  };
  return `${JSON.stringify({
    type: 'user',
    message: { content: [block] }
  })}\n`;
}

function encodeBufferedKind(kind: BufferedTextKind, text: string): string {
  return kind === 'message' ? encodeMessageLine(text) : encodeSystemLine('acp-status', text);
}

/** Slices at most `maxBytes` UTF-8 bytes from the start of `text` without splitting a surrogate pair. */
function takeBoundedUtf8Prefix(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let low = 1;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let end = low;
  if (end > 1) {
    const lastCode = text.charCodeAt(end - 1);
    if (lastCode >= HIGH_SURROGATE_MIN && lastCode <= HIGH_SURROGATE_MAX) {
      end -= 1;
    }
  }
  return text.slice(0, end);
}

export class AcpStreamEncoder {
  private bufferedKind: BufferedTextKind | null = null;
  private bufferedText = '';

  public push(event: AcpNormalizedEvent): readonly string[] {
    if (event.origin !== 'live') {
      return [];
    }

    if (event.kind === 'message' || event.kind === 'status') {
      return this.pushStreamedText(event.kind, event.text ?? '');
    }

    const out: string[] = [...this.flush()];
    switch (event.kind) {
      case 'tool-call':
        out.push(encodeToolCallLine(event));
        break;
      case 'tool-result':
        out.push(encodeToolResultLine(event));
        break;
      case 'plan':
        out.push(encodeSystemLine('acp-plan', event.text ?? ''));
        break;
    }
    return out;
  }

  public flush(): readonly string[] {
    if (this.bufferedKind === null || this.bufferedText.length === 0) {
      this.bufferedKind = null;
      this.bufferedText = '';
      return [];
    }
    const line = encodeBufferedKind(this.bufferedKind, this.bufferedText);
    this.bufferedKind = null;
    this.bufferedText = '';
    return [line];
  }

  private pushStreamedText(kind: BufferedTextKind, incoming: string): readonly string[] {
    if (incoming.length === 0) return [];
    const out: string[] = [];

    if (this.bufferedKind !== null && this.bufferedKind !== kind) {
      out.push(...this.flush());
    }

    let remaining = incoming;
    while (remaining.length > 0) {
      const currentBytes = Buffer.byteLength(this.bufferedText, 'utf8');
      const remainingBytes = Buffer.byteLength(remaining, 'utf8');
      if (currentBytes > 0 && currentBytes + remainingBytes > MAX_COALESCED_ACP_TEXT_BYTES) {
        out.push(...this.flush());
      }

      if (Buffer.byteLength(remaining, 'utf8') > MAX_COALESCED_ACP_TEXT_BYTES) {
        const slice = takeBoundedUtf8Prefix(remaining, MAX_COALESCED_ACP_TEXT_BYTES);
        out.push(encodeBufferedKind(kind, slice));
        remaining = remaining.slice(slice.length);
        continue;
      }

      this.bufferedKind = kind;
      this.bufferedText += remaining;
      remaining = '';
    }

    out.push(...this.drainParagraphs());
    return out;
  }

  private drainParagraphs(): readonly string[] {
    if (this.bufferedKind === null || this.bufferedText.length === 0) return [];
    const out: string[] = [];
    const kind = this.bufferedKind;

    let breakIdx = this.bufferedText.indexOf('\n\n');
    while (breakIdx !== -1) {
      let cutEnd = breakIdx + 2;
      while (cutEnd < this.bufferedText.length && this.bufferedText.charCodeAt(cutEnd) === 0x0a) {
        cutEnd += 1;
      }
      const paragraph = this.bufferedText.slice(0, cutEnd);
      this.bufferedText = this.bufferedText.slice(cutEnd);
      out.push(encodeBufferedKind(kind, paragraph));
      breakIdx = this.bufferedText.indexOf('\n\n');
    }

    if (this.bufferedText.length === 0) {
      this.bufferedKind = null;
    }
    return out;
  }
}

