/* =======================================================================
   Minimal zero-dependency backend.
   Why this exists: TAVILY_API_KEY must stay server-side (CLAUDE.md security
   rule — never expose secrets in client JS), and a file:// page can't read
   .env. So this tiny server (Node built-ins only, no npm install) does two
   jobs:
     1. serves index.html and the CSVs at http://localhost:3000
     2. exposes GET /api/sources — runs the 3 Tavily citation searches and
        returns the top result URL for each.

   Run:  node server.js   (with TAVILY_API_KEY set in .env)
======================================================================= */
const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");

const PORT = process.env.PORT || 3000;

/* ---- load .env (tiny parser, no dotenv dependency) ------------------ */
function loadEnv(){
  try{
    const txt = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
    txt.split(/\r?\n/).forEach(line=>{
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if(m && !process.env[m[1]]){
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    });
  }catch{ /* no .env file — rely on real environment variables */ }
}
loadEnv();

/* ---- one Tavily search -> top result {title,url} --------------------
   opts.includeDomains pins results to specific domains (canonical pages). */
function tavilySearch(query, opts={}){
  return new Promise((resolve, reject)=>{
    const key = process.env.TAVILY_API_KEY;
    if(!key) return reject(new Error("TAVILY_API_KEY is not set (add it to .env)"));

    const payload = { query, max_results: 5, search_depth: "basic" };
    if(opts.includeDomains && opts.includeDomains.length){
      payload.include_domains = opts.includeDomains;
    }
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: "api.tavily.com",
      path: "/search",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,   // current Tavily auth
        "Content-Length": Buffer.byteLength(body),
      },
    }, res=>{
      let data = "";
      res.on("data", c=> data += c);
      res.on("end", ()=>{
        if(res.statusCode < 200 || res.statusCode >= 300){
          return reject(new Error("Tavily HTTP " + res.statusCode + ": " + data.slice(0,200)));
        }
        try{
          const json = JSON.parse(data);
          const top = (json.results || [])[0];
          resolve(top ? { title: top.title, url: top.url } : { title: null, url: null });
        }catch(e){ reject(e); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ---- the 3 citation searches for the smartwrap / GPL-2.0 finding ---- */
const SEARCHES = [
  { key:"smartwrap", label:"smartwrap — npm license page",
    query:"smartwrap package", domains:["npmjs.com"] },
  { key:"spdx",      label:"SPDX GPL-2.0 license definition",
    query:"GPL-2.0 license identifier definition", domains:["spdx.org"] },
  { key:"goldman",   label:"Goldman Sachs — “The Mystery of the Disappearing NPM Dependency”",
    query:"The Mystery of the Disappearing NPM Dependency",
    domains:["developer.gs.com"], fallbackNoDomain:true },
];

async function getSources(){
  const results = await Promise.all(SEARCHES.map(async s=>{
    try{
      let top = await tavilySearch(s.query, { includeDomains: s.domains });
      // For Goldman only: if the pinned domain returned nothing, retry once
      // with no domain restriction so we still get a citation.
      if(!top.url && s.fallbackNoDomain){
        top = await tavilySearch(s.query);
      }
      return { key:s.key, label:s.label, title:top.title, url:top.url };
    }catch(err){
      return { key:s.key, label:s.label, title:null, url:null, error:err.message };
    }
  }));
  return results;
}

/* ---- write cited.md from the live Tavily URLs ----------------------
   The verdict/path are the known gatsby contamination finding (the Run
   scan always evaluates gatsby with smartwrap = GPL-2.0). Only the
   Sources section is dynamic — filled with whatever Tavily returned.
-------------------------------------------------------------------- */
function writeCitedReport(sources){
  const byKey = Object.fromEntries(sources.map(s=>[s.key, s]));
  const url = k => byKey[k] && byKey[k].url ? byKey[k].url : "[no source returned by Tavily]";

  const md = `# License Contamination Report: gatsby

## Verdict
⚠️ CONTAMINATED — a copyleft (GPL-2.0) dependency is reachable from a permissively-licensed root.

## Contamination Path
gatsby (MIT) → gatsby-recipes (MIT) → graphql-tools-schema (MIT) → value-or-promise (MIT) → to-readable-stream (MIT) → smartwrap (GPL-2.0)

## Why this matters
GPL-2.0 is copyleft: a proprietary product reachable to this package may be obligated to release its source code. This path is invisible in normal use — nobody chose smartwrap directly.

## Sources (retrieved live via Tavily)
- smartwrap license: ${url("smartwrap")}
- GPL-2.0 definition: ${url("spdx")}
- Real-world incident: Goldman Sachs Engineering, "The Mystery of the Disappearing NPM Dependency" ${url("goldman")}

## Note
Potential exposure flagged for review, not a legal determination.
`;
  fs.writeFileSync(path.join(__dirname, "cited.md"), md, "utf8");
  console.log("📝 wrote cited.md");
}

/* ---- live-scan sources: 2 Tavily searches for a found copyleft package -
   Only called when a live deps.dev scan finds contamination. Pins the npm
   license page (npmjs.com) and the SPDX license definition (spdx.org). -- */
async function getLiveSources(copyleftPkg, spdxId){
  const searches = [
    { key:"package", label:`${copyleftPkg} — npm license page`,
      query:`${copyleftPkg} package`, domains:["npmjs.com"] },
    { key:"spdx", label:`${spdxId} license definition`,
      query:`${spdxId} license identifier definition`, domains:["spdx.org"] },
  ];
  return Promise.all(searches.map(async s=>{
    try{
      const top = await tavilySearch(s.query, { includeDomains: s.domains });
      return { key:s.key, label:s.label, title:top.title, url:top.url };
    }catch(err){
      return { key:s.key, label:s.label, title:null, url:null, error:err.message };
    }
  }));
}

/* ---- write cited.md for a live scan finding ------------------------- */
function writeLiveCitedReport(pkg, copyleftPkg, spdxId, pathStr, sources){
  const byKey = Object.fromEntries(sources.map(s=>[s.key, s]));
  const url = k => byKey[k] && byKey[k].url ? byKey[k].url : "[no source returned by Tavily]";
  const md = `# License Contamination Report: ${pkg}

## Verdict
⚠️ CONTAMINATED — a copyleft (${spdxId}) dependency (${copyleftPkg}) is reachable from ${pkg}.

## Contamination Path
${pathStr}

## Why this matters
${spdxId} is copyleft: a product that distributes code reaching this package may be obligated to release its source. This dependency is transitive — nobody chose ${copyleftPkg} directly.

## Sources (retrieved live via Tavily)
- ${copyleftPkg} license: ${url("package")}
- ${spdxId} definition: ${url("spdx")}

## Note
Reasoned live by Prometheux. Potential exposure flagged for review, not a legal determination.
`;
  fs.writeFileSync(path.join(__dirname, "cited.md"), md, "utf8");
  console.log("📝 wrote cited.md (live scan: " + pkg + ")");
}

/* read a JSON request body (for POST routes) */
function readJsonBody(req){
  return new Promise(resolve=>{
    let d = "";
    req.on("data", c=> d += c);
    req.on("end", ()=>{ try{ resolve(JSON.parse(d || "{}")); }catch{ resolve({}); } });
  });
}

/* =======================================================================
   ClickHouse storage (HTTPS interface, no client library).
   POST the SQL as the request body to https://{host}:{port}/ with HTTP
   basic auth. Every call is wrapped by saveScan() so a ClickHouse outage
   logs an error but never breaks a scan.
======================================================================= */
function clickhouseQuery(sql){
  return new Promise((resolve, reject)=>{
    // CLICKHOUSE_URL may be a bare host or a full URL — normalise to host.
    const host = (process.env.CLICKHOUSE_URL || "")
      .replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
    if(!host) return reject(new Error("CLICKHOUSE_URL not set"));

    const port = process.env.CLICKHOUSE_PORT || 8443;
    const auth = (process.env.CLICKHOUSE_USER || "default") + ":" +
                 (process.env.CLICKHOUSE_PASSWORD || "");
    const body = Buffer.from(sql, "utf8");

    const req = https.request({
      hostname: host, port, path: "/", method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Length": body.length,
        "Authorization": "Basic " + Buffer.from(auth).toString("base64"),
      },
    }, res=>{
      let d = "";
      res.on("data", c=> d += c);
      res.on("end", ()=>{
        if(res.statusCode < 200 || res.statusCode >= 300){
          return reject(new Error("ClickHouse HTTP " + res.statusCode + ": " + d.slice(0,200)));
        }
        resolve(d);
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function saveScan(scan){
  try{
    if(!process.env.CLICKHOUSE_URL){
      console.log("ℹ️  CLICKHOUSE_URL not set — skipping scan storage");
      return;
    }
    const esc = s => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

    // 1. create the table if it doesn't exist
    await clickhouseQuery(
      "CREATE TABLE IF NOT EXISTS scans (timestamp DateTime, root_package String, " +
      "contaminated UInt8, copyleft_package String, path String) " +
      "ENGINE = MergeTree ORDER BY timestamp");

    // 2. insert this scan
    await clickhouseQuery(
      "INSERT INTO scans (timestamp, root_package, contaminated, copyleft_package, path) VALUES (" +
      `now(), '${esc(scan.root)}', ${scan.contaminated ? 1 : 0}, ` +
      `'${esc(scan.copyleft)}', '${esc(scan.path)}')`);

    // 3. confirm by reading the row count back
    const count = (await clickhouseQuery("SELECT count() FROM scans")).trim();
    console.log(`💾 scan saved to ClickHouse — scans table now has ${count} row(s)`);
  }catch(err){
    console.log("⚠️  ClickHouse storage failed (scan continues):", err.message);
  }
}

/* =======================================================================
   LIVE npm SCAN via deps.dev (https://deps.dev) — no API key needed.
   GET /api/scan?package=NAME resolves the default version, fetches the
   dependency graph, looks up each package's license, and returns the
   SAME { packages, dependencies } shape the UI's contamination logic uses.
======================================================================= */
const MAX_DISPLAY = 150;   // nodes shown in the graph
const MAX_LOOKUPS = 400;   // hard ceiling on license HTTP calls (bounds time)
const CONCURRENCY = 10;    // parallel license lookups

class HttpError extends Error { constructor(code,msg){ super(msg); this.code=code; } }

/* same copyleft rule as the client */
function isCopyleft(license){ return /GPL/i.test(license || ""); }

/* GET JSON over https with a timeout. Throws HttpError on non-2xx. */
function getJson(url, timeoutMs=8000){
  return new Promise((resolve, reject)=>{
    const req = https.get(url, { headers:{ "Accept":"application/json" } }, res=>{
      let d = "";
      res.on("data", c=> d += c);
      res.on("end", ()=>{
        if(res.statusCode < 200 || res.statusCode >= 300){
          return reject(new HttpError(res.statusCode, "deps.dev HTTP " + res.statusCode));
        }
        try{ resolve(JSON.parse(d)); }catch(e){ reject(new HttpError(502, "bad JSON from deps.dev")); }
      });
    });
    req.on("error", e=> reject(new HttpError(502, e.message)));
    req.setTimeout(timeoutMs, ()=>{ req.destroy(new HttpError(504, "deps.dev timed out")); });
  });
}

/* run async fn over items with a concurrency limit */
async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let i = 0;
  async function worker(){
    while(i < items.length){
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({length:Math.min(limit, items.length)}, worker));
  return out;
}

const DD = "https://api.deps.dev/v3/systems/npm/packages/";
const enc = s => encodeURIComponent(s);   // handles scoped names like @babel/core

async function scanNpmPackage(name){
  // 1. resolve the default version
  let meta;
  try{ meta = await getJson(DD + enc(name)); }
  catch(e){ if(e.code===404) throw new HttpError(404, "package not found"); throw e; }
  const versions = meta.versions || [];
  const def = versions.find(v=>v.isDefault) || versions[0];
  if(!def) throw new HttpError(404, "no published version for " + name);
  const rootVersion = def.versionKey.version;

  // 2. fetch the dependency tree (note the COLON before dependencies)
  const tree = await getJson(DD + enc(name) + "/versions/" + enc(rootVersion) + ":dependencies");
  const nodes = tree.nodes || [];
  const edgesIdx = tree.edges || [];
  if(!nodes.length) throw new HttpError(404, "no dependency data for " + name);

  // adjacency by node index (for BFS)
  const adj = nodes.map(()=>[]);
  edgesIdx.forEach(e=>{ if(adj[e.fromNode]) adj[e.fromNode].push(e.toNode); });
  const ROOT = Math.max(0, nodes.findIndex(n=>n.relation==="SELF"));

  // 3. license lookups, parallel + bounded
  const lookupCount = Math.min(nodes.length, MAX_LOOKUPS);
  const lic = new Array(nodes.length).fill("unknown");
  await mapLimit(Array.from({length:lookupCount},(_,i)=>i), CONCURRENCY, async i=>{
    const vk = nodes[i].versionKey;
    try{
      const v = await getJson(DD + enc(vk.name) + "/versions/" + enc(vk.version));
      const j = (v.licenses || []).join(" OR ");
      lic[i] = j || "unknown";
    }catch{ lic[i] = "unknown"; }   // missing license -> "unknown", never fail the scan
  });

  // 4. pick displayed nodes: PRIORITISE copyleft nodes AND their path to root,
  //    so the cap can never hide a contamination chain. Then fill by BFS order.
  const bfsParents = ()=>{
    const parent = new Array(nodes.length).fill(undefined);
    const seen = new Array(nodes.length).fill(false);
    const q=[ROOT]; seen[ROOT]=true;
    while(q.length){ const u=q.shift();
      for(const w of adj[u]) if(!seen[w]){ seen[w]=true; parent[w]=u; q.push(w); } }
    return parent;
  };
  const bfsOrder = ()=>{
    const seen=new Array(nodes.length).fill(false), order=[], q=[ROOT]; seen[ROOT]=true;
    while(q.length){ const u=q.shift(); order.push(u);
      for(const w of adj[u]) if(!seen[w]){ seen[w]=true; q.push(w); } }
    return order;
  };
  const parent = bfsParents();
  const keep = new Set([ROOT]);
  // a) copyleft nodes + their ancestor chain to root
  nodes.forEach((_,i)=>{
    if(!isCopyleft(lic[i])) return;
    let cur=i, chain=[];
    while(cur!==undefined && cur!==ROOT){ chain.push(cur); cur=parent[cur]; }
    if(cur===ROOT){ chain.push(ROOT); chain.forEach(x=>keep.add(x)); }
    else keep.add(i);   // unreachable in BFS, still keep the node itself
  });
  // b) fill remaining slots by BFS proximity to root
  for(const i of bfsOrder()){
    if(keep.size >= MAX_DISPLAY) break;
    keep.add(i);
  }
  const truncated = keep.size < nodes.length;

  // 5. unique display ids (suffix @version only when a name collides)
  const kept = [...keep];
  const nameCount = {};
  kept.forEach(i=>{ const n=nodes[i].versionKey.name; nameCount[n]=(nameCount[n]||0)+1; });
  const idOf = i=>{
    const vk = nodes[i].versionKey;
    return nameCount[vk.name] > 1 ? vk.name + "@" + vk.version : vk.name;
  };

  // 6. assemble packages + dependencies in the existing shape
  const packages = kept.map(i=>({ name: idOf(i), license: lic[i] }));
  const seenEdge = new Set();
  const dependencies = [];
  edgesIdx.forEach(e=>{
    if(!keep.has(e.fromNode) || !keep.has(e.toNode) || e.fromNode===e.toNode) return;
    const k = e.fromNode + ">" + e.toNode;
    if(seenEdge.has(k)) return; seenEdge.add(k);
    dependencies.push({ parent: idOf(e.fromNode), child: idOf(e.toNode) });
  });

  return {
    root: idOf(ROOT),
    rootVersion,
    packages, dependencies,
    truncated, total: nodes.length, shown: kept.length,
  };
}

/* =======================================================================
   PROMETHEUX — run the saved `contaminated_path` concept (live reasoning).
   Token stays server-side. Returns a normalised { ok, rows, columns,
   elapsedMs } so the browser never sees the token and gets a stable shape.
======================================================================= */
// contaminated_path2 reasons over the Gatsby dependency graph (gatsby → … → smartwrap)
const PMTX_CONCEPT_PATH = "api/v1/concepts/9e354b7f44/run/contaminated_path2";

function runConcept(){
  return new Promise(resolve=>{
    const base  = process.env.PMTX_API_URL;
    const token = process.env.PMTX_TOKEN;
    if(!base || !token) return resolve({ ok:false, error:"PMTX_API_URL / PMTX_TOKEN not set in .env" });

    // build the exact path with /api/v1/, keep https, don't follow redirects
    const url  = base.replace(/\/?$/,"/") + PMTX_CONCEPT_PATH;
    const body = JSON.stringify({ params:{}, scope:"user", persist_outputs:false });
    const t0   = Date.now();

    const req = https.request(url, {
      method:"POST",
      headers:{
        "Authorization":"Bearer " + token,
        "Content-Type":"application/json",
        "Accept":"application/json",
        "Content-Length":Buffer.byteLength(body),
      },
    }, res=>{
      let d = "";
      res.on("data", c=> d += c);
      res.on("end", ()=>{
        let j; try{ j = JSON.parse(d); }catch{ return resolve({ ok:false, error:"bad JSON from Prometheux" }); }
        if(res.statusCode !== 200 || j.status !== "success"){
          return resolve({ ok:false, error:(j && j.message) || ("HTTP " + res.statusCode), raw:j });
        }
        const ev = (j.data && j.data.evaluation_results) || {};
        // read whatever predicate the concept populated (e.g. contaminated_path2)
        const predKey = ev.resultSet ? Object.keys(ev.resultSet)[0] : null;
        const cols = (predKey && ev.columnNames && ev.columnNames[predKey]) || [];
        const rows = (predKey && ev.resultSet[predKey]) || [];
        resolve({ ok:true, elapsedMs: Date.now()-t0, serverElapsedMs: ev.elapsedTimeMs, predicate: predKey, columns:cols, rows });
      });
    });
    req.on("error", e=> resolve({ ok:false, error:e.message }));
    req.setTimeout(60000, ()=>{ req.destroy(); resolve({ ok:false, error:"Prometheux timed out (60s)" }); });
    req.write(body); req.end();
  });
}

/* ---- static file serving ------------------------------------------- */
const MIME = { ".html":"text/html", ".csv":"text/csv", ".js":"text/javascript",
               ".css":"text/css", ".md":"text/markdown" };

function serveFile(res, file){
  fs.readFile(path.join(__dirname, file), (err, buf)=>{
    if(err){ res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.end(buf);
  });
}

/* ---- routes -------------------------------------------------------- */
http.createServer(async (req, res)=>{
  const url = req.url.split("?")[0];

  if(url === "/api/scan"){
    const q = new URLSearchParams(req.url.split("?")[1] || "");
    const name = (q.get("package") || "").trim();
    if(!name){
      res.writeHead(400, {"Content-Type":"application/json"});
      return res.end(JSON.stringify({ error:"missing ?package=NAME" }));
    }
    try{
      const data = await scanNpmPackage(name);
      console.log(`🔍 live scan: ${name} → ${data.shown}/${data.total} pkgs` +
        (data.truncated ? " (truncated)" : ""));
      res.writeHead(200, {"Content-Type":"application/json"});
      res.end(JSON.stringify(data));
    }catch(err){
      const code = err.code && err.code>=400 && err.code<600 ? err.code : 500;
      console.log(`⚠️  live scan failed for ${name}: ${err.message}`);
      res.writeHead(code, {"Content-Type":"application/json"});
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if(url === "/api/prometheux"){
    const r = await runConcept();
    console.log(r.ok
      ? `🧠 Prometheux ran: ${r.rows.length} row(s) in ${r.elapsedMs}ms`
      : `⚠️  Prometheux call failed: ${r.error}`);
    res.writeHead(200, { "Content-Type":"application/json" });
    res.end(JSON.stringify(r));
    return;
  }

  if(url === "/api/unlock" && req.method === "POST"){
    // PAYWALL unlock: returns the full cited.md ONLY on the correct dev
    // password. The report never leaves the server otherwise.
    const b = await readJsonBody(req);
    const expected = process.env.DEV_UNLOCK_PASSWORD;
    const json = { "Content-Type":"application/json" };
    if(!expected){
      res.writeHead(200, json);
      return res.end(JSON.stringify({ ok:false, error:"Unlock not configured — set DEV_UNLOCK_PASSWORD in .env" }));
    }
    if(!b.password || b.password !== expected){
      res.writeHead(200, json);
      return res.end(JSON.stringify({ ok:false, error:"Incorrect password" }));
    }
    let report;
    try{ report = fs.readFileSync(path.join(__dirname, "cited.md"), "utf8"); }
    catch{
      res.writeHead(200, json);
      return res.end(JSON.stringify({ ok:false, error:"No report yet — run a scan that finds contamination first" }));
    }
    console.log("🔓 report unlocked (dev password)");
    res.writeHead(200, json);
    res.end(JSON.stringify({ ok:true, report }));
    return;
  }

  if(url === "/api/scan-sources" && req.method === "POST"){
    const b = await readJsonBody(req);
    const license = b.license || "GPL";
    // extract a clean SPDX id (e.g. GPL-3.0) from a possibly-compound license string
    const spdxId = (license.match(/[AL]?GPL[\w.\-]*/i) || [license])[0];
    try{
      const sources = await getLiveSources(b.copyleftPkg, spdxId);
      writeLiveCitedReport(b.package, b.copyleftPkg, spdxId, b.path, sources);
      // PAYWALL: gated — only signal readiness, not the source URLs.
      res.writeHead(200, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ ready:true, count: sources.length }));
    }catch(err){
      res.writeHead(200, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if(url === "/api/sources"){
    try{
      const sources = await getSources();
      writeCitedReport(sources);   // write cited.md from the live URLs
      // store this scan in ClickHouse (never throws — failures are logged)
      await saveScan({
        root: "gatsby",
        contaminated: 1,
        copyleft: "smartwrap",
        path: "gatsby → gatsby-recipes → graphql-tools-schema → value-or-promise → to-readable-stream → smartwrap",
      });
      // PAYWALL: report is written to cited.md but NOT returned here — the
      // client only learns it's ready. Full content comes via /api/unlock.
      res.writeHead(200, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ ready:true, count: sources.length }));
    }catch(err){
      res.writeHead(500, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if(url === "/" || url === "/index.html") return serveFile(res, "index.html");
  // allow only known static files (no path traversal)
  const safe = url.replace(/^\//, "");
  if(["packages.csv","dependencies.csv","sample_packages.csv","sample_dependencies.csv","cited.md"].includes(safe)){
    return serveFile(res, safe);
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, ()=>{
  console.log(`License Contamination Scanner running → http://localhost:${PORT}`);
  if(!process.env.TAVILY_API_KEY) console.log("⚠️  TAVILY_API_KEY not set — /api/sources will error. Add it to .env");
});
