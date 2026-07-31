import { parseStreamJsonlBytes } from '../services/phase-log/phase-log-jsonl-parser';

export interface ApiErrorMetadata {
  readonly isError: boolean;
  readonly terminalReason?: string;
  readonly errors?: string[];
}

export interface UnwrappedStream {
  readonly text: string;
  readonly apiError: ApiErrorMetadata | null;
}

export function unwrapStreamJson(stdout: string): UnwrappedStream {
  const { parsedLines, partialTrailingBuffer } = parseStreamJsonlBytes(stdout, '');
  const linesToProcess = [...parsedLines];

  if (partialTrailingBuffer.length > 0) {
    try {
      linesToProcess.push(JSON.parse(partialTrailingBuffer));
    } catch {
      // Ignore invalid JSON in trailing buffer
    }
  }

  let hasAssistantText = false;
  let unwrapped = '';
  let apiError: ApiErrorMetadata | null = null;

  if (linesToProcess.length === 0) {
    return { text: stdout, apiError: null };
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
            hasAssistantText = true;
          }
        }
      }
    }
  }

  return {
    text: hasAssistantText ? unwrapped : stdout,
    apiError
  };
}
