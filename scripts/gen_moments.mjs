// Asks Jockey for the moments worth jumping to in each ready video and writes
// public/data/moments.json as {vid: [{t, end, label}]}. Resumable: videos already in the
// file are skipped. Usage: TL_API_KEY=... node scripts/gen_moments.mjs [--only vid,vid] [--redo]
import { readFileSync, writeFileSync, renameSync } from "node:fs";

const API = process.env.TL_API_BASE || "https://api.twelvelabs.io/v1.3";
const KS = process.env.KS_ID || "ks_01a19fdb-0da5-7733-ad51-71c85f488a45";
const FILE = new URL("../public/data/moments.json", import.meta.url).pathname;
const VIDEOS = new URL("../public/data/videos.json", import.meta.url).pathname;
const CONCURRENCY = 4;
const MAX_LABEL = 60;

const args = process.argv.slice(2);
const only = args.includes("--only") ? new Set(args[args.indexOf("--only") + 1].split(",")) : null;
const redo = args.includes("--redo");
const key = process.env.TL_API_KEY;
if (!key) throw new Error("TL_API_KEY is not set");

const PROMPT =
  "List the 6 to 8 moments in this video most worth jumping to, in time order. One line each, formatted as " +
  "'- <label>' followed by a citation of that exact moment. The label is at most 50 characters, specific and " +
  "concrete (name who does what or the exact idea, e.g. 'Hickey defines complect' or 'Chip etched with UV light'), " +
  "never 'the speaker discusses'. No intro or closing text.";

const ntitle = (t) => String(t || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
const titleToVid = new Map(JSON.parse(readFileSync(VIDEOS, "utf8")).map((v) => [ntitle(v.title), v.vid]));

async function readyItems() {
  const page = async (n) => {
    const r = await fetch(`${API}/knowledge-stores/${KS}/items?page=${n}&page_limit=50`, { headers: { "x-api-key": key } });
    if (!r.ok) throw new Error(`items ${r.status}`);
    return r.json();
  };
  const first = await page(1);
  const rest = await Promise.all(Array.from({ length: (first.page_info?.total_page || 1) - 1 }, (_, i) => page(i + 2)));
  const out = new Map();
  for (const d of [first, ...rest]) for (const it of d.data || []) {
    const vid = it.item_metadata?.vid || titleToVid.get(ntitle(it.title));
    if (vid && it.status === "ready") out.set(vid, it._id);
  }
  return out;
}

function shorten(s) {
  if (s.length <= MAX_LABEL) return s;
  const cut = s.slice(0, MAX_LABEL - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : cut.length).replace(/[\s,;:.–—-]+$/, "")}…`;
}

// Times come only from citations on this item; a line without one is dropped, since a
// timestamp the model typed into prose is not tied to anything it saw.
function parse(text, annotations, item) {
  const moments = [];
  let pos = 0;
  for (const line of text.split("\n")) {
    const len = Array.from(line).length;
    const a = annotations.find((x) => x.type === "video_citation" && x.item_id === item && x.start_index >= pos && x.start_index < pos + len);
    pos += len + 1;
    if (!a || typeof a.start_sec !== "number") continue;
    const label = line.replace(/\[\d+\]/g, "").replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim().replace(/[\s:–—-]+$/, "");
    if (label.length < 4) continue;
    moments.push({ t: Math.floor(a.start_sec), end: Math.ceil(a.end_sec ?? a.start_sec), label: shorten(label) });
  }
  moments.sort((x, y) => x.t - y.t);
  return moments.filter((m, i) => i === 0 || m.t - moments[i - 1].t >= 5);
}

async function ask(item) {
  const r = await fetch(`${API}/responses`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jockey1.0", knowledge_store_id: KS, stream: false, tools: [],
      selections: [{ kind: "item", id: item }],
      instructions: "You write chapter markers for one video. Use only the selected video.",
      input: [{ type: "message", role: "user", content: PROMPT }],
    }),
  });
  if (!r.ok) throw new Error(`responses ${r.status}`);
  const j = await r.json();
  const parts = (j.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).filter((p) => p.type === "output_text");
  return parts.flatMap((p) => parse(p.text, p.annotations || [], item));
}

const load = () => { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; } };
const save = (all) => { writeFileSync(`${FILE}.tmp`, JSON.stringify(all)); renameSync(`${FILE}.tmp`, FILE); };

const all = load();
const ready = await readyItems();
const todo = [...ready].filter(([vid]) => (!only || only.has(vid)) && (redo || !all[vid]));
console.error(`${ready.size} ready, ${todo.length} to do`);
let done = 0;
async function worker() {
  for (let next; (next = todo.shift()); ) {
    const [vid, item] = next;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const moments = await ask(item);
        // fewer than 3 cited lines means the answer went wrong; leave it out so a rerun retries
        if (moments.length >= 3) { all[vid] = moments; save(all); }
        console.error(`${++done} ${vid} ${moments.length} moments`);
        break;
      } catch (e) {
        console.error(`${vid} attempt ${attempt}: ${e.message}`);
      }
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.error(`moments for ${Object.keys(all).length} videos`);
