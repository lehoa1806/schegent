// Feature 318 (FR-R7-04, FR-001, FR-002, FR-007, FR-008) — bounded,
// containment-safe scanner of repository-controlled agent configuration files.
//
// SECURITY INVARIANTS
//
//   1. Fixed relative path list per backend — no recursive directory walk over
//      untrusted repository trees.
//   2. Every read goes through `openWithinRoot(..., { flags: 'r', createDirs: false })`
//      so symlinked directories, symlinked leaves, reparse points (within the platform
//      limits recorded in `docs/architecture/native-binding-decision.md`), and non-regular
//      files are refused without ever reading outside the workspace root.
//   3. Reads are strictly bounded to `MAX_AGENT_CONFIG_FILE_BYTES` (256 KiB) per
//      file (using a bounded chunked `handle.read` loop that never buffers past
//      `maxBytes + 1` bytes) and `MAX_AGENT_CONFIG_SCAN_MS` (2,000 ms) total.
//   4. Values and raw file contents NEVER leave this module. Only relative names,
//      byte sizes, SHA-256 digests, closed unreadable reason categories, and —
//      for Claude JSON settings files only — sorted hook event names and
//      execution-relevant top-level key names are returned.
//   5. `.mcp.json` is NEVER parsed or interpreted (expansion freeze): reported by
//      presence, size, and SHA-256 digest only.
import { createHash } from 'node:crypto';
import type * as fsp from 'node:fs/promises';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { openWithinRoot, type SafeOpenRefusal } from '../lib/safe-open';

export const MAX_AGENT_CONFIG_FILE_BYTES = 262_144; // 256 KiB
export const MAX_AGENT_CONFIG_SCAN_MS = 2_000;

const MAX_HOOK_EVENT_NAMES = 64;
const MAX_HOOK_EVENT_NAME_CHARS = 64;

/** Fixed repository-relative paths inspected per backend (POSIX separators). */
export const REPO_AGENT_CONFIG_PATHS: Readonly<Record<BackendRunnerKind, readonly string[]>> =
  Object.freeze({
    claude: Object.freeze([
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.mcp.json',
      'CLAUDE.md',
      '.claude/CLAUDE.md'
    ]),
    codex: Object.freeze(['.codex/config.toml', 'AGENTS.md', 'AGENTS.override.md']),
    agy: Object.freeze([])
  });

const CLAUDE_SETTINGS_FILES: ReadonlySet<string> = new Set([
  '.claude/settings.json',
  '.claude/settings.local.json'
]);

/**
 * Top-level execution-relevant keys reported by NAME ONLY for Claude settings
 * JSON files. Values are never read into output structures.
 */
export const CLAUDE_EXECUTION_SETTING_KEYS = [
  'apiKeyHelper',
  'env',
  'permissions',
  'statusLine'
] as const;

export type AgentConfigUnreadableReason =
  | 'symlink'
  | 'not-a-regular-file'
  | 'size-limit-exceeded'
  | 'escapes-root'
  | 'io-failed'
  | 'timeout';

export interface PresentAgentConfigEntry {
  readonly name: string;
  readonly status: 'present';
  readonly size: number;
  readonly digest: string;
  readonly hookEvents?: readonly string[];
  readonly settingKeys?: readonly string[];
  readonly metadataMalformed?: boolean;
}

export interface UnreadableAgentConfigEntry {
  readonly name: string;
  readonly status: 'unreadable';
  readonly unreadableReason: AgentConfigUnreadableReason;
}

export type ScannedAgentConfigEntry = PresentAgentConfigEntry | UnreadableAgentConfigEntry;

export interface RepoAgentConfigScanResult {
  readonly backend: BackendRunnerKind;
  readonly entries: readonly ScannedAgentConfigEntry[];
  readonly fingerprint: string;
  readonly persistable: boolean;
  readonly scanError: boolean;
  readonly scanErrorReason?: 'timeout' | 'scan-failed';
}

export interface ScanRepoAgentConfigOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** Optional per-path scan hook for deterministic timeout testing; defaults to `scanSinglePath`. */
  readonly scanPath?: (
    workspaceRoot: string,
    relPath: string,
    maxBytes: number
  ) => Promise<ScannedAgentConfigEntry | null>;
}

