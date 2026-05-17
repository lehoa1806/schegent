// Feature 020 T025 — \n-delimited JSONL parser with partial-trailing
// buffer. Pure function; no I/O; no sanitization. See
// specs/020-phase-level-logs/contracts/phase-log-service.md §3.

export interface ParseStreamJsonlResult {
  readonly parsedLines: unknown[];
  readonly skippedLines: number;
  readonly partialTrailingBuffer: string;
}

export function parseStreamJsonlBytes(
  bytes: string | Buffer,
  partialPrefix: string
): ParseStreamJsonlResult {
  const text = (typeof bytes === 'string' ? bytes : bytes.toString('utf8'));
  const combined = partialPrefix + text;
  const endsWithNewline = combined.length > 0 && combined.charCodeAt(combined.length - 1) === 0x0a;
  const rawLines = combined.split('\n');
  let partial = '';
  let endIdx = rawLines.length;
  if (!endsWithNewline && rawLines.length > 0) {
    partial = rawLines[rawLines.length - 1];
    endIdx -= 1;
  } else if (endsWithNewline) {
    // The trailing '\n' produces an empty final element; drop it.
    endIdx -= 1;
  }
  const parsedLines: unknown[] = [];
  let skippedLines = 0;
  for (let i = 0; i < endIdx; i += 1) {
    const line = rawLines[i];
    if (line.length === 0) continue;
    try {
      parsedLines.push(JSON.parse(line));
    } catch {
      skippedLines += 1;
    }
  }
  return { parsedLines, skippedLines, partialTrailingBuffer: partial };
}
