// Feature 251 (FR-R4-F04, contract T14, SC-008, FR-022; E3 step 3) — whether an export destination is
// inside the evidence store, by where it RESOLVES and not by how it is spelled.
//
// What it pins: `classifyDestination(target, protectedRoots)` over a real temporary tree gives `inside` for
// `<ws>/.schegent/x`, for a symlink that points into `.schegent`, for a not-yet-existing child of such a
// link, and for the `..` variant that reaches it; `inside` for a case variant on a case-insensitive volume
// (skipped, with its reason, elsewhere); `unresolvable` for an ancestor that cannot be read; and `outside`
// for a plain folder.
//
// Why: the filing's finding (S-22) is that the check was a regular expression over the path's text, so an
// alias (a link, a `..`, a case variant) produced output inside the store that the text never named. Every
// `inside` here is a destination the old check called outside; each is paired with a control that is truly
// outside and must be classified so.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { classifyDestination } from '../../../src/lib/path-containment';
import { resolveExportDestination } from '../../../src/services/export-destination';
import { removeTempRoot } from '../../temp-root-cleanup';

let scratch: string;
let workspace: string;
let store: string;
let elsewhere: string;
const posixOnly = process.platform === 'win32' ? it.skip : it;

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'schegent-destination-')));
  workspace = path.join(scratch, 'workspace');
  store = path.join(workspace, '.schegent');
  elsewhere = path.join(scratch, 'elsewhere');
  await fs.mkdir(path.join(store, 'sessions'), { recursive: true });
  await fs.mkdir(elsewhere, { recursive: true });
});

afterEach(async () => {
  await removeTempRoot(scratch);
});

describe('classifyDestination (T14)', () => {
  it('is inside for a path in .schegent, existing or not', async () => {
    expect(await classifyDestination(path.join(store, 'sessions'), [store])).toBe('inside');
    expect(await classifyDestination(path.join(store, 'new-folder', 'out.json'), [store])).toBe('inside');
    expect(await classifyDestination(store, [store])).toBe('inside');
  });

  it('is outside for a plain folder, existing or not, and the control for every inside case', async () => {
    expect(await classifyDestination(elsewhere, [store])).toBe('outside');
    expect(await classifyDestination(path.join(elsewhere, 'not-yet', 'out.json'), [store])).toBe('outside');
    expect(await classifyDestination(path.join(workspace, 'exports'), [store])).toBe('outside');
  });

  posixOnly('is inside for a symlink that points into .schegent', async () => {
    const link = path.join(elsewhere, 'looks-harmless');
    await fs.symlink(path.join(store, 'sessions'), link);
    expect(await classifyDestination(link, [store])).toBe('inside');
    expect(await classifyDestination(path.join(link, 'out.json'), [store])).toBe('inside');
  });

  posixOnly('is inside for a not-yet-existing child of such a link', async () => {
    const link = path.join(elsewhere, 'alias');
    await fs.symlink(store, link);
    expect(await classifyDestination(path.join(link, 'a', 'b', 'out.json'), [store])).toBe('inside');
  });

  it('is inside for a `..` variant that reaches .schegent', async () => {
    const variant = path.join(elsewhere, '..', 'workspace', '.schegent', 'sessions', '..', 'out.json');
    expect(await classifyDestination(variant, [store])).toBe('inside');
    // The control: the same spelling reaching a folder that is not the store.
    expect(await classifyDestination(path.join(elsewhere, '..', 'workspace', 'exports', 'out.json'), [store])).toBe('outside');
  });

  it('is inside for an entry of .schegent whose name starts with `..`', async () => {
    // `..archive` is a legal name, not a step up: a bare `..` prefix test read it as outside the store.
    await fs.mkdir(path.join(store, '..archive'));
    expect(await classifyDestination(path.join(store, '..archive', 'out.json'), [store])).toBe('inside');
    expect(await classifyDestination(path.join(store, '..new', 'out.json'), [store])).toBe('inside');
    // The control: a sibling of the store whose name merely starts with it.
    expect(await classifyDestination(path.join(workspace, '.schegent..x', 'out.json'), [store])).toBe('outside');
  });

  it('refuses an export destination below a `..`-named entry of .schegent', async () => {
    const uri = { scheme: 'file', fsPath: path.join(store, '..archive', 'out.json') };
    expect(await resolveExportDestination(uri, workspace)).toEqual({ ok: false, refusal: 'destination-in-evidence-store' });
    await fs.mkdir(path.join(store, '..archive'));
    expect(await resolveExportDestination(uri, workspace)).toEqual({ ok: false, refusal: 'destination-in-evidence-store' });
    expect(await resolveExportDestination({ scheme: 'file', fsPath: path.join(elsewhere, 'out.json') }, workspace)).toEqual({
      ok: true,
      path: path.join(elsewhere, 'out.json')
    });
  });

  it('is inside for a case variant on a case-insensitive volume', async function () {
    const probe = path.join(scratch, 'CaseProbe');
    await fs.mkdir(probe);
    const insensitive = await fs.stat(path.join(scratch, 'caseprobe')).then(
      () => true,
      () => false
    );
    if (!insensitive) {
      // Case-sensitive volume (the usual Linux case): a case variant names a different directory, so there
      // is nothing to alias. Recorded as skipped, with its reason, rather than silently passing.
      console.log('[T14] case-sensitive volume: the case-variant case does not apply here');
      return;
    }
    expect(await classifyDestination(path.join(workspace, '.SCHEGENT', 'x', 'out.json'), [store])).toBe('inside');
  });

  posixOnly('is unresolvable when an ancestor cannot be read', async () => {
    const locked = path.join(elsewhere, 'locked');
    await fs.mkdir(path.join(locked, 'inner'), { recursive: true });
    await fs.chmod(locked, 0o000);
    try {
      if (process.getuid?.() === 0) return;
      expect(await classifyDestination(path.join(locked, 'inner', 'deeper', 'out.json'), [store])).toBe('unresolvable');
    } finally {
      await fs.chmod(locked, 0o700);
    }
  });
});
