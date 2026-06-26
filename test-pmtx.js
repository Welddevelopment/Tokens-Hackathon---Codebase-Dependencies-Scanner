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

/* ---- multipart/form-data upload (no deps); pathVal "" = disk root --- */
function uploadCsv(filename, content, pathVal=""){
  return new Promise(resolve=>{
    const url = join(BASE, "api/v1/data/files/upload");
    const boundary = "----pmtxBoundary" + Date.now();
    const pre  = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
                 `Content-Type: text/csv\r\n\r\n`;
    const mid  = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="path"\r\n\r\n${pathVal}\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(pre,"utf8"), Buffer.from(content,"utf8"), Buffer.from(mid,"utf8")]);
    const u = new URL(url);
    const req = https.request({
      hostname:u.hostname, path:u.pathname, method:"POST",
      headers:{
        "Authorization":"Bearer "+TOKEN,
        "Content-Type":"multipart/form-data; boundary="+boundary,
        "Content-Length":body.length,
        "Accept":"application/json",
      },
    }, res=>{
      let d=""; res.on("data",c=>d+=c);
      res.on("end",()=> resolve({ status:res.statusCode, ctype:res.headers["content-type"]||"", loc:res.headers.location, body:d }));
    });
    req.on("error",e=> resolve({ status:0, body:"ERR "+e.message }));
    req.setTimeout(30000, ()=>{ req.destroy(); resolve({ status:0, body:"TIMEOUT" }); });
    req.write(body); req.end();
  });
}

/* ---- --upload-run : definitive test that upload feeds the run --------
   Uploads express/some-pkg as the ROOT packages.csv + dependencies.csv
   (what contaminated_path2 reads), runs contaminated_path2, then RESTORES
   the gatsby CSVs from the repo so the example stays intact. ----------- */
if(process.argv.includes("--upload-run")){
  (async ()=>{
    const PKGS = "name,license\nexpress,MIT\nsome-pkg,GPL-3.0\n";
    const DEPS = "parent,child\nexpress,some-pkg\n";

    // 1+2. upload the test data to ROOT (overwrites packages.csv/dependencies.csv)
    for(const [fn, body] of [["packages.csv",PKGS], ["dependencies.csv",DEPS]]){
      console.log("=== UPLOAD " + fn + " (root) ===");
      const u = await uploadCsv(fn, body, "");
      console.log("HTTP " + u.status + "   " + (u.body||"").slice(0,200) + "\n");
    }

    // 3. run contaminated_path2 (reads root packages.csv/dependencies.csv)
    const runUrl = join(BASE, "api/v1/concepts/9e354b7f44/run/contaminated_path2");
    console.log("=== RUN contaminated_path2 ===\nPOST " + runUrl);
    const t0 = Date.now();
    const r = await post(runUrl, { params:{}, scope:"user", persist_outputs:false });
    console.log("HTTP " + r.status + "  in " + (Date.now()-t0) + "ms");
    console.log("──────────── full result ────────────");
    let out = r.body; try{ out = JSON.stringify(JSON.parse(r.body), null, 2); }catch{}
    console.log(out);
    console.log("\n>>> KEY: rows mentioning express/some-pkg = upload FEEDS run (unblocked).");
    console.log(">>>      rows mentioning gatsby/smartwrap = stale/cached (not dynamic).\n");

    // 4. RESTORE the gatsby CSVs so the example is unaffected
    console.log("=== RESTORE gatsby packages.csv + dependencies.csv ===");
    for(const fn of ["packages.csv","dependencies.csv"]){
      const u = await uploadCsv(fn, fs.readFileSync(fn,"utf8"), "");
      console.log("restored " + fn + " -> HTTP " + u.status);
    }
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
