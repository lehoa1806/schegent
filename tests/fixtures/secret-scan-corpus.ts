/**
 * FR-R4-F09 (FR-026, SC-007; research R20; contract DP3) -- the minimal compatibility corpus for the
 * secret scan.
 *
 * WHAT IT IS FOR. Aligning the secretlint family on one version (FR-025) changes the engine under a
 * scan that is the repository's only static control. Before and after the change, this corpus asks
 * the same two questions of the configured scan: does it still detect a value of each key family
 * the current engine already detects, and does it still pass the values that are not secrets. It
 * claims no family beyond those. `FR-R4-F10` extends the families.
 *
 * WHY EVERY VALUE IS ASSEMBLED AT CALL TIME. This file is tracked, and the repository's own scan
 * reads tracked files, so a literal token here would be a finding in the repository. Each planted
 * value is built from split literals and filler by a function, so no line of this file matches any
 * rule. The values are synthetic: shaped like a family's token, and valid for nothing.
 *
 * WHAT IS RECORDED RATHER THAN HIDDEN. A family whose planted case today's engine does not detect
 * is moved to `DROPPED` with the measured reason, not deleted. The corpus is "what the current
 * engine already detects", measured, not assumed.
 */

/** A planted secret: the file to write, built at call time so this file holds no token. */
export interface PlantedCase {
  /** The rule family: `secretlint-rule-<family>` appears in a report that found it. */
  readonly family: string;
  /** The tracked file name the value is written to. Some rules read the name or extension. */
  readonly file: string;
  readonly build: () => string;
}

/** A value that is not a secret, and must pass: a near-miss, an allowed value, or prose. */
export interface CleanCase {
  readonly name: string;
  readonly file: string;
  readonly text: string;
}

/** A family the current engine was measured not to detect with a synthetic value. */
export interface DroppedFamily {
  readonly family: string;
  readonly reason: string;
}

/** Filler of exactly `length` characters, in the alphabet of a token body. */
function filler(length: number): string {
  return 'Zq3K8vR2mN7pL4wT9yB6cD1fH5jX0aS7uEgIoPbVnMhGtRkQwYdLxCzA'.repeat(4).slice(0, length);
}

/** Base64-looking filler for a private-key body: no key decodes from it. */
function keyBody(lines: number): string {
  const row = 'MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gunVTLw7';
  return Array.from({ length: lines }, () => row).join('\n');
}

/** The 1Password service-account shape: `ops_` and base64 of a JSON object ending in `fQ`. */
function serviceAccountToken(): string {
  for (let padding = 1; padding < 16; padding += 1) {
    const json = JSON.stringify({
      email: ['abc', '@', '1password', 'serviceaccounts', '.lcl'].join(''),
      muk: { alg: 'A256GCM', k: filler(43), kty: 'oct' },
      pad: 'x'.repeat(padding)
    });
    const encoded = Buffer.from(json).toString('base64');
    if (/fQ={0,2}$/.test(encoded) && encoded.length >= 100) return ['ops', '_', encoded].join('');
  }
  throw new Error('could not build a service-account shaped value');
}

/**
 * One planted case per rule family of the configured preset, and the dotenv rule. Each is
 * detected by the engine this repository ran when the corpus was written (see `DROPPED`).
 */
export const PLANTED: readonly PlantedCase[] = [
  { family: '1password', file: 'service-account.txt', build: () => `token = "${serviceAccountToken()}"\n` },
  {
    // The secret-access-key assignment. The preset as shipped does not report an access key id
    // (`AKIA` and sixteen characters) on its own, measured at T073, so that shape is not planted.
    family: 'aws',
    file: 'aws-credentials.txt',
    build: () => `${['aws_secret', '_access_key'].join('')} = ${filler(40)}\n`
  },
  {
    family: 'basicauth',
    file: 'remote.txt',
    build: () => `remote = ${['https', '://', 'deploy', ':', 'S3cretPassw0rd', '@git.example.org/repo.git'].join('')}\n`
  },
  {
    family: 'gcp',
    file: 'service-account.json',
    build: () =>
      JSON.stringify({
        type: 'service_account',
        project_id: 'example',
        ['private_key' + '_id']: 'abc123',
        private_key: ['-----', 'BEGIN PRIVATE', ' KEY-----\n', keyBody(2), '\n-----', 'END PRIVATE', ' KEY-----\n'].join('')
      }) + '\n'
  },
  { family: 'github', file: 'github.txt', build: () => `token = ${['gh', 'p_'].join('')}${filler(36)}\n` },
  { family: 'linear', file: 'linear.txt', build: () => `token = ${['lin', '_api_'].join('')}${filler(40)}\n` },
  { family: 'npm', file: 'npmrc.txt', build: () => `//registry.npmjs.org/:_authToken=${['npm', '_'].join('')}${filler(36)}\n` },
  {
    family: 'openai',
    file: 'openai.txt',
    build: () => `key = ${['sk', '-'].join('')}${filler(20)}${['T3Blbk', 'FJ'].join('')}${filler(20)}\n`
  },
  {
    family: 'privatekey',
    file: 'key.txt',
    build: () =>
      ['-----', 'BEGIN RSA PRIVATE', ' KEY-----\n', keyBody(4), '\n-----', 'END RSA PRIVATE', ' KEY-----\n'].join('')
  },
  { family: 'sendgrid', file: 'sendgrid.txt', build: () => `key = ${['S', 'G.'].join('')}${filler(22)}.${filler(43)}\n` },
  {
    family: 'shopify',
    file: 'shopify.txt',
    build: () => `token = ${['shp', 'at_'].join('')}${'0123456789abcdef'.repeat(2)}\n`
  },
  {
    family: 'slack',
    file: 'slack.txt',
    build: () => `token = "${['xo', 'xb-'].join('')}1234567890-1234567890-${filler(24)}"\n`
  },
  { family: 'no-dotenv', file: '.env', build: () => `DOTENV_FIXTURE_ONLY=sentinel-value-0f3a9c\n` }
];

