// Builds public/data/hn/<vid>.json for every video on the site: the HN comments that link it
// and the videos to watch next. Usage: node scripts/build_comments.mjs [path/to/hackertube-data]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const SRC = process.argv[2] || new URL("../../../data/raw/hackertube-data/", import.meta.url).pathname;
const OUT = new URL("../public/data/hn/", import.meta.url).pathname;
const videos = JSON.parse(readFileSync(new URL("../public/data/videos.json", import.meta.url), "utf8"));
const ours = new Set(videos.map((v) => v.vid));
const lines = (f) => readFileSync(SRC + f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const MAX_TEXT = 900;
const RELATED = 10;
const RANK = { strong_rec: 0, rec: 1, reference: 2, critical: 3, joke: 4 };
const trim = (s) => {
  if (s.length <= MAX_TEXT) return s;
  const cut = s.slice(0, MAX_TEXT);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), MAX_TEXT - 80)) + "…";
};

const comments = new Map();
for (const m of lines("mentions.jsonl")) {
  if (!ours.has(m.vid)) continue;
  if (!comments.has(m.vid)) comments.set(m.vid, []);
  comments.get(m.vid).push(m);
}

// Ranked by topical likeness from the dataset's embeddings, nudged up when the same HN people
// recommended both. Co-recommendation alone is mostly one shared recommender inside our 512,
// which pairs linear algebra with UFO podcasts.
const shared = new Map();
for (const r of lines("related.jsonl")) {
  if (ours.has(r.vid)) shared.set(r.vid, new Map(r.related.filter((x) => ours.has(x.vid)).map((x) => [x.vid, x.shared_recommenders])));
}
const CO_BONUS = 0.06;

function loadEmbeddings() {
  const buf = readFileSync(SRC + "embeddings.npy");
  const headerLen = buf.readUInt16LE(8);
  const header = buf.toString("latin1", 10, 10 + headerLen);
  const [rows, dim] = header.match(/\((\d+), (\d+)\)/).slice(1).map(Number);
  if (!header.includes("'<f2'")) throw new Error(`unexpected dtype: ${header}`);
  const start = buf.byteOffset + 10 + headerLen;
  const f16 = new Float16Array(buf.buffer.slice(start, start + rows * dim * 2));
  const ids = JSON.parse(readFileSync(SRC + "embedding_ids.json", "utf8"));
  const vec = new Map();
  ids.forEach((vid, i) => { if (ours.has(vid)) vec.set(vid, Float32Array.from(f16.subarray(i * dim, (i + 1) * dim))); });
  return vec;
}
const vec = loadEmbeddings();
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
function nearest(vid) {
  const a = vec.get(vid), co = shared.get(vid) || new Map();
  if (!a) return [];
  return [...vec].filter(([v]) => v !== vid)
    .map(([v, b]) => [v, dot(a, b) + CO_BONUS * Math.min(co.get(v) || 0, 3)])
    .sort((x, y) => y[1] - x[1]).map(([v]) => v);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
let bytes = 0;
for (const { vid } of videos) {
  const c = (comments.get(vid) || [])
    .sort((a, b) => RANK[a.stance] - RANK[b.stance] || Math.min(b.text.length, 600) - Math.min(a.text.length, 600))
    .slice(0, 20)
    .map((m) => ({ id: m.hn_comment_id, by: m.author, m: m.month, story: m.story_title, st: m.stance, text: trim(m.text) }));
  const json = JSON.stringify({ comments: c, related: nearest(vid).slice(0, RELATED) });
  bytes += json.length;
  writeFileSync(OUT + vid + ".json", json);
}
console.log(`${videos.length} files, ${(bytes / 1024 / 1024).toFixed(2)} MB`);