function mapSafeOpenRefusal(reason: SafeOpenRefusal): AgentConfigUnreadableReason {
  switch (reason) {
    case 'symlink-component':
    case 'symlink-leaf':
    case 'reparse-point-leaf':
      return 'symlink';
    case 'not-a-regular-file':
    case 'not-a-directory':
      return 'not-a-regular-file';
    case 'escapes-root':
      return 'escapes-root';
    case 'io-failed':
      return 'io-failed';
  }
}

/**
 * Strip ASCII/C1 control characters and Unicode bidi/formatting overrides
 * (preventing visual spoofing in the modal) and clamp key length before any
 * untrusted JSON key name leaves the scanner.
 */
function isUnsafeDisplayCodePoint(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

function sanitizeKeyName(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (!isUnsafeDisplayCodePoint(code)) out += raw[i]!;
  }
  const cleaned = out.trim();
  if (cleaned.length === 0) return '(unnamed)';
  return cleaned.length <= MAX_HOOK_EVENT_NAME_CHARS
    ? cleaned
    : `${cleaned.slice(0, MAX_HOOK_EVENT_NAME_CHARS)}…`;
}

function extractClaudeSettingsMetadata(rawBytes: Buffer): {
  readonly hookEvents?: readonly string[];
  readonly settingKeys?: readonly string[];
  readonly metadataMalformed?: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBytes.toString('utf8'));
  } catch {
    return { metadataMalformed: true };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { metadataMalformed: true };
  }
  const record = parsed as Record<string, unknown>;

  let hookEvents: readonly string[] | undefined;
  let metadataMalformed = false;
  if (Object.prototype.hasOwnProperty.call(record, 'hooks') && record.hooks !== undefined) {
    const hooks = record.hooks;
    if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) {
      const names = Array.from(
        new Set(Object.keys(hooks as Record<string, unknown>).map(sanitizeKeyName))
      )
        .sort()
        .slice(0, MAX_HOOK_EVENT_NAMES);
      if (names.length > 0) {
        hookEvents = Object.freeze(names);
      }
    } else {
      metadataMalformed = true;
    }
  }

  const presentKeys = CLAUDE_EXECUTION_SETTING_KEYS.filter(
    (key) => Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined
  );

  return {
    ...(hookEvents !== undefined ? { hookEvents } : {}),
    ...(presentKeys.length > 0 ? { settingKeys: Object.freeze([...presentKeys]) } : {}),
    ...(metadataMalformed ? { metadataMalformed: true } : {})
  };
}

/**
 * Read at most `maxBytes` bytes from an open descriptor. Checks `fstat().size`
 * first and also bounds the chunked read to `maxBytes + 1` bytes so a growing
 * file cannot bypass the limit.
 */
async function readBoundedBytes(
  handle: fsp.FileHandle,
  maxBytes: number
): Promise<{ readonly outcome: 'ok'; readonly bytes: Buffer } | { readonly outcome: 'too-large' }> {
  const stat = await handle.stat();
  if (stat.size > maxBytes) {
    return { outcome: 'too-large' };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const chunkSize = Math.min(16_384, maxBytes + 1);
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const buf = Buffer.allocUnsafe(Math.min(chunkSize, remaining));
    const { bytesRead } = await handle.read(buf, 0, buf.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) {
      return { outcome: 'too-large' };
    }
    chunks.push(buf.subarray(0, bytesRead));
  }
  return { outcome: 'ok', bytes: chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total) };
}

