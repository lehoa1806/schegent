/**
 * Feature 106 (T597c, FR-035, SC-019, SC-020) — the archive-level assertions,
 * observed for the first time.
 *
 * T597c asked whether every assertion the gate makes today is still observed by a
 * test after the derivation. Measured, the answer was no for five of them, and it
 * had been no before this feature too: the two size bounds and the three
 * package-manifest checks live in `policy.inspectVsix`, which needs a real ZIP, so the
 * only thing that ever ran them was `package:smoke` against a package that
 * happened to be well-formed. None had ever been observed failing.
 *
 * That is the defect class this batch exists to close, so it is closed here rather
 * than recorded as acceptable. The archive below is assembled byte by byte — stored
 * entries, no compression — which is what makes the failure directions reachable:
 * an oversize package, a manifest pointing somewhere else, a duplicate entry, a
 * truncated central directory. A real build cannot produce any of them on demand.
 *
 * The names come from the same independent listing the content-policy test uses,
 * so this file asserts the archive layer and nothing about the allowlist.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { plausiblePackagedNames } from './authored-boundaries';

/**
 * Dynamic, because a static import of an ES module from this CommonJS test program
 * is TS1479 and naming its type directly is TS1542. The type is inferred from the
 * loader instead.
 */
async function loadPolicy() {
  return import('../../../scripts/check-vsix-smoke.mjs');
}

const STORED = 0;
const MANIFEST = 'extension/package.json';
const PADDABLE = 'extension/assets/banner.png';

const VALID_MANIFEST = {
  name: 'schegent',
  main: './dist/extension.js',
  activationEvents: ['workspaceContains:.specify/', 'onView:schegent.dashboard']
};

type ArchiveEntry = {
  name: string;
  data: Buffer;
  /** Central-directory method, overridden to reach the unsupported-method refusal. */
  method?: number;
  /** Central-directory uncompressed size, overridden to reach the size bound. */
  declaredUncompressed?: number;
};

type ArchiveOptions = {
  /** Break the first central-directory signature. */
  corruptCentralHeader?: boolean;
  /** Emit no end-of-central-directory record at all. */
  omitEocd?: boolean;
};

function localHeader(entry: ArchiveEntry): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(entry.method ?? STORED, 8);
  header.writeUInt32LE(entry.data.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(name.length, 26);
  return Buffer.concat([header, name, entry.data]);
}

function centralHeader(entry: ArchiveEntry, offset: number): Buffer {
  const name = Buffer.from(entry.name, 'utf8');
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(entry.method ?? STORED, 10);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.declaredUncompressed ?? entry.data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, name]);
}

function archive(entries: ArchiveEntry[], options: ArchiveOptions = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const local = localHeader(entry);
    centrals.push(centralHeader(entry, offset));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  if (options.corruptCentralHeader) central.writeUInt32LE(0xdeadbeef, 0);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);

  const body = [...locals, central];
  if (!options.omitEocd) body.push(eocd);
  return Buffer.concat(body);
}

let dir: string;
let policy: Awaited<ReturnType<typeof loadPolicy>>;
let packagedNames: readonly string[];

/**
 * Resolved once, so every builder below is synchronous. The awaited form of this
 * file put `await` inside `expect(() => …)` three times over, which esbuild
 * rejects outright — a builder that needs no await cannot make that mistake.
 */
