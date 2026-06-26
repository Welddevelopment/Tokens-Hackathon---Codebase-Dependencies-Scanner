# License Contamination Report: gatsby

## Verdict
⚠️ CONTAMINATED — a copyleft (GPL-2.0) dependency is reachable from a permissively-licensed root.

## Contamination Path
gatsby (MIT) → gatsby-recipes (MIT) → graphql-tools-schema (MIT) → value-or-promise (MIT) → to-readable-stream (MIT) → smartwrap (GPL-2.0)

## Why this matters
GPL-2.0 is copyleft: a proprietary product reachable to this package may be obligated to release its source code. This path is invisible in normal use — nobody chose smartwrap directly.

## Sources (retrieved live via Tavily)
- smartwrap license: https://www.npmjs.com/package/smartwrap?activeTab=dependents
- GPL-2.0 definition: https://spdx.org/licenses/GPL-2.0-or-later.html
- Real-world incident: Goldman Sachs Engineering, "The Mystery of the Disappearing NPM Dependency" https://developer.gs.com/blog/posts/mystery-of-disappearing-npm-dependency

## Note
Potential exposure flagged for review, not a legal determination.
