/**
 * FR-R3-048 — synthetic armored blocks for redaction tests.
 *
 * Every body below is inert filler, not a key: nothing here decodes to key
 * material, so an escaped test artifact leaks nothing. The sentinel words
 * (`BODY_MUST_NOT_SURVIVE`, `TAIL_MUST_NOT_SURVIVE`) exist so an assertion can
 * name what must be absent without naming anything secret — a redaction test
 * that prints the protected string on failure leaks in CI.
 */

/** Sentinels an assertion may search for. Never real key material. */
export const BODY_SENTINEL = 'BODY_MUST_NOT_SURVIVE';
export const TAIL_SENTINEL = 'TAIL_MUST_NOT_SURVIVE';
export const FOOTER_MARK = '-----END';

export interface KeyBlockCase {
  /** Test-facing name. Deliberately describes the SHAPE, never the content. */
  readonly name: string;
  /** The armored block, as a backend would print it. */
  readonly text: string;
  /** Substrings that must be absent after redaction. */
  readonly mustNotSurvive: ReadonlyArray<string>;
}

/**
 * The armor shapes a real backend emits: OpenSSH, RSA, standard PGP, the legacy
 * PGP spelling, and unlabeled PKCS#8.
 */
export const PRIVATE_KEY_CASES: ReadonlyArray<KeyBlockCase> = [
  {
    name: 'OpenSSH, complete',
    text: [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ',
      BODY_SENTINEL,
      '-----END OPENSSH PRIVATE KEY-----'
    ].join('\n'),
    mustNotSurvive: [BODY_SENTINEL, 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', FOOTER_MARK]
  },
  {
    name: 'RSA, complete',
    text: [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEogIBAAKCAQEAx4fm7dngEmokFQ8U9PKbhysmBfBy',
      BODY_SENTINEL,
      '-----END RSA PRIVATE KEY-----'
    ].join('\n'),
    mustNotSurvive: [BODY_SENTINEL, 'MIIEogIBAAKCAQEAx4fm7dngEmokFQ8U9PKbhysmBfBy', FOOTER_MARK]
  },
  {
    name: 'PGP, standard armor (the form GnuPG writes)',
    text: [
      '-----BEGIN PGP PRIVATE KEY BLOCK-----',
      'lQHYBGZabcdefgHIJKLmnopQRSTUVwxyz0123456789',
      BODY_SENTINEL,
      '-----END PGP PRIVATE KEY BLOCK-----'
    ].join('\n'),
    mustNotSurvive: [BODY_SENTINEL, 'lQHYBGZabcdefgHIJKLmnopQRSTUVwxyz0123456789', FOOTER_MARK]
  },
  {
    name: 'PGP, legacy spelling — the pre-change set matched this, so it must keep matching',
    text: [
      '-----BEGIN PGP PRIVATE KEY-----',
      'lQHYBGZlegacyspellingBODYfiller0123456789',
      BODY_SENTINEL,
      '-----END PGP PRIVATE KEY-----'
    ].join('\n'),
    mustNotSurvive: [BODY_SENTINEL, 'lQHYBGZlegacyspellingBODYfiller0123456789', FOOTER_MARK]
  },
  {
    // No algorithm label at all. `openssl genpkey`, `openssl pkcs8` and
    // `ssh-keygen -m PKCS8` all write this, and it is the default private-key
    // encoding of most current tooling. A label-REQUIRED armor alternation
    // misses it entirely, which is why the label is optional in the pattern
    // rather than another entry in the label list.
    name: 'PKCS#8, unlabeled — what openssl genpkey writes',
    text: [
      '-----BEGIN PRIVATE KEY-----',
      'MIIJKQIBAAKCAgEAunlabeledPkcs8Filler0123456789',
      BODY_SENTINEL,
      '-----END PRIVATE KEY-----'
    ].join('\n'),
    mustNotSurvive: [BODY_SENTINEL, 'MIIJKQIBAAKCAgEAunlabeledPkcs8Filler0123456789', FOOTER_MARK]
  }
];

/** A block that opens and never closes. A truncated key is still a key. */
export const UNTERMINATED_CASE: KeyBlockCase = {
  name: 'EC, opened and never closed',
  text: ['-----BEGIN EC PRIVATE KEY-----', 'MHcCAQEEIFillerFillerFiller', TAIL_SENTINEL].join('\n'),
  mustNotSurvive: [TAIL_SENTINEL, 'MHcCAQEEIFillerFillerFiller']
};

/** Explicitly shareable. Must pass through byte-identical. */
export const PUBLIC_KEY_BLOCK = [
  '-----BEGIN PUBLIC KEY-----',
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
  '-----END PUBLIC KEY-----'
].join('\n');

/** Two blocks back to back: neither footer may close the other. */
export const ADJACENT_BLOCKS = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'firstBodyFiller',
  '-----END RSA PRIVATE KEY-----',
  'ordinary text between the blocks',
  '-----BEGIN EC PRIVATE KEY-----',
  'secondBodyFiller',
  '-----END EC PRIVATE KEY-----'
].join('\n');

/** A body line shaped like a marker, which must not close the block. */
export const FAKE_MARKER_IN_BODY = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'not-a-marker---END---still-body',
  BODY_SENTINEL,
  '-----END RSA PRIVATE KEY-----'
].join('\n');

/** An entire block on one line, as a JSON payload or escaped log line delivers it. */
export const SINGLE_LINE_BLOCK =
  `-----BEGIN RSA PRIVATE KEY-----oneLineBodyFiller${BODY_SENTINEL}-----END RSA PRIVATE KEY-----`;

/**
 * Two keys concatenated with no trailing newline on the first, so a well-formed
 * END and the next BEGIN share ONE line — what `cat key1 key2` produces, and the
 * shape the spec names as occurring in practice. A presence-only same-line close
 * test reads the shared line as "opened and closed here" and lets the second
 * key's body through.
 */
export const CONCATENATED_KEYS_SHARED_LINE: ReadonlyArray<string> = Object.freeze([
  '-----BEGIN RSA PRIVATE KEY-----',
  'firstBodyFiller',
  '-----END RSA PRIVATE KEY----------BEGIN RSA PRIVATE KEY-----',
  BODY_SENTINEL,
  '-----END RSA PRIVATE KEY-----'
]);
