// dropbox-sync 의 빌드 패턴.
// .env 의 MODULAR_VAULT_PLUGIN_DIR 이 있으면 빌드 후 그 자리로 자동 복사.
// 예: ~/Documents/notes/.obsidian/plugins/modular/

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const isWatch = Bun.argv.includes("--watch");

function loadEnv(): Record<string, string> {
  try {
    const content = readFileSync(".env", "utf-8");
    const vars: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      vars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return vars;
  } catch {
    return {};
  }
}

const env = loadEnv();

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: "dist",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "browser",
  sourcemap: isWatch ? "inline" : "none",
  // CJS 빌드라 import.meta 가 syntax error. ESM 의존성 (zustand 등) 이
  // import.meta.env.MODE 같은 패턴을 쓰므로 상수로 치환.
  define: {
    "import.meta.env.MODE": JSON.stringify("production"),
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env": '({ MODE: "production", DEV: false, PROD: true })',
    "import.meta.url": JSON.stringify("file:///obsidian-plugin-modular"),
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  console.error("Build failed:");
  for (const msg of result.logs) {
    console.error(msg);
  }
  process.exit(1);
}

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");

// styles.css: reactflow base CSS 를 앞에 prepend.
// (Bun.build 가 src 의 CSS import 를 처리하지 않으므로 빌드 단계에서 직접 합침.)
const rfCss = readFileSync("node_modules/reactflow/dist/style.css", "utf-8");
const ownCss = readFileSync("styles.css", "utf-8");
const combinedCss = `/* reactflow base CSS */\n${rfCss}\n\n/* modular plugin CSS */\n${ownCss}\n`;
writeFileSync("dist/styles.css", combinedCss);

const size = (result.outputs[0]?.size ?? 0) / 1024 | 0;
console.log(`Build succeeded: dist/main.js (${size}KB)`);

// vault plugin 폴더로 복사 — .env 의 MODULAR_VAULT_PLUGIN_DIR 가 있을 때만.
const vaultPluginDir = env.MODULAR_VAULT_PLUGIN_DIR;
if (vaultPluginDir) {
  if (!existsSync(vaultPluginDir)) {
    mkdirSync(vaultPluginDir, { recursive: true });
  }
  copyFileSync("dist/main.js", join(vaultPluginDir, "main.js"));
  copyFileSync("dist/manifest.json", join(vaultPluginDir, "manifest.json"));
  copyFileSync("dist/styles.css", join(vaultPluginDir, "styles.css"));
  console.log(`Deployed to: ${vaultPluginDir}`);
}
