// Feature 318 (FR-R7-04, FR-003) — durable per-workspace acknowledgements of
// repository-controlled agent configuration, bound to `(workspace, backend, digest set)`.
//
// Modelled directly on `src/state/git-plan-grants.ts`:
//   - Stored in VS Code `context.workspaceState` (`state.vscdb` outside the repo),
//     so repository content cannot forge a grant by checking in a file.
//   - Total reader: never throws on any malformed input; drops invalid entries
//     and fails closed (a dropped grant costs one modal, never false consent).
//   - Pure module: zero `vscode` imports, independently unit-testable.
import { SUPPORTED_BACKENDS, type BackendRunnerKind } from '../contracts/backend-kinds';

export interface AgentConfigGrantFileSummary {
  readonly name: string;
  readonly size: number;
  readonly digest: string;
}

export interface AgentConfigGrant {
  readonly fingerprint: string;
  readonly backend: BackendRunnerKind;
  readonly grantedAt: number;
  readonly files: readonly AgentConfigGrantFileSummary[];
}

export type AgentConfigGrantMap = Readonly<Record<string, AgentConfigGrant>>;

export interface AgentConfigGrantsRead {
  readonly grants: AgentConfigGrantMap;
  /** One message per rejection, bounded for logging. Empty on a clean read. */
  readonly problems: readonly string[];
}

const MAX_ECHOED_CHARS = 64;
const MAX_REPORTED_PROBLEMS = 10;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const BACKEND_SET: ReadonlySet<string> = new Set(SUPPORTED_BACKENDS);

const EMPTY: AgentConfigGrantMap = Object.freeze({});

const echo = (value: string): string =>
  value.length <= MAX_ECHOED_CHARS ? value : `${value.slice(0, MAX_ECHOED_CHARS)}… (truncated)`;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function isValidRelativeName(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  if (name.startsWith('/') || name.includes('\\')) return false;
  const parts = name.split('/');
  return parts.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

function isValidFileSummary(raw: unknown): raw is AgentConfigGrantFileSummary {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const rec = raw as Record<string, unknown>;
  return (
    typeof rec.name === 'string' &&
    isValidRelativeName(rec.name) &&
    typeof rec.size === 'number' &&
    Number.isSafeInteger(rec.size) &&
    rec.size >= 0 &&
    typeof rec.digest === 'string' &&
    SHA256_HEX_RE.test(rec.digest)
  );
}

function reject(key: string, value: unknown): string | null {
  if (!SHA256_HEX_RE.test(key)) {
    return 'the map key is not a valid SHA-256 hex fingerprint';
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `the entry is ${describe(value)}, not a grant record`;
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.fingerprint !== 'string' || entry.fingerprint !== key) {
    return 'its `fingerprint` field does not equal the key it is stored under';
  }
  if (typeof entry.backend !== 'string' || !BACKEND_SET.has(entry.backend)) {
    return '`backend` is absent or not a supported backend id';
  }
  if (typeof entry.grantedAt !== 'number' || !Number.isFinite(entry.grantedAt)) {
    return '`grantedAt` is absent or is not a finite number';
  }
  if (
    !Array.isArray(entry.files) ||
    entry.files.length === 0 ||
    !entry.files.every(isValidFileSummary)
  ) {
    return '`files` is absent, empty, or contains an invalid file summary';
  }
  return null;
}

function narrow(key: string, entry: Record<string, unknown>): AgentConfigGrant {
  const files = (entry.files as AgentConfigGrantFileSummary[]).map((file) =>
    Object.freeze({ name: file.name, size: file.size, digest: file.digest })
  );
  return Object.freeze({
    fingerprint: key,
    backend: entry.backend as BackendRunnerKind,
    grantedAt: entry.grantedAt as number,
    files: Object.freeze(files)
  });
}

/**
 * Total, fail-closed reader for persisted workspace agent config grants.
 * Never throws; drops malformed entries so the worst a corrupt record can do is
 * prompt the operator again.
 */
export function readAgentConfigGrants(raw: unknown): AgentConfigGrantsRead {
  if (raw === undefined) return { grants: EMPTY, problems: [] };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      grants: EMPTY,
      problems: [
        `the stored value is ${describe(raw)}, not a map of agent config grants. ` +
          'No acknowledgement is in effect; uncontained runs with repository config will ask again.'
      ]
    };
  }

  const grants: Record<string, AgentConfigGrant> = {};
  const problems: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rejection = reject(key, value);
    if (rejection === null) {
      grants[key] = narrow(key, value as Record<string, unknown>);
      continue;
    }
    if (problems.length < MAX_REPORTED_PROBLEMS) {
      problems.push(`dropped the grant stored under '${echo(key)}': ${rejection}`);
    }
  }
  return { grants, problems };
}

export function writeAgentConfigGrant(
  current: AgentConfigGrantMap,
  grant: AgentConfigGrant
): AgentConfigGrantMap {
  return { ...current, [grant.fingerprint]: grant };
}

export function forgetAgentConfigGrant(
  current: AgentConfigGrantMap,
  fingerprint: string
): AgentConfigGrantMap | null {
  if (!Object.prototype.hasOwnProperty.call(current, fingerprint)) return null;
  const next: Record<string, AgentConfigGrant> = { ...current };
  delete next[fingerprint];
  return next;
}

/**
 * Most recently granted record for `backend`, or `null` if none exists.
 * Used when a configuration changes so the re-prompt modal can describe which
 * files were added, removed, or changed by name and digest (never values).
 */
export function latestGrantForBackend(
  grants: AgentConfigGrantMap,
  backend: BackendRunnerKind
): AgentConfigGrant | null {
  let latest: AgentConfigGrant | null = null;
  for (const grant of Object.values(grants)) {
    if (grant.backend !== backend) continue;
    if (
      latest === null ||
      grant.grantedAt > latest.grantedAt ||
      (grant.grantedAt === latest.grantedAt && grant.fingerprint > latest.fingerprint)
    ) {
      latest = grant;
    }
  }
  return latest;
}
