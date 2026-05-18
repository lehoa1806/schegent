# License Review

This document describes how Schegent maintainers keep the dependency
license surface trustworthy. The runtime does not consult this file —
it is an operator playbook.

## Schedule

Quarterly review of all production and dev dependencies. The review
target dates are the first business day of February, May, August, and
November. Skipping a quarter is acceptable when no new dependency has
been added or upgraded; record the skip under **Last Review**.

## Tool

```bash
npx license-checker-rseidelsohn --excludePrivatePackages
```

Operator-chosen equivalents (`license-checker`, `pnpm licenses list`,
`yarn licenses list`, an SPDX-aware SBOM tool) are acceptable as long
as they emit a license identifier per package and a path to the
license file.

## Procedure

1. Run the tool from the repo root with a clean `node_modules`
   (`npm ci` first so the resolved tree matches the lockfile).
2. Compare every license identifier against the **Allowlist** below.
3. For any new restrictive license (GPL, AGPL, LGPL, SSPL, BUSL,
   Commons Clause, or any "no-derivatives" / "non-commercial"
   variant), file a security-review issue before the next release.
4. For any unrecognized identifier, treat it as **REQUIRES review**.
5. Record the date, package count, review-required count, and
   approval count under **Last Review** below.

## Allowlist

Pre-approved, no per-occurrence review needed:

- **MIT**
- **ISC**
- **BSD-3-Clause**
- **BSD-2-Clause**
- **Apache-2.0**
- **CC0-1.0** (effectively public domain)
- **0BSD** (zero-clause BSD)
- **Unlicense**

Anything outside this list requires a documented review decision
before it ships in a Schegent release.

## Last Review

<DATE> — <N> packages, <N> requiring review, <N> approved.

> _Pending first quarterly review. The Wave 9 commit only creates this
> playbook; the first run lands in the next operator-cadence cycle._
