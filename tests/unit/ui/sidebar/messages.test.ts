import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// Feature 013 — Wave 5 (US5): the host and webview shims were collapsed
// to single `export *` re-exports of `src/contracts/sidebar-ipc.ts`. The
// historical "do both shims declare the same literals?" check is now
// redundant with the module-identity check in
// `tests/unit/contracts/sidebar-ipc-drift.test.ts`. This file now
// guards the AUTHORITATIVE module's source text directly.

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const AUTHORITATIVE_PATH = path.join(REPO_ROOT, 'src', 'contracts', 'sidebar-ipc.ts');

const LITERAL_RX = /export const (CMD_[A-Z_]+|STATE_[A-Z_]+) = ['"]([A-Z_]+)['"]/g;

interface ParsedLiterals {
  symbols: ReadonlyMap<string, string>;
  count: number;
}

function readLiterals(filePath: string): ParsedLiterals {
  const src = fs.readFileSync(filePath, 'utf8');
  const map = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = LITERAL_RX.exec(src)) !== null) {
    map.set(match[1], match[2]);
  }
  LITERAL_RX.lastIndex = 0;
  return { symbols: map, count: map.size };
}

describe('messages literal mirror (Wave 5 — authoritative module)', () => {
  it('the authoritative IPC contract declares a non-empty set of CMD_/STATE_ literals', () => {
    const authoritative = readLiterals(AUTHORITATIVE_PATH);
    expect(authoritative.count).toBeGreaterThan(0);
    for (const [symbol, literal] of authoritative.symbols) {
      expect(symbol, 'symbol name and literal must agree').toBe(literal);
    }
  });

  it('declares all 004-era command constants in the authoritative module', () => {
    const authoritative = readLiterals(AUTHORITATIVE_PATH);
    const expected = [
      'CMD_RETRY_QUEUE_ITEM',
      'CMD_MOVE_QUEUE_ITEM_UP',
      'CMD_MOVE_QUEUE_ITEM_DOWN',
      'CMD_PAUSE_QUEUE',
      'CMD_RESUME_QUEUE',
      'CMD_CLEAR_COMPLETED',
      'CMD_CLEAR_FAILED',
      'CMD_OPEN_DASHBOARD',
      'CMD_RETRY_ACTIVE_RUN',
      'CMD_OPEN_QUEUE_ITEM_DETAILS',
      'CMD_OPEN_HISTORY_ITEM_DETAILS',
      'CMD_RERUN_FROM_HISTORY'
    ];
    for (const symbol of expected) {
      expect(authoritative.symbols.has(symbol), `${symbol} must be declared`).toBe(true);
    }
  });

  // Feature 100 (T509) — `CMD_SAVE_PIPELINES` and `CMD_SAVE_PHASES` were two of
  // this era's five, and the lifecycle retired both along with the whole-array
  // layer envelope they carried. What the test claims is unchanged: every
  // command literal is declared in the authoritative module and nowhere else.
  // The two names are replaced by the commands that now do their work rather
  // than dropped, because a shortened list would let a literal drift out of the
  // barrel while the era still looked covered.
  it('declares the 011+012-era command constants in the authoritative module', () => {
    const authoritative = readLiterals(AUTHORITATIVE_PATH);
    const expected = [
      'CMD_SAVE_DEFINITION_DRAFT',
      'CMD_PUBLISH_DEFINITION',
      'CMD_PUBLISH_PACKAGE',
      'CMD_SAVE_MODELS',
      'CMD_SAVE_GENERAL_SETTINGS',
      'CMD_RETRY_PHASE_NOW'
    ];
    for (const symbol of expected) {
      expect(authoritative.symbols.has(symbol), `${symbol} must be declared`).toBe(true);
    }
  });
});
