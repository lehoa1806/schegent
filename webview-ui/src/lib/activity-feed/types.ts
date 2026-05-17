// Feature 029 — UI projection types for the Activity Feed view layer.
// These types are derived at render time from sanitized
// PhaseLogDisplayEntry records — never persisted, never sent over IPC.

import type { PhaseLogDisplayEntry } from '../../../../src/services/phase-log/types';

export type ToolArgumentValue =
  | string
  | number
  | boolean
  | null
  | readonly ToolArgumentValue[]
  | { readonly [key: string]: ToolArgumentValue };

export type ArgValueClassification =
  | { kind: 'scalar'; display: string }
  | { kind: 'multiline'; text: string; lineCount: number; language?: string }
  | { kind: 'object'; children: ParsedToolArgument[] }
  | { kind: 'array'; items: ParsedToolArgument[]; truncatedAt?: number };

export interface ParsedToolArgument {
  key: string;
  value: ToolArgumentValue;
  classification: ArgValueClassification;
}

export type ParseToolArgumentsResult =
  | { ok: true; args: ParsedToolArgument[] }
  | { ok: false; rawText: string };

export type AuditFooterStatus = 'CLEAR' | 'FAILED' | 'UNKNOWN';

export interface AuditFooterMatch {
  matched: true;
  status: AuditFooterStatus;
  blockText: string;
  prefixText: string;
  suffixText: string;
}

export interface AuditFooterMiss {
  matched: false;
}

export type AuditFooterDetection = AuditFooterMatch | AuditFooterMiss;

export type MetadataKey =
  | 'cwd'
  | 'session_id'
  | 'duration_ms'
  | 'cost'
  | 'tools'
  | 'model'
  | 'num_turns'
  | 'other';

export interface MetadataLine {
  key: MetadataKey;
  rawKey: string;
  value: string;
}

export type PhaseLogEntryForRender = PhaseLogDisplayEntry;
