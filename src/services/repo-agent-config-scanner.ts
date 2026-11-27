// Feature 318 (FR-R7-04, FR-001, FR-002, FR-007, FR-008) & Principal Review S3 — bounded,
// containment-safe scanner of repository-controlled agent configuration files and trees.
//
// SECURITY INVARIANTS
//
//   1. Declared repository-relative paths and directory prefixes per backend
//      (trailing `/`). Recursive walks are strictly bounded to
//      `MAX_AGENT_CONFIG_WALK_DEPTH` (4), `MAX_AGENT_CONFIG_FILES` (256), and
//      `MAX_AGENT_CONFIG_TOTAL_BYTES` (4 MiB total). Exceeding any bound emits
//      an unreadable overflow marker into `entries` (and thus into the
//      fingerprint with `persistable: false`) so the gate fails toward prompting
//      and never silently skips excess files.
//   2. Every directory component is checked with `lstat` (`walkDirectoriesWithinRoot` /
//      `fsp.lstat`) without following symlinks, and every file read goes through
//      `openWithinRoot(..., { flags: 'r', createDirs: false })` so symlinked
//      directories, symlinked leaves, reparse points (within the platform limits
//      recorded in `docs/architecture/native-binding-decision.md`), and non-regular
//      files are refused without ever reading outside the workspace root.
//   3. Per-file reads are strictly bounded to `MAX_AGENT_CONFIG_FILE_BYTES` (256 KiB)
//      (using a bounded chunked `handle.read` loop that never requests or buffers
//      past `maxBytes` bytes, paired with pre- and post-read `fstat` checks) and
//      `MAX_AGENT_CONFIG_SCAN_MS` (2,000 ms) total via monotonic `performance.now()`
//      and an `AbortSignal` deadline.
//   4. Values and raw file contents NEVER leave this module. Only relative names,
//      byte sizes, SHA-256 digests, closed unreadable reason categories, and —
//      for Claude JSON settings files only — sorted hook event names,
//      execution-relevant top-level key names, and resolved workspace-internal
//      hook script paths that exist on disk are returned.
//   5. `.mcp.json` is NEVER parsed or interpreted (expansion freeze): reported by
//      presence, size, and SHA-256 digest only.
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  computeAgentConfigFingerprint,
  MAX_AGENT_CONFIG_FILE_BYTES
} from '../contracts/agent-config-fingerprint';
import type { BackendRunnerKind } from '../contracts/backend-kinds';
import { mapBackends, type BackendMap } from '../contracts/backend-descriptors';
import {
  openWithinRoot,
  segmentsUnderRoot,
  walkDirectoriesWithinRoot,
  type SafeOpenRefusal
} from '../lib/safe-open';

export { computeAgentConfigFingerprint, MAX_AGENT_CONFIG_FILE_BYTES };
export const MAX_AGENT_CONFIG_SCAN_MS = 2_000;
export const MAX_AGENT_CONFIG_WALK_DEPTH = 4;
export const MAX_AGENT_CONFIG_FILES = 256;
export const MAX_AGENT_CONFIG_TOTAL_BYTES = 4 * 1024 * 1024;

const MAX_HOOK_EVENT_NAMES = 64;
const MAX_HOOK_EVENT_NAME_CHARS = 64;
const MAX_HOOK_COMMAND_STRINGS = 64;
const MAX_HOOK_SCRIPT_CANDIDATES = 64;
const MAX_HOOK_SCRIPT_PATH_CHARS = 512;
const MAX_DEPTH_OVERFLOW_MARKERS = 16;

/** Declared repository-relative paths and directory prefixes (trailing `/`) inspected per backend. */
export const REPO_AGENT_CONFIG_PATHS: BackendMap<readonly string[]> = mapBackends(
  (descriptor) => descriptor.repoAgentConfigPaths
);

const CLAUDE_SETTINGS_FILES: ReadonlySet<string> = new Set([
  '.claude/settings.json',
  '.claude/settings.local.json'
]);

const INTERPRETER_BINARIES: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'node',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'tsx',
  'ts-node',
  'bun',
  'deno',
  'pwsh',
  'powershell'
]);