export function computeAgentConfigFingerprint(
  backend: BackendRunnerKind,
  entries: readonly ScannedAgentConfigEntry[],
  scanError: boolean,
  scanErrorReason?: 'timeout' | 'scan-failed'
): string {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const lines: string[] = [`backend:${backend}`];
  for (const entry of sorted) {
    if (entry.status === 'present') {
      lines.push(`file:${entry.name}:present:${entry.size}:${entry.digest}`);
    } else {
      lines.push(`file:${entry.name}:unreadable:${entry.unreadableReason}`);
    }
  }
  if (scanError) {
    lines.push(`scan-error:${scanErrorReason ?? 'scan-failed'}`);
  }
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

async function scanSinglePath(
  workspaceRoot: string,
  relPath: string,
  maxBytes: number
): Promise<ScannedAgentConfigEntry | null> {
  const segments = relPath.split('/');
  const opened = await openWithinRoot(workspaceRoot, segments, {
    flags: 'r',
    createDirs: false
  });
  if (opened.outcome === 'refused') {
    // Missing parent directory or missing file is ordinary absence, not an unreadable file.
    if (opened.reason === 'io-failed' && opened.errno === 'ENOENT') {
      return null;
    }
    return {
      name: relPath,
      status: 'unreadable',
      unreadableReason: mapSafeOpenRefusal(opened.reason)
    };
  }

  try {
    const read = await readBoundedBytes(opened.handle, maxBytes);
    if (read.outcome === 'too-large') {
      return {
        name: relPath,
        status: 'unreadable',
        unreadableReason: 'size-limit-exceeded'
      };
    }
    const digest = createHash('sha256').update(read.bytes).digest('hex');
    // Only Claude settings JSON files have hook/key metadata extracted; `.mcp.json`
    // and all other files are strictly presence + size + digest.
    const claudeMeta = CLAUDE_SETTINGS_FILES.has(relPath)
      ? extractClaudeSettingsMetadata(read.bytes)
      : {};
    return {
      name: relPath,
      status: 'present',
      size: read.bytes.length,
      digest,
      ...claudeMeta
    };
  } catch {
    return {
      name: relPath,
      status: 'unreadable',
      unreadableReason: 'io-failed'
    };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

export async function scanRepoAgentConfig(
  workspaceRoot: string,
  backend: BackendRunnerKind,
  options: ScanRepoAgentConfigOptions = {}
): Promise<RepoAgentConfigScanResult> {
  const maxBytes =
    typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : MAX_AGENT_CONFIG_FILE_BYTES;
  const timeoutMs =
    typeof options.timeoutMs === 'number' &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : MAX_AGENT_CONFIG_SCAN_MS;

  const candidates = REPO_AGENT_CONFIG_PATHS[backend];
  if (candidates.length === 0) {
    const empty: readonly ScannedAgentConfigEntry[] = Object.freeze([]);
    return {
      backend,
      entries: empty,
      fingerprint: computeAgentConfigFingerprint(backend, empty, false),
      persistable: false,
      scanError: false
    };
  }

  const entries: ScannedAgentConfigEntry[] = [];
  const scanPathImpl = options.scanPath ?? scanSinglePath;
  const abortController = new AbortController();
  const isAborted = (): boolean => abortController.signal.aborted;
  let scanError = false;
  let scanErrorReason: 'timeout' | 'scan-failed' | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const work = async (): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (const relPath of candidates) {
      if (isAborted() || Date.now() >= deadline) {
        if (!isAborted()) {
          scanError = true;
          scanErrorReason = 'timeout';
        }
        return;
      }
      const entry = await scanPathImpl(workspaceRoot, relPath, maxBytes);
      if (isAborted()) return;
      if (entry !== null) {
        entries.push(entry);
      }
    }
  };

  const timeoutPromise = new Promise<'timed-out'>((resolve) => {
    timer = setTimeout(() => {
      abortController.abort();
      resolve('timed-out');
    }, timeoutMs);
  });

  const workPromise = work().then(() => 'done' as const);
  try {
    const race = await Promise.race([workPromise, timeoutPromise]);
    if (race === 'timed-out') {
      abortController.abort();
      scanError = true;
      scanErrorReason = 'timeout';
      // Prevent late unhandled rejection if the abandoned promise fails after timeout.
      void workPromise.catch(() => undefined);
    }
  } catch {
    abortController.abort();
    scanError = true;
    scanErrorReason = 'scan-failed';
  } finally {
    abortController.abort();
    if (timer !== undefined) clearTimeout(timer);
  }

  const frozenEntries = Object.freeze([...entries]);
  const persistable =
    !scanError &&
    frozenEntries.length > 0 &&
    frozenEntries.every((entry) => entry.status === 'present');

  return {
    backend,
    entries: frozenEntries,
    fingerprint: computeAgentConfigFingerprint(backend, frozenEntries, scanError, scanErrorReason),
    persistable,
    scanError,
    ...(scanErrorReason !== undefined ? { scanErrorReason } : {})
  };
}
