// FR-R3-169 — the gate the CSP supply-chain policy named and never got.
//
// The policy adopted on 2026-05-10 chose assert-by-test, wrote down where the test
// would live, and said *"There is no opt-out."* This file is that test. It reads
// the built webview and asserts no artifact references a remote origin.
//
// Three properties are load-bearing and each exists because its absence is a way
// this file could report green while protecting nothing:
//
//   1. NO ALLOWANCE LIST. Not one. The matcher keys on reference syntax, so the
//      sixteen absolute URLs the bundle legitimately contains as string literals
//      are not references and never need excusing. Filing §7: *"One named literal
//      with a reason is a decision; a regex exclusion is a hole."* Zero is the only
//      count that cannot erode.
//   2. NO CONDITIONAL EXECUTION. Every assertion below runs on every invocation.
//      Nothing makes a case conditional on the bundle being present: a missing
//      bundle is a RED build, not a quiet pass. That is filing §3, and it is the
//      whole reason this feature exists rather than only the matcher.
//      Spec SC-005 checks this mechanically, by searching this directory for the
//      names of vitest's conditional-execution helpers and requiring zero hits —
//      so this file does not spell those names even to disclaim them, and neither
//      should any comment added later. Prose that says "we do not use X" is
//      indistinguishable from using X to every grep anyone will run.
//   3. FLOORS. `expect(remote).toEqual([])` passes on an empty bundle, an empty
//      walk and a broken extractor exactly as it passes on a clean build. The
//      floors below are what distinguish "read 39 files and found nothing" from
//      "read nothing".
//
// This file makes no claim about the runtime policy header the webview is served
// with. That half is already tested elsewhere; conflating the two is how the gap
// survived 118 days.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { filesUnder } from '../../../lint/source-scan';
import {
  COVERED_EXTENSIONS,
  MIN_ARTIFACTS,
  MIN_CSS,
  MIN_HTML,
  MIN_JS,
  MIN_REFERENCES,
  renderReference,
  scanArtifacts,
  type Artifact,
  type ReferenceForm
} from './remote-refs-scan';

const REPO_ROOT = resolve(__dirname, '../../../..');
const WEBVIEW_DIST = resolve(REPO_ROOT, 'dist/webview');
const BUILD = 'npm run build:webview';

function kindOf(file: string): Artifact['kind'] {
  if (file.endsWith('.html')) return 'html';
  if (file.endsWith('.css')) return 'css';
  return 'js';
}

/**
 * Every covered artifact under `dist/webview`, with repo-relative paths.
 *
 * The root is fixed. There is deliberately no parameter and no environment
 * override: a root that can be pointed at an empty directory is the opt-out the
 * policy ruled out, arriving as a convenience (FR-018).
 */
function loadBundle(): Artifact[] {
  return filesUnder(WEBVIEW_DIST, { extensions: [...COVERED_EXTENSIONS] }).map((absolute) => ({
    path: relative(REPO_ROOT, absolute),
    kind: kindOf(absolute),
    content: readFileSync(absolute, 'utf8')
  }));
}

/** Every distinct extension under `dist/webview`, covered or not. */
function extensionsPresent(): string[] {
  const seen = new Set<string>();
  for (const absolute of filesUnder(WEBVIEW_DIST)) {
    const name = basename(absolute);
    const dot = name.lastIndexOf('.');
    seen.add(dot > 0 ? name.slice(dot) : '(no extension)');
  }
  return [...seen].sort();
}

const fixture = (path: string, kind: Artifact['kind'], content: string): Artifact => ({
  path,
  kind,
  content
});

interface PlantedCase {
  readonly label: string;
  readonly artifact: Artifact;
  readonly form: ReferenceForm;
  readonly target: string;
}

