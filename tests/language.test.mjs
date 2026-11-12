// Regression test for script/language guessing in src/dom.js.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = vm.createContext({ console });
vm.runInContext(readFileSync(new URL("../src/dom.js", import.meta.url), "utf8"), ctx);
const guess = (s) => ctx.GHT_DOM.guessScriptLanguage(s);

const cases = [
  ["Chinese text", "把 Claude 大小姐关起来，为了更好地保护我们的相遇", "Chinese"],
  ["Chinese page with a Korean and a Japanese language link", "Claude Cage 把大小姐关起来，彻底杜绝网络泄露，支持多平台适配与远程部署。 한국어 日本語 English", "Chinese"],
  ["Korean text", "Claude를 위해 특화된 가벼운 가상 머신입니다. 네트워크 유출을 막습니다.", "Korean"],
  ["Japanese text (kana plus kanji)", "Claude のための軽量な仮想マシンです。ネットワークの漏えいを防ぎます。", "Japanese"],
  ["Russian text", "Легковесная виртуальная машина для Claude", "Russian"],
  ["Arabic text", "آلة افتراضية خفيفة الوزن", "Arabic"],
  ["Plain English", "A lightweight virtual machine", null]
];
let failed = 0;
for (const [name, text, want] of cases) {
  const got = guess(text);
  const ok = got === want;
  console.log((ok ? "ok   " : "FAIL ") + name + (ok ? "" : ` (got ${got}, want ${want})`));
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
