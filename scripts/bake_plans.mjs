// Records the home-page watch plans into public/data/plans.json. Each plan's id, title,
// pitch and prompt live in that file; this fills in the recorded answer, the videos it
// cites and its length. A run is kept only if it cites at least MIN_VIDEOS videos, so a
// plan that degrades into one video's chapter list keeps its previous recording.
// Usage: SITE=http://localhost:8787 node scripts/bake_plans.mjs [plan-id ...]
import { readFileSync, writeFileSync } from "node:fs";

const SITE = process.env.SITE || "http://localhost:8787";
const MIN_VIDEOS = 3;
const FILE = new URL("../public/data/plans.json", import.meta.url);
const plans = JSON.parse(readFileSync(FILE, "utf8"));
const only = process.argv.slice(2);

function parse(blocks) {
  const data = (b) => { try { return JSON.parse(b.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")); } catch { return null; } };
  const done = blocks.map(data).find((e) => e?.type === "response.completed");
  if (!done) return null;
  const parts = done.response.output.flatMap((o) => o.content || []);
  const text = parts.map((p) => p.text || "").join("");
  const vids = [...new Set(parts.flatMap((p) => p.annotations || []).map((a) => a.vid).filter(Boolean))];
  // The plan states its length in words; the cited clips are often shorter than the
  // segments they anchor, so summing them undercounts.
  const total = text.match(/total[^\n]*?(\d+)\s*min/i);
  const minutes = total ? Number(total[1]) : [...text.matchAll(/about (\d+)\s*min/gi)].reduce((s, m) => s + Number(m[1]), 0);
  return { text, vids, minutes };
}

for (const p of plans) {
  if (only.length && !only.includes(p.id)) continue;
  let kept = false;
  for (let attempt = 1; attempt <= 3 && !kept; attempt++) {
    const r = await fetch(`${SITE}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: p.q, mode: "watch" }) });
    const raw = await r.text();
    const blocks = raw.split(/(?<=\n\n)/).filter((b) => b.trim());
    const got = r.ok && parse(blocks);
    console.error(`${p.id} attempt ${attempt}: ${got ? `${got.vids.length} videos, ${got.minutes} min` : `failed (${r.status})`}`);
    // An answer that apologizes for a video it couldn't find reads as broken on the home page.
    if (got && /\b(not|n't) (available|in the index|indexed)\b/i.test(got.text)) { console.error(`${p.id}: mentions a missing video`); continue; }
    if (got && got.vids.length >= MIN_VIDEOS) {
      Object.assign(p, { vids: got.vids, minutes: got.minutes, stream: blocks });
      kept = true;
    }
    // A completed answer is cached server-side for 30 min, so a retry would replay it.
    if (!kept && r.headers.get("x-cache") === "hit") { console.error(`${p.id}: cached answer; restart the server to retry`); break; }
  }
  writeFileSync(FILE, JSON.stringify(plans));
}
