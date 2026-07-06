/**
 * generate-icons.mjs
 * Converts src-tauri/icons/icon.svg into every PNG size Tauri needs,
 * then emits a 1024-px source image so `npx tauri icon` can rebuild
 * the ICO / ICNS / Windows-store / Android assets automatically.
 *
 * Usage:
 *   node scripts/generate-icons.mjs
 *   npx tauri icon src-tauri/icons/source-1024.png
 */

import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, "..");
const iconsDir  = join(root, "src-tauri", "icons");

const svgContent = readFileSync(join(iconsDir, "icon.svg"), "utf8");

function renderPng(size) {
  const resvg = new Resvg(svgContent, { fitTo: { mode: "width", value: size } });
  return resvg.render().asPng();
}

// ── Standard Tauri PNG sizes ─────────────────────────────────────────────────
const targets = [
  // Core
  ["32x32.png",          32],
  ["64x64.png",          64],
  ["128x128.png",        128],
  ["128x128@2x.png",     256],
  ["icon.png",           512],
  ["app-icon.png",       512],
  // Windows Store
  ["Square30x30Logo.png",   30],
  ["Square44x44Logo.png",   44],
  ["Square71x71Logo.png",   71],
  ["Square89x89Logo.png",   89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png",         50],
  // Large source (used by `npx tauri icon` for ICO/ICNS/Android)
  ["source-1024.png",    1024],
];

for (const [name, size] of targets) {
  writeFileSync(join(iconsDir, name), renderPng(size));
  console.log(`  ✓  ${name.padEnd(28)} ${size}×${size}`);
}

// ── Android mipmap ───────────────────────────────────────────────────────────
const android = [
  ["mipmap-mdpi",    48],
  ["mipmap-hdpi",    72],
  ["mipmap-xhdpi",   96],
  ["mipmap-xxhdpi",  144],
  ["mipmap-xxxhdpi", 192],
];

for (const [folder, size] of android) {
  const dir = join(iconsDir, "android", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ic_launcher.png"),       renderPng(size));
  writeFileSync(join(dir, "ic_launcher_round.png"), renderPng(size));
  console.log(`  ✓  android/${folder}/ic_launcher*.png  ${size}×${size}`);
}

console.log("\nDone. Run:  npx tauri icon src-tauri/icons/source-1024.png");
console.log("to regenerate ICO, ICNS, and any remaining platform assets.\n");
