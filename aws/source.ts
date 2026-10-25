// What the Host is built from; the commit is only for telling a person which one to switch to. `src` is the tree hash of src/: it decides both what the Host accepts and what the
// publisher checks, and unlike the commit it survives a rebase merge or a docs commit on top of the deployed one.
export function source(root = new URL("../", import.meta.url).pathname): { commit: string; src: string } {
  const git = (...args: string[]) => { const r = Bun.spawnSync(["git", "-C", root, ...args]); return r.success ? r.stdout.toString().trim() : undefined; };
  const commit = git("rev-parse", "HEAD"), tree = git("rev-parse", "HEAD:src"), status = git("status", "--porcelain", "--", "src");
  if (!commit || !tree || status === undefined) return { commit: "unknown", src: "unknown" };
  return { commit, src: status ? tree + "-dirty" : tree };
}
