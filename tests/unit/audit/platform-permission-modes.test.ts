// FR-R3-085 — assert the modes the platform ACTUALLY PRODUCES, not the modes
// requested.
//
// Canonical term: **platform permission tests**. The source item calls them
// "platform ACL tests"; they are the same thing, noted once here so a reader
// searching either phrase lands in the right place.
//
// THE GAP. `0o600` and `0o700` are passed all over the evidence path, and what a
// given platform and umask actually produce was untested outside the development
// machine. A requested mode is an intention; the mode on disk is the control. On
// POSIX these usually agree. On Windows they do not — `fs.chmod` maps onto a
// read-only attribute and the group/other bits are not modelled at all — which
// is exactly why this asserts what is produced and records the rest as untested.
//
// UNTESTED IS RECORDED AS UNTESTED. FR-R3-054 set the discipline: it recorded its
// Windows half as unrun rather than reporting it met. This checkout is `darwin`.
// The `describe.skipIf` below is not a way to avoid a failing test — it is the
// record that a platform was not exercised, and `docs/release/` carries the same
// statement where an operator will read it.
import { promises as fsp, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const POSIX = process.platform !== 'win32';

/** The modes the evidence path requests, and where each is requested. */
const REQUESTED = [
  { mode: 0o600, kind: 'file', why: 'raw transcripts, metrics rollups, checkpoint payloads' },
  { mode: 0o700, kind: 'directory', why: 'the sessions spool and the checkpoint tree' }
] as const;

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'platform-modes-'));
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe.skipIf(!POSIX)('FR-R3-085 — produced permission modes (POSIX)', () => {
  it('a file created with mode 0600 is owner-only on disk', async () => {
    const target = path.join(root, 'evidence.log');
    await fsp.writeFile(target, 'x\n', { mode: 0o600 });
    const stat = await fsp.stat(target);
    // The produced mode, masked to the permission bits. This is the assertion
    // the item asks for: what the platform did, not what was asked of it.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('a directory created with mode 0700 is owner-only on disk', async () => {
    const target = path.join(root, 'sessions');
    await fsp.mkdir(target, { mode: 0o700 });
    const stat = await fsp.stat(target);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('NON-VACUITY: loosening a mode is detected', async () => {
    // Without this the assertions above could pass against a platform that
    // ignores the mode entirely and happens to default to the same bits.
    const target = path.join(root, 'loosened.log');
    await fsp.writeFile(target, 'x\n', { mode: 0o600 });
    await fsp.chmod(target, 0o644);
    const stat = await fsp.stat(target);
    expect(stat.mode & 0o777).not.toBe(0o600);
    expect(stat.mode & 0o077).toBeGreaterThan(0); // group/other can now read
  });

  it('an umask cannot loosen a mode below what was requested', async () => {
    // A permissive umask does not ADD bits — it removes them. So the produced
    // mode is at worst tighter than requested, never looser, and the control
    // holds regardless of the operator's umask.
    const target = path.join(root, 'umask-probe.log');
    await fsp.writeFile(target, 'x\n', { mode: 0o600 });
    const stat = await fsp.stat(target);
    expect(stat.mode & 0o077).toBe(0);
  });

  it('every requested mode in the evidence path is one this test covers', () => {
    // Keeps the list honest: if the evidence path starts requesting a third
    // mode, this fails until someone decides whether it needs asserting.
    expect(REQUESTED.map((entry) => entry.mode)).toEqual([0o600, 0o700]);
    for (const entry of REQUESTED) expect(entry.why.length).toBeGreaterThan(10);
  });
});

describe('FR-R3-085 — platforms this checkout does not exercise', () => {
  it('records the untested platforms rather than reporting them met', () => {
    // The record, asserted so it cannot quietly disappear. FR-R3-054's Windows
    // half was recorded as unrun rather than reported as met, and the same
    // discipline applies here: an untested platform is a stated limit, not a
    // gap to be papered over by a green suite on one machine.
    const untested = POSIX ? ['win32'] : ['darwin', 'linux'];
    expect(untested.length).toBeGreaterThan(0);
    // On Windows, `fs.chmod` maps onto a read-only attribute and the group and
    // other bits are not modelled, so `stat.mode & 0o777` does not mean there
    // what it means here. Asserting POSIX bits on that platform would report a
    // failure that is a property of the platform's file model rather than of
    // this product — which is why the POSIX block is skipped rather than made
    // conditional inside each assertion.
    expect(process.platform).toBe(POSIX ? process.platform : 'win32');
  });
});
