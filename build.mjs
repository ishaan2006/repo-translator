// Builds dist/chrome and dist/firefox from src/ plus manifest.base.json.
// Usage: node build.mjs
import { readFileSync, writeFileSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";

const base = JSON.parse(readFileSync("manifest.base.json", "utf8"));

const targets = {
  chrome: {
    ...base,
    minimum_chrome_version: "121",
    background: { service_worker: "background.js" }
  },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    browser_specific_settings: {
      gecko: {
        id: "repo-translator@local",
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["websiteContent"] }
      },
      gecko_android: { strict_min_version: "142.0" }
    }
  }
};

rmSync("dist", { recursive: true, force: true });
for (const [name, manifest] of Object.entries(targets)) {
  const out = `dist/${name}`;
  mkdirSync(out, { recursive: true });
  cpSync("src", out, { recursive: true });
  writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
  const archive = name === "firefox" ? "repo-translator-firefox.xpi" : "repo-translator-chrome.zip";
  execFileSync("python3", ["-c",
    "import sys,os,zipfile\n" +
    "src,dst=sys.argv[1],sys.argv[2]\n" +
    "z=zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED)\n" +
    "[z.write(os.path.join(r,f),os.path.relpath(os.path.join(r,f),src)) for r,_,fs in os.walk(src) for f in sorted(fs)]\n" +
    "z.close()", out, `dist/${archive}`]);
  console.log(`built ${out} and dist/${archive}`);
}
