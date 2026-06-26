# LicenseTrace — Autonomous License Contamination Agent

**Your private code can be legally forced open by one buried dependency you've never heard of. LicenseTrace finds it, traces exactly how it reaches you, and proves it — with real sources.**

## The problem

Modern software is built on hundreds of free packages, each pulling in hundreds more, layers deep. You choose your top-level dependencies — the rest come along for the ride, unseen. Some carry "copyleft" licenses (GPL, AGPL, LGPL) that spread virally: if one is buried in your dependency tree, it can legally obligate you to open-source your entire proprietary product. This exposure is invisible until it's expensive — a broken build, or a lawyer's letter.

This really happens. In a documented case, teams using **GatsbyJS** hit sudden build failures because a GPL-2.0 package (`smartwrap`) was pulled in deep in their dependency tree — code nobody chose or knew about (Goldman Sachs Engineering, "The Mystery of the Disappearing NPM Dependency"). Companies have paid heavily for similar exposure: Orange was ordered to pay over €900,000, and Panasonic faces a $100M+ suit, over GPL compliance.

## What LicenseTrace does

An autonomous agent that takes a codebase's dependency tree and:
1. **Traces** every dependency hop, however deep, to find buried copyleft licenses.
2. **Proves** the exact contamination path from your app down to the offending package — not just a list of licenses, but the chain that legally reaches you.
3. **Grounds** every finding in real, live-fetched sources (the package page, the license definition, the documented incident).
4. **Reports** the result to a cited `cited.md` file.
5. **Stores** every scan for audit/monitoring.

Unlike license scanners that flag what licenses are *present*, LicenseTrace reasons about *reachability* — which buried package legally contaminates your specific product, and by what path.

## How it works

- **Prometheux** — the reasoning engine. Recursive reachability over the dependency graph derives and proves the contamination path.
- **Tavily** — live web search; fetches real, canonical sources for each finding to ground the citations.
- **ClickHouse** — stores every scan's results for history and monitoring.
- **Built with Claude.**

## Demo

Point it at a codebase (e.g. `gatsby`). It draws the dependency graph, lights up the contamination path in red, shows a plain-English verdict, fetches real sources live, and writes `cited.md`. Toggle a package's license (GPL ↔ MIT) and watch the verdict re-derive live — proving it's reasoning, not a lookup.

## Run it

**Prerequisites:** Node.js (no other install needed — the server uses Node built-ins only).

1. **Add your keys.** Copy the template and fill it in:
   ```bash
   cp .env.example .env
   ```
   ```ini
   TAVILY_API_KEY=tvly-...          # live source fetching
   CLICKHOUSE_URL=...               # host (e.g. xxxx.clickhouse.cloud)
   CLICKHOUSE_PORT=8443             # HTTPS interface
   CLICKHOUSE_USER=default
   CLICKHOUSE_PASSWORD=...
   ```
   `.env` is git-ignored — secrets never leave your machine.

2. **Start the server:**
   ```bash
   node server.js        # or: npm start
   ```
   You should see `running → http://localhost:3000`.

3. **Open the app:**
   ```
   http://localhost:3000
   ```
   Open the `localhost` URL, not the file directly — the backend (Tavily, ClickHouse, `cited.md`) only runs through the server.

4. **Run a scan.** The input is pre-filled with `gatsby`. Hit **Run scan**: the graph renders, the contamination path animates red, real sources load under the verdict, and `cited.md` is written to the repo root. Flip the **smartwrap** license toggle (GPL-2.0 ↔ MIT) to watch the verdict re-derive live.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Single-page UI — graph, verdict, animated path, live license toggle |
| `server.js` | Zero-dependency backend — Tavily searches, `cited.md`, ClickHouse storage |
| `packages.csv` / `dependencies.csv` | Demo dependency tree (the `gatsby → smartwrap` chain) |
| `cited.md` | Generated report with live Tavily-sourced citations |
| `.env.example` | Template for required keys (copy to `.env`) |

## Security

No secrets in code or in the repo. All keys live in `.env` (git-ignored) and are used only server-side, so they're never exposed to the browser.
