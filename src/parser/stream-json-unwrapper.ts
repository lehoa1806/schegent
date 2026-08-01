import { parseStreamJsonlBytes } from '../services/phase-log/phase-log-jsonl-parser';
import type { ZippedStreamBuffer } from '../runner/zipped-stream-buffer';

export interface ApiErrorMetadata {
  readonly isError: boolean;
  readonly terminalReason?: string;
  readonly errors?: string[];
}

export interface UnwrappedStream {
  readonly text: string;
  readonly apiError: ApiErrorMetadata | null;
}

export function unwrapStreamJson(stdout: ZippedStreamBuffer | string): UnwrappedStream {
  const chunks: Iterable<string> =
    typeof stdout === 'string' ? [stdout] : stdout.decompressStream();
  const linesToProcess: unknown[] = [];
  let rawText = '';
  let partialTrailingBuffer = '';
  for (const chunk of chunks) {
    rawText += chunk;
    const result = parseStreamJsonlBytes(chunk, partialTrailingBuffer);
    linesToProcess.push(...result.parsedLines);
    partialTrailingBuffer = result.partialTrailingBuffer;
  }

  if (partialTrailingBuffer.length > 0) {
    try {
      linesToProcess.push(JSON.parse(partialTrailingBuffer));
    } catch {
      // Ignore invalid JSON in trailing buffer
    }
  }

  let hasModelText = false;
  let unwrapped = '';
  let apiError: ApiErrorMetadata | null = null;

  if (linesToProcess.length === 0) {
    return { text: rawText, apiError: null };
  }

  for (const line of linesToProcess) {
    if (line === null || typeof line !== 'object') continue;
    const rec = line as Record<string, unknown>;

    // Check for error metadata
    if (rec.is_error === true) {
      apiError = {
        isError: true,
        terminalReason: typeof rec.terminal_reason === 'string' ? rec.terminal_reason : undefined,
        errors: Array.isArray(rec.errors) ? rec.errors.map(String) : undefined
      };
    }

    if (rec.type === 'assistant') {
      const message = rec.message as Record<string, unknown> | undefined;
      if (!message || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'text') {
          const text = (block as Record<string, unknown>).text;
          if (typeof text === 'string') {
            unwrapped += text;
            hasModelText = true;
          }
        }
      }
    }

    // Codex `exec --json` emits completed model messages as
    // { type: "item_completed", item: { type: "agent_message", text } }.
    // Accept the older dotted spelling too so recorded transcripts from
    // earlier CLI versions remain replayable.
    // Decode the text before downstream audit-marker and issue parsing so
    // escaped newlines retain their original contract semantics.
    if (rec.type === 'item_completed' || rec.type === 'item.completed') {
      const item = rec.item as Record<string, unknown> | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        // Each completed agent message is a distinct logical block. Preserve
        // that boundary even when neither payload includes a newline so a
        // progress message cannot merge into a later audit heading/token.
        if (
          hasModelText &&
          unwrapped.length > 0 &&
          !unwrapped.endsWith('\n') &&
          !item.text.startsWith('\n')
        ) {
          unwrapped += '\n';
        }
        unwrapped += item.text;
        hasModelText = true;
      }
    }
  }

  return {
    text: hasModelText ? unwrapped : rawText,
    apiError
  };
}
