import { test, expect, describe } from "bun:test";
import { seal, open, LocalKeyStore } from "./key-store";
import { SsmKeyStore } from "./aws-key-store";
import { LocalD1 } from "./local-d1";

const hmac = "secret".repeat(10), plain = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
test("seal and open round-trip", () => {
  const sealed = seal(hmac, "creator-1", plain);
  expect(open(hmac, "creator-1", sealed)).toBe(plain);
  expect(seal(hmac, "creator-1", plain)).not.toBe(sealed);
});
test("another subject cannot open", () => {
  expect(() => open(hmac, "creator-2", seal(hmac, "creator-1", plain))).toThrow();
  expect(() => open("other-".repeat(10), "creator-1", seal(hmac, "creator-1", plain))).toThrow();
});
test("tampered ciphertext is refused", () => {
  const sealed = seal(hmac, "creator-1", plain), i = sealed.length - 3;
  const bad = sealed.slice(0, i) + (sealed[i] === "A" ? "B" : "A") + sealed.slice(i + 1);
  expect(() => open(hmac, "creator-1", bad)).toThrow();
  expect(() => open(hmac, "creator-1", "short")).toThrow();
});
test("the sealed value does not contain the plaintext", () => {
  const sealed = seal(hmac, "creator-1", plain);
  expect(sealed).not.toContain("sk-ant");
  expect(Buffer.from(sealed, "base64url").toString("latin1")).not.toContain("sk-ant");
});
describe("LocalKeyStore", () => {
  test("put, get, overwrite, remove", async () => {
    const store = new LocalKeyStore(new LocalD1());
    expect(await store.get("a")).toBeNull();
    await store.put("a", "one"); expect(await store.get("a")).toBe("one");
    await store.put("a", "two"); expect(await store.get("a")).toBe("two");
    await store.put("b", "other");
    await store.remove("a"); expect(await store.get("a")).toBeNull(); expect(await store.get("b")).toBe("other");
  });
  test("touch and sweep", async () => {
    let now = 1000; const store = new LocalKeyStore(new LocalD1(), () => now);
    await store.put("old", "x"); await store.put("used", "y");
    now = 5000; await store.touch("used", now);
    await store.sweep(999); expect(await store.get("old")).toBe("x");
    await store.sweep(1000); expect(await store.get("old")).toBeNull(); expect(await store.get("used")).toBe("y");
    await store.sweep(5000); expect(await store.get("used")).toBeNull();
    await store.touch("used", 9000); expect(await store.get("used")).toBeNull();
  });
});
describe("SsmKeyStore", () => {
  const notFound = Object.assign(new Error("nope"), { name: "ParameterNotFound" });
  test("sends the three commands with the prefixed name", async () => {
    const sent: any[] = []; let reply: any = { Parameter: { Value: "sealed" } };
    const store = new SsmKeyStore("/capsule-host/dev/creator-key", { send: async (c: any) => { sent.push([c.constructor.name, c.input]); return reply; } } as any);
    await store.put("c1", "sealed");
    expect(await store.get("c1")).toBe("sealed");
    await store.remove("c1");
    expect(sent).toEqual([
      ["PutParameterCommand", { Name: "/capsule-host/dev/creator-key/c1", Type: "SecureString", Value: "sealed", Overwrite: true }],
      ["GetParameterCommand", { Name: "/capsule-host/dev/creator-key/c1", WithDecryption: true }],
      ["DeleteParameterCommand", { Name: "/capsule-host/dev/creator-key/c1" }],
    ]);
  });
  test("ParameterNotFound is null on get and a no-op on remove; other errors surface", async () => {
    let error: Error = notFound;
    const store = new SsmKeyStore("/p", { send: async () => { throw error; } } as any);
    expect(await store.get("x")).toBeNull();
    await store.remove("x");
    error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    expect(store.get("x")).rejects.toThrow("denied");
    expect(store.remove("x")).rejects.toThrow("denied");
  });
  test("sweep deletes only what is past the cutoff", async () => {
    const at = (ms: number) => new Date(ms), sent: any[] = [];
    const pages: Record<string, any> = {
      "": { Parameters: [{ Name: "/p/old", LastModifiedDate: at(100) }, { Name: "/p/used", LastModifiedDate: at(100) }, { Name: "/p/at-cutoff", LastModifiedDate: at(500) }], NextToken: "t2" },
      t2: { Parameters: [{ Name: "/p/new", LastModifiedDate: at(900) }, { Name: "/p/gone", LastModifiedDate: at(100) }, { Name: "/p/stale-tag", LastModifiedDate: at(100) }] },
    };
    const tags: Record<string, any[]> = { "/p/used": [{ Key: "used", Value: "800" }], "/p/stale-tag": [{ Key: "used", Value: "200" }] };
    const store = new SsmKeyStore("/p", { send: async (c: any) => {
      sent.push([c.constructor.name, c.input]);
      if (c.constructor.name === "GetParametersByPathCommand") return pages[c.input.NextToken ?? ""];
      // Removed by its creator after the page was read: skipped, and the sweep goes on.
      if (c.constructor.name === "ListTagsForResourceCommand" && c.input.ResourceId === "/p/gone") throw Object.assign(new Error("gone"), { name: "InvalidResourceId" });
      if (c.constructor.name === "ListTagsForResourceCommand") return { TagList: tags[c.input.ResourceId] ?? [] };
      return {};
    } } as any);
    await store.sweep(500);
    expect(sent.filter(([n]) => n === "GetParametersByPathCommand").map(([, i]) => i)).toEqual([
      { Path: "/p", Recursive: false, WithDecryption: false },
      { Path: "/p", Recursive: false, WithDecryption: false, NextToken: "t2" },
    ]);
    expect(sent.filter(([n]) => n === "DeleteParameterCommand").map(([, i]) => i.Name)).toEqual(["/p/old", "/p/at-cutoff", "/p/stale-tag"]);
    expect(sent.find(([n, i]) => n === "ListTagsForResourceCommand" && i.ResourceId === "/p/used")?.[1]).toEqual({ ResourceType: "Parameter", ResourceId: "/p/used" });
  });
  test("touch tags and never puts", async () => {
    const sent: any[] = []; let error: Error | null = null;
    const store = new SsmKeyStore("/p", { send: async (c: any) => { sent.push([c.constructor.name, c.input]); if (error) throw error; return {}; } } as any);
    await store.touch("c1", 1234);
    expect(sent).toEqual([["AddTagsToResourceCommand", { ResourceType: "Parameter", ResourceId: "/p/c1", Tags: [{ Key: "used", Value: "1234" }] }]]);
    for (const name of ["InvalidResourceId", "ParameterNotFound"]) { error = Object.assign(new Error("gone"), { name }); await store.touch("c1", 1); }
    expect(sent.some(([n]) => n === "PutParameterCommand")).toBe(false);
    error = Object.assign(new Error("denied"), { name: "AccessDeniedException" });
    await expect(store.touch("c1", 1)).rejects.toThrow("denied");
  });
});
