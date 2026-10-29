import { describe, expect, test } from "bun:test";
import { CloudHost } from "./cloud-host";
import { LocalD1 } from "./local-d1";
import { isLoopback, localIdentity } from "./local-identity";

const local = "http://localhost:47840", remote = "https://capsule.example";
const ask = (origin: string, path: string, cookie?: string) => localIdentity(origin)(new Request(origin + path, { method: "POST", headers: cookie ? { Cookie: cookie } : {} }));

describe("localIdentity", () => {
  test("a loopback server gives its identity to the creator enrollment, but not with a creator's cookie or to the IAM publisher's other routes", async () => {
    expect(isLoopback(local)).toBe(true); expect(isLoopback("http://127.0.0.1:47840")).toBe(true); expect(isLoopback("http://[::1]:47840")).toBe(true);
    expect(await ask(local, "/v1/creators/enroll")).toBe("local");
    expect(await ask(local, "/v1/publish")).toBe("local");
    expect(await ask(local, "/v1/assist/" + "a".repeat(32))).toBe("local");
    expect(await ask(local, "/v1/creators/enroll", "capsule_creator=x")).toBeNull();
    expect(await ask(local, "/v1/publish", "a=1; capsule_creator=x")).toBeNull();
    for (const path of ["/recover", "/v1/creators/list", "/v1/creators/revoke", "/v1/account", "/v1/operator"]) expect(await ask(local, path)).toBeNull();
  });
  test("a server that is not on loopback gives no identity to any route", async () => {
    expect(isLoopback(remote)).toBe(false);
    for (const path of ["/v1/publish", "/v1/recipe", "/v1/check", "/v1/account/key", "/v1/creators/enroll", "/v1/assist", "/v1/assist/" + "a".repeat(32)]) expect(await ask(remote, path)).toBeNull();
  });
  test("CloudHost hands out a creator enrollment link on loopback only", async () => {
    for (const [origin, status] of [[local, 201], [remote, 401]] as const) {
      const db = new LocalD1(), host = new CloudHost({ DB: db, CAPSULE_HMAC_KEY: "secret".repeat(10), CAPSULE_ORIGIN: origin }, () => Date.now(), localIdentity(origin));
      try {
        const res = await host.fetch(new Request(origin + "/v1/creators/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ label: "確認", confirm: true }) }));
        expect(res.status).toBe(status);
        if (status === 201) expect((await res.json()).url).toContain("#creator=");
      } finally { db.close(); }
    }
  });
});
