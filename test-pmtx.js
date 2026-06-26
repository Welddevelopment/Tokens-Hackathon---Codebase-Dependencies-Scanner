/* =======================================================================
   Minimal Prometheux API connectivity test.
   Reads PMTX_API_URL + PMTX_TOKEN from .env, then does simple authenticated
   GETs to confirm the URL and token work BEFORE we build the real
   integration. No dependencies — Node built-ins only.

   Run:  node test-pmtx.js              (probes a few likely endpoints)
         node test-pmtx.js projects     (hits just <base>/projects)
======================================================================= */
const https = require("https");
const http  = require("http");
const fs    = require("fs");

/* ---- load .env (tiny parser) ---------------------------------------- */
const env = {};
try{
  fs.readFileSync(".env", "utf8").split(/\r?\n/).forEach(l=>{
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if(m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
}catch{ /* rely on process.env */ }

const BASE  = process.env.PMTX_API_URL || env.PMTX_API_URL;
const TOKEN = process.env.PMTX_TOKEN   || env.PMTX_TOKEN;

if(!BASE || !TOKEN){
  console.error("❌ Missing PMTX_API_URL and/or PMTX_TOKEN in .env");
  process.exit(1);
}
console.log("Base URL:", BASE);
console.log("Token   :", TOKEN.slice(0,6) + "…" + TOKEN.slice(-4), "(len " + TOKEN.length + ")\n");

/* ---- one authenticated GET ------------------------------------------ */
function get(url){
  return new Promise(resolve=>{
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "Authorization": "Bearer " + TOKEN, "Accept": "application/json" },
    }, res=>{
      let d = "";
      res.on("data", c=> d += c);
      res.on("end", ()=> resolve({ status: res.statusCode, ctype: res.headers["content-type"]||"", body: d }));
    });
    req.on("error", e=> resolve({ status: 0, ctype:"", body: "NETWORK ERROR: " + e.message }));
    req.setTimeout(10000, ()=>{ req.destroy(); resolve({ status: 0, ctype:"", body:"TIMEOUT" }); });
  });
}

const join = (base, path)=> path ? base.replace(/\/$/,"") + "/" + path.replace(/^\//,"") : base;

/* ---- one authenticated POST (for running a concept) ----------------- */
function post(url, payload){
  return new Promise(resolve=>{
    const lib = url.startsWith("https") ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request(url, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + TOKEN,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, res=>{
      let d = "";
      res.on("data", c=> d += c);
      res.on("end", ()=> resolve({ status: res.statusCode, ctype: res.headers["content-type"]||"", body: d }));
    });
    req.on("error", e=> resolve({ status: 0, ctype:"", body: "NETWORK ERROR: " + e.message }));
    req.setTimeout(120000, ()=>{ req.destroy(); resolve({ status: 0, ctype:"", body:"TIMEOUT (120s)" }); });
    req.write(data); req.end();
  });
}

/* ---- --run-concept : run the saved contaminated_path concept --------- */
const CONCEPT_RUN_URL = join(BASE, "api/v1/concepts/9e354b7f44/run/contaminated_path");
const CONCEPT_PAYLOAD = { params: {}, scope: "user", persist_outputs: false };

if(process.argv.includes("--run-concept")){
  (async ()=>{
    console.log("POST " + CONCEPT_RUN_URL);
    console.log("payload: " + JSON.stringify(CONCEPT_PAYLOAD) + "\n");
    const t0 = Date.now();
    const r = await post(CONCEPT_RUN_URL, CONCEPT_PAYLOAD);
    console.log("HTTP " + r.status + "   " + r.ctype + "   in " + (Date.now()-t0) + "ms");
    console.log("──────────── full response body ────────────");
    let pretty = r.body;
    try{ pretty = JSON.stringify(JSON.parse(r.body), null, 2); }catch{}
    console.log(pretty);
  })();
  return;
}

(async ()=>{
  // If a path was passed on the CLI, hit only that. Otherwise probe a few.
  const arg = process.argv[2];
  const paths = arg !== undefined ? [arg]
    : ["", "projects", "project", "workspaces", "me", "health", "status"];

  for(const p of paths){
    const url = join(BASE, p);
    const r = await get(url);
    const label = p === "" ? "(base URL)" : "/" + p;
    console.log("──────────────────────────────────────────────");
    console.log("GET " + label + "  →  " + url);
    console.log("HTTP " + r.status + "   " + r.ctype);
    const body = r.body.length > 900 ? r.body.slice(0,900) + " …[truncated]" : r.body;
    console.log(body || "(empty body)");
  }
  console.log("──────────────────────────────────────────────");
})();
