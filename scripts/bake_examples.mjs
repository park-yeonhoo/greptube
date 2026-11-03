// Records answers for the home-page example questions into public/data/examples.json.
// Run against the live site after ingestion finishes, then redeploy.
import { readFileSync, writeFileSync } from "node:fs";

const SITE = process.env.SITE || "https://greptube.vercel.app";
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const block = html.slice(html.indexOf("const EXAMPLES = ["), html.indexOf("];", html.indexOf("const EXAMPLES = [")) + 1);
const EXAMPLES = eval(block.replace("const EXAMPLES =", "(") + ")");
const out = {};
for (const ex of EXAMPLES.filter((e) => e.mode !== "search")) {
  const mode = ex.mode === "watch" ? "watch" : "default";
  const r = await fetch(`${SITE}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ q: ex.q, mode }) });
  const text = await r.text();
  if (!r.ok || !text.includes('"response.completed"')) { console.error("FAILED", ex.q, r.status); continue; }
  out[`${mode}|${ex.q}`] = text.split(/(?<=\n\n)/).filter((b) => b.trim());
  console.error("ok", ex.q);
}
writeFileSync(new URL("../public/data/examples.json", import.meta.url), JSON.stringify(out));
