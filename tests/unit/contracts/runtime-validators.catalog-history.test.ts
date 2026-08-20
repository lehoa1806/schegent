// Feature 101 (US4, T044) — the response validator for CMD_READ_DEFINITION_VERSION.
//
// `ack.result` is `unknown`. This validator is the only thing standing between a
// host acknowledgement and a definition body rendered in the webview, and it is
// the only place a definition body re-enters the webview outside the snapshot
// (T054). Everything the panel shows about a version's content passes through
// here, so the shape it admits is the shape the panel can assume.
//
// FR-034 — no filesystem path crosses this boundary in either direction. The
// request side is a coordinate by construction (`{ kind, id, versionId }`, no
// path field exists to fill). The response side is enforced here: the wire shape
// is exactly `{ body }`, so a path smuggled in beside the body is rejected
// rather than ignored. A validator that merely ignored the extra key would let a
// host build start shipping paths and no test would notice.

import { describe, it, expect } from 'vitest';
import { isValidReadDefinitionVersionResponse } from '../../../src/contracts/runtime-validators';

describe('isValidReadDefinitionVersionResponse — the accepted shape (US4, T044)', () => {
  it('accepts a well-formed response carrying a definition body', () => {
    expect(
      isValidReadDefinitionVersionResponse({
        body: { id: 'specify', instruction: 'Write the spec.', runner: 'claude' }
      })
    ).toBe(true);
  });

  it('accepts an empty object as a body — emptiness is the host\'s to report, not this validator\'s', () => {
    // FR-012b's "never render an empty body on failure" is about a *failed* read.
    // A successful read of a definition whose body genuinely is `{}` is a valid
    // response, and rejecting it here would turn a legible definition into an
    // error the operator cannot act on.
    expect(isValidReadDefinitionVersionResponse({ body: {} })).toBe(true);
  });
});

describe('isValidReadDefinitionVersionResponse — a missing body (US4, T044)', () => {
  it('rejects a response with no body key at all', () => {
    expect(isValidReadDefinitionVersionResponse({})).toBe(false);
  });

  it('rejects an explicitly undefined body', () => {
    expect(isValidReadDefinitionVersionResponse({ body: undefined })).toBe(false);
  });

  it('rejects a null body', () => {
    // `null` is the one non-object the runtime calls an object. FR-012b turns on
    // exactly this: a null body would render as a definition with no content.
    expect(isValidReadDefinitionVersionResponse({ body: null })).toBe(false);
  });
});

describe('isValidReadDefinitionVersionResponse — a non-object body (US4, T044)', () => {
  it.each([
    ['a string', 'instruction: write the spec'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', [{ id: 'specify' }]]
  ])('rejects %s as a body', (_label, body) => {
    expect(isValidReadDefinitionVersionResponse({ body })).toBe(false);
  });
});

describe('isValidReadDefinitionVersionResponse — the envelope itself (US4, T044)', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'body'],
    ['a number', 7],
    ['an array', [{ body: {} }]]
  ])('rejects %s as the whole response', (_label, value) => {
    expect(isValidReadDefinitionVersionResponse(value)).toBe(false);
  });
});

describe('isValidReadDefinitionVersionResponse — no path crosses the boundary (US4, T044, FR-034)', () => {
  it('rejects a response carrying a filesystem path beside the body', () => {
    expect(
      isValidReadDefinitionVersionResponse({
        body: { id: 'specify' },
        path: '/Users/someone/project/.schegent/catalog/phase/specify/v2.json'
      })
    ).toBe(false);
  });

  it('rejects any extra key, not just one spelled "path"', () => {
    // The rule is the closed shape, not a blocklist of field names. A blocklist
    // would pass `sourceFile`, `location`, `uri`, and every other spelling.
    expect(isValidReadDefinitionVersionResponse({ body: {}, sourceFile: 'x' })).toBe(false);
    expect(isValidReadDefinitionVersionResponse({ body: {}, uri: 'file:///x' })).toBe(false);
  });

  it('does not reach inside the body to police its content', () => {
    // A definition is operator-authored and may legitimately name a path as data
    // — a Phase whose instruction quotes one, for instance. This validator owns
    // the envelope; policing the body would corrupt legible definitions and
    // would still not stop a host that put a path in the envelope.
    expect(
      isValidReadDefinitionVersionResponse({
        body: { instruction: 'Read /etc/hosts and summarise it.' }
      })
    ).toBe(true);
  });
});
