import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AuditLogWriter } from '../../../src/audit/audit-log-writer';
import { SanitizedLogger } from '../../../src/lib/logger';

/**
 * FR-R3-053 (H-02) — the audit append composes its path lexically and appends
 * with no containment check.
 *
 * No race is required. A `.schegent` symlink that already exists inside the
 * workspace, pointing anywhere, redirects the very next append: `mkdir
 * -p`/`appendFile` both follow the link, so the audit log -- the append-only
 * evidence record -- is written outside the workspace entirely.
 *
 * The oracle is where the bytes LAND, read from the real filesystem. Asserting
 * on the writer's own idea of its path would only restate the lexical
 * composition that is the defect.
 */
describe('the audit append stays inside the workspace (H-02)', () => {
  let root: string;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-escape-'));
    workspace = path.join(root, 'workspace');
    outside = path.join(root, 'outside');
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const entry = () =>
    ({ eventType: 'phase-start', runId: 'run-1', payload: { phase: 'implement' } }) as never;

  const listing = async (dir: string): Promise<readonly string[]> => {
    try {
      return (await fs.readdir(dir)).sort();
    } catch {
      return [];
    }
  };

  it('does not follow a pre-existing .schegent symlink out of the workspace', async () => {
    await fs.symlink(outside, path.join(workspace, '.schegent'));
    const writer = new AuditLogWriter({ workspaceRoot: workspace }, new SanitizedLogger());

    await writer.append(entry()).catch(() => undefined);

    // Nothing may appear outside the workspace, whatever the writer decided to
    // do about the redirect.
    expect(await listing(outside)).toEqual([]);
  });

  it('does not follow a symlinked audit.log out of the workspace', async () => {
    // The other half of the same hole: the directory is real, the FILE is the
    // link. `appendFile` follows it just as readily.
    const dir = path.join(workspace, '.schegent');
    await fs.mkdir(dir);
    const target = path.join(outside, 'stolen.log');
    await fs.writeFile(target, '');
    await fs.symlink(target, path.join(dir, 'audit.log'));

    const writer = new AuditLogWriter({ workspaceRoot: workspace }, new SanitizedLogger());
    await writer.append(entry()).catch(() => undefined);

    expect(await fs.readFile(target, 'utf8')).toBe('');
  });
});
