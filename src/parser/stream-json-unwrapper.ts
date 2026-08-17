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
  let rawText = '';
  let partialTrailingBuffer = '';
  let sawAnyLine = false;

  let hasModelText = false;
  let unwrapped = '';
  let apiError: ApiErrorMetadata | null = null;

  // Lines are consumed as they are parsed rather than collected first.
  // Holding every parsed object from the whole stream simultaneously made
  // peak heap a multiple of the retained buffer, which is what made the
  // stream cap a memory decision instead of a retention one.
  const processLine = (line: unknown): void => {
    if (line === null || typeof line !== 'object') return;
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
      // `return` rather than the former loop's `continue`: a record typed
      // 'assistant' is never also an item_completed, so skipping the rest
      // of this line is what the original control flow did.
      if (!message || !Array.isArray(message.content)) return;
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
  };

  for (const chunk of chunks) {
    // `rawText` is only ever returned when no model text was found, so it
    // stops being reachable the moment `hasModelText` flips. Releasing it
    // there keeps the common stream-json path from carrying a second full
    // copy of the stream purely as a fallback that will not be used.
    if (!hasModelText) rawText += chunk;
    const result = parseStreamJsonlBytes(chunk, partialTrailingBuffer);
    for (const line of result.parsedLines) {
      sawAnyLine = true;
      processLine(line);
    }
    partialTrailingBuffer = result.partialTrailingBuffer;
    if (hasModelText && rawText.length > 0) rawText = '';
  }

  if (partialTrailingBuffer.length > 0) {
    try {
      const line: unknown = JSON.parse(partialTrailingBuffer);
      sawAnyLine = true;
      processLine(line);
    } catch {
      // Ignore invalid JSON in trailing buffer
    }
  }

  if (!sawAnyLine) {
    return { text: rawText, apiError: null };
  }

  return {
    text: hasModelText ? unwrapped : rawText,
    apiError
  };
}
