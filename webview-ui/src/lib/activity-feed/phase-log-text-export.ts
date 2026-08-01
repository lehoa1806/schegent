import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';
import { parseToolArguments } from './parse-tool-arguments';
import type { ParsedToolArgument, ToolArgumentValue } from './types';

/**
 * Convert host-sanitized display entries into the flat text used by Copy All.
 * This is presentation-only: it does not reparse raw JSONL or sanitize values.
 */
export function phaseLogEntriesToText(entries: readonly PhaseLogDisplayEntry[]): string {
  return entries.map(entryToText).join('\n');
}

function toolUseToText(entry: PhaseLogDisplayEntry, prefix: string): string {
  const lines: string[] = [`${prefix}\u25b6 ${entry.body.toolName ?? '(tool)'}`];
  const parsed = parseToolArguments(entry);
  if (!parsed.ok) {
    lines.push(parsed.rawText);
    return lines.join('\n');
  }
  for (const argument of parsed.args) {
    argumentToTextLines(argument, '  ', lines);
  }
  return lines.join('\n');
}

function argumentToTextLines(
  argument: ParsedToolArgument,
  indent: string,
  output: string[]
): void {
  const classification = argument.classification;
  if (classification.kind === 'scalar') {
    output.push(`${indent}${argument.key}: ${classification.display}`);
    return;
  }
  if (classification.kind === 'multiline') {
    output.push(`${indent}${argument.key}:`);
    for (const line of classification.text.split('\n')) {
      output.push(`${indent}  ${line}`);
    }
    return;
  }
  if (classification.kind === 'object') {
    output.push(`${indent}${argument.key}:`);
    for (const child of classification.children) {
      argumentToTextLines(child, `${indent}  `, output);
    }
    return;
  }
  if (classification.kind === 'array') {
    output.push(`${indent}${argument.key}:`);
    for (const item of classification.items) {
      argumentToTextLines(item, `${indent}  `, output);
    }
    if (classification.truncatedAt !== undefined) {
      output.push(`${indent}  \u2026 +${classification.truncatedAt - classification.items.length} more`);
    }
    return;
  }
  output.push(`${indent}${argument.key}: ${jsonOrEmpty(argument.value)}`);
}

function jsonOrEmpty(value: ToolArgumentValue): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function entryToText(entry: PhaseLogDisplayEntry): string {
  const prefix = entry.ts ? `[${entry.ts}] ` : '';
  switch (entry.kind) {
    case 'assistant-text':
      return `${prefix}${entry.body.text ?? ''}`;
    case 'tool-use':
      return toolUseToText(entry, prefix);
    case 'tool-result':
      return `${prefix}${entry.body.isError ? '[ERROR] ' : ''}${entry.body.toolResult ?? ''}`;
    case 'system':
      return `${prefix}${entry.body.systemSummary ?? entry.body.systemSubtype ?? ''}`;
    case 'result':
      return `${prefix}${entry.body.resultSummary ?? ''}`;
    case 'truncated-head':
      return `${prefix}(${entry.body.droppedEntryCount ?? 0} earlier entries hidden)`;
    case 'tail-ended':
      return `${prefix}Tail ended (${entry.body.reason ?? 'unknown'})`;
    default:
      return prefix;
  }
}
