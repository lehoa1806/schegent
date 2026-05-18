import {
  AUDIT_SCHEMA_VERSION,
  KNOWN_AUDIT_EVENT_TYPE_SET,
  RESERVED_METRIC_KEYS,
  type AuditEntry,
  type AuditEntryFields,
  type AuditEventType,
  type AuditOutcome
} from '../audit/audit-entry';
import type { Phase } from '../controller/phase';

const OUTCOMES: ReadonlySet<string> = new Set(['success', 'failure', 'info']);

export interface ParseAuditLineResult {
  entry: AuditEntry | null;
  warning?: string;
}

export function parseAuditLogLine(line: string): AuditEntry | null {
  return parseAuditLogLineDetailed(line).entry;
}

export function parseAuditLogLineDetailed(line: string): ParseAuditLineResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { entry: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { entry: null, warning: 'malformed JSON' };
  }
  if (!parsed || typeof parsed !== 'object') return { entry: null, warning: 'not an object' };
  const obj = parsed as Record<string, unknown>;
  const id = typeof obj.id === 'string' ? obj.id : null;
  const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;
  const runId = typeof obj.runId === 'string' ? obj.runId : null;
  // Phase ids are operator-extensible (`schegent.phases`) and the built-in
  // catalog now includes non-Speckit ids such as `bugfix-report`. The
  // structured audit reader must preserve any non-empty phase id instead of
  // pinning to the original seven-phase built-in list.
  const phase =
    typeof obj.phase === 'string' && obj.phase.trim().length > 0
      ? (obj.phase as Phase)
      : null;
  const iteration =
    typeof obj.iteration === 'number' && Number.isFinite(obj.iteration) ? obj.iteration : null;
  const eventTypeRaw = typeof obj.eventType === 'string' ? obj.eventType : null;
  const outcome =
    typeof obj.outcome === 'string' && OUTCOMES.has(obj.outcome)
      ? (obj.outcome as AuditOutcome)
      : null;
  const payload =
    obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload)
      ? (obj.payload as Record<string, unknown>)
      : null;

  if (
    !id ||
    !timestamp ||
    !runId ||
    !phase ||
    iteration === null ||
    !eventTypeRaw ||
    !outcome ||
    !payload
  ) {
    return { entry: null, warning: 'missing required field(s)' };
  }

  let warning: string | undefined;
  if (!KNOWN_AUDIT_EVENT_TYPE_SET.has(eventTypeRaw)) {
    warning = `unknown eventType "${eventTypeRaw}" — preserving record`;
  }
  const eventType = eventTypeRaw as AuditEventType;

  const persistedSchema =
    typeof obj.schemaVersion === 'number' && Number.isFinite(obj.schemaVersion)
      ? obj.schemaVersion
      : undefined;
  if (persistedSchema !== undefined && persistedSchema > AUDIT_SCHEMA_VERSION) {
    warning = `record schemaVersion ${persistedSchema} exceeds runtime ${AUDIT_SCHEMA_VERSION}`;
  }

  const correlationId = typeof obj.correlationId === 'string' ? obj.correlationId : undefined;

  const entry: AuditEntry = {
    id,
    timestamp,
    runId,
    phase,
    iteration,
    eventType,
    payload,
    outcome,
    ...(persistedSchema !== undefined ? { schemaVersion: persistedSchema } : {}),
    ...(correlationId ? { correlationId } : {})
  };

  return { entry, warning };
}

const OPEN_MARKER = '=== SCHEGENT AUDIT LOG ===';
const CLOSE_MARKER = '=== END AUDIT LOG ===';

const REQUIRED_FIELDS = [
  'phase',
  'files_created',
  'files_modified',
  'files_deleted',
  'commands_executed',
  'network_calls',
  'ruleset_switches',
  'notes'
] as const;

// Structural sub-block headings inside the SCHEGENT AUDIT LOG block. Lines
// nested under these headings are NOT captured as metrics (FR-007).
const SUBBLOCK_HEADING = /^(Open Questions|Remaining Issues|Notes|Findings):\s*$/i;

// Identifier pattern shared with the retry-condition DSL (FR-007).
const METRIC_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface AuditLogParseResult {
  entry: AuditEntryFields | null;
  warnings: string[];
}

