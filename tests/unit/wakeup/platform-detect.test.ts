// Feature 014 T016 — unit tests for platform detection.
//
// `detectPlatform()` exposes two injection seams (platform string +
// systemd probe). Production callers pass none; tests pass both to
// exercise every branch without touching globals.

import { describe, it, expect } from 'vitest';
import { detectPlatform } from '../../../src/wakeup/platform-detect';

describe('detectPlatform', () => {
  it('darwin → darwin (probe ignored)', () => {
    expect(detectPlatform('darwin', () => true)).toBe('darwin');
    expect(detectPlatform('darwin', () => false)).toBe('darwin');
  });

  it('win32 → win32 (probe ignored)', () => {
    expect(detectPlatform('win32', () => true)).toBe('win32');
    expect(detectPlatform('win32', () => false)).toBe('win32');
  });

  it('linux + systemd-user → linux-systemd', () => {
    expect(detectPlatform('linux', () => true)).toBe('linux-systemd');
  });

  it('linux + no systemd → linux-cron', () => {
    expect(detectPlatform('linux', () => false)).toBe('linux-cron');
  });

  it('unsupported platform → linux-cron fallback', () => {
    expect(detectPlatform('freebsd' as NodeJS.Platform, () => false)).toBe('linux-cron');
  });

  it('default arg path returns a valid platform on the host', () => {
    const r = detectPlatform();
    expect(['darwin', 'win32', 'linux-systemd', 'linux-cron']).toContain(r);
  });
});
