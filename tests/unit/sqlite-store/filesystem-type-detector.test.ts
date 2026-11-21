// FR-R7-11 (T003, FR-016) — Unit tests for host OS filesystem type detection and mount parsers.
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyFilesystemTypeName,
  classifyWin32Path,
  detectFilesystemType,
  parseDarwinMountOutput,
  parseLinuxMountInfo,
  parseLinuxProcMounts
} from '../../../src/services/sqlite-store/filesystem-type-detector';
import { removeTempRoot } from '../../temp-root-cleanup';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await removeTempRoot(tempDirs.pop()!);
  }
});

describe('FR-R7-11 — filesystem-type-detector', () => {
  describe('classifyFilesystemTypeName', () => {
    it('classifies known local, network, and unknown filesystem names accurately', () => {
      for (const localFs of ['apfs', 'ext4', 'xfs', 'btrfs', 'tmpfs', 'ntfs', 'local', 'APFS']) {
        expect(classifyFilesystemTypeName(localFs)).toEqual({
          classification: 'local',
          filesystemType: localFs.toLowerCase()
        });
      }
      for (const netFs of ['nfs', 'nfs4', 'smb', 'smbfs', 'cifs', 'afp', 'afpfs', 'webdav', 'fuse.sshfs', 'ncpfs', 'unc']) {
        expect(classifyFilesystemTypeName(netFs)).toEqual({
          classification: 'network',
          filesystemType: netFs.toLowerCase()
        });
      }
      expect(classifyFilesystemTypeName(undefined)).toEqual({ classification: 'unknown', filesystemType: 'unknown' });
      expect(classifyFilesystemTypeName('')).toEqual({ classification: 'unknown', filesystemType: 'unknown' });
      expect(classifyFilesystemTypeName('autofs')).toEqual({ classification: 'unknown', filesystemType: 'autofs' });
      expect(classifyFilesystemTypeName('fuse.opaque')).toEqual({ classification: 'unknown', filesystemType: 'fuse.opaque' });
    });
  });

  describe('parseDarwinMountOutput', () => {
    const sampleMount = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
      '//alice@nas/Team Share on /Volumes/Team Share (smbfs, nodev, nosuid, mounted by alice)',
      '//alice@nas/Work on NAS on /Volumes/Work on NAS (smbfs, nodev)',
      'nas.internal:/export/work on /Users/alice/nfs-home (nfs, nodev, nosuid)',
      'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)'
    ].join('\n');

    it('matches longest mount-point prefix including paths with spaces', () => {
      expect(parseDarwinMountOutput(sampleMount, '/Users/alice/local/db')).toEqual({
        classification: 'local',
        filesystemType: 'apfs'
      });
      expect(parseDarwinMountOutput(sampleMount, '/Volumes/Team Share/globalStorage/sqlite/abc')).toEqual({
        classification: 'network',
        filesystemType: 'smbfs'
      });
      expect(parseDarwinMountOutput(sampleMount, '/Volumes/Work on NAS/globalStorage/sqlite/abc')).toEqual({
        classification: 'network',
        filesystemType: 'smbfs'
      });
      expect(
        parseDarwinMountOutput(
          'Work on NAS on /Volumes/Work on NAS (smbfs, nodev)',
          '/Volumes/Work on NAS/sqlite/scope'
        )
      ).toEqual({
        classification: 'network',
        filesystemType: 'smbfs'
      });
      expect(parseDarwinMountOutput(sampleMount, '/Users/alice/nfs-home/.config/Code')).toEqual({
        classification: 'network',
        filesystemType: 'nfs'
      });
      // Prefix lookalike must NOT match /Users/alice/nfs-home
      expect(parseDarwinMountOutput(sampleMount, '/Users/alice/nfs-home-local/db')).toEqual({
        classification: 'local',
        filesystemType: 'apfs'
      });
      expect(parseDarwinMountOutput(sampleMount, '/System/Volumes/Data/home/alice')).toEqual({
        classification: 'unknown',
        filesystemType: 'autofs'
      });
    });

    it('returns unknown for malformed or empty output', () => {
      expect(parseDarwinMountOutput('', '/tmp/x')).toEqual({ classification: 'unknown', filesystemType: 'unknown' });
      expect(parseDarwinMountOutput('not a mount line', '/tmp/x')).toEqual({
        classification: 'unknown',
        filesystemType: 'unknown'
      });
    });
  });

  describe('parseLinuxMountInfo and parseLinuxProcMounts', () => {
    const sampleMountInfo = [
      '23 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw,errors=remount-ro',
      '45 23 0:42 / /mnt/corp\\040share rw,relatime shared:2 - cifs //files/share rw,vers=3.0',
      '46 23 0:43 / /home/alice/remote rw,nosuid - fuse.sshfs alice@host:/data rw',
      '47 23 0:44 / /srv/nfs rw,relatime - nfs4 10.0.0.1:/export rw'
    ].join('\n');

    it('parses /proc/self/mountinfo with octal-escaped mount points and optional fields', () => {
      expect(parseLinuxMountInfo(sampleMountInfo, '/home/alice/.config/Code/User/globalStorage')).toEqual({
        classification: 'local',
        filesystemType: 'ext4'
      });
      expect(parseLinuxMountInfo(sampleMountInfo, '/mnt/corp share/sqlite/scope')).toEqual({
        classification: 'network',
        filesystemType: 'cifs'
      });
      expect(parseLinuxMountInfo(sampleMountInfo, '/home/alice/remote/ws')).toEqual({
        classification: 'network',
        filesystemType: 'fuse.sshfs'
      });
      expect(parseLinuxMountInfo(sampleMountInfo, '/srv/nfs/storage')).toEqual({
        classification: 'network',
        filesystemType: 'nfs4'
      });
    });

    it('parses /proc/mounts fallback format', () => {
      const sampleProcMounts = [
        '# comment line',
        '/dev/nvme0n1p2 / xfs rw,relatime 0 0',
        '10.0.0.5:/share /mnt/my\\040nfs nfs rw,vers=3 0 0'
      ].join('\n');

      expect(parseLinuxProcMounts(sampleProcMounts, '/var/tmp/local')).toEqual({
        classification: 'local',
        filesystemType: 'xfs'
      });
      expect(parseLinuxProcMounts(sampleProcMounts, '/mnt/my nfs/state')).toEqual({
        classification: 'network',
        filesystemType: 'nfs'
      });
    });
  });

  describe('classifyWin32Path', () => {
    it('classifies UNC shares as network/smb and local drive paths as local', () => {
      expect(classifyWin32Path('\\\\fileserver\\share\\globalStorage')).toEqual({
        classification: 'network',
        filesystemType: 'smb'
      });
      expect(classifyWin32Path('\\\\?\\UNC\\fileserver\\share\\sqlite')).toEqual({
        classification: 'network',
        filesystemType: 'smb'
      });
      expect(classifyWin32Path('//fileserver/share/state')).toEqual({
        classification: 'network',
        filesystemType: 'smb'
      });
      expect(classifyWin32Path('C:\\Users\\alice\\AppData\\Roaming\\Code')).toEqual({
        classification: 'local',
        filesystemType: 'local'
      });
      expect(classifyWin32Path('\\\\?\\D:\\schegent\\state')).toEqual({
        classification: 'local',
        filesystemType: 'local'
      });
      expect(classifyWin32Path('relative/path')).toEqual({
        classification: 'unknown',
        filesystemType: 'unknown'
      });
    });
  });

  describe('detectFilesystemType ancestor walk and platform dispatch', () => {
    it('walks up to nearest existing ancestor without creating missing subdirectories', async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fr-r7-11-fsdet-'));
      tempDirs.push(root);
      const nonExistentLeaf = path.join(root, 'never-created-a', 'never-created-b', 'sqlite', 'scope');

      const verdict = await detectFilesystemType(nonExistentLeaf);
      expect(verdict.classification).toBe('local');
      expect(verdict.filesystemType).not.toBe('unknown');
      // Must NOT have created any directory during probe.
      await expect(fsp.lstat(path.join(root, 'never-created-a'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('returns unknown on darwin when /sbin/mount execution fails', async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fr-r7-11-darwin-err-'));
      tempDirs.push(root);
      const verdict = await detectFilesystemType(path.join(root, 'future-dir'), {
        platform: 'darwin',
        execDarwinMount: async () => {
          throw new Error('mount failed');
        }
      });
      expect(verdict.classification).toBe('unknown');
      expect(verdict.filesystemType).toBe('unknown');
    });

    it('falls back from mountinfo to /proc/mounts on linux', async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'fr-r7-11-linux-fb-'));
      tempDirs.push(root);
      const resolvedRoot = await fsp.realpath(root);
      const verdict = await detectFilesystemType(path.join(root, 'missing-sub'), {
        platform: 'linux',
        readLinuxMountInfo: async () => null,
        readLinuxProcMounts: async () => `10.0.0.2:/vol ${resolvedRoot} nfs4 rw 0 0\n`
      });
      expect(verdict.classification).toBe('network');
      expect(verdict.filesystemType).toBe('nfs4');
    });

    it('classifies UNC paths immediately as network on win32 without requiring mount commands', async () => {
      const verdict = await detectFilesystemType('\\\\corp-nas\\profiles\\alice\\Code', {
        platform: 'win32'
      });
      expect(verdict).toEqual({ classification: 'network', filesystemType: 'smb' });
    });
  });
});
