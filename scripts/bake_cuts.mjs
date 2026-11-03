// Records the home page's cut examples (mode "cut") into public/data/examples.json, leaving
// every other recorded example as it is. A run is kept only if it is a real cut: at least 4
// clips, and clips from 2+ videos when the question asks for several.
// Usage: SITE=http://localhost:8796 node scripts/bake_cuts.mjs
import { readFileSync, writeFileSync } from "node:fs";

const SITE = process.env.SITE || "http://localhost:8787";
const FILE = new URL("../public/data/examples.json", import.meta.url);
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = html.slice(html.indexOf("const EXAMPLES = ["), html.indexOf("];", html.indexOf("const EXAMPLES = [")) + 1);
const EXAMPLES = eval(block.replace("const EXAMPLES =", "(") + ")");
const out = JSON.parse(readFileSync(FILE, "utf8"));

for (const ex of EXAMPLES.filter((e) => e.mode === "cut")) {
  const several = /several|multiple|different videos/i.test(ex.q);
  let kept = false;
  for (let attempt = 1; attempt <= 3 && !kept; attempt++) {
    const r = await fetch(`${SITE}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: ex.q, mode: "cut" }) });
    const text = await r.text();
    const blocks = text.split(/(?<=\n\n)/).filter((b) => b.trim());
    const done = blocks.find((b) => b.includes('"response.completed"'));
    if (!r.ok || !done) { console.error(`${ex.q}: attempt ${attempt} failed (${r.status})`); continue; }
    const resp = JSON.parse(done.slice(5).trim()).response;
    const anns = resp.output.flatMap((o) => (o.content || []).flatMap((c) => c.annotations || [])).filter((a) => a.type === "video_citation" && a.vid);
    const vids = new Set(anns.map((a) => a.vid));
    console.error(`${ex.q}: ${anns.length} clips from ${vids.size} videos`);
    for (const a of anns) console.error(`  ${a.vid} ${a.start_sec?.toFixed(1)}-${a.end_sec?.toFixed(1)}`);
    if (anns.length >= 4 && (!several || vids.size >= 2)) { out[`cut|${ex.q}`] = blocks; kept = true; }
    else if (r.headers.get("x-cache") === "hit") { console.error("  cached answer; restart the server to retry"); break; }
  }
}
writeFileSync(FILE, JSON.stringify(out));
