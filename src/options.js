"use strict";
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const ORIGINS = ["https://github.com/*", "https://api.anthropic.com/*"];

function msg(el, text, kind) {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function send(m) {
  return new Promise((resolve) => {
    const p = api.runtime.sendMessage(m, (r) => resolve(r || {}));
    if (p && typeof p.then === "function") p.then(resolve, (e) => resolve({ error: String(e) }));
  });
}

async function refresh() {
  const s = await api.storage.local.get(["apiKey", "model", "auto"]);
  const k = s.apiKey;
  $("keyState").innerHTML = "";
  if (k) {
    const span = document.createElement("span");
    span.append("Key saved: ");
    const b = document.createElement("b");
    b.textContent = k.slice(0, 7) + "…" + k.slice(-4); // never show the full key
    span.append(b);
    $("keyState").append(span);
  } else {
    $("keyState").textContent = "No key saved yet.";
  }
  $("model").value = s.model || "claude-haiku-5-5";
  $("auto").checked = s.auto === true;
}

$("keyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const v = $("key").value.trim();
  if (!/^sk-ant-[A-Za-z0-9_\-]{20,}$/.test(v)) {
    msg($("keyMsg"), "That doesn't look like an Anthropic API key (it should start with sk-ant-).", "err");
    return;
  }
  await api.storage.local.set({ apiKey: v });
  $("key").value = "";
  msg($("keyMsg"), "Saved on this device.", "ok");
  refresh();
});

$("test").addEventListener("click", async () => {
  msg($("keyMsg"), "Testing…");
  const r = await send({ type: "testKey" });
  if (r.ok) msg($("keyMsg"), `Works. "你好，世界" → "${r.sample}"`, "ok");
  else msg($("keyMsg"), r.error || "Test failed.", "err");
});

$("remove").addEventListener("click", async () => {
  await api.storage.local.remove("apiKey");
  msg($("keyMsg"), "Key removed from this device.", "ok");
  refresh();
});

$("saveSettings").addEventListener("click", async () => {
  const model = $("model").value.trim() || "claude-haiku-5-5";
  await api.storage.local.set({ model, auto: $("auto").checked });
  msg($("setMsg"), "Saved.", "ok");
});

$("clear").addEventListener("click", async () => {
  const r = await send({ type: "clearCache" });
  msg($("setMsg"), `Cleared ${r.cleared || 0} cached translations.`, "ok");
});

// Firefox can install MV3 extensions with host access not yet granted.
async function checkPerms() {
  if (!api.permissions || !api.permissions.contains) return;
  const ok = await api.permissions.contains({ origins: ORIGINS });
  $("permSection").hidden = ok;
}
$("grant").addEventListener("click", async () => {
  const ok = await api.permissions.request({ origins: ORIGINS });
  msg($("permMsg"), ok ? "Access granted." : "Access was not granted.", ok ? "ok" : "err");
  checkPerms();
});

refresh();
checkPerms();
