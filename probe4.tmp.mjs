import { Store } from "./dist/store/index.js";
import { userText } from "./dist/trajectory/agent-identity.js";
const store = new Store(process.env.HOME + "/.tracetap/index.db");
const seen = new Set();
for (const r of store.listRequests("claude:b5ba8662").slice(0, 40)) {
  const p = store.getRawPair("claude:b5ba8662", r.seq);
  if (!p) continue;
  const t = userText(p);
  // Strip the system-reminder preamble the way the join does, then show what
  // the workflow actually handed this agent.
  const after = t.replace(/^.*?<\/system-reminder>\s*/s, "");
  const key = after.slice(0, 90);
  if (seen.has(key)) continue;
  seen.add(key);
  console.log("seq", String(r.seq).padStart(3), "|", JSON.stringify(after.slice(0, 130)));
  if (seen.size >= 8) break;
}
console.log("\ndistinct task openings among first 40 calls:", seen.size);
