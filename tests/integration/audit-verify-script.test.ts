import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../src/audit/audit-log-writer';
import { digestOf } from '../../src/audit/audit-chain';
import { SanitizedLogger } from '../../src/lib/logger';

/**
 * FR-R4-F03 (FR-016, FR-018; contract T16, O5; R18, R22) — `npm run audit:verify`, executed.
 *
 * This is the first test that RUNS `scripts/verify-audit-chain.ts` (R22). The script is outside
 * `tsc`, and it loads `src/audit/audit-chain.ts` under `node --experimental-strip-types`, which
 * resolves relative imports literally; that is why the chain module keeps no relative import.
 * A test that only imports the chain proves none of that, so this one spawns the real script.
 *
 * HOW THE FIXTURE REACHES THE SCRIPT. The script finds the workspace from its own location, not
 * from its working directory, so each fixture is a temporary copy of the layout it needs
 * (`scripts/verify-audit-chain.ts` beside `src/audit/audit-chain.ts`) with the real writer's output
 * in `.schegent/`. The copy is byte-for-byte the repository's file, so a stripped-types failure in
 * the real script is a failure here.
 *
 * WHAT THE SCRIPT CANNOT DO is stated by it, always: it reads no checkpoint, so it never reports a
 * loss verdict, and it says so on every run instead of letting a clean exit look like one.
 */

const REPO = path.resolve(__dirname, '..', '..');
const LOSS_LINE =
  "audit:verify: loss check: not performed (the checkpoint is kept in the extension's per-user storage, which this script does not read)";

interface Outcome {
  readonly status: number | null;
  readonly out: string;
  readonly err: string;
}

describe('npm run audit:verify, executed against fixture workspaces (T16)', () => {
  let layout: string;
  const auditDir = (): string => path.join(layout, '.schegent');
  const entry = (runId: string) =>
    ({ eventType: 'phase-start', runId, payload: { phase: 'implement' } }) as never;

  beforeEach(async () => {
    layout = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-verify-script-'));
    await fs.mkdir(path.join(layout, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(layout, 'src', 'audit'), { recursive: true });
    await fs.copyFile(
      path.join(REPO, 'scripts', 'verify-audit-chain.ts'),
      path.join(layout, 'scripts', 'verify-audit-chain.ts')
    );
    await fs.copyFile(
      path.join(REPO, 'src', 'audit', 'audit-chain.ts'),
      path.join(layout, 'src', 'audit', 'audit-chain.ts')
    );
  });

  afterEach(async () => {
    await fs.rm(layout, { recursive: true, force: true });
  });

  const writer = (overrides: Record<string, number> = {}): AuditLogWriter =>
    new AuditLogWriter({ workspaceRoot: layout, ...overrides }, new SanitizedLogger([]));

  const appendRows = async (w: AuditLogWriter, count: number): Promise<void> => {
    for (let n = 0; n < count; n += 1) await w.append(entry(`row-${n}`));
  };

  function runScript(): Outcome {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', path.join(layout, 'scripts', 'verify-audit-chain.ts')],
      { cwd: layout, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }
    );
    return { status: result.status, out: result.stdout, err: result.stderr };
  }

  it('an intact chain: exit 0, the transition, the counts, and the always-present loss line', async () => {
    await appendRows(writer(), 5);

    const result = runScript();

    expect(result.err, 'the script loads and runs under stripped types').toBe('');
    expect(result.status).toBe(0);
    expect(result.out).toContain('audit:verify: ok  5 entries chained, 0 legitimate cut(s)');
    expect(result.out).toContain('audit:verify: transition: genesis');
    expect(result.out).toContain(LOSS_LINE);
    expect(result.out).toContain(
      'whether recent entries were removed (loss detection needs the extension)'
    );
  });

  it('a history that began by linking to the last legacy row (form B): exit 0, transition legacy-tail', async () => {
    await fs.mkdir(auditDir(), { recursive: true });
    const legacy = Array.from({ length: 4 }, (_, n) =>
      JSON.stringify({ id: `legacy-${n}`, eventType: 'phase-start', runId: 'old', payload: {} })
    );
    await fs.writeFile(path.join(auditDir(), 'audit.log'), `${legacy.join('\n')}\n`);
    await appendRows(writer(), 3);

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.out).toContain('audit:verify: ok  3 entries chained');
    expect(result.out).toContain('audit:verify: transition: legacy-tail');
    expect(result.out).toContain('4 leading entries predate the chain');
    expect(result.out).toContain(LOSS_LINE);
    expect(digestOf(legacy[3] as string)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('legacy rows that retention removed are reported as pruned legacy rows', async () => {
    await fs.mkdir(auditDir(), { recursive: true });
    const legacy = Array.from({ length: 3 }, (_, n) =>
      JSON.stringify({ id: `legacy-${n}`, eventType: 'phase-start', runId: 'old', payload: {} })
    );
    await fs.writeFile(path.join(auditDir(), 'audit.log'), `${legacy.join('\n')}\n`);
    const rotating = writer({ rotationSizeBytes: 1, retentionMaxArchives: 1 });
    for (let n = 0; n < 4; n += 1) {
      await rotating.append(entry(`rotated-${n}`));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.out).toContain('audit:verify: pruned legacy rows: 3');
    expect(result.out).toContain(LOSS_LINE);
  });

  it('a diagnosed damaged tail: exit 0, one diagnosed damage line naming file, line, length and digest prefix', async () => {
    await appendRows(writer(), 2);
    const torn = '{"id":"torn","eventType":"phase-sta';
    await fs.appendFile(path.join(auditDir(), 'audit.log'), torn);
    await appendRows(writer(), 1);

    const result = runScript();

    expect(result.status).toBe(0);
    const damageLines = result.out.split('\n').filter((line) => line.startsWith('audit:verify: diagnosed damage:'));
    expect(damageLines).toHaveLength(1);
    expect(damageLines[0]).toMatch(
      new RegExp(`^audit:verify: diagnosed damage: audit\\.log line 3, ${Buffer.byteLength(torn)} bytes, sha256 [0-9a-f]{12}$`)
    );
    expect(result.out).toContain(LOSS_LINE);
  });

  it('an edited entry: exit 1, the break named at the first bad entry, and the loss line still present', async () => {
    await appendRows(writer(), 5);
    const logPath = path.join(auditDir(), 'audit.log');
    const rows = (await fs.readFile(logPath, 'utf8')).split('\n');
    rows[1] = (rows[1] as string).replace('"phase-start"', '"phase-end"');
    await fs.writeFile(logPath, rows.join('\n'));

    const result = runScript();

    expect(result.status).toBe(1);
    expect(result.err).toContain('audit:verify: broken-link at entry 3');
    expect(result.out).toContain(LOSS_LINE);
  });

  it('a workspace with no audit file: exit 0, and it says it cannot tell new from missing', () => {
    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.out).toContain('no audit file is present');
    expect(result.out).toContain('cannot tell a new workspace from missing history');
    expect(result.out, 'the old wording said there was nothing to verify').not.toContain('nothing to verify');
  });
});
