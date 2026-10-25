// The licence notices aws/build.ts puts at the top of map.js (the minifier drops the libraries' own comments).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The package a bundled file comes from: the part after the last node_modules/, a scoped name as both of its parts. */
export function packageOf(input: string): string {
  const [first, second] = input.split("node_modules/").at(-1)!.split("/");
  return first!.startsWith("@") ? `${first}/${second}` : first!;
}

/** The package's name, version, licence and the licence text it ships; a package that ships none says so and names where its text is. */
export function notice(dir: string, name: string): string {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string; license: string; repository?: string | { url?: string }; homepage?: string };
  const file = readdirSync(dir).sort().find(f => /^(LICEN[CS]E|COPYING)/i.test(f)), text = file && join(dir, file);
  const where = (typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url)?.replace(/^git\+/, "") ?? pkg.homepage;
  return `\n${name} ${pkg.version} (${pkg.license})\n` + (text ? readFileSync(text, "utf8").replaceAll("*/", "* /") : `The package ships no licence text${where ? `; its repository: ${where}` : ""}\n`);
}
