// Repo Translator: content script for github.com.
// Finds non-English text in page sections (About blurb, latest commit + file list commit
// messages, README / issues / PRs), asks the background script to translate it with Claude,
// and swaps it in place with a "Show original" toggle. This script never sees the API key.
(function () {
  "use strict";
  if (window.__ghtLoaded) return;
  window.__ghtLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const D = window.GHT_DOM;
  const BATCH_CHARS = 6000, BATCH_SEGS = 60, PARALLEL = 3;
  const sections = new Map(); // element -> section state
  let status = null;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        const p = api.runtime.sendMessage(msg, (r) => resolve(r || { error: api.runtime.lastError?.message || "no response" }));
        if (p && typeof p.then === "function") p.then(resolve, (e) => resolve({ error: String(e && e.message || e) }));
      } catch (e) { resolve({ error: String(e.message || e) }); }
    });
  }

  async function getStatus() {
    if (!status) status = await send({ type: "status" });
    return status;
  }

  // ---------- sections of a GitHub page ----------
  const COMMIT_SEL = "td.react-directory-row-commit-cell a.Link--secondary, [data-testid='latest-commit-html'] a";

  function findSections() {
    const out = [];
    // About blurb: GitHub renders it twice (narrow + wide layouts), so take every copy.
    document.querySelectorAll("h2").forEach((h) => {
      if (!/^\s*About\s*$/.test(h.textContent)) return;
      let n = h.nextElementSibling;
      while (n && !/^(P|H2|H3)$/.test(n.tagName)) n = n.nextElementSibling;
      if (n && n.tagName === "P") out.push({ el: n, kind: "about" });
    });
    // Latest commit + file list commit messages, as one section anchored on the file table.
    const cell = document.querySelector("td.react-directory-row-commit-cell");
    const table = cell && cell.closest("table");
    if (table) out.push({ el: table, kind: "commits" });
    // README, issues, PRs, releases, wiki.
    document.querySelectorAll(".markdown-body").forEach((el) => {
      if (el.closest("textarea, form, .ght-ui") || el.parentElement.closest(".markdown-body")) return;
      out.push({ el, kind: "md" });
    });
    return out;
  }

  function sectionText(sec) {
    if (sec.kind === "commits") return Array.from(document.querySelectorAll(COMMIT_SEL)).map((a) => a.textContent).join(" \n ");
    return D.proseText(sec.el);
  }

  function sectionItems(sec, mode) {
    if (sec.kind === "commits") {
      const items = [];
      document.querySelectorAll(COMMIT_SEL).forEach((a) => {
        if (a.hasAttribute("data-ght") || a.hasAttribute("data-ght-fail")) return;
        const enc = D.encode(a);
        if (!enc) return;
        if (mode === "script" && !D.FOREIGN_TEST(enc.plain)) return;
        items.push({ el: a, enc });
      });
      return items;
    }
    return D.findBlocks(sec.el, mode).filter((it) => !it.el.hasAttribute("data-ght-fail"));
  }

  async function detect(text) {
    if (text.length < 2) return null;
    const foreign = D.countForeign(text), latin = D.countLatin(text);
    if (foreign >= 2 && foreign / (foreign + latin) >= 0.12) {
      return { mode: "script", name: D.guessScriptLanguage(text) || "another language" };
    }
    if (latin < 150) return null;
    try {
      const r = await api.i18n.detectLanguage(text.slice(0, 4000));
      const top = r && r.languages && r.languages[0];
      if (r && r.isReliable && top && !/^en/.test(top.language) && top.percentage >= 60) {
        let name = top.language;
        try { name = new Intl.DisplayNames(["en"], { type: "language" }).of(top.language) || name; } catch (e) { /* keep code */ }
        return { mode: "latin", name };
      }
    } catch (e) { /* detectLanguage unavailable */ }
    return null;
  }

  // ---------- UI ----------
  function makeBar(sec) {
    const inline = sec.kind === "about";
    const bar = document.createElement(inline ? "span" : "div");
    bar.className = "ght-ui ght-bar" + (inline ? " ght-inline" : "");
    bar.setAttribute("role", "status");
    sec.el.insertAdjacentElement(inline ? "afterend" : "beforebegin", bar);
    return bar;
  }

  function setBar(bar, parts) {
    bar.textContent = "";
    parts.forEach((p) => {
      if (typeof p === "string") { bar.appendChild(document.createTextNode(p)); return; }
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ght-link";
      b.textContent = p.label;
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); p.onClick(); });
      bar.appendChild(b);
    });
  }

  function label(sec) {
    return sec.kind === "commits" ? "Commit messages" : sec.kind === "about" ? "Description" : "Text";
  }

  function renderDone(sec) {
    const n = sec.info.name;
    const toggle = { label: sec.showing === "trans" ? "Show original" : "Show English", onClick: () => toggleAll(sec.showing === "trans" ? "orig" : "trans") };
    const extra = sec.failed ? ` (${sec.failed} left as-is)` : "";
    const left = sec.pending ? sec.pending.size : 0;
    if (sec.kind === "md" && left && sec.showing === "trans") {
      setBar(sec.bar, [(sec.records.length ? `Translated from ${n} by Claude` : `${n} text: translating as you scroll`) + extra + " \u00B7 ",
        toggle, ` \u00B7 ${left} more part${left > 1 ? "s" : ""} below translate as you scroll \u00B7 `,
        { label: "Translate the rest now", onClick: () => translateRest(sec) }]);
      return;
    }
    if (sec.kind === "about") setBar(sec.bar, [sec.showing === "trans" ? `translated from ${n} · ` : `original ${n} · `, toggle]);
    else setBar(sec.bar, [(sec.showing === "trans" ? `${label(sec)} translated from ${n} by Claude` : `Original ${n}`) + extra + " · ", toggle]);
  }

  // One toggle flips every translated section on the page.
  function toggleAll(which) {
    sections.forEach((sec) => {
      if (sec.state !== "done") return;
      sec.records.forEach((r) => D.show(r, which));
      sec.showing = which;
      renderDone(sec);
    });
  }

  function promptBar(sec, kind) {
    const n = sec.info.name;
    if (kind === "nokey") {
      sec.bar.setAttribute("data-ght-nokey", "1");
      setBar(sec.bar, [`${n} text detected. `, { label: "Add your Anthropic API key", onClick: () => send({ type: "openOptions" }) }, " to translate it."]);
    } else {
      setBar(sec.bar, [`${n} text detected · `, { label: "Translate page with Claude", onClick: () => translateAll() }]);
    }
  }

  // ---------- translation ----------
  // Page-wide memo: every distinct string is requested once, even across sections
  // (GitHub shows the About blurb twice) and while another request for it is in flight.
  const memo = new Map(); // text -> Promise<{t: string|null, error?: string}>

  function requestTexts(texts) {
    const fresh = texts.filter((t) => !memo.has(t));
    const batches = [];
    let cur = [], size = 0;
    fresh.forEach((t) => {
      if (cur.length && (size + t.length > BATCH_CHARS || cur.length >= BATCH_SEGS)) { batches.push(cur); cur = []; size = 0; }
      cur.push(t); size += t.length;
    });
    if (cur.length) batches.push(cur);
    // run at most PARALLEL batches at a time
    let running = 0;
    const queue = [];
    const gate = () => new Promise((res) => { if (running < PARALLEL) { running++; res(); } else queue.push(res); });
    const release = () => { const n = queue.shift(); if (n) n(); else running--; };
    batches.forEach((batch) => {
      const p = gate().then(() => send({ type: "translate", segments: batch })).finally(release);
      batch.forEach((t, i) => {
        memo.set(t, p.then((r) => {
          if (r.error) { if (r.error === "NO_KEY" || !/Unparseable|wrong shape/.test(r.error)) memo.delete(t); return { t: null, error: r.error }; }
          return { t: r.translations[i] || null };
        }));
      });
    });
    return texts.map((t) => memo.get(t));
  }

  async function translateItems(sec, items, showProgress) {
    const groups = new Map(); // identical strings (e.g. one commit message on many rows) once
    items.forEach((it) => {
      const k = it.enc.text;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(it);
    });
    const texts = Array.from(groups.keys());
    let done = 0, fatal = null;
    const progress = () => {
      if (showProgress) setBar(sec.bar, [`Translating ${label(sec).toLowerCase()} from ${sec.info.name} with Claude\u2026 ${Math.round((done / texts.length) * 100)}%`]);
    };
    progress();
    await Promise.all(requestTexts(texts).map((p, i) => p.then((res) => {
      const t = texts[i];
      if (res.error && (res.error === "NO_KEY" || !/Unparseable|wrong shape/.test(res.error))) { fatal = fatal || res.error; return; }
      groups.get(t).forEach((it) => {
        if (!it.el.isConnected) return;
        const rec = res.t ? D.apply(it, res.t) : null;
        if (rec) {
          sec.records.push(rec);
          if (sec.showing === "orig") D.show(rec, "orig");
        } else { it.el.setAttribute("data-ght-fail", "1"); sec.failed++; }
      });
      done++;
      if (!fatal) progress();
    })));
    return fatal;
  }

  // Long text (READMEs, issues) is translated as it scrolls into view, so you only pay for
  // what you read. "Translate the rest" does everything at once.
  const LAZY_MARGIN = "50% 0px 100% 0px"; // half a screen above, one screen below

  function observeLazily(sec, items) {
    if (!sec.pending) sec.pending = new Map();
    if (!sec.io) {
      sec.queue = [];
      sec.io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const it = sec.pending.get(e.target);
          if (it) { sec.pending.delete(e.target); sec.queue.push(it); sec.io.unobserve(e.target); }
        });
        clearTimeout(sec.flushTimer);
        sec.flushTimer = setTimeout(() => flushLazy(sec), 150);
      }, { rootMargin: LAZY_MARGIN });
    }
    items.forEach((it) => { if (!sec.pending.has(it.el)) { sec.pending.set(it.el, it); sec.io.observe(it.el); } });
    if (sec.state !== "done") { sec.state = "done"; renderDone(sec); }
  }

  async function flushLazy(sec) {
    const batch = sec.queue.splice(0);
    if (!batch.length) return;
    const first = !sec.records.length;
    const fatal = await translateItems(sec, batch, first);
    if (fatal === "NO_KEY") { status = null; sec.state = "waiting"; promptBar(sec, "nokey"); return; }
    if (fatal) {
      batch.forEach((it) => { sec.pending.set(it.el, it); sec.io.observe(it.el); });
      setBar(sec.bar, [`Translation failed: ${fatal} `, { label: "Retry", onClick: () => translateRest(sec) }]);
      return;
    }
    renderDone(sec);
  }

  function translateRest(sec) {
    if (!sec.pending) return;
    sec.pending.forEach((it, el) => { sec.queue.push(it); sec.io.unobserve(el); });
    sec.pending.clear();
    flushLazy(sec);
  }

  async function translateSection(sec) {
    if (sec.state === "running") return;
    let items = sectionItems(sec, sec.info.mode);
    if (sec.pending) items = items.filter((it) => !sec.pending.has(it.el) && !(sec.queue || []).includes(it));
    if (!items.length) {
      const waitingOnScroll = sec.pending && sec.pending.size;
      if (!sec.records.length && !waitingOnScroll) { sec.bar.remove(); sec.state = "empty"; } else sec.state = "done";
      return;
    }
    if (sec.kind === "md") { observeLazily(sec, items); return; }
    const first = sec.state !== "done";
    sec.state = "running";
    const fatal = await translateItems(sec, items, first);
    if (fatal === "NO_KEY") { status = null; sec.state = "waiting"; promptBar(sec, "nokey"); return; }
    if (fatal && !sec.records.length) {
      sec.state = "error";
      setBar(sec.bar, [`Translation failed: ${fatal} `, { label: "Retry", onClick: () => { sec.state = "waiting"; translateSection(sec); } }]);
      return;
    }
    sec.state = "done";
    renderDone(sec);
  }

  let manualStarted = false;
  function translateAll() {
    manualStarted = true; // later sections on this page translate without another click
    sections.forEach((sec) => {
      if (sec.state === "waiting" || sec.state === "error") translateSection(sec);
    });
  }

  // ---------- scanning (GitHub swaps pages and re-renders parts without reloads) ----------
  let scanning = false, again = false;
  async function scan() {
    if (scanning) { again = true; return; }
    scanning = true;
    try {
      // forget sections whose elements GitHub removed
      sections.forEach((sec, el) => { if (!el.isConnected) { sec.bar && sec.bar.remove(); sections.delete(el); } });
      const st = await getStatus();
      for (const found of findSections()) {
        let sec = sections.get(found.el);
        if (sec) {
          // already handled: pick up rows GitHub re-rendered or added (cached, so cheap)
          if (sec.state === "done" && sec.showing === "trans") translateSection(sec);
          continue;
        }
        const info = await detect(sectionText(found));
        sec = { ...found, info, state: info ? "waiting" : "skip", records: [], failed: 0, showing: "trans", bar: null };
        sections.set(found.el, sec);
        if (!info) continue;
        sec.bar = makeBar(sec);
        if (!st || !st.hasKey) promptBar(sec, "nokey");
        else if (!st.auto && !manualStarted) promptBar(sec, "manual");
        else translateSection(sec);
      }
    } finally {
      scanning = false;
      if (again) { again = false; setTimeout(scan, 300); }
    }
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(scan, 600); };
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !(n.classList && n.classList.contains("ght-ui"))) { schedule(); return; }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  ["turbo:load", "turbo:render", "pjax:end", "popstate"].forEach((ev) => document.addEventListener(ev, () => { manualStarted = false; schedule(); }));

  // After the key is added in options, coming back to the tab picks it up.
  window.addEventListener("focus", async () => {
    const waiting = Array.from(sections.values()).filter((s) => s.bar && s.bar.hasAttribute("data-ght-nokey"));
    if (!waiting.length) return;
    status = null;
    const st = await getStatus();
    if (!st || !st.hasKey) return;
    waiting.forEach((s) => {
      s.bar.removeAttribute("data-ght-nokey");
      if (st.auto || manualStarted) translateSection(s); else promptBar(s, "manual");
    });
  });
  schedule();
})();
