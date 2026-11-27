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
 *
 * FR-R4-F10 (data-model section 1; contract SC) EXTENDS the same three lists in place, and adds a
 * fourth. `PLANTED` gains the families the scan was measured to miss: Anthropic keys, JSON web
 * tokens, a lone AWS access key id, an AWS account id, password assignments (unquoted and quoted),
 * and `.env.<suffix>` file names. `CLEAN` gains a near-miss per new family and the three dotenv
 * templates. `UNSUPPORTED` records the shapes the configured scan is known NOT to detect, so a
 * limit is a listed fact rather than a silence. `reportedAs` names the rule a finding carries when
 * it is not `secretlint-rule-<family>`, and `modes` restricts a case to tree or staged mode.
 */

/** A planted secret: the file to write, built at call time so this file holds no token. */
export interface PlantedCase {
  /** The family: `secretlint-rule-<family>` appears in a report that found it, unless `reportedAs` says otherwise. */
  readonly family: string;
  /** The tracked file name the value is written to. Some rules read the name or extension. */
  readonly file: string;
  readonly build: () => string;
  /** The rule id substring a finding must carry. Defaults to `secretlint-rule-<family>`. */
  readonly reportedAs?: string;
  /** The scan modes the case applies to. Defaults to both. */
  readonly modes?: ReadonlyArray<ScanMode>;
}

/** The two ways the scan runs: over tracked files on disk, and over what a commit stages. */
export type ScanMode = 'tree' | 'staged';

/** A value that is not a secret, and must pass: a near-miss, an allowed value, or prose. */
export interface CleanCase {
  readonly name: string;
  readonly file: string;
  readonly text: string;
  /** The scan modes the case applies to. Defaults to both. */
  readonly modes?: ReadonlyArray<ScanMode>;
}

