import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { NativeReviewKind } from '../contracts/process-definitions';
import { ALL_PHASE_CAPABILITIES, grants, type DeclaredCapabilitySet } from '../contracts/phase-capabilities';
import { CapabilityNotEnforceableError } from '../services/capability-refusal';

export interface NativeReviewInvocation {
  readonly kind: NativeReviewKind;
  readonly mergeBase: string;
  readonly excludedPaths?: readonly string[];
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

export function codexSecurityLaunch(review: NativeReviewInvocation, env: NodeJS.ProcessEnv, model?: string, effort?: string) {
  if (!isReviewCommit(review.mergeBase) || review.excludedPaths?.some((path) => !isReviewExclusion(path))) {
    throw new Error('Native security review requires a resolved merge base and repository-relative exclusions.');
  }
  const scanEnv: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  if (env.PATH !== undefined) {
    const directories = env.PATH.split(delimiter).filter(isAbsolute);
    if (directories.length === 0) throw new Error('Codex Security needs an absolute executable search path.');
    scanEnv.PATH = directories.join(delimiter);
  }
  delete scanEnv.CODEX_SECURITY_PROJECT_CONFIG;
  // mkdtemp creates the scratch directory with owner-only permissions.
  const scratch = mkdtempSync(join(tmpdir(), 'schegent-security-review-'));
  return {
    command: 'codex-security',
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