// One planted remote reference per covered form, plus the protocol-relative
// spelling. These are the permanent regression proof for T1727: whatever else
// changes, a remote reference in any of these positions is caught.
const PLANTED: readonly PlantedCase[] = [
  {
    label: 'HTML script src',
    artifact: fixture(
      'fixture/script-source.html',
      'html',
      '<script type="module" crossorigin src="https://cdn.example.com/evil.js"></script>'
    ),
    form: 'html-script-source',
    target: 'https://cdn.example.com/evil.js'
  },
  {
    label: 'HTML link href (stylesheet)',
    artifact: fixture(
      'fixture/link-stylesheet.html',
      'html',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">'
    ),
    form: 'html-link-href',
    target: 'https://fonts.googleapis.com/css2?family=Inter'
  },
  {
    // The policy enumerated three `rel` values. A remote URL does not care which
    // one it sits behind, so neither does the matcher.
    label: 'HTML link href (a rel the policy never enumerated)',
    artifact: fixture(
      'fixture/link-preconnect.html',
      'html',
      '<link rel="preconnect" href="https://tracker.example.net">'
    ),
    form: 'html-link-href',
    target: 'https://tracker.example.net'
  },
  {
    label: 'CSS @import, bare string',
    artifact: fixture(
      'fixture/import-string.css',
      'css',
      '@import "https://cdn.example.com/reset.css";'
    ),
    form: 'css-import',
    target: 'https://cdn.example.com/reset.css'
  },
  {
    label: 'CSS @import, url()',
    artifact: fixture(
      'fixture/import-url.css',
      'css',
      '@import url("https://cdn.example.com/theme.css") screen;'
    ),
    form: 'css-import',
    target: 'https://cdn.example.com/theme.css'
  },
  {
    label: 'CSS @import, unquoted url()',
    artifact: fixture(
      'fixture/import-url-bare.css',
      'css',
      '@import url(https://cdn.example.com/bare.css);'
    ),
    form: 'css-import',
    target: 'https://cdn.example.com/bare.css'
  },
  {
    label: 'JS dynamic import()',
    artifact: fixture(
      'fixture/dynamic.js',
      'js',
      'const load = () => import("https://esm.sh/left-pad@1.3.0");'
    ),
    form: 'dynamic-import',
    target: 'https://esm.sh/left-pad@1.3.0'
  },
  {
    // The form the adopted policy omitted, and the larger of the two by 2.5x in
    // this bundle. See `remote-refs-scan.ts` and research R2.
    label: 'JS static import … from',
    artifact: fixture(
      'fixture/static.js',
      'js',
      'import { mount } from "https://esm.sh/svelte@5.0.0";\nexport { mount };'
    ),
    form: 'static-import',
    target: 'https://esm.sh/svelte@5.0.0'
  },
  {
    label: 'JS bare side-effect import',
    artifact: fixture('fixture/bare.js', 'js', 'import "https://cdn.example.com/polyfill.js";'),
    form: 'static-import',
    target: 'https://cdn.example.com/polyfill.js'
  },
  {
    label: 'JS re-export from',
    artifact: fixture(
      'fixture/reexport.js',
      'js',
      'export * from "https://cdn.example.com/shared.js";'
    ),
    form: 'static-import',
    target: 'https://cdn.example.com/shared.js'
  },
  {
    label: 'protocol-relative script src',
    artifact: fixture(
      'fixture/protocol-relative.html',
      'html',
      '<script src="//cdn.example.com/p.js"></script>'
    ),
    form: 'html-script-source',
    target: '//cdn.example.com/p.js'
  },
  {
    label: 'protocol-relative dynamic import',
    artifact: fixture('fixture/protocol-relative.js', 'js', 'import("//cdn.example.com/p.js");'),
    form: 'dynamic-import',
    target: '//cdn.example.com/p.js'
  }
];

// R1's sixteen literals in miniature. Every one of these is a real shape from the
// real bundle, and every one is why this gate needs no allowance list: a substring
// gate would be red on all six and would be made green by six exclusions.
const BENIGN: readonly { readonly label: string; readonly artifact: Artifact }[] = [
  {
    label: 'a Svelte runtime error-documentation link (15 of these in the real bundle)',
    artifact: fixture(
      'fixture/svelte-error.js',
      'js',
      'throw new Error("https://svelte.dev/e/state_unsafe_mutation");'
    )
  },
  {
    label: 'the XHTML namespace URI passed to createElementNS',
    artifact: fixture(
      'fixture/namespace.js',
      'js',
      'const el = document.createElementNS("http://www.w3.org/1999/xhtml", "div");'
    )
  },
  {
    label: 'a regex literal whose tail reads as a protocol-relative prefix',
    artifact: fixture(
      'fixture/regex-literal.js',
      'js',
      "const trimmed = value.replace(/[a-z]\\//g, '');"
    )
  },
  {
    label: 'an inlined data: URI in CSS',
    artifact: fixture(
      'fixture/data-uri.css',
      'css',
      '.icon { background: url(data:image/svg+xml;base64,PHN2Zy8+); }'
    )
  },
  {
    label: 'a same-origin absolute path — not relative, and not remote either',
    artifact: fixture(
      'fixture/same-origin.html',
      'html',
      '<script type="module" src="/absolute/path.js"></script>'
    )
  },
  {
    label: 'the relative forms the real bundle actually emits',
    artifact: fixture(
      'fixture/relative.html',
      'html',
      '<script type="module" crossorigin src="./index.js"></script>\n' +
        '<link rel="modulepreload" crossorigin href="./chunks/vendor.js">\n' +
        '<link rel="stylesheet" crossorigin href="../shared/base.css">'
    )
  }
];