/** A shape the configured scan is known not to detect, recorded rather than hidden. */
export interface UnsupportedShape {
  readonly name: string;
  /** A label for the shape. It is never a `PLANTED.family`: nothing here is claimed as detected. */
  readonly family: string;
  readonly reason: string;
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

/** An Anthropic-shaped key: `sk-ant-`, a version tag, and a body of `bodyLength` token characters. */
function anthropicKey(bodyLength: number): string {
  return `${['sk', '-ant-'].join('')}api03-${filler(bodyLength)}`;
}

/** The base64url form of a JSON object, as a JWT segment: it begins `eyJ` for any object. */
function jwtSegment(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A JWT-shaped token: a header and a payload that are JSON objects, and a signature of filler. */
function jsonWebToken(): string {
  return [jwtSegment({ alg: 'HS256', typ: 'JWT' }), jwtSegment({ sub: 'user-1', scope: 'read' }), filler(43)].join('.');
}

/** A name ending in a password word, assembled so this file holds no `<NAME>PASSWORD=` text. */
function passwordName(upper: boolean): string {
  return upper ? ['MY_DB_PASS', 'WORD'].join('') : ['db_pass', 'word'].join('');
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
  { family: 'no-dotenv', file: '.env', build: () => `DOTENV_FIXTURE_ONLY=sentinel-value-0f3a9c\n` },
  // FR-R4-F10: the families the scan was measured to miss. The first four are reported by the local
  // rule (`secretlint-rule-schegent`), and the AWS pair by the preset's AWS rule with its id scan on.
  {
    family: 'anthropic',
    file: 'anthropic.txt',
    reportedAs: 'secretlint-rule-schegent',
    build: () => `key = ${anthropicKey(48)}\n`
  },
  {
    family: 'jwt',
    file: 'session-token.txt',
    reportedAs: 'secretlint-rule-schegent',
    build: () => `token = ${jsonWebToken()}\n`
  },
  {
    // A lone access key id, which the preset reports only with `enableIDScanRule`. Not the AWS
    // documentation example, which the rule ignores.
    family: 'aws-access-key-id',
    file: 'aws-key-id.txt',
    reportedAs: 'secretlint-rule-aws',
    build: () => `id = ${['AK', 'IA'].join('')}ZQ3K8VR2MN7PL4WT\n`
  },
  {
    // The 12-digit account id the same option enables (research R7).
    family: 'aws-account-id',
    file: 'aws-account.txt',
    reportedAs: 'secretlint-rule-aws',
    build: () => `${['aws_account', '_id'].join('')} = "123456789012"\n`
  },
  {
    family: 'password-assignment',
    file: 'settings.txt',
    reportedAs: 'secretlint-rule-schegent',
    build: () => `${passwordName(true)}=${filler(12)}\n`
  },
  {
    family: 'password-assignment-quoted',
    file: 'config.yml',
    reportedAs: 'secretlint-rule-schegent',
    build: () => `${passwordName(false)}: '${filler(12)}'\n`
  },
  {
    family: 'dotenv-variant',
    file: '.env.local',
    reportedAs: 'secretlint-rule-schegent',
    build: () => 'SOME_SETTING=placeholder\n'
  },
  {
    family: 'dotenv-variant-nested',
    file: 'config/.env.production',
    reportedAs: 'secretlint-rule-schegent',
    build: () => 'SOME_SETTING=placeholder\n'
  },
  {
    // A template name is not reported by name, but its content still passes through every rule.
    family: 'anthropic-in-template',
    file: '.env.example',
    reportedAs: 'secretlint-rule-schegent',
    build: () => `ANTHROPIC_API_KEY=${anthropicKey(48)}\n`
  }
];

/** Families moved out of `PLANTED` once measured not to be detected. */
export const DROPPED: readonly DroppedFamily[] = [
  {
    family: 'azure',
    reason:
      'Measured at T073, and measured again on 2026-11-01 against the installed engine and preset ' +
      '(both 10.2.2): the preset registers ' +
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
  },
  // FR-R4-F10: a near-miss per new family, and the dotenv templates.
  { name: 'an Anthropic-shaped key with a body under 32 characters', file: 'near-anthropic.txt', text: `key = ${anthropicKey(20)}\n` },
  {
    name: 'a JWT-shaped token whose payload is not a JSON object',
    file: 'near-jwt.txt',
    text: `token = ${[jwtSegment({ alg: 'HS256', typ: 'JWT' }), filler(20), filler(43)].join('.')}\n`
  },
  { name: 'a password assignment with a value under 8 characters', file: 'near-password.txt', text: `${passwordName(true)}=abc123\n` },
  {
    name: 'a password assignment that interpolates another variable',
    file: 'interpolated-password.yml',
    text: `${passwordName(false)}: "\${DB_PASSWORD}"\n`
  },
  {
    name: 'a code reference to a password property',
    file: 'code-reference.txt',
    text: 'const value = options.password;\nreturn user.password;\n'
  },
  { name: 'a 12-digit number under a key that is not an account', file: 'non-account-number.txt', text: 'invoice_total = 123456789012\n' },
  { name: 'a .env.example template with no credential', file: '.env.example', text: 'SOME_SETTING=placeholder\n' },
  { name: 'a .env.sample template with no credential', file: '.env.sample', text: 'SOME_SETTING=placeholder\n' },
  { name: 'a .env.template template with no credential', file: '.env.template', text: 'SOME_SETTING=placeholder\n' }
];

/**
 * Shapes the configured scan is known not to detect (research R6, R7). Each is a limit stated, not a
 * defect hidden: `SECURITY.md` lists them, and the wording gate keeps the two in step.
 */
export const UNSUPPORTED: readonly UnsupportedShape[] = [
  {
    name: 'a TOKEN or SECRET code constant',
    family: 'token-secret-constant',
    reason:
      'Names ending in TOKEN or SECRET are not matched: the tree holds code constants with such names ' +
      'whose values are not credentials, so a rule on them would report the repository itself. The ' +
      'runtime redactor covers those names.'
  },
  {
    name: 'a .envrc file',
    family: 'envrc',
    reason: 'The dotenv rule matches the exact name `.env`, and the local rule matches `.env.<suffix>`; `.envrc` is neither.'
  },
  {
    name: 'a dotenv file with no leading dot',
    family: 'env-no-leading-dot',
    reason: 'A file named `env.local` is not a dotenv name by either rule.'
  },
  {
    name: 'a secret split across two files',
    family: 'split-secret',
    reason: 'Each rule reads one file at a time, so a credential whose halves are in two files matches neither half.'
  },
  {
    name: 'a bespoke internal token format',
    family: 'bespoke-token',
    reason: 'A format with no vendor prefix or fixed shape cannot be recognised without a pattern for that format.'
  }
];
