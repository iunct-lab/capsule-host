import { mkdir, copyFile } from "node:fs/promises";
import { source } from "./source";
import { notice, packageOf } from "../src/notices";
const root = new URL("../", import.meta.url).pathname;
// Only the src tree hash, not the commit: a commit would change the bundle on every docs commit and break the
// "same CodeSha256 on dev and prod" check of a deploy made from the branch on one side and main on the other.
const { src } = source(root);
if (src === "unknown") throw new Error("src/ のツリーハッシュを git から取れません。git の作業ツリーでビルドしてください。");
await mkdir(root + "dist/aws", { recursive: true });
await mkdir(root + "dist/public", { recursive: true });
// The minifier drops the libraries' license comments, so map.js starts with every package it bundles (Bun's metafile), its
// version and licence, and the licence text the package ships (src/notices.ts; a package that ships none names its repository).
const mapInputs = await Bun.build({ entrypoints: [root + "src/map.ts"], target: "browser", metafile: true });
// Keyed by the package's directory: the same package bundled twice (a nested node_modules) gets a notice for each copy.
const packages = new Map(Object.keys(mapInputs.metafile!.inputs).filter(i => i.includes("node_modules/")).map(i => {
  const name = packageOf(i);
  return [root + i.slice(0, i.lastIndexOf("node_modules/")) + "node_modules/" + name, name] as const;
}));
const bundled = [...new Set(packages.values())];
const mapBanner = "/*! map.js carries:\n" + [...packages].sort(([a, x], [b, y]) => x.localeCompare(y) || a.localeCompare(b)).map(([dir, name]) => notice(dir, name)).join("") + "*/";
if (!bundled.includes("maplibre-gl") || !bundled.includes("pmtiles")) throw new Error("map.js の依存が見つかりません: " + bundled.join(", "));
for (const [entry, target, outdir, naming] of [["aws-handler.ts", "node", "aws", "index.mjs"], ["aws-web.ts", "node", "aws-web", "index.mjs"], ["client.ts", "browser", "public", "app.js"], ["map.ts", "browser", "public", "map.js"]] as const) {
  const result = await Bun.build({ entrypoints: [root + "src/" + entry], target, format: "esm", outdir: root + "dist/" + outdir, naming, minify: true, ...(entry === "map.ts" ? { banner: mapBanner } : {}),
    // Only the Lambda learns what it was built from; the publisher reads it back through /v1/version.
    ...(target === "node" ? { define: { "process.env.CAPSULE_SRC": JSON.stringify(src) } } : {}) });
  if (!result.success) throw new Error(result.logs.join("\n"));
}
await copyFile(root + "src/index.html", root + "dist/public/index.html");
await copyFile(root + "src/style.css", root + "dist/public/app.css");
// The map's worker and stylesheet as MapLibre ships them, under the names src/map.ts asks for (docs/design/footprint-basemap.md).
await copyFile(root + "node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", root + "dist/public/maplibre-worker.mjs");
await copyFile(root + "node_modules/maplibre-gl/dist/maplibre-gl.css", root + "dist/public/map.css");