describe('Remote-reference matcher (FR-R3-169 T1727)', () => {
  it.each(PLANTED)('flags a planted remote reference: $label', ({ artifact, form, target }) => {
    const { remote } = scanArtifacts([artifact]);
    expect(remote.map(renderReference)).toEqual([`${artifact.path} (${form}): ${target}`]);
  });

  it.each(BENIGN)('does not flag $label', ({ artifact }) => {
    const { remote } = scanArtifacts([artifact]);
    expect(remote.map(renderReference)).toEqual([]);
  });

  it('reports the verbatim target, not a normalised one', () => {
    const messy = 'HTTPS://CDN.Example.com/a/../b.js?v=1#frag';
    const { remote } = scanArtifacts([
      fixture('fixture/verbatim.js', 'js', `import("${messy}");`)
    ]);
    expect(remote.map((reference) => reference.target)).toEqual([messy]);
  });

  it('counts every reference it sees, remote or not, so the floors can be non-vacuous', () => {
    const { references, remote } = scanArtifacts([
      fixture(
        'fixture/mixed.html',
        'html',
        '<script src="./local.js"></script><link rel="preload" href="https://x.example/y.css">'
      )
    ]);
    expect(references).toHaveLength(2);
    expect(remote).toHaveLength(1);
  });

  // Found by measuring, not by reasoning. The first version of this matcher used
  // `\b` before each keyword, and `\b` is satisfied by a quote — so the string
  // literal `"from"`, which this app emits everywhere for date filters and
  // pipeline edges, was read as a `from` clause whose target ran from the
  // literal's own closing quote to the next quote in the file. Twelve of the 97
  // references the real bundle then reported were that. None were remote, so the
  // verdict held; the COUNT did not, and FR-020 rests on the count.
  //
  // Each case below invents a reference under `\b` and none under the boundary in
  // `remote-refs-scan.ts`. Asserting `references` — not `remote` — is the whole
  // point: a benign-looking check on `remote` passes just as well when the
  // matcher is hallucinating, because hallucinated targets are never remote.
  it.each([
    [
      'a "from" string literal followed by another string, as the bundle emits it',
      'js',
      'F("from",e.currentTarget.value)),J("change",H,x=>F("to",x));'
    ],
    ['a "from" entry in an array of field names', 'js', 'const keys = ["from","to"];'],
    ['a data-* attribute that ends in a real attribute name', 'html', '<link data-href="./x.css">'],
    ['a data-* attribute on a script tag', 'html', '<script data-src="./x.js"></script>']
  ] as const)('invents no reference from %s', (label, kind, content) => {
    const { references } = scanArtifacts([fixture(`fixture/boundary-${kind}.${kind}`, kind, content)]);
    expect(references.map(renderReference), `"${label}" is not a reference`).toEqual([]);
  });
});

describe('No remote references in the built webview (FR-R3-169 T1728, T1729)', () => {
  // Unguarded by design — see property 2 in the header.
  const bundle = loadBundle();
  const result = scanArtifacts(bundle);

  it('read a real bundle rather than an empty directory', () => {
    expect(
      bundle.length,
      `read ${bundle.length} artifacts from dist/webview, expected at least ${MIN_ARTIFACTS}. ` +
        `An empty or partial bundle makes every "no remote references" assertion below vacuous. ` +
        `Run \`${BUILD}\`.`
    ).toBeGreaterThanOrEqual(MIN_ARTIFACTS);
  });

  it.each([
    ['html', MIN_HTML],
    ['js', MIN_JS],
    ['css', MIN_CSS]
  ] as const)('read enough %s artifacts (floor %i)', (kind, floor) => {
    const count = bundle.filter((artifact) => artifact.kind === kind).length;
    expect(
      count,
      `read ${count} ${kind} artifacts, expected at least ${floor}. A build that stopped ` +
        `emitting one kind would otherwise leave that kind unscanned and still green. Run \`${BUILD}\`.`
    ).toBeGreaterThanOrEqual(floor);
  });

  it('extracted a plausible number of references', () => {
    expect(
      result.references.length,
      `extracted ${result.references.length} references, expected at least ${MIN_REFERENCES}. ` +
        `This floor fails when an extractor stops matching — the one failure mode an empty ` +
        `\`remote\` list cannot distinguish from success.`
    ).toBeGreaterThanOrEqual(MIN_REFERENCES);
  });

  it('holds no artifact type the matcher cannot read', () => {
    const uncovered = extensionsPresent().filter(
      (extension) => !COVERED_EXTENSIONS.includes(extension)
    );
    expect(
      uncovered,
      `dist/webview holds ${uncovered.join(', ')}, which the matcher does not read. A new ` +
        `artifact type must be covered or deliberately excluded — never silently unscanned. ` +
        `Extend COVERED_EXTENSIONS in remote-refs-scan.ts and add an extractor.`
    ).toEqual([]);
  });

  it('references no remote origin from any built artifact', () => {
    const offenders = result.remote.map(renderReference);
    expect(
      offenders,
      `the built webview references ${offenders.length} remote origin(s):\n  ` +
        `${offenders.join('\n  ')}\n` +
        `All webview assets must be bundled locally. If a remote asset is genuinely required, ` +
        `the CSP supply-chain policy must be revised first — see ` +
        `docs/security/csp-supply-chain-record.md. Do not add an exclusion here.`
    ).toEqual([]);
  });
});
