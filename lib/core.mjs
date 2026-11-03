// Web-standard (Request -> Response) handlers shared by the Vercel functions and the
// local dev server. The TwelveLabs key stays here; the browser only sees sanitized data.
import { createHash } from "node:crypto";

const API = process.env.TL_API_BASE || "https://api.twelvelabs.io/v1.3";
const KS = process.env.KS_ID || "ks_01a19fdb-0da5-7733-ad51-71c85f488a45";
const key = () => {
  if (!process.env.TL_API_KEY) throw new Error("TL_API_KEY is required");
  return process.env.TL_API_KEY;
};

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

// --- item map, read from the store itself so newly ready videos appear without a deploy.
// Items added with metadata carry item_metadata.vid; the bulk adds match on title.
// Every item is mapped, not only ready ones: Jockey searches and cites a video while its
// indexing is still in progress, and an unmapped citation would vanish from the answer.
let items = { at: 0, vidToItem: new Map(), itemToVid: new Map(), ready: new Set(), counts: {} };
let itemsLoading = null;
const ntitle = (t) => String(t || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
let titleToVid = null;
export function setCatalog(videos) { titleToVid = new Map(videos.map((v) => [ntitle(v.title), v.vid])); }

async function itemsPage(page) {
  const r = await fetch(`${API}/knowledge-stores/${KS}/items?page=${page}&page_limit=50`, { headers: { "x-api-key": key() } });
  if (!r.ok) throw new Error(`items ${r.status}`);
  return r.json();
}
async function loadItems() {
  const vidToItem = new Map(), itemToVid = new Map(), ready = new Set(), counts = {};
  // The API caps a page at 50 items and takes ~4.5 s per page, so 510 videos one page
  // after another is close to a minute. Fetch the first page for the count, then the rest at once.
  const first = await itemsPage(1);
  const total = first.page_info?.total_page || 1;
  const rest = await Promise.all(Array.from({ length: total - 1 }, (_, i) => itemsPage(i + 2)));
  for (const d of [first, ...rest]) {
    for (const it of d.data || []) {
      counts[it.status] = (counts[it.status] || 0) + 1;
      const vid = it.item_metadata?.vid || titleToVid?.get(ntitle(it.title));
      if (!vid || it.status === "failed") continue;
      vidToItem.set(vid, it._id); itemToVid.set(it._id, vid);
      if (it.status === "ready") ready.add(vid);
    }
  }
  items = { at: Date.now(), vidToItem, itemToVid, ready, counts };
}
async function getItems(unknownIds = []) {
  const age = Date.now() - items.at;
  // An id we have never seen means the store grew since the last load: reload now, but at
  // most every 15 s so a flood of requests can't turn into a flood of store listings.
  const stale = age > 120_000 || (age > 15_000 && unknownIds.some((id) => !items.itemToVid.has(id)));
  if (stale) {
    itemsLoading ??= loadItems().catch((e) => console.error(e)).finally(() => { itemsLoading = null; });
    if (!items.at || unknownIds.length) await itemsLoading; // a plain refresh runs in the background
  }
  return items;
}

// --- abuse limits. Per-instance memory: good enough to stop one client hammering prod.
const buckets = new Map();
function allow(ip, kind, perMin) {
  const k = `${kind}:${ip}`, now = Date.now();
  const b = buckets.get(k) || { t: perMin, at: now };
  b.t = Math.min(perMin, b.t + ((now - b.at) / 60_000) * perMin);
  b.at = now;
  buckets.set(k, b);
  if (buckets.size > 50_000) buckets.clear();
  if (b.t < 1) return false;
  b.t -= 1;
  return true;
}
// Entries expire because the store is still growing: an answer cached at 40 videos
// shouldn't keep being served once there are 500.
class LRU {
  constructor(n, ttlMs) { this.n = n; this.ttl = ttlMs; this.m = new Map(); }
  get(k) {
    const e = this.m.get(k);
    if (!e) return undefined;
    this.m.delete(k);
    if (Date.now() - e.at > this.ttl) return undefined;
    this.m.set(k, e);
    return e.v;
  }
  set(k, v) { this.m.set(k, { v, at: Date.now() }); if (this.m.size > this.n) this.m.delete(this.m.keys().next().value); }
}
const searchCache = new LRU(2000, 10 * 60_000);
const askCache = new LRU(1000, 30 * 60_000);
const MAX_INFLIGHT_ASKS = Number(process.env.MAX_INFLIGHT_ASKS || 24);
let inflightAsks = 0;

const norm = (q) => q.trim().toLowerCase().replace(/\s+/g, " ");
const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 24);
const ipOf = (req) => (req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "local").split(",")[0].trim();

