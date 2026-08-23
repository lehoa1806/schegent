# License review and release packaging

Schegent's source distribution is licensed under the MIT License. The
repository license grants the usual MIT permissions, requires preservation of
the copyright and permission notice in copies or substantial portions, and
disclaims warranties and liability. The root package manifest declares
`"license": "MIT"`.

<!-- Source: LICENSE.md -->
<!-- Source: package.json -->

This project license does not replace third-party licenses. JavaScript bundled
into the host or webview, development and packaging tools, examples, and
authored assets remain subject to their own terms. Treat license review as a
release input, not as a conclusion inferred from Schegent's MIT declaration.

<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package-lock.json -->

## What the automated gate proves

Run:

```bash
npm run license:check
```

The current gate proves exactly three structural facts:

1. `LICENSE.md` exists.
2. This operations document exists.
3. `package.json` has a non-empty `license` field.

On success it prints the manifest identifier, currently `MIT`. It does **not**
enumerate dependency licenses, parse SPDX expressions, inspect license text,
check notice obligations, compare the webview manifest, or decide whether a
dependency may be distributed in the VSIX.

<!-- Source: scripts/check-licenses.mjs -->
<!-- Source: package.json -->

`license:check` is part of `verify:all`, which is run by the pull-request, CI,
and release workflows. A passing consolidated gate therefore proves the three
facts above and no broader legal compatibility claim.

<!-- Source: package.json -->
<!-- Source: .github/workflows/pr.yml -->
<!-- Source: .github/workflows/ci.yml -->
<!-- Source: .github/workflows/release.yml -->

## Dependency records in scope

Review both dependency trees:

| Tree | Manifest | Resolution record |
| --- | --- | --- |
| Extension host, build, tests, and packaging | `package.json` | `package-lock.json` |
| Svelte webview, build, and tests | `webview-ui/package.json` | `webview-ui/package-lock.json` |

Both lockfiles use npm lockfile version 3 and record license metadata on package
entries where the package supplies it. The metadata includes simple SPDX IDs,
compound `AND`/`OR` expressions, and package-specific text such as
`SEE LICENSE IN ...`; it is an inventory lead, not a substitute for reading the
referenced license. The private webview package has no project-level license
field and is not checked by `license:check`.

<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package-lock.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: scripts/check-licenses.mjs -->

The root and webview manifests currently declare development dependencies
rather than runtime dependency sections, but the build bundles selected
library code into `dist/extension.js` and `dist/webview/`. A dependency's
`devDependency` classification therefore does not by itself prove that none of
its code ships.

<!-- Source: package.json -->
<!-- Source: webview-ui/package.json -->
<!-- Source: esbuild.config.mjs -->

## Review a dependency change

Use this procedure whenever either manifest or lockfile changes:

1. Identify every added, removed, or upgraded package in both lockfiles,
   including transitive changes.
2. Read each changed entry's `license` value and inspect the package's actual
   license and notice files in the resolved package. Do not collapse an SPDX
   `AND` expression into either side or assume an `OR` expression chooses a
   branch automatically.
3. Determine whether the package's code or assets enter the host bundle,
   webview bundle, examples, branding, or release tooling. Review transitive
   code reached by bundling, not only direct manifest rows.
4. Record any attribution, source-offer, copyleft, patent, trademark, or notice
   obligation. If the VSIX must carry another file, update the package policy
   and its tests before release; the current allowlist admits only the project
   `LICENSE.md`, not a general notice directory.
5. Run `npm run license:check`, the relevant build, and
   `npm run package:smoke`. Inspect the produced archive policy before merging.
6. Escalate unclear, non-SPDX, source-available, copyleft, dual-license, or
   attribution-heavy terms for a human legal decision. Do not encode a new
   allowlist by guesswork in this document.

<!-- Source: package-lock.json -->
<!-- Source: webview-ui/package-lock.json -->
<!-- Source: esbuild.config.mjs -->
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: package.json -->

The repository does not contain a dependency-license allowlist or a checked-in
license-scanner command. If maintainers adopt one, add it as a pinned project
dependency or reproducible workflow step, document its exact policy, and make
the structural gate verify its output rather than relying on an unpinned global
tool.

<!-- Source: package.json -->
<!-- Source: scripts/check-licenses.mjs -->
<!-- Source: .github/workflows/dependency-review.yml -->

## Pull-request dependency controls

Pull requests targeting `develop` run GitHub's pinned
`actions/dependency-review-action`. The workflow explicitly fails on newly
introduced vulnerabilities at `high` severity or above and comments a summary
on failure. It does not configure `allow-licenses` or `deny-licenses`, so this
repository's workflow file contains no project-specific license compatibility
policy.

<!-- Source: .github/workflows/dependency-review.yml -->

Dependabot opens weekly root and webview npm update pull requests and groups
several related toolchains; major updates are ignored for manual handling. A
separate weekly security workflow runs `npm audit --audit-level=low` against
both lockfiles. Those controls address dependency freshness and known
vulnerabilities. They complement, but do not perform, the manual license review
above.

<!-- Source: .github/dependabot.yml -->
<!-- Source: .github/workflows/security-audit.yml -->

## What ships

The VSIX content policy explicitly includes `extension/LICENSE.md` and rejects
unexpected archive entries. Source, tests, implementation docs, lockfiles, and
`node_modules` are excluded from the extension package. As a result, this
operations page is a maintainer runbook and does not ship inside the VSIX; the
MIT text itself does.

<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .vscodeignore -->

The release workflow runs `verify:all`, builds, runs package smoke, packages the
release, and checks the actual released archive with the same VSIX policy. It
also generates a CycloneDX SBOM and checksums for the release bundle. The SBOM
is a dependency inventory artifact; its existence does not waive or satisfy a
license or notice obligation by itself.

<!-- Source: .github/workflows/release.yml -->
<!-- Source: scripts/package-vsix-smoke.mjs -->
<!-- Source: scripts/check-vsix-smoke.mjs -->

## Release checklist

Before publishing a dependency-bearing release, confirm:

- `LICENSE.md` still matches the intended project license and the manifest
  still declares `MIT`;
- every changed root and webview dependency has a recorded license review;
- all required third-party notices are present in the exact archive that will
  ship, with the VSIX allowlist updated intentionally if needed;
- `npm run license:check` and `npm run package:smoke` pass; and
- the generated release SBOM describes the same dependency resolution used for
  the release build.

<!-- Source: LICENSE.md -->
<!-- Source: package.json -->
<!-- Source: scripts/check-licenses.mjs -->
<!-- Source: scripts/check-vsix-smoke.mjs -->
<!-- Source: .github/workflows/release.yml -->
