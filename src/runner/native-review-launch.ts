import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { NativeReviewKind } from '../contracts/process-definitions';
import { ALL_PHASE_CAPABILITIES, grants, type DeclaredCapabilitySet } from '../contracts/phase-capabilities';
import { resolveExecutableCommand } from '../lib/spawn-command';
import { CapabilityNotEnforceableError } from '../services/capability-refusal';
import type { ResolvedScannerExecutable } from '../services/containment-qualification/scanner-admission';

const MAX_SCANNER_DIGEST_BYTES = 128 * 1024 * 1024;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export interface NativeReviewInvocation {
  readonly kind: NativeReviewKind;
  readonly mergeBase: string;
  readonly excludedPaths?: readonly string[];
  /** FR-R8-02 (02-02): host-resolved canonical absolute executable path for `codex-security` (never re-resolved in bridge). */
  readonly resolvedScannerPath?: string;
  /** FR-R8-02 (02-02): host-computed SHA-256 digest of `resolvedScannerPath`, re-verified before spawn in bridge. */
  readonly resolvedScannerSha256?: string;
}

const STRIPPED_SCANNER_ENV_KEYS = new Set([
  'CODEX_SECURITY_PROJECT_CONFIG',
  'NODE_OPTIONS',
  'NODE_COMPILE_CACHE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'OPENSSL_CONF',
  'OPENSSL_MODULES',
  'OPENSSL_ENGINES'
]);

function isStrippedScannerEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return STRIPPED_SCANNER_ENV_KEYS.has(upper) || upper.startsWith('DYLD_');
}

function hashExecutableFileSync(filePath: string): { readonly realPath: string; readonly sha256: string } | null {
  try {
    const realPath = realpathSync(filePath);
    const st = statSync(realPath);
    if (!st.isFile() || st.size > MAX_SCANNER_DIGEST_BYTES) return null;
    const sha256 = createHash('sha256').update(readFileSync(realPath)).digest('hex');
    return { realPath, sha256 };
  } catch {
    return null;
  }
}

export function isReviewCommit(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

export function isReviewExclusion(value: string): boolean {
  return value.length > 0 && !value.includes('\0') && !value.includes('\\') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** The standalone scanner cannot enforce restrictions on the Codex CLI's tool set. */
export function assertCodexSecurityCapabilities(capabilities: DeclaredCapabilitySet | undefined): void {
  if (capabilities === undefined || capabilities.declaredAt === 'default') return;
  const withheld = ALL_PHASE_CAPABILITIES.filter((capability) => !grants(capabilities, capability));
  if (withheld.length > 0) throw new CapabilityNotEnforceableError('codex', withheld);
}

/**
 * Builds the exact sanitized environment shared between single host-side `codex-security`
 * executable resolution, version probing, and bridge launch. Strips ambient project-config and
 * dynamic-loader injection variables case-insensitively and removes relative `PATH` entries.
 */
export function buildCodexSecurityEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scanEnv: NodeJS.ProcessEnv = {};
  let sawPath = false;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || isStrippedScannerEnvKey(key)) continue;
    if (key.toUpperCase() === 'PATH') {
      sawPath = true;
      const directories = value.split(delimiter).filter(isAbsolute);
      if (directories.length === 0) {
        throw new Error('Codex Security needs an absolute executable search path.');
      }
      scanEnv[key] = directories.join(delimiter);
      continue;
    }
    scanEnv[key] = value;
  }
  scanEnv.GIT_OPTIONAL_LOCKS = '0';
  if (!sawPath && env.PATH !== undefined) {
    throw new Error('Codex Security needs an absolute executable search path.');
  }
  return scanEnv;
}

/**
 * Resolves `codex-security` ONCE under the exact sanitized spawn environment, canonicalizes
 * symlinks via `realpathSync`, and requires a readable regular file `<= 128 MiB` with a non-null
 * SHA-256 content digest so in-place swaps or symlink redirects cannot bypass bindings.
 */
