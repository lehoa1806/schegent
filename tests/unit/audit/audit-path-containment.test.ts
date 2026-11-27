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

  it('refuses to rotate a symlinked audit.log even when its external target exceeds rotationSizeBytes (FR-R7-18 / N11)', async () => {
    const dir = path.join(workspace, '.schegent');
    await fs.mkdir(dir);
    const externalTarget = path.join(outside, 'large-external.log');
    await fs.writeFile(externalTarget, 'x'.repeat(2048));
    await fs.symlink(externalTarget, path.join(dir, 'audit.log'));

    const writer = new AuditLogWriter(
      { workspaceRoot: workspace, rotationSizeBytes: 64 },
      new SanitizedLogger()
    );
    await expect(writer.append(entry())).rejects.toThrow();

    // The symlink must still be in place (not renamed to an archive) and outside must be untouched.
    expect((await fs.lstat(path.join(dir, 'audit.log'))).isSymbolicLink()).toBe(true);
    const schegentEntries = await listing(dir);
    expect(schegentEntries.filter((name) => name.startsWith('audit.log.'))).toEqual([]);
    expect(await fs.readFile(externalTarget, 'utf8')).toBe('x'.repeat(2048));
  });

  it('skips symlinked archive slots during retention pruning without following or unlinking them (FR-R7-18 / N11)', async () => {
    const dir = path.join(workspace, '.schegent');
    await fs.mkdir(dir);
    const externalArchive = path.join(outside, 'external-archive.log');
    await fs.writeFile(externalArchive, 'do-not-delete\n');

    // Create 1 real archive and 2 symlinked archive slots with newer mtimes; with
    // retentionMaxArchives=1, symlinks must be ignored (neither unlinked nor counted
    // against retentionMaxArchives so the legitimate real archive stays preserved).
    const realArchive = path.join(dir, 'audit.log.20260801-000001-000-aaaaaaaa');
    await fs.writeFile(realArchive, '{"id":"1"}\n');
    const symlinkNewer1 = path.join(dir, 'audit.log.20260802-000001-000-bbbbbbbb');
    const symlinkNewer2 = path.join(dir, 'audit.log.20260803-000001-000-cccccccc');
    await fs.symlink(externalArchive, symlinkNewer1);
    await fs.symlink(externalArchive, symlinkNewer2);

    const writer = new AuditLogWriter(
      { workspaceRoot: workspace, retentionMaxArchives: 1 },
      new SanitizedLogger()
    );
    expect(await writer.runArchiveMaintenance()).toBe('ran');

    expect(await fs.readFile(externalArchive, 'utf8')).toBe('do-not-delete\n');
    expect((await fs.lstat(symlinkNewer1)).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(symlinkNewer2)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(realArchive, 'utf8')).toBe('{"id":"1"}\n');
  });

  it('rotates and prunes legitimate regular audit files using canonical resolved paths under a symlinked workspace alias', async () => {
    const workspaceAlias = path.join(root, 'workspace-alias');
    await fs.symlink(workspace, workspaceAlias);

    const writer = new AuditLogWriter(
      {
        workspaceRoot: workspaceAlias,
        rotationSizeBytes: 120,
        retentionMaxArchives: 1
      },
      new SanitizedLogger()
    );

    // Three appends exceed 120 bytes each time, triggering two rotations and pruning the oldest archive.
    await writer.append(entry());
    await writer.append(entry());
    await writer.append(entry());

    const schegentEntries = await listing(path.join(workspace, '.schegent'));
    const rotated = schegentEntries.filter((name) => /^audit\.log\.\d{8}-/.test(name));
    expect(rotated).toHaveLength(1);
    expect(schegentEntries).toContain('audit.log');
    expect(schegentEntries).toContain('audit.log.cuts');
    expect(await listing(outside)).toEqual([]);
  });
});