export function parseAuditLogBlock(stdout: string): AuditLogParseResult {
  const warnings: string[] = [];
  const lines = stdout.split(/\r?\n/);
  const openIndex = lines.findIndex((line) => line.trim() === OPEN_MARKER);
  if (openIndex === -1) {
    warnings.push('[constitution] missing audit log');
    return { entry: null, warnings };
  }
  const closeIndex = lines.findIndex(
    (line, idx) => idx > openIndex && line.trim() === CLOSE_MARKER
  );
  if (closeIndex === -1) {
    warnings.push('[constitution] unterminated audit log');
    return { entry: null, warnings };
  }

  const body = lines.slice(openIndex + 1, closeIndex);
  const map = new Map<string, string>();
  const metrics = new Map<string, number>();
  const entryWarnings: string[] = [];
  const droppedReserved: string[] = [];
  let droppedNonFinite = false;
  let droppedNonNumeric = false;
  let inSubBlock = false;
  for (const raw of body) {
    const line = raw.trim();
    if (line === '') {
      inSubBlock = false;
      continue;
    }
    if (SUBBLOCK_HEADING.test(line)) {
      inSubBlock = true;
      continue;
    }
    // Sub-block body — list items under a heading. Treat as opaque.
    if (inSubBlock) continue;
    const sepIndex = line.indexOf(':');
    if (sepIndex === -1) {
      warnings.push(`[constitution] malformed audit field: ${line.slice(0, 60)}`);
      continue;
    }
    const key = line.slice(0, sepIndex).trim();
    const value = line.slice(sepIndex + 1).trim();
    map.set(key, value);
    // Metric capture — only attempt for identifiers that aren't already
    // recognized as structured fields (FR-007).
    if ((REQUIRED_FIELDS as readonly string[]).includes(key)) continue;
    if (!METRIC_IDENT_RE.test(key)) continue;
    if (RESERVED_METRIC_KEYS.has(key)) {
      droppedReserved.push(key);
      continue;
    }
    const num = parseMetricValue(value);
    if (num === undefined) {
      droppedNonNumeric = true;
      continue;
    }
    if (!Number.isFinite(num)) {
      droppedNonFinite = true;
      continue;
    }
    metrics.set(key, num); // last-occurrence wins via Map semantics
  }

  if (droppedReserved.length > 0) {
    entryWarnings.push(
      `[constitution] dropped reserved metric key(s): ${droppedReserved.join(', ')}`
    );
  }
  if (droppedNonFinite) {
    entryWarnings.push('[constitution] dropped non-finite metric value(s)');
  }
  if (droppedNonNumeric) {
    entryWarnings.push('[constitution] dropped non-numeric metric value(s)');
  }

  const missing = REQUIRED_FIELDS.filter((f) => !map.has(f));
  if (missing.length > 0) {
    warnings.push(`[constitution] audit missing fields: ${missing.join(', ')}`);
    return { entry: null, warnings };
  }

  const entry: AuditEntryFields = {
    phase: (map.get('phase') ?? 'speckit-specify') as Phase,
    filesCreated: parseList(map.get('files_created') ?? '[]', warnings, 'files_created'),
    filesModified: parseList(map.get('files_modified') ?? '[]', warnings, 'files_modified'),
    filesDeleted: parseList(map.get('files_deleted') ?? '[]', warnings, 'files_deleted'),
    commandsExecuted: parseList(map.get('commands_executed') ?? '[]', warnings, 'commands_executed'),
    networkCalls: parseList(map.get('network_calls') ?? '[]', warnings, 'network_calls'),
    rulesetSwitches: parseList(map.get('ruleset_switches') ?? '[]', warnings, 'ruleset_switches'),
    notes: (map.get('notes') ?? '').slice(0, 240),
    metrics: Object.freeze(Object.fromEntries(metrics)),
    warnings: Object.freeze(entryWarnings.slice())
  };

  return { entry, warnings };
}

function parseMetricValue(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // Reject obvious non-numeric inputs early so JS coercion doesn't masquerade
  // empty/whitespace/list values as 0.
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  // Permit NaN / Infinity / -Infinity tokens through to surface as
  // non-finite drops in the caller.
  if (trimmed === 'NaN') return NaN;
  if (trimmed === 'Infinity') return Infinity;
  if (trimmed === '-Infinity') return -Infinity;
  return undefined;
}

function parseList(raw: string, warnings: string[], fieldName: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '[]') return [];
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    warnings.push(`[constitution] ${fieldName} not a list: ${trimmed.slice(0, 60)}`);
    return [];
  }
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter((s) => s.length > 0);
}
