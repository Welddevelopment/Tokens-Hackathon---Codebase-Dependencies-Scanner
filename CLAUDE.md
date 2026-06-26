# Project: Autonomous License Contamination Agent (hackathon, solo, ~6h)

## What this is
An agent that takes a software dependency tree, uses Tavily to verify licenses and gather
real web sources, uses the Prometheux API to detect hidden copyleft (GPL/AGPL) contamination
and prove the exact dependency path, writes a cited report to cited.md, stores results in
ClickHouse, and exposes one paid "unlock full report" action.
Demo target: gatsby -> gatsby-recipes -> graphql-tools-schema -> value-or-promise -> ... -> smartwrap (GPL-2.0).

## Architecture
- Front-end (this app) = the face. Prometheux = the reasoning brain. Tavily = live web sourcing.
- Flow on Run: gather dependency data -> Tavily verifies licenses + fetches sources ->
  send to Prometheux API -> get contamination path back -> display it, write cited.md
  (with Tavily sources), save scan to ClickHouse.

## Priorities (in order)
1. Working over polished — must run reliably in a LIVE demo.
2. Simple over scalable — minimal files, no infra beyond what's required.
3. Readable, commented code — I'm a beginner; explain what things do.
4. Visually dramatic — the contamination path lighting up is the "wow".

## SECURITY (public repo — critical)
- NEVER hardcode API keys/tokens/credentials. Use environment variables only.
- Keep all secrets in .env. Add .env to .gitignore. Never commit secrets.
- Env vars: PMTX_TOKEN, PMTX_API_URL, TAVILY_API_KEY, CLICKHOUSE_URL, CLICKHOUSE_USER,
  CLICKHOUSE_PASSWORD, PAYMENT_* (TBD).

## Stack
- Single-page app: React + Tailwind (or plain HTML/JS if simpler).
- A small backend/serverless function if needed to call Prometheux/Tavily/ClickHouse.
- As few files as possible.

## What the app MUST do
- Input box (pre-filled "gatsby") + Run button.
- On Run: use Tavily to verify package licenses / fetch sources, then call the Prometheux API
  with the dependency data and receive the contamination path.
- Render the dependency graph: permissive = green, GPL/copyleft = red, root = distinct.
- Highlight + animate the contamination path from root down to the GPL package.
- Plain-English verdict banner, e.g.:
  "⚠️ gatsby is legally exposed — a GPL-2.0 dependency (smartwrap) is reachable via this path."
- Write the result to cited.md (format provided), including the real sources Tavily returned.
- Save each scan's result to ClickHouse.
- THE KICKER: a license dropdown on smartwrap switching GPL-2.0 <-> MIT; on change, auto
  re-run and update verdict + path. Default on load: smartwrap = GPL-2.0 (contaminated).
  Make it obvious and reliable — for live demo.
- One paid action: free scan shows verdict; paid unlock reveals the full cited report.

## Do NOT
- Add features I didn't ask for or over-engineer.
- Add routing/state libraries unless necessary.
- Assume production use — this is a demo.
- Block the whole UI on slow calls — show a loading state.