beforeAll(async () => {
  policy = await loadPolicy();
  packagedNames = await plausiblePackagedNames();
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vsix-archive-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A well-formed package, with any single entry overridden. */
function entries(override: Partial<ArchiveEntry> & { name?: string } = {}): ArchiveEntry[] {
  return packagedNames.map((name) => {
    const base: ArchiveEntry = {
      name,
      data: name === MANIFEST ? Buffer.from(JSON.stringify(VALID_MANIFEST), 'utf8') : Buffer.alloc(0)
    };
    return override.name === name ? { ...base, ...override } : base;
  });
}

function inspect(buffer: Buffer): void {
  const path = join(dir, 'schegent-test.vsix');
  writeFileSync(path, buffer);
  policy.inspectVsix(path);
}

describe('a well-formed package passes every archive assertion', () => {
  it('accepts it, so each failure below is the one thing that changed', () => {
    expect(() => inspect(archive(entries()))).not.toThrow();
  });
});

describe('size bounds (SC-019)', () => {
  it('refuses a package over the compressed bound, naming both numbers', () => {
    const oversize = policy.MAX_VSIX_COMPRESSED_BYTES + 1_024;
    const buffer = archive(entries({ name: PADDABLE, data: Buffer.alloc(oversize) }));
    expect(buffer.length).toBeGreaterThan(policy.MAX_VSIX_COMPRESSED_BYTES);
    expect(() => inspect(buffer)).toThrow(
      new RegExp(`\\[policy\\] compressed size ${buffer.length} exceeds ${policy.MAX_VSIX_COMPRESSED_BYTES}`)
    );
  });

  it('refuses a package over the uncompressed bound', () => {
    // Declared in the central directory rather than stored, so the compressed
    // bound is not what fires: the two bounds are separate assertions and this
    // one has to be reachable on its own.
    const declared = policy.MAX_VSIX_UNCOMPRESSED_BYTES + 4_096;
    const built = entries({ name: PADDABLE, declaredUncompressed: declared });
    const buffer = archive(built);
    expect(buffer.length).toBeLessThan(policy.MAX_VSIX_COMPRESSED_BYTES);
    // The bound is on the sum across every entry, not on the largest one, so the
    // number reported is the total — 127 bytes of manifest above `declared` here.
    const total = built.reduce(
      (sum, entry) => sum + (entry.declaredUncompressed ?? entry.data.length),
      0
    );
    expect(total).toBeGreaterThan(declared);
    expect(() => inspect(buffer)).toThrow(
      new RegExp(`\\[policy\\] uncompressed size ${total} exceeds ${policy.MAX_VSIX_UNCOMPRESSED_BYTES}`)
    );
  });

  it('keeps the bounds at the values the feature inherited (FR-033)', () => {
    expect(policy.MAX_VSIX_COMPRESSED_BYTES).toBe(2 * 1024 * 1024);
    expect(policy.MAX_VSIX_UNCOMPRESSED_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe('the three package-manifest checks (SC-020)', () => {
  function withManifest(manifest: unknown): Buffer {
    return archive(entries({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest), 'utf8') }));
  }

  it('refuses a package whose manifest names something else', () => {
    expect(() => inspect(withManifest({ ...VALID_MANIFEST, name: 'schegent-fork' }))).toThrow(
      /\[policy\] package\.json name is not schegent/
    );
  });

  it('refuses a manifest whose entry point does not point at dist', () => {
    expect(() => inspect(withManifest({ ...VALID_MANIFEST, main: './src/extension.ts' }))).toThrow(
      /\[policy\] package\.json main does not point at dist/
    );
  });

  it('refuses a manifest missing the workspaceContains activation event', () => {
    const without = { ...VALID_MANIFEST, activationEvents: ['onView:schegent.dashboard'] };
    expect(() => inspect(withManifest(without))).toThrow(
      /\[policy\] package\.json missing workspaceContains activation event/
    );
  });

  it('refuses a manifest with no activationEvents array at all', () => {
    const { activationEvents: _dropped, ...without } = VALID_MANIFEST;
    expect(() => inspect(withManifest(without))).toThrow(
      /\[policy\] package\.json missing workspaceContains activation event/
    );
  });
});

describe('a malformed archive is refused before its contents are judged', () => {
  it('names a duplicate entry rather than reporting one of the two', () => {
    const base = entries();
    const duplicated = [...base, base.find((entry) => entry.name === PADDABLE)!];
    expect(() => inspect(archive(duplicated))).toThrow(
      /\[policy\] duplicate ZIP entry extension\/assets\/banner\.png/
    );
  });

  it('refuses a corrupt central-directory header, naming the offset', () => {
    expect(() => inspect(archive(entries(), { corruptCentralHeader: true }))).toThrow(
      /\[policy\] invalid central-directory header at \d+/
    );
  });

  it('refuses a file with no end-of-central-directory record', () => {
    expect(() => inspect(archive(entries(), { omitEocd: true }))).toThrow(
      /\[policy\] ZIP end-of-central-directory not found/
    );
  });

  it('refuses a compression method it cannot read', () => {
    // Method 99 is AES-encrypted in the wild. Whatever it is, this reader will not
    // guess at the bytes behind it.
    expect(() => inspect(archive(entries({ name: MANIFEST, method: 99 })))).toThrow(
      /\[policy\] unsupported compression method 99 for extension\/package\.json/
    );
  });

  it('every archive failure carries the policy stage, never the packaging stage', () => {
    const buffer = archive(entries({ name: PADDABLE, declaredUncompressed: 9_000_000 }));
    let message = '';
    try {
      inspect(buffer);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('[policy]');
    expect(message).not.toContain('[packaging]');
  });
});
