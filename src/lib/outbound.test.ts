import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const FIX = 'If this change is intended, update the README section "What leaves your machine".';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe("outbound connections", () => {
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));

  it("CSP connect-src only allows the app, IPC and privatecompass.app", () => {
    const csp: string = conf.app.security.csp;
    const directive = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("connect-src "));
    expect(directive?.split(/\s+/).slice(1), FIX).toEqual(["'self'", "ipc:", "http://ipc.localhost", "https://privatecompass.app"]);
  });

  it("updater endpoint is the GitHub release feed only", () => {
    expect(conf.plugins.updater.endpoints, FIX).toEqual(["https://github.com/__REPO__/releases/latest/download/latest.json"]);
  });

  it("source URL literals only name allow-listed hosts", () => {
    const allowed = new Set(["privatecompass.app", "github.com", "www.w3.org"]);
    const files = walk(join(root, "src")).filter((f) => /\.(ts|tsx|css)$/.test(f) && !/\.test\.tsx?$/.test(f));
    const found = new Set<string>();
    for (const f of files) {
      for (const m of readFileSync(f, "utf8").matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        if (!allowed.has(m[1].toLowerCase())) found.add(`${m[1]} (${f.slice(root.length + 1)})`);
      }
    }
    expect([...found], FIX).toEqual([]);
  });

  it("Rust backend has no HTTP client and no http: capability", () => {
    const cargo = read("src-tauri/Cargo.toml");
    expect(cargo, FIX).not.toMatch(/\b(reqwest|ureq|hyper|tauri-plugin-http|isahc|surf|attohttpc)\b/);
    for (const f of readdirSync(join(root, "src-tauri/capabilities")).filter((f) => f.endsWith(".json"))) {
      const perms = JSON.parse(read(`src-tauri/capabilities/${f}`)).permissions as unknown[];
      const http = perms.map((p) => (typeof p === "string" ? p : (p as { identifier: string }).identifier)).filter((p) => p.startsWith("http:"));
      expect(http, FIX).toEqual([]);
    }
  });
});
