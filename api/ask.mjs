import { handleAsk, setCatalog } from "../lib/core.mjs";
import videos from "../lib/catalog.json" with { type: "json" };

setCatalog(videos);
export const POST = (req) => handleAsk(req);
