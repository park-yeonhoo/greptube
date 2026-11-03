import { handleItems, setCatalog } from "../lib/core.mjs";
import videos from "../lib/catalog.json" with { type: "json" };

setCatalog(videos);
export const GET = () => handleItems();
