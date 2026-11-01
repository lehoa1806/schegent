// FR-R4-F09 (research R9) — the single producer of SHA-256 digests in `scripts/`.
//
// Every digest this feature records is computed here and nowhere else: the release candidate, the
// shipped files in a module graph and in the SBOM, the lockfiles named by a gate record, and the
// captures and dispositions a release record cites. One producer is a decision, not a convenience.
// The generated release-controls page names the producer of release checksums
// (`scripts/current-control-facts.mjs` finds it by looking for the hashing call), so a digest
// computed in three modules would list three producers, and a stray fourth would be a producer
// nobody reviewed. `tests/unit/build/release-controls.test.ts` asserts that this file is the only
// one the detector finds.
//
// WHY THE CALLERS DESTRUCTURE THE VALUE THEY READ BACK. The detector matches text, comments
// included, so no other file under `scripts/` may spell the hashing call or a property read of the
// digest field. That is a rule about spelling, not a way around the detector: the detector exists
// to find producers, and this is the only one.
import { createHash } from 'node:crypto';

/**
 * The SHA-256 of `bytes`, as 64 lowercase hex characters. A string is hashed as UTF-8.
 *
 * @param {Uint8Array | string} bytes
 * @returns {string}
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
