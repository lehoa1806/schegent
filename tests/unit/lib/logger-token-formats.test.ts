/**
 * Review gap GC-13 (2026-11-12) — token formats the redaction set had no pattern for: SendGrid API
 * keys, Twilio API key SIDs, PyPI upload tokens, HashiCorp Vault tokens, and Azure Storage SAS
 * signatures and account keys. Fixtures are assembled from repeated characters so the repository's
 * own secret scan does not read them as live credentials.
 */
import { describe, expect, it } from 'vitest';

import { SanitizedLogger } from '../../../src/lib/logger';

const logger = new SanitizedLogger();
const REDACTED = '[REDACTED]';

const SENDGRID = `SG.${'a'.repeat(22)}.${'B'.repeat(43)}`;
const TWILIO_API_KEY = `SK${'0123456789abcdef'.repeat(2)}`;
const PYPI = `pypi-AgEIcHlwaS5vcmc${'x'.repeat(60)}`;
const VAULT_SERVICE = `hvs.${'C'.repeat(90)}`;
const VAULT_BATCH = `hvb.${'d'.repeat(120)}`;
const SAS_SIGNATURE = `${'Q'.repeat(30)}%2B${'r'.repeat(10)}%3D`;
const ACCOUNT_KEY = `${'K'.repeat(86)}==`;

describe('GC-13 — redaction covers more token formats', () => {
  it.each([
    ['a SendGrid API key', SENDGRID],
    ['a Twilio API key SID', TWILIO_API_KEY],
    ['a PyPI upload token', PYPI],
    ['a Vault service token', VAULT_SERVICE],
    ['a Vault batch token', VAULT_BATCH]
  ])('removes %s', (_label, token) => {
    const out = logger.sanitize(`saw ${token} end`);

    expect(out).not.toContain(token);
    expect(out).toBe(`saw ${REDACTED} end`);
  });

  it('removes an Azure SAS signature and keeps the rest of the URL readable', () => {
    const url = `https://acct.blob.core.windows.net/c/b.txt?sv=2022-11-02&sr=b&sig=${SAS_SIGNATURE}&se=2026-12-01`;

    const out = logger.sanitize(url);

    expect(out).not.toContain(SAS_SIGNATURE);
    expect(out).toBe(`https://acct.blob.core.windows.net/c/b.txt?sv=2022-11-02&sr=b&sig=${REDACTED}&se=2026-12-01`);
  });

  it('removes an Azure Storage account key from a connection string', () => {
    const connection = `DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${ACCOUNT_KEY};EndpointSuffix=core.windows.net`;

    const out = logger.sanitize(connection);

    expect(out).not.toContain(ACCOUNT_KEY);
    expect(out).toBe(`DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=${REDACTED};EndpointSuffix=core.windows.net`);
  });

  it.each([
    ['a Twilio account SID, which is an identifier', `AC${'0123456789abcdef'.repeat(2)}`],
    ['a short sig parameter', '?sig=abc'],
    ['an SG. prefix with no key shape', 'SG.example.com'],
    ['a dotted word starting hvs', 'hvs.config']
  ])('keeps %s', (_label, text) => {
    expect(logger.sanitize(text)).toBe(text);
  });
});
