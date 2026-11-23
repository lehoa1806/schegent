import { createHash } from 'node:crypto';
import type { BackendRunnerKind } from './backend-kinds';

export const MAX_AGENT_CONFIG_FILE_BYTES = 262_144;

type FingerprintEntry = { readonly name: string } & (
  | { readonly status: 'present'; readonly size: number; readonly digest: string }
  | { readonly status: 'unreadable'; readonly unreadableReason: string }
);

/** The persisted fingerprint format shared by the scanner and acknowledgement reader. */
export function computeAgentConfigFingerprint(
  backend: BackendRunnerKind,
  entries: readonly FingerprintEntry[],
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
  if (scanError) lines.push(`scan-error:${scanErrorReason ?? 'scan-failed'}`);
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}
