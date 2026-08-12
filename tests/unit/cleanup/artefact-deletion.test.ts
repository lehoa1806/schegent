// Feature 091 T014 — contract C-05, FR-015: which files cleanup may
// delete from the Wake-up data directory, and which it must leave.
//
// The retained files are the point. The invocation log and the session
// log are historical records the operator may still need, and the
// directory itself must survive because those logs live in it. Deleting
// only what makes an entry *invocable* is what separates this from
// "remove the wake-up folder".

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { deleteInvocableArtefacts } from '../../../src/cleanup/wakeup-cleanup';
import { CLEANUP_ARTEFACTS } from '../../../src/cleanup/cleanup-record';

const INVOCABLE = ['runner.js', 'settings.json', 'workspace-roots.json'] as const;
const RETAINED = ['invocations.log', 'session.log'] as const;

describe('C-05 artefact deletion', () => {
  let home: string;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'schegent-wakeup-home-'));
    for (const name of [...INVOCABLE, ...RETAINED]) {
      await fs.writeFile(path.join(home, name), `contents of ${name}`, 'utf8');
    }
  });

  afterEach(() => {
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it('deletes exactly the three invocable artefacts', async () => {
    const result = await deleteInvocableArtefacts(home, fs);
    expect([...result.removed].sort()).toEqual([...INVOCABLE].sort());
    expect(result.failures).toEqual([]);

    for (const name of INVOCABLE) {
      await expect(fs.stat(path.join(home, name))).rejects.toThrow();
    }
  });

  it('retains the invocation log, the session log, and the directory itself', async () => {
    await deleteInvocableArtefacts(home, fs);

    for (const name of RETAINED) {
      expect(await fs.readFile(path.join(home, name), 'utf8')).toBe(`contents of ${name}`);
    }
    expect(readdirSync(home).sort()).toEqual([...RETAINED].sort());
  });

  it('treats an absent file as already clean, never as a failure', async () => {
    await fs.unlink(path.join(home, 'settings.json'));

    const result = await deleteInvocableArtefacts(home, fs);
    expect(result.failures).toEqual([]);
    expect([...result.removed].sort()).toEqual(['runner.js', 'workspace-roots.json']);
  });

  it('reports nothing removed and no failure when the directory does not exist', async () => {
    const missing = path.join(home, 'never-created');
    const result = await deleteInvocableArtefacts(missing, fs);
    expect(result.removed).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('records bare filenames only — never a path', async () => {
    const result = await deleteInvocableArtefacts(home, fs);
    for (const name of result.removed) {
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name).not.toContain(home);
      expect(CLEANUP_ARTEFACTS).toContain(name);
    }
  });

  it('touches nothing outside the three named artefacts', async () => {
    // Files that look adjacent to the closed set, including one whose
    // name embeds an artefact name.
    const bystanders = [
      'runner.js.bak',
      'settings.json.tmp',
      'workspace-roots.json.old',
      'runner.mjs',
      'other-settings.json'
    ];
    for (const name of bystanders) {
      await fs.writeFile(path.join(home, name), 'bystander', 'utf8');
    }

    await deleteInvocableArtefacts(home, fs);

    for (const name of bystanders) {
      expect(await fs.readFile(path.join(home, name), 'utf8')).toBe('bystander');
    }
  });

  it('does not recurse into subdirectories', async () => {
    const nested = path.join(home, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'runner.js'), 'nested runner', 'utf8');

    await deleteInvocableArtefacts(home, fs);

    expect(await fs.readFile(path.join(nested, 'runner.js'), 'utf8')).toBe('nested runner');
  });

  it('issues exactly one unlink per artefact, against the joined path', async () => {
    const seen: string[] = [];
    await deleteInvocableArtefacts(home, {
      unlink: async (p) => {
        seen.push(p);
      }
    });

    expect(seen).toEqual([
      path.join(home, 'runner.js'),
      path.join(home, 'settings.json'),
      path.join(home, 'workspace-roots.json')
    ]);
  });

  it('records a non-ENOENT failure without aborting the remaining artefacts', async () => {
    const result = await deleteInvocableArtefacts(home, {
      unlink: async (p) => {
        if (p.endsWith('settings.json')) {
          const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
          err.code = 'EACCES';
          throw err;
        }
      }
    });

    expect(result.failures).toEqual(['settings.json']);
    // The other two were still attempted — one refused file must not
    // leave the rest of the entry invocable.
    expect([...result.removed]).toEqual(['runner.js', 'workspace-roots.json']);
  });

  it('is idempotent — a second run reports nothing removed and no failure', async () => {
    await deleteInvocableArtefacts(home, fs);
    const second = await deleteInvocableArtefacts(home, fs);

    expect(second.removed).toEqual([]);
    expect(second.failures).toEqual([]);
  });
});
