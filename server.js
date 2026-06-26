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

/* ---- static file serving ------------------------------------------- */
const MIME = { ".html":"text/html", ".csv":"text/csv", ".js":"text/javascript",
               ".css":"text/css", ".md":"text/markdown" };

function serveFile(res, file){
  fs.readFile(path.join(__dirname, file), (err, buf)=>{
    if(err){ res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ---- routes -------------------------------------------------------- */
http.createServer(async (req, res)=>{
  const url = req.url.split("?")[0];

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
      res.writeHead(200, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ sources }));
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
