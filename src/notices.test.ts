import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notice, packageOf } from "./notices";

test("the package a bundled file comes from, scoped names whole", () => {
  expect(packageOf("node_modules/maplibre-gl/dist/maplibre-gl.js")).toBe("maplibre-gl");
  expect(packageOf("node_modules/@maplibre/vt-pbf/dist/index.js")).toBe("@maplibre/vt-pbf");
  expect(packageOf("node_modules/pmtiles/node_modules/fflate/esm/browser.js")).toBe("fflate");
});

test("a notice carries the licence text the package ships, or says it ships none and names its repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "notices-"));
  try {
    mkdirSync(join(dir, "@s/with"), { recursive: true }); mkdirSync(join(dir, "bare"));
    writeFileSync(join(dir, "@s/with/package.json"), JSON.stringify({ version: "1.0.0", license: "MIT" }));
    writeFileSync(join(dir, "@s/with/LICENSE.txt"), "Copyright x */ y\n");
    writeFileSync(join(dir, "bare/package.json"), JSON.stringify({ version: "2.0.0", license: "BSD-3-Clause", repository: { url: "git+https://example.com/bare.git" } }));
    expect(notice(join(dir, "@s/with"), "@s/with")).toBe("\n@s/with 1.0.0 (MIT)\nCopyright x * / y\n");
    expect(notice(join(dir, "bare"), "bare")).toBe("\nbare 2.0.0 (BSD-3-Clause)\nThe package ships no licence text; its repository: https://example.com/bare.git\n");
    for (const [file, pkg] of [["LICENCE.txt", "licence"], ["COPYING.md", "copying"], ["license-MIT", "lower"], ["LICENSE_MIT", "under"]] as const) {
      mkdirSync(join(dir, pkg)); writeFileSync(join(dir, pkg, "package.json"), JSON.stringify({ version: "3.0.0", license: "MIT" })); writeFileSync(join(dir, pkg, file), `text of ${file}\n`);
      expect(notice(join(dir, pkg), pkg)).toBe(`\n${pkg} 3.0.0 (MIT)\ntext of ${file}\n`);
    }
  } finally { rmSync(dir, { recursive: true }); }
});