/** Families moved out of `PLANTED` once measured not to be detected. */
export const DROPPED: readonly DroppedFamily[] = [
  {
    family: 'azure',
    reason:
      'Measured at T073 against secretlint 13.0.4 with the preset at 10.2.2: the preset registers ' +
      'twelve scanning rules and a comments filter, and none is an Azure rule (its package.json ' +
      'lists @secretlint/secretlint-rule-azure, but its src/index.ts does not import it). A ' +
      'synthetic storage-account key, as a connection string and as an assignment, is not reported.'
  }
];

/** The shapes of the allowed values in `.secretlintrc.json`, so the corpus cannot drift from it. */
const ALLOWED_BASIC_AUTH = ['https', '://', 'user:pass@example.com'].join('');
const ALLOWED_GITHUB = ['gh', 'p_0123456789abcdefghijklmnopqrstuvwxyz'].join('');

/**
 * Values that are not secrets. Near-misses of each shape (one character or one part short), the
 * values `.secretlintrc.json` allows, and prose that names each family. All of them share one
 * repository, and the scan must pass it.
 */
export const CLEAN: readonly CleanCase[] = [
  { name: 'an AWS secret access key one character short', file: 'near-aws.txt', text: `${['aws_secret', '_access_key'].join('')} = ${filler(39)}\n` },
  { name: 'a GitHub-shaped token with a short body', file: 'near-github.txt', text: `token = ${['gh', 'p_'].join('')}${filler(10)}\n` },
  { name: 'a Slack-shaped prefix with one part only', file: 'near-slack.txt', text: `token = ${['xo', 'xb-'].join('')}notatokenjustaword\n` },
  { name: 'an npm-shaped token with a short body', file: 'near-npm.txt', text: `token = ${['npm', '_'].join('')}${filler(8)}\n` },
  { name: 'a SendGrid-shaped key with short parts', file: 'near-sendgrid.txt', text: `key = ${['S', 'G.'].join('')}${filler(5)}.${filler(5)}\n` },
  { name: 'a Shopify-shaped token with a short body', file: 'near-shopify.txt', text: `token = ${['shp', 'at_'].join('')}0123abcd\n` },
  { name: 'an OpenAI-shaped key with a short body', file: 'near-openai.txt', text: `key = ${['sk', '-'].join('')}${filler(12)}\n` },
  { name: 'a Linear-shaped token with a short body', file: 'near-linear.txt', text: `token = ${['lin', '_api_'].join('')}${filler(8)}\n` },
  { name: 'a service-account prefix with no body', file: 'near-1password.txt', text: `token = ${['ops', '_'].join('')}\n` },
  { name: 'a URL with no credentials', file: 'near-basicauth.txt', text: `remote = ${['https', '://'].join('')}git.example.org/repo.git\n` },
  {
    name: 'a public key, which is not a private key',
    file: 'public-key.txt',
    text: ['-----', 'BEGIN PUBLIC', ' KEY-----\n', keyBody(1), '\n-----', 'END PUBLIC', ' KEY-----\n'].join('')
  },
  { name: 'a service-account JSON with no private key', file: 'near-gcp.json', text: '{ "type": "service_account", "project_id": "example" }\n' },
  { name: 'an environment example file', file: 'environment-example.txt', text: 'SOME_SETTING=placeholder\n' },
  { name: 'the basic-auth value .secretlintrc.json allows', file: 'allowed-basicauth.txt', text: `remote = ${ALLOWED_BASIC_AUTH}\n` },
  { name: 'the GitHub value .secretlintrc.json allows', file: 'allowed-github.txt', text: `token = ${ALLOWED_GITHUB}\n` },
  {
    name: 'prose that names each family',
    file: 'prose.md',
    text:
      'Rotate AWS keys, Azure storage keys, GitHub, Linear, npm, OpenAI, SendGrid, Shopify and Slack ' +
      'tokens, 1Password service accounts, Google Cloud service-account keys and private keys on a ' +
      'schedule, and keep dotenv files out of version control.\n'
  }
];
