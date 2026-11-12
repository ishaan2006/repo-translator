import { readFileSync } from "node:fs";
import vm from "node:vm";

const store = {};
let listener;
const calls = [];
let mode = "ok";
const chrome = {
  runtime: { id: "ext", onMessage: { addListener: (f) => (listener = f) }, openOptionsPage() {} },
  action: { onClicked: { addListener() {} } },
  storage: { local: {
    async get(keys) { if (keys === null) return { ...store }; const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = store[k]; return o; },
    async set(o) { Object.assign(store, o); },
    async remove(keys) { for (const k of [].concat(keys)) delete store[k]; },
    setAccessLevel() {}
  } }
};
async function fakeFetch(url, init) {
  const body = JSON.parse(init.body);
  calls.push({ url, headers: init.headers, body });
  const segs = JSON.parse(body.messages[0].content);
  if (mode === "401") return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
  let out = segs.map((s) => "EN:" + s);
  if (mode === "bad-multi" && segs.length > 1) out = out.slice(1); // wrong length forces a split
  return new Response(JSON.stringify({ content: [{ type: "text", text: "Sure:\n" + JSON.stringify(out) }] }), { status: 200, headers: { "content-type": "application/json" } });
}
const ctx = vm.createContext({ chrome, fetch: fakeFetch, crypto: globalThis.crypto, TextEncoder, Response, setTimeout, console, Promise, Math, Date, JSON, Array, Object, Number, String, Error, Uint8Array });
vm.runInContext(readFileSync(new URL("../src/background.js", import.meta.url), "utf8"), ctx);
const ask = (msg, id = "ext") => new Promise((res) => listener(msg, { id }, res));

const results = {};
results.noKey = (await ask({ type: "translate", segments: ["你好"] })).error;
store.apiKey = "sk-ant-test-0123456789abcdefghijklmnop";
const st = await ask({ type: "status" });
results.statusHasNoKeyValue = !JSON.stringify(st).includes("sk-ant");
const r1 = await ask({ type: "translate", segments: ["你好 ⟦0⟧", "<t1>世界</t1>"] });
const c = calls[0];
const before = calls.length;
await ask({ type: "translate", segments: ["你好 ⟦0⟧", "<t1>世界</t1>"] });
const cacheCalls = calls.length - before;
mode = "bad-multi";
const r3 = await ask({ type: "translate", segments: ["一", "二", "三", "四"] });
mode = "401";
const badKey = (await ask({ type: "translate", segments: ["新的文本"] })).error;
const foreign = (await ask({ type: "status" }, "evil")).error;
const cleared = (await ask({ type: "clearCache" })).cleared;

const checks = {
  "missing key is reported": results.noKey === "NO_KEY",
  "status never returns the key": results.statusHasNoKeyValue,
  "translations keep order and markers": JSON.stringify(r1.translations) === JSON.stringify(["EN:你好 ⟦0⟧", "EN:<t1>世界</t1>"]),
  "request has key and version headers": c.headers["x-api-key"] === store.apiKey && c.headers["anthropic-version"] === "2023-06-01",
  "only api.anthropic.com is called": c.url === "https://api.anthropic.com/v1/messages",
  "default model is claude-haiku-5-5": c.body.model === "claude-haiku-5-5",
  "malformed batch is split and recovered": JSON.stringify(r3.translations) === JSON.stringify(["EN:一", "EN:二", "EN:三", "EN:四"]),
  "401 gives a clear message": badKey === "API key was rejected (401). Check it in the extension options.",
  "messages from other extensions are rejected": foreign === "forbidden",
  "cache can be cleared": cleared > 0
};
checks["repeat request is served from cache"] = cacheCalls === 0;
let failed = 0;
for (const [name, ok] of Object.entries(checks)) { console.log((ok ? "ok   " : "FAIL ") + name); if (!ok) failed++; }
process.exit(failed ? 1 : 0);
