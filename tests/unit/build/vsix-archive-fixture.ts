/**
 * FR-R4-F09 (contract test T5) -- the hand-built VSIX archive, shared by two test files.
 *
 * It lived inside `vsix-archive-assertions.test.ts`, which uses it to reach archive failures a real
 * build cannot produce on demand: an oversize package, a duplicate entry, a truncated central
 * directory. `vsix-sbom-agreement.test.ts` needs the same builder to put a chosen SBOM and chosen
 * `dist/` bytes into an archive, and a second copy would let the two drift in how they write a
 * ZIP. So the builder moved here unchanged, exported, and both files import it.
 *
 * Entries are stored, not compressed (method 0), which is what makes every byte of the archive
 * assertable. A caller may override the compression method and the declared uncompressed size per
 * entry to reach the refusals that read them.
 */

export const STORED = 0;
export type ArchiveEntry = {
  name: string;
  data: Buffer;
  /** Central-directory method, overridden to reach the unsupported-method refusal. */
  method?: number;
  /** Central-directory uncompressed size, overridden to reach the size bound. */
  declaredUncompressed?: number;
};

export type ArchiveOptions = {
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

export function archive(entries: ArchiveEntry[], options: ArchiveOptions = {}): Buffer {
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
