// Local dev server: serves public/ and routes /api/* to the same handlers Vercel runs.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { Readable } from "node:stream";
import { handleAsk, handleEvent, handleItems, handleSearch, setCatalog } from "./lib/core.mjs";

const PUB = new URL("./public/", import.meta.url).pathname;
setCatalog(JSON.parse(await readFile(join(PUB, "data/videos.json"), "utf8")));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    let r;
    if (url.pathname.startsWith("/api/")) {
      const ac = new AbortController();
      res.on("close", () => { if (!res.writableEnded) ac.abort(); });
      const init = { method: req.method, headers: req.headers, signal: ac.signal };
      if (req.method === "POST") { init.body = Readable.toWeb(req); init.duplex = "half"; }
      const wreq = new Request(url, init);
      r = url.pathname === "/api/search" ? await handleSearch(wreq)
        : url.pathname === "/api/ask" ? await handleAsk(wreq)
        : url.pathname === "/api/items" ? await handleItems()
        : url.pathname === "/api/ev" ? await handleEvent(wreq)
        : new Response("not found", { status: 404 });
    } else {
      const p = extname(url.pathname) ? url.pathname : "/index.html";
      const file = normalize(join(PUB, p));
      if (!file.startsWith(PUB)) return res.writeHead(403).end();
      r = new Response(await readFile(file), { headers: { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-cache" } });
    }
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body) res.write(c);
    res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
}).listen(process.env.PORT || 8787, () => console.log("listening"));
