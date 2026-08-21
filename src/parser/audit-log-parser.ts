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
  // Phase ids are operator-defined — every Phase in the catalog store is — so
  // the structured audit reader must preserve any non-empty phase id instead of
  // pinning to the original seven-phase list.
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

/**
 * The SCHEGENT AUDIT LOG closing sentinel.
 *
 * Feature 030 BUG-002 exported it so the phase layer could hand it to the
 * runner as an `InvocationRequest.completionMarker`, on the reasoning that a
 * phase's required final output makes a reliable "output complete" signal.
 * `e2bf9ad` replaced that mechanism with a stream-json envelope check and
 * Feature 107 (FR-020) removed the residual field, because the reasoning does
 * not survive the stream being untrusted: the marker is a string the model can
 * print inside a quoted diff, so it could arm a SIGTERM against a healthy
 * process. It is no longer a process-control signal.
 *
 * The export remains because the marker bounds the trailing region (FR-003) and
 * because test fixtures build realistic phase output from it.
 */
export const AUDIT_LOG_CLOSE_MARKER = CLOSE_MARKER;

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

/**
 * Feature 107 (FR-003) — the trailing region: the text from the start of the
 * selected close-marker line to the end of stdout.
 *
 * The host reads its termination token out of the same stream that carries
 * file contents, diffs and tool output, so *where* a control signal appears is
 * the only thing separating the run's own verdict from a string the model
 * printed. The region is that boundary, computed once here (this module owns
 * marker semantics) and consumed by `parseInvocation`.
 *
 * `present` is false whenever no complete marker pair was found — a missing,
 * unterminated, or retention-truncated block. That is ordinary degraded input,
 * never an invariant violation, and it selects the labeled fallback scan.
 */
export interface TrailingRegion {
  text: string;
  present: boolean;
}

const NO_REGION: TrailingRegion = { text: '', present: false };

export interface AuditLogParseResult {
  entry: AuditEntryFields | null;
  warnings: string[];
  region: TrailingRegion;
}

interface MarkerPair {
  openIndex: number;
  closeIndex: number;
}

/**
 * Feature 107 (FR-001, FR-006) — every complete open/close pair, in order.
 *
 * The audit block is a phase's constitutionally-required *final* output, so
 * the last complete pair is the run's own; earlier ones are quoted, echoed, or
 * left over from a prior phase. Scanning for one marker at a time (open only
 * while closed, close only while open) reproduces the previous
 * `findIndex`-based pairing exactly on single-block input, including the two
 * shapes where a single line carries both markers.
 */
function collectMarkerPairs(lines: string[]): { pairs: MarkerPair[]; unterminatedOpen: boolean } {
  const pairs: MarkerPair[] = [];
  let openAt: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (openAt === null) {
      if (lines[i].includes(OPEN_MARKER)) openAt = i;
      continue;
    }
    if (lines[i].includes(CLOSE_MARKER)) {
      pairs.push({ openIndex: openAt, closeIndex: i });
      openAt = null;
    }
  }
  return { pairs, unterminatedOpen: openAt !== null };
}

export function parseAuditLogBlock(stdout: string): AuditLogParseResult {
  const warnings: string[] = [];
  const lines = stdout.split(/\r?\n/);
  const { pairs, unterminatedOpen } = collectMarkerPairs(lines);
  if (pairs.length === 0) {
    // An unterminated open marker is a distinct diagnosis from no marker at
    // all; a bare close marker is the retention window cutting a block in half.
    warnings.push(
      unterminatedOpen ? '[constitution] unterminated audit log' : '[constitution] missing audit log'
    );
    return { entry: null, warnings, region: NO_REGION };
  }
  const { openIndex, closeIndex } = pairs[pairs.length - 1];
  if (pairs.length > 1) {
    // FR-002, FR-014 — count and position only. Quoting any of the competing
    // blocks would put attacker-influenced bytes into an operator-facing log.
    warnings.push(
      `[constitution] multiple audit blocks (${pairs.length} found, using the one closing at line ${closeIndex + 1})`
    );
  }
  // FR-003, plan D2 — the region starts *at* the close-marker line, not after
  // it. A correct run whose block is the last thing on the stream would
  // otherwise publish an empty region and read as tokenless, and a token
  // appended to the marker line is the shape models actually produce.
  const region: TrailingRegion = { text: lines.slice(closeIndex).join('\n'), present: true };

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
      // The `Notes:` heading shares its name with the REQUIRED_FIELDS entry
      // `notes`. When the line has no inline value, record the field as empty
      // so the entry still satisfies the REQUIRED_FIELDS check (FR-007).
      const headingKey = line.slice(0, line.indexOf(':')).trim().toLowerCase();
      if ((REQUIRED_FIELDS as readonly string[]).includes(headingKey) && !map.has(headingKey)) {
        map.set(headingKey, '');
      }
      inSubBlock = true;
      continue;
    }
    // Sub-block body — list items under a heading are opaque. However, a
    // top-level field or metric line that appears without a blank-line
    // separator must still be captured (BUG-001, FR-007). Re-detect a
    // `key: value` shape whose key is either a REQUIRED_FIELDS entry or a
    // valid metric identifier, and fall through to the top-level handler.
    if (inSubBlock) {
      const probeSep = line.indexOf(':');
      if (probeSep === -1) continue;
      const probeKey = line.slice(0, probeSep).trim();
      const isTopLevelKey =
        (REQUIRED_FIELDS as readonly string[]).includes(probeKey) ||
        METRIC_IDENT_RE.test(probeKey);
      if (!isTopLevelKey) continue;
      inSubBlock = false;
    }
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
    // The region is still published: a complete marker pair bounds the stream
    // regardless of whether the block's *contents* satisfied the constitution.
    return { entry: null, warnings, region };
  }

  const entry: AuditEntryFields = {
    // Feature 098 (FR-008) — a read, not a default. `phase` is in
    // `REQUIRED_FIELDS`, so a block that omits it returned `{ entry: null }`
    // above and never reaches this line; the `?? 'speckit-specify'` that stood
    // here could not fire. Had it fired it would have been wrong twice over: it
    // named an id from a catalog the extension no longer ships, and it would
    // have attributed one Phase's audit record to another.
    phase: map.get('phase') as Phase,
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

  return { entry, warnings, region };
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
