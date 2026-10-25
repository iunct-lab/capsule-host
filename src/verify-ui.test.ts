import { expect, test } from "bun:test";
import { join } from "node:path";

// `bun run verify:ui <group>` with a name it does not know stops before Chrome starts or the host is asked (no host runs here),
// saying which groups there are.
test("an unknown group is refused with the groups' names, before anything runs", () => {
  const r = Bun.spawnSync(["bun", join(import.meta.dir, "verify-ui.ts"), "nope"], { env: { ...process.env, CAPSULE_ORIGIN: "http://localhost:1" } });
  expect(r.exitCode).toBe(1);
  expect(r.stderr.toString()).toContain("使える群: plan, members, seat, passkey, sealed");
  expect(r.stdout.toString()).toBe("");
});