const INLINE_CODE_FLAGS: ReadonlySet<string> = new Set(['-c', '-e', '--eval', '-p', '--print']);

const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.py',
  '.rb',
  '.pl',
  '.ps1',
  '.cmd',
  '.bat'
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
  | 'depth-limit-exceeded'
  | 'file-count-limit-exceeded'
  | 'total-bytes-limit-exceeded'
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
  /** True when discovered by resolving a workspace-internal script referenced in a Claude hook command. */
  readonly hookScript?: true;
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
  readonly maxWalkDepth?: number;
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  /** Optional per-path scan hook for deterministic timeout testing; defaults to `scanSinglePath`. */
  readonly scanPath?: (
    workspaceRoot: string,
    relPath: string,
    maxBytes: number,
    signal?: AbortSignal
  ) => Promise<ScannedAgentConfigEntry | null>;
}

const ABORT_SENTINEL = Symbol('agent-config-scan-aborted');

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T | typeof ABORT_SENTINEL> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return ABORT_SENTINEL;
  }
  let resolveAbort!: (value: typeof ABORT_SENTINEL) => void;
  const abortPromise = new Promise<typeof ABORT_SENTINEL>((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = (): void => resolveAbort(ABORT_SENTINEL);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([promise, abortPromise]);
    if (result === ABORT_SENTINEL) {
      void promise.catch(() => undefined);
    }
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
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

function errnoOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
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

function collectHookCommandStrings(hooksObj: Record<string, unknown>): readonly string[] {
  const commands: string[] = [];
  const pushCommand = (value: unknown): void => {
    if (commands.length >= MAX_HOOK_COMMAND_STRINGS) return;
    if (typeof value === 'string' && value.trim().length > 0) {
      commands.push(value);
    }
  };
  for (const entries of Object.values(hooksObj)) {
    if (commands.length >= MAX_HOOK_COMMAND_STRINGS) break;
    if (!Array.isArray(entries)) continue;
    for (const item of entries) {
      if (commands.length >= MAX_HOOK_COMMAND_STRINGS) break;
      if (typeof item === 'string') {
        pushCommand(item);
        continue;
      }
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if ((rec.type === undefined || rec.type === 'command') && typeof rec.command === 'string') {
        pushCommand(rec.command);
      }
      if (Array.isArray(rec.hooks)) {
        for (const nested of rec.hooks) {
          if (commands.length >= MAX_HOOK_COMMAND_STRINGS) break;
          if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) continue;
          const nestedRec = nested as Record<string, unknown>;
          if (
            (nestedRec.type === undefined || nestedRec.type === 'command') &&
            typeof nestedRec.command === 'string'
          ) {
            pushCommand(nestedRec.command);
          }
        }
      }
    }
  }
  return commands;
}

/**
 * Split a shell hook command string into simple command segments (on unquoted `;`, `|`, `&&`, `||`)
 * and quote-unwrapped tokens. Strictly best-effort: dynamic shell expansion is not evaluated.
 */
function tokenizeHookCommand(command: string): readonly (readonly string[])[] {
  const segments: string[][] = [];
  let currentSegment: string[] = [];
  let currentToken = '';
  let inSingle = false;
  let inDouble = false;
  let hasToken = false;

  const flushToken = (): void => {
    if (hasToken) {
      currentSegment.push(currentToken);
      currentToken = '';
      hasToken = false;
    }
  };
  const flushSegment = (): void => {
    flushToken();
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        currentToken += ch;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < command.length) {
        const next = command[i + 1]!;
        if (next === '"' || next === '\\' || next === '$') {
          currentToken += next;
          i += 1;
        } else {
          currentToken += ch;
        }
      } else {
        currentToken += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      hasToken = true;
    } else if (ch === '"') {
      inDouble = true;
      hasToken = true;
    } else if (ch === '\\' && i + 1 < command.length) {
      currentToken += command[i + 1]!;
      hasToken = true;
      i += 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flushToken();
    } else if (ch === ';') {
      flushSegment();
    } else if (ch === '|' || ch === '&') {
      if (command[i + 1] === ch) i += 1;
      flushSegment();
    } else {
      currentToken += ch;
      hasToken = true;
    }
  }
  flushSegment();
  return segments;
}

function isEnvAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function commandBasename(token: string): string {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  return (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase();
}

function resolveWorkspaceScriptCandidate(token: string, workspaceRoot: string): string | null {
  if (token.length === 0 || token.length > MAX_HOOK_SCRIPT_PATH_CHARS) return null;
  if (token.startsWith('-')) return null;

  let normalized = token.trim();
  if (normalized.startsWith('$CLAUDE_PROJECT_DIR/')) {
    normalized = `./${normalized.slice('$CLAUDE_PROJECT_DIR/'.length)}`;
  } else if (normalized.startsWith('${CLAUDE_PROJECT_DIR}/')) {
    normalized = `./${normalized.slice('${CLAUDE_PROJECT_DIR}/'.length)}`;
  } else if (normalized.startsWith('"$CLAUDE_PROJECT_DIR"/')) {
    normalized = `./${normalized.slice('"$CLAUDE_PROJECT_DIR"/'.length)}`;
  }

  // Reject unresolved variables, globs, backticks, or control characters.
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return null;
  }
  if (/[$`*?[\]]/.test(normalized)) return null;

  const hasSeparator = normalized.includes('/') || normalized.includes('\\');
  const ext = path.posix.extname(normalized.replace(/\\/g, '/')).toLowerCase();
  if (!hasSeparator && !SCRIPT_EXTENSIONS.has(ext)) return null;

  const resolved = path.isAbsolute(normalized)
    ? path.resolve(normalized)
    : path.resolve(workspaceRoot, normalized);
  const segs = segmentsUnderRoot(workspaceRoot, resolved);
  if (segs === null || segs.length === 0) return null;
  if (segs.some((seg) => seg.length === 0 || seg === '.' || seg === '..' || seg.includes('/'))) {
    return null;
  }
  const relPosix = segs.join('/');
  return relPosix.length <= MAX_HOOK_SCRIPT_PATH_CHARS ? relPosix : null;
}

function extractHookScriptCandidates(
  hooksObj: Record<string, unknown>,
  workspaceRoot: string
): readonly string[] {
  const candidates = new Set<string>();
  const commands = collectHookCommandStrings(hooksObj);
  for (const command of commands) {
    for (const segment of tokenizeHookCommand(command)) {
      let idx = 0;
      while (idx < segment.length && isEnvAssignmentToken(segment[idx]!)) idx += 1;
      if (idx >= segment.length) continue;

      let base = commandBasename(segment[idx]!);
      if (base === 'env') {
        idx += 1;
        while (idx < segment.length && (segment[idx]!.startsWith('-') || isEnvAssignmentToken(segment[idx]!))) {
          idx += 1;
        }
        if (idx >= segment.length) continue;
        base = commandBasename(segment[idx]!);
      }

      if (INTERPRETER_BINARIES.has(base)) {
        idx += 1;
        while (idx < segment.length && segment[idx]!.startsWith('-')) {
          const flag = segment[idx]!;
          idx += 1;
          if (INLINE_CODE_FLAGS.has(flag)) {
            idx += 1; // Skip inline script text so it is never treated as a path.
          }
        }
      }

      for (let i = idx; i < segment.length && candidates.size < MAX_HOOK_SCRIPT_CANDIDATES; i += 1) {
        const relPath = resolveWorkspaceScriptCandidate(segment[i]!, workspaceRoot);
        if (relPath !== null) {
          candidates.add(relPath);
        }
      }
      if (candidates.size >= MAX_HOOK_SCRIPT_CANDIDATES) break;
    }
    if (candidates.size >= MAX_HOOK_SCRIPT_CANDIDATES) break;
  }
  return [...candidates].sort();
}

function extractClaudeSettingsMetadata(
  rawBytes: Buffer,
  workspaceRoot?: string
): {
  readonly hookEvents?: readonly string[];
  readonly settingKeys?: readonly string[];
  readonly metadataMalformed?: boolean;
  readonly hookScriptCandidates?: readonly string[];
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
  let hookScriptCandidates: readonly string[] | undefined;
  let metadataMalformed = false;
  if (Object.prototype.hasOwnProperty.call(record, 'hooks') && record.hooks !== undefined) {
    const hooks = record.hooks;
    if (hooks !== null && typeof hooks === 'object' && !Array.isArray(hooks)) {
      const hooksRec = hooks as Record<string, unknown>;
      const names = Array.from(new Set(Object.keys(hooksRec).map(sanitizeKeyName)))
        .sort()
        .slice(0, MAX_HOOK_EVENT_NAMES);
      if (names.length > 0) {
        hookEvents = Object.freeze(names);
      }
      if (workspaceRoot !== undefined) {
        const scripts = extractHookScriptCandidates(hooksRec, workspaceRoot);
        if (scripts.length > 0) {
          hookScriptCandidates = scripts;
        }
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
    ...(metadataMalformed ? { metadataMalformed: true } : {}),
    ...(hookScriptCandidates !== undefined ? { hookScriptCandidates } : {})
  };
}

/**
 * Read at most `maxBytes` bytes from an open descriptor. Checks `fstat().size`
 * before and after the bounded chunked read loop so `handle.read()` never
 * requests bytes past `maxBytes` and concurrent file growth past `maxBytes`
 * fails closed. Races awaits against `signal` when supplied.
 */
export async function readBoundedBytes(
  handle: fsp.FileHandle,
  maxBytes: number,
  signal?: AbortSignal
): Promise<
  | { readonly outcome: 'ok'; readonly bytes: Buffer }
  | { readonly outcome: 'too-large' }
  | { readonly outcome: 'changed' }
  | { readonly outcome: 'aborted'; readonly pendingOp?: Promise<unknown> }
> {
  if (signal?.aborted) return { outcome: 'aborted' };

  const preStatPromise = handle.stat();
  const stat = await raceWithAbort(preStatPromise, signal);
  if (stat === ABORT_SENTINEL || signal?.aborted) {
    return { outcome: 'aborted', pendingOp: preStatPromise };
  }
  if (stat.size > maxBytes) {
    return { outcome: 'too-large' };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  const chunkSize = Math.min(16_384, maxBytes);
  while (total < maxBytes) {
    if (signal?.aborted) return { outcome: 'aborted' };
    const remaining = maxBytes - total;
    const buf = Buffer.allocUnsafe(Math.min(chunkSize, remaining));
    const readPromise = handle.read(buf, 0, buf.length, null);
    const readResult = await raceWithAbort(readPromise, signal);
    if (readResult === ABORT_SENTINEL || signal?.aborted) {
      return { outcome: 'aborted', pendingOp: readPromise };
    }
    if (readResult.bytesRead === 0) break;
    total += readResult.bytesRead;
    if (total > maxBytes) {
      return { outcome: 'too-large' };
    }
    chunks.push(buf.subarray(0, readResult.bytesRead));
  }

  if (signal?.aborted) return { outcome: 'aborted' };
  const postStatPromise = handle.stat();
  const postStat = await raceWithAbort(postStatPromise, signal);
  if (postStat === ABORT_SENTINEL || signal?.aborted) {
    return { outcome: 'aborted', pendingOp: postStatPromise };
  }
  if (postStat.size > maxBytes) {
    return { outcome: 'too-large' };
  }
  if (
    total !== postStat.size || stat.size !== postStat.size ||
    stat.mtimeMs !== postStat.mtimeMs || stat.ctimeMs !== postStat.ctimeMs
  ) {
    return { outcome: 'changed' };
  }

  return { outcome: 'ok', bytes: chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total) };
}

async function scanOpenedHandleWithContext(
  relPath: string,
  handle: fsp.FileHandle,
  maxBytes: number,
  signal?: AbortSignal,
  workspaceRoot?: string,
  onHookScriptCandidates?: (paths: readonly string[]) => void
): Promise<ScannedAgentConfigEntry | null> {
  let pendingOp: Promise<unknown> | undefined;
  try {
    if (signal?.aborted) return null;
    const read = await readBoundedBytes(handle, maxBytes, signal);
    if (read.outcome === 'aborted') {
      pendingOp = read.pendingOp;
      return null;
    }
    if (signal?.aborted) return null;
    if (read.outcome === 'too-large') {
      return {
        name: relPath,
        status: 'unreadable',
        unreadableReason: 'size-limit-exceeded'
      };
    }
    if (read.outcome === 'changed') {
      return {
        name: relPath,
        status: 'unreadable',
        unreadableReason: 'io-failed'
      };
    }
    const digest = createHash('sha256').update(read.bytes).digest('hex');
    // Only Claude settings JSON files have hook/key metadata extracted; `.mcp.json`
    // and all other files are strictly presence + size + digest.
    const claudeMeta = CLAUDE_SETTINGS_FILES.has(relPath)
      ? extractClaudeSettingsMetadata(read.bytes, workspaceRoot)
      : {};
    if (claudeMeta.hookScriptCandidates && onHookScriptCandidates !== undefined) {
      onHookScriptCandidates(claudeMeta.hookScriptCandidates);
    }
    return {
      name: relPath,
      status: 'present',
      size: read.bytes.length,
      digest,
      ...(claudeMeta.hookEvents !== undefined ? { hookEvents: claudeMeta.hookEvents } : {}),
      ...(claudeMeta.settingKeys !== undefined ? { settingKeys: claudeMeta.settingKeys } : {}),
      ...(claudeMeta.metadataMalformed ? { metadataMalformed: true } : {})
    };
  } catch {
    if (signal?.aborted) return null;
    return {
      name: relPath,
      status: 'unreadable',
      unreadableReason: 'io-failed'
    };
  } finally {
    try {
      await handle.close();
    } catch {
      if (pendingOp !== undefined) {
        void pendingOp
          .catch(() => undefined)
          .finally(() => {
            void handle.close().catch(() => undefined);
          });
      }
    }
  }
}

export async function scanOpenedHandle(
  relPath: string,
  handle: fsp.FileHandle,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ScannedAgentConfigEntry | null> {
  return scanOpenedHandleWithContext(relPath, handle, maxBytes, signal);
}

async function scanSinglePath(
  workspaceRoot: string,
  relPath: string,
  maxBytes: number,
  signal?: AbortSignal,
  onHookScriptCandidates?: (paths: readonly string[]) => void
): Promise<ScannedAgentConfigEntry | null> {
  if (signal?.aborted) return null;
  const segments = relPath.split('/');
  const openPromise = openWithinRoot(workspaceRoot, segments, {
    flags: 'r',
    createDirs: false
  });
  const opened = await raceWithAbort(openPromise, signal);
  if (opened === ABORT_SENTINEL) {
    void openPromise
      .then((late) =>
        late.outcome === 'opened' ? late.handle.close().catch(() => undefined) : undefined
      )
      .catch(() => undefined);
    return null;
  }
  if (signal?.aborted) {
    if (opened.outcome === 'opened') {
      await opened.handle.close().catch(() => undefined);
    }
    return null;
  }
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

  return scanOpenedHandleWithContext(
    relPath,
    opened.handle,
    maxBytes,
    signal,
    workspaceRoot,
    onHookScriptCandidates
  );
}

function clampPositiveInt(value: number | undefined, hardMax: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.min(hardMax, Math.floor(value));
  }
  return hardMax;
}

export async function scanRepoAgentConfig(
  workspaceRoot: string,
  backend: BackendRunnerKind,
  options: ScanRepoAgentConfigOptions = {}
): Promise<RepoAgentConfigScanResult> {
  const maxBytes = clampPositiveInt(options.maxBytes, MAX_AGENT_CONFIG_FILE_BYTES);
  const timeoutMs = clampPositiveInt(options.timeoutMs, MAX_AGENT_CONFIG_SCAN_MS);
  const maxWalkDepth = clampPositiveInt(options.maxWalkDepth, MAX_AGENT_CONFIG_WALK_DEPTH);
  const maxFiles = clampPositiveInt(options.maxFiles, MAX_AGENT_CONFIG_FILES);
  const maxTotalBytes = clampPositiveInt(options.maxTotalBytes, MAX_AGENT_CONFIG_TOTAL_BYTES);

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

  const fixedCandidates = candidates.filter((relPath) => !relPath.endsWith('/'));
  const dirCandidates = candidates.filter((relPath) => relPath.endsWith('/'));

  const entries: ScannedAgentConfigEntry[] = [];
  const seenPaths = new Set<string>();
  const hookScriptCandidates = new Set<string>();
  const collectHookScripts = (paths: readonly string[]): void => {
    for (const candidate of paths) {
      if (hookScriptCandidates.size < MAX_HOOK_SCRIPT_CANDIDATES) {
        hookScriptCandidates.add(candidate);
      }
    }
  };
  const scanPathImpl: (
    ws: string,
    rel: string,
    cap: number,
    sig?: AbortSignal
  ) => Promise<ScannedAgentConfigEntry | null> =
    options.scanPath ??
    ((ws, rel, cap, sig) => scanSinglePath(ws, rel, cap, sig, collectHookScripts));

  const abortController = new AbortController();
  const isAborted = (): boolean => abortController.signal.aborted;
  let scanError = false;
  let scanErrorReason: 'timeout' | 'scan-failed' | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limits = {
    scannedFileCount: 0,
    totalReadBytes: 0,
    fileCountExceeded: false,
    totalBytesExceeded: false,
    depthOverflowMarkers: 0
  };

  const limitReached = (): boolean => limits.fileCountExceeded || limits.totalBytesExceeded;

  const deadline = performance.now() + timeoutMs;
  const expired = (): boolean => {
    if (isAborted()) return true;
    if (performance.now() < deadline) return false;
    scanError = true;
    scanErrorReason = 'timeout';
    abortController.abort();
    return true;
  };

  const recordDiscoveredEntry = (
    entry: ScannedAgentConfigEntry,
    markHookScript = false
  ): boolean => {
    if (limits.scannedFileCount >= maxFiles) {
      if (!limits.fileCountExceeded) {
        limits.fileCountExceeded = true;
        entries.push({
          name: entry.name,
          status: 'unreadable',
          unreadableReason: 'file-count-limit-exceeded'
        });
      }
      return false;
    }
    if (entry.status === 'present' && limits.totalReadBytes + entry.size > maxTotalBytes) {
      if (!limits.totalBytesExceeded) {
        limits.totalBytesExceeded = true;
        entries.push({
          name: entry.name,
          status: 'unreadable',
          unreadableReason: 'total-bytes-limit-exceeded'
        });
      }
      return false;
    }
    const finalEntry: ScannedAgentConfigEntry =
      markHookScript && entry.status === 'present' ? { ...entry, hookScript: true } : entry;
    entries.push(finalEntry);
    seenPaths.add(entry.name);
    limits.scannedFileCount += 1;
    if (entry.status === 'present') {
      limits.totalReadBytes += entry.size;
    }
    return true;
  };

  const walkDirectory = async (
    dirPath: string,
    relSegments: readonly string[],
    depth: number
  ): Promise<void> => {
    if (expired() || limitReached()) return;
    let dirents: readonly Dirent[];
    try {
      const readDirPromise = fsp.readdir(dirPath, { withFileTypes: true, encoding: 'utf8' });
      const raced = await raceWithAbort(readDirPromise, abortController.signal);
      if (raced === ABORT_SENTINEL || expired()) return;
      dirents = raced;
    } catch (error) {
      if (expired()) return;
      if (errnoOf(error) === 'ENOENT') return;
      entries.push({
        name: `${relSegments.join('/')}/`,
        status: 'unreadable',
        unreadableReason: 'io-failed'
      });
      return;
    }

    const sorted = [...dirents].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of sorted) {
      if (expired() || limitReached()) return;
      const name = dirent.name;
      if (
        name.length === 0 ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\')
      ) {
        entries.push({
          name: `${relSegments.join('/')}/${name}`,
          status: 'unreadable',
          unreadableReason: 'escapes-root'
        });
        continue;
      }
      const childSegments = [...relSegments, name];
      const childRelPath = childSegments.join('/');
      const childFullPath = path.join(dirPath, name);

      let stat: Awaited<ReturnType<typeof fsp.lstat>>;
      try {
        const lstatPromise = fsp.lstat(childFullPath);
        const racedStat = await raceWithAbort(lstatPromise, abortController.signal);
        if (racedStat === ABORT_SENTINEL || expired()) return;
        stat = racedStat;
      } catch (error) {
        if (expired()) return;
        if (errnoOf(error) === 'ENOENT') continue;
        recordDiscoveredEntry({
          name: childRelPath,
          status: 'unreadable',
          unreadableReason: 'io-failed'
        });
        continue;
      }

      if (stat.isSymbolicLink()) {
        // Symlinks are never followed; emit an unreadable entry so the operator sees it and is prompted.
        recordDiscoveredEntry({
          name: childRelPath,
          status: 'unreadable',
          unreadableReason: 'symlink'
        });
        continue;
      }

      if (stat.isDirectory()) {
        if (depth >= maxWalkDepth) {
          if (limits.depthOverflowMarkers < MAX_DEPTH_OVERFLOW_MARKERS) {
            limits.depthOverflowMarkers += 1;
            entries.push({
              name: `${childRelPath}/`,
              status: 'unreadable',
              unreadableReason: 'depth-limit-exceeded'
            });
          }
          continue;
        }
        await walkDirectory(childFullPath, childSegments, depth + 1);
        continue;
      }

      if (!stat.isFile()) {
        recordDiscoveredEntry({
          name: childRelPath,
          status: 'unreadable',
          unreadableReason: 'not-a-regular-file'
        });
        continue;
      }

      if (seenPaths.has(childRelPath)) continue;
      if (limits.scannedFileCount >= maxFiles) {
        limits.fileCountExceeded = true;
        entries.push({
          name: childRelPath,
          status: 'unreadable',
          unreadableReason: 'file-count-limit-exceeded'
        });
        return;
      }
      if (stat.size <= maxBytes && limits.totalReadBytes + stat.size > maxTotalBytes) {
        limits.totalBytesExceeded = true;
        entries.push({
          name: childRelPath,
          status: 'unreadable',
          unreadableReason: 'total-bytes-limit-exceeded'
        });
        return;
      }

      const entry = await scanPathImpl(workspaceRoot, childRelPath, maxBytes, abortController.signal);
      if (expired()) return;
      if (entry !== null) {
        recordDiscoveredEntry(entry);
      }
    }
  };

  const work = async (): Promise<void> => {
    // 1. Scan fixed repository-relative files in declared order.
    for (const relPath of fixedCandidates) {
      if (expired() || limitReached()) return;
      const entry = await scanPathImpl(workspaceRoot, relPath, maxBytes, abortController.signal);
      if (expired()) return;
      if (entry !== null) {
        recordDiscoveredEntry(entry);
      }
    }

    // 2. Bounded recursive walk of declared directory prefixes (no symlink following).
    for (const dirPrefix of dirCandidates) {
      if (expired() || limitReached()) return;
      const prefixSegments = dirPrefix.slice(0, -1).split('/');
      const walkedPromise = walkDirectoriesWithinRoot(workspaceRoot, prefixSegments);
      const walked = await raceWithAbort(walkedPromise, abortController.signal);
      if (walked === ABORT_SENTINEL || expired()) return;
      if (walked.outcome === 'refused') {
        if (walked.reason === 'io-failed' && walked.errno === 'ENOENT') {
          continue;
        }
        entries.push({
          name: dirPrefix,
          status: 'unreadable',
          unreadableReason: mapSafeOpenRefusal(walked.reason)
        });
        continue;
      }
      await walkDirectory(walked.directory, prefixSegments, 0);
    }

    // 3. Best-effort bounded hashing of workspace-internal scripts referenced by settings hook commands.
    if (hookScriptCandidates.size > 0) {
      for (const relPath of [...hookScriptCandidates].sort()) {
        if (expired() || limitReached()) return;
        if (seenPaths.has(relPath)) continue;
        const entry = await scanPathImpl(workspaceRoot, relPath, maxBytes, abortController.signal);
        if (expired()) return;
        if (entry !== null) {
          recordDiscoveredEntry(entry, true);
        }
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
    if (!expired()) {
      scanError = true;
      scanErrorReason = 'scan-failed';
    }
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