export function resolveCodexSecurityExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): ResolvedScannerExecutable {
  let scanEnv: NodeJS.ProcessEnv;
  try {
    scanEnv = buildCodexSecurityEnv(env);
  } catch {
    return { ok: false, cause: 'not-found' };
  }
  const resolved = resolveExecutableCommand('codex-security', scanEnv, platform);
  if (!resolved.ok) {
    return { ok: false, cause: resolved.cause === 'not-executable' ? 'not-executable' : 'not-found' };
  }
  const hashed = hashExecutableFileSync(resolved.resolvedPath);
  if (hashed === null) {
    return { ok: false, cause: 'not-executable' };
  }
  return { ok: true, resolvedPath: hashed.realPath, binaryDigest: hashed.sha256 };
}

export function codexSecurityLaunch(
  review: NativeReviewInvocation,
  env: NodeJS.ProcessEnv,
  model?: string,
  effort?: string,
  resolvedScannerPath?: string,
  expectedScannerSha256?: string
) {
  if (!isReviewCommit(review.mergeBase) || review.excludedPaths?.some((path) => !isReviewExclusion(path))) {
    throw new Error('Native security review requires a resolved merge base and repository-relative exclusions.');
  }
  const commandPath = resolvedScannerPath ?? review.resolvedScannerPath;
  if (typeof commandPath !== 'string' || commandPath.length === 0 || !isAbsolute(commandPath) || commandPath.includes('\0')) {
    throw new Error('Codex Security requires a host-resolved absolute scanner executable path.');
  }
  const expectedDigest = expectedScannerSha256 ?? review.resolvedScannerSha256;
  if (typeof expectedDigest !== 'string' || !SHA256_HEX_RE.test(expectedDigest)) {
    throw new Error('Codex Security requires a host-admitted SHA-256 scanner executable digest.');
  }
  const verified = hashExecutableFileSync(commandPath);
  if (verified === null || verified.realPath !== commandPath || verified.sha256 !== expectedDigest) {
    throw new Error('Codex Security executable changed or became unreadable between admission and launch.');
  }
  const scanEnv = buildCodexSecurityEnv(env);
  // mkdtemp creates the scratch directory with owner-only permissions.
  const scratch = mkdtempSync(join(tmpdir(), 'schegent-security-review-'));
  return {
    command: verified.realPath,
    args: [
      'scan', '.', '--working-tree', '--base', review.mergeBase, '--headless', '--json', '--full-output',
      '--validate=false', '--patch=false', '--create-pr=false',
      ...[...new Set(['specs', '.specify', ...(review.excludedPaths ?? [])])].map((path) => `--exclude-path=${path}`),
      ...(model !== undefined ? [`--model=${model}`] : []),
      ...(effort !== undefined ? [`--effort=${effort}`] : []),
      '--output-dir', join(scratch, 'results')
    ],
    env: scanEnv,
    cleanup: () => rm(scratch, { recursive: true, force: true })
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Only a complete scan report can become review input. Keep report text bounded and omit raw evidence. */
export function summarizeSecurityScan(text: string, mergeBase: string): string | null {
  let envelope: Record<string, unknown> | null;
  try {
    envelope = object(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
  const data = envelope?.ok === true ? object(envelope.data) : null;
  const scan = object(object(data?.manifest)?.scan);
  const target = object(scan?.target);
  if (scan?.status !== 'completed' || target?.kind !== 'git_diff' || target.baseRevision !== mergeBase) return null;
  const coverage = object(data?.coverage);
  if (Array.isArray(coverage?.deferred) && coverage.deferred.length > 0) return null;
  const findings = object(data?.findings)?.findings;
  if (!Array.isArray(findings)) return null;
  const summaries = [];
  for (const item of findings as unknown[]) {
    const finding = object(item);
    if (typeof finding?.title !== 'string' || typeof finding.summary !== 'string' || !Array.isArray(finding.locations)) return null;
    const locations = [];
    for (const raw of finding.locations as unknown[]) {
      const location = object(raw);
      if (typeof location?.path !== 'string' || !isReviewExclusion(location.path) ||
          typeof location.startLine !== 'number' || !Number.isSafeInteger(location.startLine) || location.startLine < 1) return null;
      locations.push({ path: location.path, line: location.startLine });
    }
    if (locations.length === 0) return null;
    summaries.push({
      title: finding.title,
      summary: finding.summary,
      severity: object(finding.severity)?.level,
      locations,
      remediation: typeof finding.remediation === 'string' ? finding.remediation : undefined
    });
  }
  const report = JSON.stringify({ status: 'completed', findings: summaries });
  return report.length <= 32_768 ? report : null;
}
