// Repo Translator: DOM engine (no extension APIs here, so it can be tested on its own).
// Turns a block element (p, li, td, ...) into a compact string for the model:
//   formatted inline elements (links, bold, ...)  ->  <t3>...</t3>   (text inside gets translated)
//   code, images, emoji, line breaks, nested lists ->  [[5]] style atoms (copied, never translated)
// and rebuilds the block from the model's answer WITHOUT parsing any HTML from it.
(function (root) {
  "use strict";

  var ATOM_OPEN = "⟦", ATOM_CLOSE = "⟧"; // ⟦ ⟧

  var WRAP = new Set(["A", "STRONG", "B", "EM", "I", "DEL", "S", "INS", "MARK", "SPAN", "SUB", "SUP", "SMALL", "U", "ABBR", "Q", "CITE", "LABEL", "FONT"]);
  var BLOCK_SEL = "p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, summary, figcaption";
  var BLOCKISH = new Set(["P", "UL", "OL", "LI", "PRE", "DIV", "TABLE", "BLOCKQUOTE", "DETAILS", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DL", "FIGURE", "SECTION", "MARKDOWN-ACCESSIBLITY-TABLE"]);
  var SKIP_INSIDE = "pre, code, .highlight, textarea, [contenteditable], .ght-ui, svg, math";

  // Scripts that are clearly not English.
  var FOREIGN_RE = /[Ѐ-ӿ֐-׿؀-ۿऀ-ॿ฀-๿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/;
  var FOREIGN_RE_G = new RegExp(FOREIGN_RE.source, "g");
  var LETTER_RE_G = /[A-Za-zÀ-ɏ]/g;

  function countForeign(s) { return (s.match(FOREIGN_RE_G) || []).length; }
  function countLatin(s) { return (s.match(LETTER_RE_G) || []).length; }
  function hasLetters(s) { return /[\p{L}]/u.test(s); }

  // Names the dominant non-English script. Counts characters per script instead of taking the first match,
  // so a Chinese page with a "한국어" or "日本語" language link is still reported as Chinese.
  function guessScriptLanguage(s) {
    function n(re) { return (s.match(re) || []).length; }
    var kana = n(/[぀-ヿ]/g), han = n(/[一-鿿㐀-䶿]/g);
    var counts = {
      Korean: n(/[가-힯]/g),
      Chinese: han,
      // Japanese mixes kana with han, so it needs a real share of kana, not a stray character.
      Japanese: kana > 0.15 * (kana + han) ? kana + han : 0,
      Russian: n(/[Ѐ-ӿ]/g),
      Arabic: n(/[؀-ۿ]/g),
      Hebrew: n(/[֐-׿]/g),
      Hindi: n(/[ऀ-ॿ]/g),
      Thai: n(/[฀-๿]/g)
    };
    var best = null, top = 0;
    for (var k in counts) { if (counts[k] > top) { top = counts[k]; best = k; } }
    return best;
  }

  // Text of a container without code, so code comments don't sway the language check.
  function proseText(el) {
    var clone = el.cloneNode(true);
    clone.querySelectorAll("pre, code, .highlight, svg, .ght-ui").forEach(function (n) { n.remove(); });
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function escapeText(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function unescapeText(s) { return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }

  // Leaf-ish blocks inside a container that hold translatable prose.
  function findBlocks(container, mode) {
    var out = [];
    container.querySelectorAll(BLOCK_SEL).forEach(function (b) {
      if (b.closest(SKIP_INSIDE)) return;
      if (b.hasAttribute("data-ght")) return;
      var enc = encode(b);
      if (!enc) return;
      if (mode === "script" && !FOREIGN_RE.test(enc.plain)) return;
      if (mode !== "script" && countLatin(enc.plain) < 3) return;
      out.push({ el: b, enc: enc });
    });
    if (!out.length && container.matches && !container.querySelector(BLOCK_SEL)) {
      var enc = encode(container);
      if (enc && (mode !== "script" || FOREIGN_RE.test(enc.plain))) out.push({ el: container, enc: enc });
    }
    return out;
  }

  function encode(block) {
    var parts = [], map = [], plain = [];
    (function walk(node) {
      node.childNodes.forEach(function (n) {
        if (n.nodeType === 3) {
          var t = n.nodeValue.replace(/\s+/g, " ");
          parts.push(escapeText(t));
          plain.push(t);
        } else if (n.nodeType === 1) {
          var tag = n.tagName.toUpperCase();
          var k = map.length;
          if (WRAP.has(tag) && hasLetters(n.textContent) && !n.querySelector(BLOCK_SEL + ", pre, ul, ol, table")) {
            map.push({ node: n, kind: "wrap" });
            parts.push("<t" + k + ">");
            walk(n);
            parts.push("</t" + k + ">");
          } else {
            map.push({ node: n, kind: "atom", block: BLOCKISH.has(tag) });
            parts.push(ATOM_OPEN + k + ATOM_CLOSE);
          }
        }
      });
    })(block);
    var text = parts.join("").replace(/\s+/g, " ").trim();
    var plainText = plain.join("").replace(/\s+/g, " ").trim();
    if (!hasLetters(plainText)) return null;
    return { text: text, map: map, plain: plainText };
  }

  // Rebuild translated content. Returns {nodes, phO, phT} or null if the answer is malformed.
  function decode(str, map, lenient) {
    var frag = document.createDocumentFragment();
    var stack = [frag], ids = new WeakMap(), used = new Set();
    var re = /<t(\d+)>|<\/t(\d+)>|⟦(\d+)⟧/g, last = 0, m;
    var atomSlots = {};

    function top() { return stack[stack.length - 1]; }
    function pushText(s) { if (s) top().appendChild(document.createTextNode(unescapeText(s))); }

    while ((m = re.exec(str))) {
      pushText(str.slice(last, m.index));
      last = re.lastIndex;
      if (m[1] !== undefined) {
        var k1 = +m[1], e1 = map[k1];
        if (!e1 || e1.kind !== "wrap" || used.has(k1)) return null;
        used.add(k1);
        var el = e1.node.cloneNode(false);
        ids.set(el, k1);
        top().appendChild(el);
        stack.push(el);
      } else if (m[2] !== undefined) {
        var k2 = +m[2];
        if (stack.length < 2 || ids.get(top()) !== k2) return null;
        stack.pop();
      } else {
        var k3 = +m[3], e3 = map[k3];
        if (!e3 || e3.kind !== "atom" || used.has(k3)) return null;
        used.add(k3);
        var slot = document.createComment("ght-atom-" + k3);
        atomSlots[k3] = slot;
        top().appendChild(slot);
      }
    }
    pushText(str.slice(last));
    if (stack.length !== 1) return null;

    // Never lose code, images or nested lists: missing atoms are appended (lenient) or rejected.
    for (var k = 0; k < map.length; k++) {
      if (map[k].kind === "atom" && !atomSlots[k]) {
        if (!lenient) return null;
        var s2 = document.createComment("ght-atom-" + k);
        if (map[k].block) frag.appendChild(s2); else { frag.appendChild(document.createTextNode(" ")); frag.appendChild(s2); }
        atomSlots[k] = s2;
      }
    }
    return { nodes: Array.prototype.slice.call(frag.childNodes), slots: atomSlots };
  }

  // Flip a translated block between "orig" and "trans". Atoms (code, images, nested lists)
  // are moved, not copied, so they keep their event handlers and nested translations.
  function show(r, which) {
    if (r.showing === which) return;
    if (r.textOnly) {
      r.node.nodeValue = which === "trans" ? r.transText : r.origText;
      r.showing = which;
      return;
    }
    var target = which === "trans" ? r.trans : r.orig;
    // 1. while the current tree is attached, swap every atom out for its slot in that tree
    r.map.forEach(function (e, k) {
      if (e.kind !== "atom") return;
      var leave = which === "trans" ? r.origSlots[k] : r.transSlots[k];
      if (e.node.parentNode) e.node.parentNode.replaceChild(leave, e.node);
    });
    // 2. detach the current tree and remember it
    var current = Array.prototype.slice.call(r.el.childNodes);
    current.forEach(function (n) { r.el.removeChild(n); });
    if (which === "trans") r.orig = current; else r.trans = current;
    // 3. attach the target tree, then drop each atom into its slot there
    target.forEach(function (n) { r.el.appendChild(n); });
    r.map.forEach(function (e, k) {
      if (e.kind !== "atom") return;
      var slot = which === "trans" ? r.transSlots[k] : r.origSlots[k];
      if (slot.parentNode) slot.parentNode.replaceChild(e.node, slot);
    });
    r.showing = which;
  }

  function apply(item, translated) {
    // Plain-text elements (commit messages, the About blurb) are often owned by GitHub's
    // React code: change only the text node's value so the element structure is untouched.
    var el0 = item.el;
    if (!item.enc.map.length && el0.childNodes.length === 1 && el0.firstChild.nodeType === 3) {
      var clean = unescapeText(translated.replace(/<\/?t\d+>|\u27E6\d+\u27E7/g, "")).replace(/\s+/g, " ").trim();
      if (!clean) return null;
      var lead = (el0.firstChild.nodeValue.match(/^\s*/) || [""])[0], trail = (el0.firstChild.nodeValue.match(/\s*$/) || [""])[0];
      var tr = { el: el0, textOnly: true, node: el0.firstChild, origText: el0.firstChild.nodeValue, transText: lead + clean + trail, showing: "orig" };
      show(tr, "trans");
      el0.setAttribute("data-ght", "1");
      return tr;
    }
    var rec = decode(translated, item.enc.map, false) || decode(translated, item.enc.map, true);
    if (!rec) return null;
    var r = {
      el: item.el, map: item.enc.map,
      orig: null, trans: rec.nodes, origSlots: {}, transSlots: rec.slots, showing: "orig"
    };
    item.enc.map.forEach(function (e, k) { if (e.kind === "atom") r.origSlots[k] = document.createComment("ght-orig-" + k); });
    show(r, "trans");
    item.el.setAttribute("data-ght", "1");
    return r;
  }

  root.GHT_DOM = {
    FOREIGN_RE: FOREIGN_RE,
    countForeign: countForeign,
    countLatin: countLatin,
    guessScriptLanguage: guessScriptLanguage,
    proseText: proseText,
    findBlocks: findBlocks,
    FOREIGN_TEST: function (s) { return FOREIGN_RE.test(s); },
    encode: encode,
    decode: decode,
    apply: apply,
    show: show
  };
})(typeof window !== "undefined" ? window : globalThis);