function jockey(path, body, signal) {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "x-api-key": key(), "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

async function body(req) {
  const s = await req.text();
  if (s.length > 8192) throw new Error("body too large");
  return s ? JSON.parse(s) : {};
}

const EVENTS = new Set(["ts", "share"]);
export async function handleEvent(req) {
  const b = await req.json().catch(() => ({}));
  if (EVENTS.has(b.e)) console.log(JSON.stringify({ ev: b.e, p: String(b.p || "").slice(0, 300), h: String(b.h || "").slice(0, 300) }));
  return new Response(null, { status: 204 });
}

export async function handleItems() {
  const it = await getItems();
  // stale-while-revalidate: the CDN keeps answering from its copy while one request refreshes
  // it, so no visitor waits on the slow store listing after the first.
  return json({ items: Object.fromEntries(it.itemToVid), ready: [...it.ready], counts: it.counts }, 200, { "cache-control": "public, s-maxage=60, stale-while-revalidate=3600" });
}

export async function handleSearch(req) {
  const { q, vid } = await body(req);
  if (typeof q !== "string" || !q.trim() || q.length > 300) return json({ error: "bad query" }, 400);
  const ck = hash(`${norm(q)}|${vid || ""}`);
  const hit = searchCache.get(ck);
  if (hit) return json(hit);
  if (!allow(ipOf(req), "search", 30)) return json({ error: "slow down" }, 429);
  const it = await getItems();
  const payload = {
    query: { text: q },
    search_options: { video: { modalities: ["visual", "audio"] } },
    group_by: "none",
    page_size: 40,
  };
  if (vid) {
    const item = it.vidToItem.get(vid);
    if (!item) return json({ results: [] });
    payload.filter = { item_id: { in: [item] } };
  }
  console.log(JSON.stringify({ ev: "search", q: q.slice(0, 300), vid: vid || null }));
  const r = await jockey(`/knowledge-stores/${KS}/search`, payload);
  if (!r.ok) { console.error("search", r.status, (await r.text()).slice(0, 300)); return json({ error: "upstream" }, 502); }
  const env = await r.json();
  const known = await getItems((env.data || []).map((h) => h.item_id));
  const results = [];
  for (const h of env.data || []) {
    const v = known.itemToVid.get(h.item_id);
    if (!v) continue;
    for (const m of h.matches || []) results.push({ vid: v, start: m.start_sec, end: m.end_sec, transcription: m.transcription || null, modalities: m.modalities || [] });
  }
  const out = { results };
  searchCache.set(ck, out);
  return json(out);
}

const INSTRUCTIONS = {
  default:
    "You answer questions about a collection of YouTube videos that Hacker News commenters keep recommending. " +
    "Ground every claim in specific moments of the videos and cite them. Prefer the exact moment over the whole video. " +
    "Be concise and concrete; write for curious engineers.",
  watch:
    "You are a viewing guide for a collection of YouTube videos that Hacker News commenters keep recommending. " +
    "Given the viewer's interests, recommend what to watch and, crucially, WHICH PART: name the exact segments worth their time, " +
    "in a sensible order, with one line on why each segment matters. Cite every segment. Skip filler. Keep it tight. " +
    "State each segment's length in whole minutes (\"about 4 min\"), never as m:ss, so it can't be mistaken for a timestamp.",
  cut:
    "You cut videos from a collection of YouTube videos that Hacker News commenters keep recommending down to one short video. " +
    "Answer with a numbered list of clips in playing order. Each clip is 15 to 40 seconds, starts at a clean point (the start of a sentence or idea), " +
    "and gets a one-line bold label saying what happens in it, followed by its citation. Cite every clip with its exact start and end. " +
    "Keep the total near the length the viewer asked for. No timestamps in the prose, no filler, no intro beyond one short line.",
};

// The upstream stream carries billing, signed HLS/thumbnail URLs and other account
// details; only text, citation positions and the session id reach the browser.
function sanitize(ev) {
  const t = ev.type || "";
  if (t === "response.output_text.delta") return { type: t, delta: ev.delta || "" };
  if (t === "response.failed" || t === "error") return { type: "error" };
  if (t.includes("function_call") || t.includes("tool")) return { type: "step", name: ev.item?.name || ev.name || "" };
  if (t !== "response.completed") return null;
  const r = ev.response || {};
  return {
    type: t,
    response: {
      session_id: r.session_id,
      output: (r.output || []).filter((o) => o.type === "message").map((o) => ({
        type: "message",
        content: (o.content || []).filter((p) => p.type === "output_text").map((p) => ({
          type: "output_text",
          text: p.text,
          annotations: (p.annotations || []).map((a) => ({
            type: a.type, start_index: a.start_index, end_index: a.end_index,
            item_id: a.item_id, start_sec: a.start_sec, end_sec: a.end_sec,
            ...(a.type === "url_citation" ? { url: a.url, title: a.title } : {}),
          })),
        })),
      })),
    },
  };
}

const SSE = { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" };

export async function handleAsk(req) {
  // Kill switch for a spend spike: set ASK_DISABLED=1 in Vercel env and redeploy (env is bound
  // at deploy time, ~30 s). Search keeps working,
  // and recorded example answers still play from the static file.
  if (process.env.ASK_DISABLED === "1") return json({ error: "paused" }, 503);
  const { q, vid, session_id, mode } = await body(req);
  if (typeof q !== "string" || !q.trim() || q.length > 1200) return json({ error: "bad query" }, 400);
  const cacheable = !session_id;
  const ck = hash(`${norm(q)}|${vid || ""}|${mode || ""}`);
  const hit = cacheable && askCache.get(ck);
  if (hit) return new Response(hit.join(""), { headers: { ...SSE, "x-cache": "hit" } });
  if (!allow(ipOf(req), "ask", 6)) return json({ error: "slow down" }, 429);
  if (inflightAsks >= MAX_INFLIGHT_ASKS) return json({ error: "busy" }, 503);

  const payload = {
    model: "jockey1.0",
    knowledge_store_id: KS,
    input: [{ type: "message", role: "user", content: q }],
    stream: true,
    tools: [],
    instructions: INSTRUCTIONS[mode] || INSTRUCTIONS.default,
  };
  if (session_id) payload.session_id = session_id;
  if (vid) {
    const item = (await getItems()).vidToItem.get(vid);
    if (item) payload.selections = [{ kind: "item", id: item }];
  }

  console.log(JSON.stringify({ ev: "ask", q: q.slice(0, 600), mode: mode || "default", vid: vid || null, followup: !!session_id }));
  inflightAsks++;
  let released = false;
  const release = () => { if (!released) { released = true; inflightAsks--; } };
  let upstream;
  try {
    upstream = await jockey("/responses", payload, req.signal);
  } catch (e) {
    release();
    console.error("ask fetch", e);
    return json({ error: "upstream" }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    release();
    console.error("ask", upstream.status, (await upstream.text()).slice(0, 300));
    return json({ error: "upstream" }, 502);
  }

  const recorded = [];
  const enc = new TextEncoder(), dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const emit = (obj) => { const s = `data: ${JSON.stringify(obj)}\n\n`; recorded.push(s); ctrl.enqueue(enc.encode(s)); };
      let buf = "", completed = false;
      try {
        for await (const chunk of upstream.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
            if (!data || data === "[DONE]") continue;
            let ev; try { ev = JSON.parse(data); } catch { continue; }
            const out = sanitize(ev);
            if (out?.type === "response.completed") {
              // The page knows videos, not store items; resolve here, where the map can be refreshed.
              const anns = out.response.output.flatMap((o) => o.content.flatMap((p) => p.annotations));
              const known = await getItems(anns.map((a) => a.item_id).filter(Boolean));
              for (const a of anns) if (a.item_id) a.vid = known.itemToVid.get(a.item_id) || null;
              completed = true;
            }
            if (out) emit(out);
          }
        }
        if (cacheable && completed) askCache.set(ck, recorded);
      } catch (e) {
        try { emit({ type: "error" }); } catch {}
      } finally {
        release();
        try { ctrl.close(); } catch {}
      }
    },
    cancel() { release(); },
  });
  return new Response(stream, { headers: SSE });
}
