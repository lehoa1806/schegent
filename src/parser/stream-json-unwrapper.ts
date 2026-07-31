import { parseStreamJsonlBytes } from '../services/phase-log/phase-log-jsonl-parser';

export function unwrapStreamJson(stdout: string): string {
  const { parsedLines, partialTrailingBuffer } = parseStreamJsonlBytes(stdout, '');
  const linesToProcess = [...parsedLines];

  if (partialTrailingBuffer.length > 0) {
    try {
      linesToProcess.push(JSON.parse(partialTrailingBuffer));
    } catch {
      // Ignore invalid JSON in trailing buffer
    }
  }

  if (linesToProcess.length === 0) return stdout;

  let hasAssistantText = false;
  let unwrapped = '';

  for (const line of linesToProcess) {
    if (line === null || typeof line !== 'object') continue;
    const rec = line as Record<string, unknown>;
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

  return hasAssistantText ? unwrapped : stdout;
}
