// FR-R6-F09 (FR-004, FR-013; research R5, data-model AcceptanceBinding) -- the acceptance
// bindings, one per backend, kept in the workspace memento and validated on every read.
//
// READ. The stored value is untrusted: another host version, a hand edit or a corrupt store may
// have written it. A value a newer host wrote (`schemaVersion` above this host's) reads as
// `future-schema` for every kind and is never rewritten. Anything else that fails validation --
// the whole value or one entry -- is treated as absent, and the log names the kind only, never the
// stored text (NFR-005).
//
// WRITE. A bind replaces the kind's entry, keeps the other valid entries and drops the invalid
// ones. It refuses outright over a future-schema value.

import { SUPPORTED_BACKENDS, isBackendRunnerKind, type BackendRunnerKind } from '../../contracts/backend-kinds';
import {
  ACCEPTANCE_BINDINGS_KEY,
  ACCEPTANCE_BINDINGS_MAX_BYTES,
  ACCEPTANCE_BINDINGS_SCHEMA_VERSION,
  ACCEPTANCE_ORIGINS,
  DIGEST_PATTERN,
  FINGERPRINT_COMPONENTS,
  FINGERPRINT_COMPONENT_MAX,
  type AcceptanceBinding,
  type AcceptanceOrigin,
  type BindingInput,
  type FingerprintRecord
} from '../../contracts/containment-qualification';

/** The slice of a VS Code `Memento` the store needs. */
export interface AcceptanceMementoPort {
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface AcceptanceBindingsLogger {
  warn(line: string): void;
}

/** A bind attempted over a record a newer host wrote. Carries no stored text. */
export class AcceptanceBindingsFutureSchemaError extends Error {
  constructor() {
    super('acceptance bindings were written by a newer Schegent; not rewritten');
    this.name = 'AcceptanceBindingsFutureSchemaError';
  }
}

/** Bound on an ISO-8601 `boundAt`. */
const BOUND_AT_MAX = 40;
const VALUE_KEYS = Object.freeze(['bindings', 'schemaVersion']);
const ENTRY_KEYS = Object.freeze(['boundAt', 'fingerprint', 'origin']);
const FINGERPRINT_KEYS = Object.freeze(['components', 'digest']);
const LOG_PREFIX = 'acceptance bindings:';

type ParsedValue =
  | { readonly state: 'future-schema' }
  | { readonly state: 'valid'; readonly bindings: ReadonlyMap<BackendRunnerKind, AcceptanceBinding> };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, index) => key === keys.at(index));
}

function serializedBytes(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    return typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : null;
  } catch {
    return null;
  }
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isComponents(value: unknown, kind: BackendRunnerKind): boolean {
  if (!isPlainObject(value) || !hasExactKeys(value, [...FINGERPRINT_COMPONENTS].sort())) return false;
  if (!FINGERPRINT_COMPONENTS.every((name) => isBoundedString(value[name], FINGERPRINT_COMPONENT_MAX))) return false;
  return value['backend'] === kind;
}

function isFingerprint(value: unknown, kind: BackendRunnerKind): value is FingerprintRecord {
  if (!isPlainObject(value) || !hasExactKeys(value, FINGERPRINT_KEYS)) return false;
  return typeof value['digest'] === 'string' && DIGEST_PATTERN.test(value['digest']) && isComponents(value['components'], kind);
}

function isOrigin(value: unknown): value is AcceptanceOrigin {
  return typeof value === 'string' && (ACCEPTANCE_ORIGINS as readonly string[]).includes(value);
}

function isBoundAt(value: unknown): value is string {
  return isBoundedString(value, BOUND_AT_MAX) && !Number.isNaN(Date.parse(value));
}

/**
 * `value` as `kind`'s binding, or `null` when it is not exactly one: the three keys, a fingerprint
 * of the seven bounded components for this backend with a 64-hex digest, a known origin, and an
 * ISO-8601 `boundAt`. Shared with the headless inspection so both refuse the same shapes.
 */
