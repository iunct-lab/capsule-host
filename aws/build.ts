import { mkdir, copyFile } from "node:fs/promises";
import { source } from "./source";
import { banner, notice, packageOf } from "../src/notices";
const root = new URL("../", import.meta.url).pathname;
// Only the src tree hash, not the commit: a commit would change the bundle on every docs commit and break the
// "same CodeSha256 on dev and prod" check of a deploy made from the branch on one side and main on the other.
const { src } = source(root);
if (src === "unknown") throw new Error("src/ のツリーハッシュを git から取れません。git の作業ツリーでビルドしてください。");
await mkdir(root + "dist/aws", { recursive: true });
await mkdir(root + "dist/public", { recursive: true });
// The minifier drops the libraries' license comments, so every file shipped starts with every package it bundles (Bun's metafile),
// its version and licence, and the licence text the package ships (src/notices.ts; a package that ships none names its repository).
for (const [entry, target, outdir, naming] of [["aws-handler.ts", "node", "aws", "index.mjs"], ["aws-web.ts", "node", "aws-web", "index.mjs"], ["client.ts", "browser", "public", "app.js"], ["map.ts", "browser", "public", "map.js"]] as const) {
  const inputs = Object.keys((await Bun.build({ entrypoints: [root + "src/" + entry], target, metafile: true })).metafile!.inputs);
  if (entry === "map.ts") {
    const bundled = inputs.filter(i => i.includes("node_modules/")).map(packageOf);
    if (!bundled.includes("maplibre-gl") || !bundled.includes("pmtiles")) throw new Error("map.js の依存が見つかりません: " + [...new Set(bundled)].join(", "));
  }
  const result = await Bun.build({ entrypoints: [root + "src/" + entry], target, format: "esm", outdir: root + "dist/" + outdir, naming, minify: true, banner: banner(naming, root, inputs),
    // Only the Lambda learns what it was built from; the publisher reads it back through /v1/version.
    ...(target === "node" ? { define: { "process.env.CAPSULE_SRC": JSON.stringify(src) } } : {}) });
  if (!result.success) throw new Error(result.logs.join("\n"));
}
await copyFile(root + "src/index.html", root + "dist/public/index.html");
await copyFile(root + "src/style.css", root + "dist/public/app.css");
// The map's worker and stylesheet as MapLibre ships them, under the names src/map.ts asks for (docs/design/footprint-basemap.md),
// behind MapLibre's notice: the worker opens with only a link to the licence and the stylesheet with none.
const maplibre = root + "node_modules/maplibre-gl";
for (const [from, to] of [["maplibre-gl-worker.mjs", "maplibre-worker.mjs"], ["maplibre-gl.css", "map.css"]]) {
  await Bun.write(root + "dist/public/" + to, `/*! ${to} carries:\n${notice(maplibre, "maplibre-gl")}*/\n` + await Bun.file(maplibre + "/dist/" + from).text());
}
