import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * FR-R3-059 (H-08 / RE-01) — the manifest's VS Code floor and the API surface
 * the host is compiled against must agree.
 *
 * `engines.vscode` declared `^1.85.0` while `@types/vscode` carried a caret and
 * resolved to 1.118.0. Nothing established a break on 1.85; the claim was simply
 * unbacked, and the host was type-checked against 33 minor versions of API the
 * floor does not promise. A call into anything added after 1.85 would compile
 * here and throw on a floor install.
 *
 * This gate makes the two agree by construction. It does NOT establish runtime
 * qualification -- see the README note and the item record for what remains.
 */
const ROOT = resolve(__dirname, '..', '..');

interface Manifest {
  readonly engines?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, relative), 'utf8')) as T;
}

/** `1.85.0` from `^1.85.0`, `>=1.85.0`, or `1.85.0`. */
function floorOf(range: string): readonly number[] {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!match) throw new Error(`unparseable version range: ${range}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

const compare = (a: readonly number[], b: readonly number[]): number =>
  a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

describe('the declared VS Code floor is the API the host compiles against', () => {
  const manifest = readJson<Manifest>('package.json');
  const engines = manifest.engines?.vscode;
  const types = manifest.devDependencies?.['@types/vscode'];

  it('declares both a floor and a types version', () => {
    expect(engines).toBeTruthy();
    expect(types).toBeTruthy();
  });

  it('resolves @types/vscode no higher than the declared floor', () => {
    // The installed version, not the range: a caret is exactly how 1.85 became
    // 1.118 without anyone changing a declared number.
    const resolved = readJson<{ version: string }>('node_modules/@types/vscode/package.json');
    expect(compare(floorOf(resolved.version), floorOf(engines!))).toBeLessThanOrEqual(0);
  });

  it('pins @types/vscode exactly, with no range operator', () => {
    // A caret here re-creates the drift on the next `npm install`, silently. The
    // pin is the mechanism; this assertion is what keeps it.
    expect(types).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('pins it to the floor itself, not merely to something below it', () => {
    expect(floorOf(types!)).toEqual(floorOf(engines!));
  });
});