export function parseAcceptanceBinding(value: unknown, kind: BackendRunnerKind): AcceptanceBinding | null {
  if (!isPlainObject(value) || !hasExactKeys(value, ENTRY_KEYS)) return null;
  const { fingerprint, origin, boundAt } = value;
  if (!isFingerprint(fingerprint, kind) || !isOrigin(origin) || !isBoundAt(boundAt)) return null;
  return Object.freeze({ fingerprint, origin, boundAt });
}

/** The acceptance bindings over a memento. Validated on read; never trusts what it finds. */
export class AcceptanceBindingStore {
  private readonly logged = new Set<string>();

  constructor(
    private readonly memento: AcceptanceMementoPort,
    private readonly logger: AcceptanceBindingsLogger,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** The kind's binding, `null` when absent or invalid, or `'future-schema'`. */
  read(kind: BackendRunnerKind): BindingInput {
    const parsed = this.parse();
    if (parsed.state === 'future-schema') return 'future-schema';
    return parsed.bindings.get(kind) ?? null;
  }

  /**
   * Binds `kind` to `fingerprint`, replacing its previous binding and dropping invalid entries.
   * Throws {@link AcceptanceBindingsFutureSchemaError} over a record a newer host wrote.
   */
  async bind(kind: BackendRunnerKind, fingerprint: FingerprintRecord, origin: AcceptanceOrigin): Promise<void> {
    const parsed = this.parse();
    if (parsed.state === 'future-schema') throw new AcceptanceBindingsFutureSchemaError();
    const next = new Map(parsed.bindings);
    next.set(kind, Object.freeze({ fingerprint, origin, boundAt: this.now().toISOString() }));
    const bindings: Record<string, AcceptanceBinding> = {};
    for (const backend of SUPPORTED_BACKENDS) {
      const binding = next.get(backend);
      if (binding !== undefined) bindings[backend] = binding;
    }
    await this.memento.update(ACCEPTANCE_BINDINGS_KEY, { schemaVersion: ACCEPTANCE_BINDINGS_SCHEMA_VERSION, bindings });
  }

  private parse(): ParsedValue {
    const empty: ParsedValue = { state: 'valid', bindings: new Map() };
    const value = this.memento.get(ACCEPTANCE_BINDINGS_KEY);
    if (value === undefined) return empty;
    if (!isPlainObject(value)) return this.ignoreValue('not an object', empty);
    const version = value['schemaVersion'];
    if (!Number.isInteger(version)) return this.ignoreValue('no schema version', empty);
    if ((version as number) > ACCEPTANCE_BINDINGS_SCHEMA_VERSION) return { state: 'future-schema' };
    const bytes = serializedBytes(value);
    if (bytes === null || bytes > ACCEPTANCE_BINDINGS_MAX_BYTES) return this.ignoreValue('over the size bound', empty);
    if (version !== ACCEPTANCE_BINDINGS_SCHEMA_VERSION || !hasExactKeys(value, VALUE_KEYS)) {
      return this.ignoreValue('unexpected shape', empty);
    }
    const stored = value['bindings'];
    if (!isPlainObject(stored)) return this.ignoreValue('unexpected shape', empty);
    return { state: 'valid', bindings: this.parseEntries(stored) };
  }

  private parseEntries(stored: Record<string, unknown>): Map<BackendRunnerKind, AcceptanceBinding> {
    const bindings = new Map<BackendRunnerKind, AcceptanceBinding>();
    for (const [key, entry] of Object.entries(stored)) {
      if (!isBackendRunnerKind(key)) {
        this.warnOnce(`${LOG_PREFIX} entry ignored kind=unknown`);
        continue;
      }
      const binding = parseAcceptanceBinding(entry, key);
      if (binding === null) {
        this.warnOnce(`${LOG_PREFIX} entry ignored kind=${key}`);
        continue;
      }
      bindings.set(key, binding);
    }
    return bindings;
  }

  private ignoreValue(why: string, empty: ParsedValue): ParsedValue {
    this.warnOnce(`${LOG_PREFIX} stored value ignored (${why})`);
    return empty;
  }

  private warnOnce(line: string): void {
    if (this.logged.has(line)) return;
    this.logged.add(line);
    this.logger.warn(line);
  }
}
