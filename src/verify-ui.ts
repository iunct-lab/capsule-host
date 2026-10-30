import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTrip, tripDay } from "./test-fixture";
import { localDay } from "./schema";
import { revisable, reviseText } from "./revise";
import { exportFiles, tripHtml, tripMarkdown } from "./export";
import { openField } from "./trip-keys";
import { photosPageShown } from "./moments";

// Drives the screen of an already-running local host in a headless Chrome over the DevTools protocol: reordering by grip and by
// arrow key, the time the host gives (a placeholder, "ごろ"), an item without a time given one by a drag and by the edit form, the
// 詳細 / リスト switch, an item's end (typed, moved with the start, refused before it, emptied) with the free time and overlaps it
// shows between items, a "＋" between items adding one right there at the time the host would give it, the 候補・相談 tab
// saying what each column is for (375px, nothing off the side), each theme's contrast of text against its background, the owner's forms for the 準備 list and the 費用メモ, 旅を保存 (Markdown
// copied or shown selected, the ZIP's files), the owner's history of invites, a participant's view, and the passkey check before an owner's important actions (Chrome's virtual authenticator answers the OS
// dialog), replacing the passkey (a check by the current one, then the new one), a participant signing out and coming back with
// their passkey, a participant's own plan (among the day's items, marked 自分だけ) and diary (written, changed, removed; not the owner's to see). The owner's check lasts five minutes on the host's own
// clock, so the script waits them out before the replacement and the purge that must ask for it again.
// The editor's header opens チャットで直す: scope note, pasted answer without a title diff, apply and undo;
// the owner and participant have no such header entry. The editor's 共有・管理 hands out and revokes viewer invites only, and
// the owner sees who handed each out; a participant has no 共有・管理.
// Every group's trip is sealed by its owner's page as the seat is taken (the banner's 移す), and its members take the key by the codes.
// Last, the sealed trip (#691): drawn from what the page opens, "＋", the grip, a promoted suggestion, 旅を保存 and チャットで直す made
// by the page, photos put up from the participant's page and shown to the viewer (#447), and a purge with another title not sent.
// Then, on trips of their own, the first seal (#694) and the trip key replaced by the owner's page after a member
// left (#695): revoked, reached only through the revoked one, or past an invite's end; and the new owner after the owner invite was
// handed over asked whether to replace it, the hand-over stopped while no other seat holds the key, and a seat made again kept.
// Apart from any trip's own screens, the creator's (#995): enrolled from a link the loopback host hands out, another device, the
// right to create handed to an owner by a delegation link (redeemed in the owner's trip tab) and revoked.
// A disposable fictional capsule, purged at the end; no link or cookie is printed. No dependency: Bun has WebSocket and fetch, and Chrome is found on this machine (or named in CHROME_PATH).
// The scenes come in groups, each on a disposable trip of its own that it opens with what it needs (`openTrip()` and, in the
// group, the invites, passkeys, handoffs and the seal) and removes when it ends or fails (`closeTrip()`): `bun run verify:ui
// <group>` runs one, and with no name every group runs in this order. A group prints its seconds when it passes.
const groups: Record<string, () => Promise<void>> = { plan, members, seat, passkey, sealed, creator };
const chosen = process.argv.slice(2);
if (chosen.some(name => !Object.hasOwn(groups, name))) { console.error(`知らない群です: ${chosen.filter(name => !Object.hasOwn(groups, name)).join(", ")}。使える群: ${Object.keys(groups).join(", ")}`); process.exit(1); }
const origin = process.env.CAPSULE_ORIGIN ?? "http://localhost:47840";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Verification is restricted to a local host");
const chromePath = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (!chromePath) throw new Error("Chrome not found. Set CHROME_PATH to the browser's executable");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// The waits are the host's (the passkey check's five minutes, the counts per minute, a seat's footprint a minute), not the
// browser's: the loopback bun run dev moves its clock forward on POST /dev/clock (src/main.ts) instead of this script waiting.
const advance = async (ms: number) => {
  const r = await fetch(origin + "/dev/clock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ advance: Math.ceil(ms) }) });
  if (!r.ok) throw new Error(`verify:ui はループバックの bun run dev に向けてください（POST /dev/clock が ${r.status}）`);
  return (await r.json() as { now: number }).now;
};
const hostNow = () => advance(0);
// The start of the host's next minute, a second's margin for the counts' edges as before.
const nextMinute = async () => advance(61000 - await hostNow() % 60000);
await hostNow();  // before the browser starts: stops here when pointed at a host without the clock
const title = "画面確認用（自動削除）", day = localDay(Date.now(), "Asia/Tokyo");
const seed = testTrip(day); seed.spec.title = title;
seed.document.suggestions = [{ id: "idea", author: "みどり", body: "夜は星を見たい", createdAt: "2026-09-20T00:00:00.000Z", promoted: false }];
seed.document.comments = [{ id: "ask", author: "あおい", body: "集合は何時？", createdAt: "2026-09-20T00:00:00.000Z" }];
seed.document.items = [["one", "一番目の予定", "09:00"], ["two", "二番目の予定", "11:00"], ["three", "三番目の予定", "13:00"]].map(([id, t, time]) => ({ id: id!, title: t!, day, startsAt: `${day}T${time}:00+09:00`, kind: "activity" as const, status: "confirmed" as const, revision: 1 }));

// --- the browser
// Port 0: Chrome picks a free one and writes it to the profile, so the script only ever talks to the browser it started.
const profile = mkdtempSync(join(tmpdir(), "capsule-verify-ui-"));
const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "about:blank"], { stdio: "ignore" });
let endpoint = ""; for (let i = 0; i < 50 && !endpoint; i++) { try { const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n"); endpoint = `ws://127.0.0.1:${port}${path}`; } catch { await sleep(200); } }
if (!endpoint) throw new Error("Chrome did not start");
const ws = new WebSocket(endpoint); await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", () => reject(new Error("could not connect to Chrome")), { once: true }); });
let seq = 0; const waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
// Every URL each page asked for, by the page's session (Network.requestWillBeSent), for the checks that no other origin is asked.
const asked = new Map<string, string[]>();
// A request a page's Fetch domain stopped, handed to that page's handler (the sealed trip's 「ここで直す」 answers Anthropic's part, #787).
const paused = new Map<string, (params: { requestId: string; request: { url: string; method: string; headers: Record<string, string>; postData?: string } }) => void>();
ws.addEventListener("message", m => { const d = JSON.parse(String(m.data)), w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); }
  if (d.method === "Network.requestWillBeSent" && d.sessionId) asked.set(d.sessionId, [...asked.get(d.sessionId) ?? [], d.params.request.url]);
  if (d.method === "Fetch.requestPaused" && d.sessionId) paused.get(d.sessionId)?.(d.params); });
// A browser that went away must not leave a call waiting for ever: the cleanup below still has to run and name the capsule.
const dropAll = (why: string) => { for (const [id, w] of waiting) { waiting.delete(id); w.reject(new Error(why)); } };
ws.addEventListener("close", () => dropAll("Chrome closed the connection")); ws.addEventListener("error", () => dropAll("Chrome connection failed"));
const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
  if (ws.readyState !== WebSocket.OPEN) return reject(new Error("Chrome is not connected"));
  const id = ++seq, timer = setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${method} did not answer in 30 s`)); }, 30000);
  waiting.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// The pages open now and the most open at once (printed at the end): a scene closes its pages, and their browser context, when it ends.
let open = 0, peak = 0;
const dispose = (browserContextId: string) => send("Target.disposeBrowserContext", { browserContextId });
// A page has no <geolocation> element unless asked for (`element`): the scenes before the element's own run the button every other
// browser has, and its absence is what they check (#675).
async function page(width: number, height: number, mobile: boolean, context?: string, element = false) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank", ...(context ? { browserContextId: context } : {}) });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method: string, params: object = {}) => send(method, params, sessionId);
  open++; peak = Math.max(peak, open); let closed = false;
  const close = async () => { if (closed) return; closed = true; open--; await s("Page.close"); };
  await s("Page.enable"); await s("Runtime.enable"); await s("Network.enable");
  if (!element) await s("Page.addScriptToEvaluateOnNewDocument", { source: `delete window.HTMLGeolocationElement;` });
  // The checks' own requests from the page go as the new screen's do (ui=2, src/client.ts api()); the screen's own are left as they are.
  await s("Page.addScriptToEvaluateOnNewDocument", { source: `window.vfetch = (u, o) => fetch(u + (u.includes("?") ? "&" : "?") + "ui=2", o);` });
  const requests = () => asked.get(sessionId) ?? [];
  const size = async (w: number, h: number, touch: boolean) => { await s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: touch }); await s("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 1 }); };
  await size(width, height, mobile);
  const evaluate = async (expression: string) => { const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} | in: ${expression.slice(0, 160)}`); return r.result.value; };
  // A timed-out wait names the lines of this file that called it (Bun keeps the callers across awaits in the stack): which wait it was (#924).
  const until = async (expression: string, ms = 10000) => { const at = [...(new Error().stack ?? "").matchAll(/verify-ui\.ts:(\d+)/g)].slice(1).map(m => "src/verify-ui.ts:" + m[1]).join(" < "); const end = Date.now() + ms; while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(100); } throw new Error("timed out waiting for: " + expression + " | dialog: " + await evaluate(`(document.querySelector("#dialog")?.open ? "open " : "closed ") + (document.querySelector("#dialog")?.innerText ?? "")`).catch(() => "?") + " | notice: " + await evaluate(`[...document.querySelectorAll(".notice,[role=status],[role=alert]")].map(x => x.textContent).join(" / ")`).catch(() => "?") + " | at: " + at); };
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) => s("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
  const key = async (k: string, code: number) => { for (const type of ["keyDown", "keyUp"]) await s("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: code, ...(k === "Enter" && type === "keyDown" ? { text: "\r" } : {}) }); };
  const box = (selector: string) => evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, top: b.top, bottom: b.bottom }; })()`) as Promise<{ x: number; y: number; top: number; bottom: number }>;
  // A finger on the grip, moved to a height (and on to another, when given), lifted.
  const drag = async (grip: string, toY: number, thenY?: number) => {
    const a = await box(grip); await touch("touchStart", a.x, a.y); await sleep(50);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", a.x, a.y + (toY - a.y) * i / 10); await sleep(30); }
    if (thenY !== undefined) for (let i = 1; i <= 10; i++) { await touch("touchMove", a.x, toY + (thenY - toY) * i / 10); await sleep(30); }
    await touch("touchEnd");
  };
  const join = async (url: string) => { await s("Page.navigate", { url }); await until(`!!document.querySelector('[data-action="join"]')`); await evaluate(`document.querySelector('[data-action="join"]').click()`); await until(drawn); const shown = await evaluate(`document.querySelector("#dialog").textContent`) as string; await evaluate(`document.querySelector('#dialog [data-action="close"]')?.click()`); await sleep(200); return shown; };
  const reload = async () => { await s("Page.reload"); await sleep(300); await until(drawn); };
  // A real press (CDP input): the <geolocation> element only answers a trusted one.
  const press = async (selector: string) => {
    // The page settles (the map above loads) after the element is first in view: press where it is once it has stayed in one place.
    const where = () => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center", behavior: "instant" }); const b = e.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`) as Promise<number[]>;
    let at = await where();
    // A <geolocation> element answers only once it has validated itself, which it does in view.
    await until(`document.querySelector(${JSON.stringify(selector)}).isValid !== false`); for (let i = 0; i < 50; i++) { await sleep(200); const now = await where(); if (now[0] === at[0] && now[1] === at[1]) break; at = now; }
    for (const type of ["mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 });
  };
  return { evaluate, until, key, box, drag, join, reload, size, requests, press, close, cdp: s, session: sessionId as string };
}
// What the day's rows say, whichever way they are shown.
const order = `[...document.querySelectorAll("[data-order-day] [data-item]")].map(r => r.dataset.item).join()`;
const message = `document.querySelector("#message").textContent`;
const shownTab = `document.querySelector('.navigation [aria-current="page"]').dataset.tab`;
// A trip's page drawn: the plan; or, in a sealed trip without the key, the ask for it; or, for an owner whose trip is not sealed
// yet, the banner to seal it (all the host lets that owner do).
const drawn = `!!document.querySelector(".timeline, .timeline-list, [data-sealed='locked'], [data-seal='owner'] [data-action='seal-trip'], [data-seal='no-passkey']")`;
const timeOf = (id: string) => `document.querySelector('[data-item="${id}"] .event-time, [data-item="${id}"] .row-time').firstChild.textContent`;
const heading = `document.querySelector(".section-heading").scrollIntoView({ block: "start" })`;

let capsuleId = "", owner: Awaited<ReturnType<typeof page>> | undefined, checkedAt = 0;  // checkedAt: the host's time
// The page talks to the host with its own cookie; the script never sees it. An owner's important action sent this way past the
// passkey check's five minutes is answered 428: like the screen, it checks the passkey (the authenticator answers) and sends the
// action once more, so a slow run does not fail a scene that is not about the check (#759). The check's time is kept for (i).
// In a sealed trip the words go sealed, as the screen seals them (src/trip-keys.ts sealOperation, sealSpec): the page's seat key opens
// the trip key. Sets `sent`, the body to send, from `v`, the host's answer the expression read just before.
const sealing = async (action: string, body: object) => ["document", "spec"].includes(action) ? `const sent = await (async () => { ${await tripKeysCode()}
    const k = globalThis.tripKeys, id = "${capsuleId}", body = ${JSON.stringify(body)};
    if (!v.sealed) return JSON.stringify(body);
    const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
    const s = v.seatKey, g = v.sealed.generation, trip = await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation);
    return JSON.stringify("${action}" === "spec" ? { ...body, spec: await k.sealSpec(trip, id, g, body.spec) } : await k.sealOperation(trip, id, g, body, (await k.openTrip(trip, id, v)).document));
  })();` : `const sent = ${JSON.stringify(JSON.stringify(body))};`;
const sendFromPage = async (action: string, body: object, method: string) => owner!.evaluate(`(async () => { const v = await (await vfetch("/v1/c/${capsuleId}")).json(); ${await sealing(action, body)} const revision = v.document.revision; const r = await vfetch("/v1/c/${capsuleId}/${action}", { method: "${method}", headers: { "Content-Type": "application/json", "If-Match": '"' + revision + '"' }, body: sent }); return { status: r.status, body: await r.json() }; })()`) as Promise<{ status: number; body: any }>;
const checkFromPage = () => owner!.evaluate(`(async () => {
  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""), unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const post = (path, body) => vfetch("/v1/c/${capsuleId}/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const { challenge, rpId } = await (await post("passkey/challenge", {})).json();
  const c = await navigator.credentials.get({ publicKey: { challenge: unb64(challenge), rpId, userVerification: "required" } }), r = c.response;
  return (await post("passkey/verify", { challenge, id: c.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) })).status;
})()`) as Promise<number>;
// What a page's browser keeps for a trip (#842): the names of its keys in IndexedDB (never the keys), whether the top page lists
// it, and its 開いたときに足あとを残す setting. `nothing` is a browser that kept nothing.
const storedFor = (trip: string) => `(async () => ({ keys: await new Promise(ok => { const q = indexedDB.open("capsule", 1); q.onupgradeneeded = () => q.result.createObjectStore("private-keys"); q.onerror = () => ok(["?"]); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").getAllKeys(); r.onsuccess = () => { q.result.close(); ok(r.result.filter(k => k === "${trip}" || k === "seat:${trip}")); }; r.onerror = () => { q.result.close(); ok(["?"]); }; }; }), listed: JSON.parse(localStorage.getItem("capsules") ?? "[]").some(t => t.id === "${trip}"), footprint: localStorage.getItem("auto-footprint:${trip}") }))()`;
const nothing = { keys: [], listed: false, footprint: null };
const fromPage = async (action: string, body: object, method = "POST") => {
  const first = await sendFromPage(action, body, method).catch(e => { throw new Error(`${method} ${action} ${JSON.stringify(body).slice(0, 200)}: ${(e as Error).message.split("\n")[0]}`); }); if (first.status !== 428) return first;
  assert.equal(await checkFromPage(), 200, `the passkey check before ${method} ${action}`); checkedAt = await hostNow();
  return sendFromPage(action, body, method);
};
// The OS's passkey checks and creations are counted too: the authenticator answers them silently, so a count is the only way
// to see they were asked.
const answerYes = `(() => { window.asked ??= []; window.confirm = m => { window.asked.push(m); return true; }; window.checks = 0; window.made = 0; const get = navigator.credentials.get.bind(navigator.credentials); navigator.credentials.get = o => { window.checks++; return get(o); }; const create = navigator.credentials.create.bind(navigator.credentials); navigator.credentials.create = o => { window.made++; return create(o); }; return true; })()`;
const invite = async (role = "participant") => {
  await owner!.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner!.until(`!!document.querySelector('#dialog form[data-form="grant"]')`);
  await owner!.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="grant"]'); f.elements.namedItem("role").value = "${role}"; f.requestSubmit(); return true; })()`); await owner!.until(`!!document.querySelector("#issued-link")`);
  const url = await owner!.evaluate(`document.querySelector("#issued-link").value`) as string; await owner!.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); return url;
};
const openSave = async (p: typeof owner, from = "") => { await p!.evaluate(`document.querySelector('${from}[data-action="save"]').click()`); await p!.until(`!!document.querySelector('#dialog [data-action="copy-markdown"]')`); };
const manageOpen = async () => { await owner!.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner!.until(`!!document.querySelector("#dialog details.history")`); };
const footprintRows = `[...document.querySelectorAll("[data-footprint]")].map(r => r.querySelector("strong").textContent)`;
const locate = async (p: typeof owner, setting: "granted" | "denied", context?: string, latitude = 35.6812, longitude = 139.7671) => {
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting, origin, ...(context ? { browserContextId: context } : {}) });
  await p!.cdp("Emulation.setGeolocationOverride", { latitude, longitude, accuracy: 20 });
};
// The footprints page is the Spec's trip-map page; a trip without one has the screen's 足あと tab instead (#583).
const footprintsTab = async (p: typeof owner) => { await p!.evaluate(`(document.querySelector('[data-action="tab"][data-tab="map"]') ?? document.querySelector('[data-action="tab"][data-tab=":footprints"]')).click()`); await p!.until(`[...document.querySelectorAll("h2")].some(h => h.textContent === "足あと")`); };
const stepHere = async (p: typeof owner, count: number) => { await p!.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await p!.until(`document.querySelectorAll("[data-footprint]").length === ${count}`); };
const removable = `[...document.querySelectorAll("[data-footprint]")].map(r => !!r.querySelector('[data-action="remove-footprint"]'))`;
const spots = `document.querySelectorAll(".trip-map .spot").length`;
// The memo key this browser kept for its own entries forgotten, the seat's key pair (`seat:<trip>`, which opens the sealed trip) kept.
const forgetMemoKey = `new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const t = q.result.transaction("private-keys", "readwrite"), store = t.objectStore("private-keys"), keys = store.getAllKeys(); keys.onsuccess = () => { for (const k of keys.result) if (!String(k).startsWith("seat:")) store.delete(k); }; t.oncomplete = () => { q.result.close(); ok(true); }; t.onerror = () => no(t.error); }; })`;
const typeCode = (b: NonNullable<typeof owner>, value: string) => b.evaluate(`(() => { const i = document.querySelector("[data-handoff-input]"); i.value = ${JSON.stringify(value)}; document.querySelector('#dialog [data-action="handoff-submit"]').click(); return true; })()`);
const ownCode = (b: NonNullable<typeof owner>) => b.evaluate(`document.querySelector("#dialog [data-handoff-own]").textContent.trim()`) as Promise<string>;
// The trip's Spec changed from the owner's page (a change of settings: inside the passkey check's five minutes).
const setSpec = async (change: (spec: any) => void) => { const spec = (await opened(owner!)).spec; change(spec); assert.equal((await fromPage("spec", { spec, confirm: true }, "PATCH")).status, 200); };
const saveDialog = `[!!document.querySelector('#dialog [data-action="save-page"]'), !!document.querySelector('#dialog [data-action="copy-markdown"]'), !!document.querySelector('#dialog a[href$="/export"]'), [...document.querySelectorAll("#dialog li")].map(l => l.textContent), [...document.querySelectorAll("#dialog p")].some(p => p.textContent.includes("スマホでは「ファイル」アプリ（iPhone）やファイルマネージャ（Android）で ZIP をタップすると展開されます。"))]`;
const edit = async (id: string) => { await owner!.evaluate(`document.querySelector('[data-action="edit-item"][data-id="${id}"]').click()`); await owner!.until(`!!document.querySelector('#dialog form[data-form="item"]')`); };
const submit = `document.querySelector('#dialog form[data-form="item"]').requestSubmit()`;
const compact = `(() => {
  const list = document.querySelector('.timeline-list'), timeline = list ?? document.querySelector('.timeline'), groups = [...document.querySelectorAll('.insert-actions')];
  if (timeline) {
    const entries = [...timeline.querySelectorAll(list ? '.insert-row' : ':scope > .insert-actions')], rows = [...timeline.children].filter(el => !el.classList.contains('insert-row') && !el.classList.contains('insert-actions'));
    const snapshot = () => [timeline.getBoundingClientRect().height, ...rows.flatMap(el => { const r = el.getBoundingClientRect(); return [r.top, r.height]; })];
    const before = snapshot(); entries.forEach(el => el.hidden = true); const after = snapshot(); entries.forEach(el => el.hidden = false);
    if (before.some((n, k) => Math.abs(n - after[k]) > 0.1) || entries.some(el => el.getBoundingClientRect().height !== 0)) return false;
    if (list) {
      // The original row and gap padding totals also give the same list geometry.
      const padded = rows.map(el => el.classList.contains('row') ? el.querySelector('[data-action]') : el).filter(Boolean);
      const styles = padded.map(el => [el.style.cssText, el.className]);
      padded.forEach(el => { const gap = el.classList.contains('gap'); el.classList.remove('boundary-wrapped'); el.style.rowGap = ''; el.style.paddingTop = gap ? '6px' : '8px'; el.style.paddingBottom = gap ? '6px' : '8px'; });
      const original = snapshot(); padded.forEach((el, k) => { el.style.cssText = styles[k][0]; el.className = styles[k][1]; });
      if (before.some((n, k) => Math.abs(n - original[k]) > 0.1)) return false;
    }

  }
  return groups.every(group => {
    const r = group.getBoundingClientRect(), row = group.closest('.insert-row');
    const buttons = [...group.querySelectorAll('button')], visible = buttons.map(b => b.getBoundingClientRect());
    const targets = buttons.map((b, k) => { const r = visible[k], p = getComputedStyle(b, '::after'); const x = p.content === 'none' ? 0 : -parseFloat(p.left)-parseFloat(getComputedStyle(b).borderLeftWidth), y = p.content === 'none' ? 0 : -parseFloat(p.top)-parseFloat(getComputedStyle(b).borderTopWidth); return {left:r.left-x,right:r.right+x,top:r.top-y,bottom:r.bottom+y,width:r.width+2*x,height:r.height+2*y}; });
    const separate = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    if (targets.some((t, k) => t.width < 24 || t.height < 24 || t.left < 0 || t.right > innerWidth || targets.some((x, j) => k !== j && !separate(t, x)))) return false;
    if (row) {
      const boundary = row.getBoundingClientRect().top;
      if (visible.some(b => Math.abs((b.top+b.bottom)/2-boundary) > 1)) return false;
    } else {
      const card = group.previousElementSibling?.querySelector('.event-content');
      if (r.height !== 0 || !card || visible.some(b => Math.abs((b.top+b.bottom)/2-card.getBoundingClientRect().bottom) > 1)) return false;
    }
    const content = [...timeline.querySelectorAll(list ? '.row-time, .row-title, .badge, .gap' : '.event-time, h3, .event-content p, .badge, .links, .gap')].flatMap(el => { const range = document.createRange(); range.selectNodeContents(el); return [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0); });
    if (targets.some(b => content.some(c => !separate(b, c)))) return false;
    return true;
  }) && document.documentElement.scrollWidth <= innerWidth;
})()`;
const headingTargets = `(() => { const buttons = [...document.querySelectorAll('.section-heading [data-action="new-item"], .section-heading [data-action="new-private-item"]')]; return buttons.every((b, k) => { const r = b.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth && buttons.every((c, j) => { const x = c.getBoundingClientRect(); return k === j || r.right <= x.left || x.right <= r.left || r.bottom <= x.top || x.bottom <= r.top; }); }); })()`;
const entryCounts = `[document.querySelectorAll('[data-action="new-item"]').length, document.querySelectorAll('[data-action="new-private-item"]').length, document.querySelectorAll('[data-action="insert-item"]').length, document.querySelectorAll('[data-action="insert-private-item"]').length]`;
const tabTo = async (p: typeof owner, name: string, ready: string) => { await p!.evaluate(`document.querySelector('[data-action="tab"][data-tab="${name}"]').click()`); await p!.until(`!!document.querySelector(${JSON.stringify(ready)})`); };
const day2 = tripDay(day, 1);
// The trip sealed by the owner's page as soon as the seat is taken, as every trip is (docs/design/trip-e2e.md §5, the third step
// of handing out): the banner's 移す, with the passkey registered there as the check (the page's virtual authenticator answers).
async function sealFromBanner(p: NonNullable<typeof owner>) {
  await p.until(`!!document.querySelector('[data-seal="owner"] [data-action="seal-trip"]')`, 20000);
  await p.evaluate(`(() => { document.querySelector("#message").textContent = ""; document.querySelector('[data-action="seal-trip"]').click(); return true; })()`);
  await p.until(`${message} === "旅行を、メンバーにだけ読める形にしました。" || (${message} ?? "").includes("移せません")`, 30000);
  assert.equal(await p.evaluate(message), "旅行を、メンバーにだけ読める形にしました。");
  // What the page asked on the way (answerYes counts them), before the reload starts the counts again.
  const asked = await p.evaluate(`({ asked: window.asked, checks: window.checks, made: window.made })`) as { asked: string[]; checks: number; made: number };
  await p.reload(); await p.evaluate(answerYes);
  return asked;
}
// src/trip-keys.ts built for a page, as globalThis.tripKeys: loaded again in each expression that uses it, so it is there whatever
// the page did in between. Built once.
let keysBuilt: string | undefined;
async function tripKeysCode() {
  if (keysBuilt) return keysBuilt;
  const entryDir = mkdtempSync(join(tmpdir(), "capsule-verify-seal-")), entry = join(entryDir, "entry.ts");
  writeFileSync(entry, `import * as k from ${JSON.stringify(join(import.meta.dir, "trip-keys.ts"))}; (globalThis as any).tripKeys = k;`);
  const keysBuild = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" }); rmSync(entryDir, { recursive: true, force: true });
  assert.ok(keysBuild.success, "src/trip-keys.ts did not build for the page");
  return keysBuilt = await keysBuild.outputs[0]!.text();
}
// The host's answer for the trip as a page holding the trip key opens it: the seat's private key in IndexedDB opens the trip key,
// which opens the plan and the footprints (what the screen draws from). A trip not sealed is as the host sent it.
async function opened(p: NonNullable<typeof owner>, id = capsuleId) {
  return await p.evaluate(`(async () => { ${await tripKeysCode()}
    const k = globalThis.tripKeys, id = "${id}", v = await (await vfetch("/v1/c/" + id)).json(), s = v.seatKey;
    if (!v.sealed) return v;
    const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
    const trip = await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation), o = await k.openTrip(trip, id, v);
    if (!o) throw new Error("the trip did not open: " + JSON.stringify(v.spec).slice(0, 300));
    const footprints = await Promise.all(v.footprints.map(async ({ point, by, ...f }) => ({ ...f, ...await k.openPoint(trip, id, f.id, point), by: await k.openName(trip, id, "footprint", f.id, by) })));
    return { ...v, spec: o.spec, document: o.document, footprints };
  })()`) as { spec: any; document: any; footprints: Array<{ at: string }>; photos?: boolean; media?: unknown[] };
}
// A name of the sealed trip (a member's, an invite's) as a page holding the trip key opens it; one the host gave stays as it is.
async function openedName(p: NonNullable<typeof owner>, kind: "member" | "grant", of: string, label: string) {
  return await p.evaluate(`(async () => { ${await tripKeysCode()}
    const k = globalThis.tripKeys, id = "${capsuleId}", s = (await (await vfetch("/v1/c/" + id)).json()).seatKey;
    const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
    return k.openName(await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation), id, "${kind}", "${of}", ${JSON.stringify(label)});
  })()`) as string;
}
// The trip key handed from a page that holds it to a member's, the two comparing their codes (#703), as (v) (c) does.
async function handOver(giver: NonNullable<typeof owner>, member: NonNullable<typeof owner>) {
  await member.cdp("Page.reload"); await member.until(`document.querySelector('[data-sealed="locked"]')?.textContent === "オーナーかメンバーから鍵を受け取ってください"`, 20000);
  await member.evaluate(`document.querySelector('[data-action="receive-key"]').click()`); await member.until(`document.querySelector("#dialog")?.textContent.includes("「渡す」を押してもらってください")`, 20000);
  await giver.cdp("Page.reload"); await giver.until(`!!document.querySelector("[data-handoff-waiting]")`, 20000); await giver.evaluate(answerYes);
  await giver.evaluate(`document.querySelector('footer [data-action="give-key"]').click()`);
  for (const b of [giver, member]) await b.until(`!!document.querySelector("#dialog [data-handoff-own]")`, 20000);
  const [giverCode, memberCode] = [await ownCode(giver), await ownCode(member)];
  await typeCode(giver, memberCode); await typeCode(member, giverCode);
  await member.until(`!!document.querySelector('[data-trip-key="held"]')`, 30000);
  for (const b of [giver, member]) { await b.reload(); await b.evaluate(answerYes); }
}
// A group's trip: published from the seed, opened by the owner's page (what the dialog after joining said is returned), and
// sealed there (sealFromBanner), the owner's passkey (Chrome's virtual authenticator, with PRF) registered as the check before
// the owner's important actions.
async function openTrip(seal = true) {
  // A fresh minute of the host's clock: the counts per minute (logins, an owner's requests) are not the group's before.
  await nextMinute();
  const created = await fetch(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) });
  assert.equal(created.status, 201); const c = await created.json() as { id: string; url: string }; capsuleId = c.id;
  const p = await page(390, 844, true); owner = p;
  const joined = await p.join(c.url); await p.until(`!!document.querySelector('[data-trip-key="held"]')`);
  await p.cdp("WebAuthn.enable"); const { authenticatorId } = await p.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  // Unsealed (`seal` false, for the scenes that seal it themselves), the footer's passkey is registered, which counts as the check.
  const register = async () => { await p.evaluate(`document.querySelector('footer [data-action="passkey-register"]').click()`); await p.until(`(${message} ?? "").startsWith("パスキーを登録しました")`, 20000); };
  await p.evaluate(answerYes); const sealing = seal ? await sealFromBanner(p) : (await register(), undefined); checkedAt = await hostNow();
  return { owner: p, joined, authenticatorId: authenticatorId as string, sealing };
}
// A member of the group's trip: an invite of `role` from the owner's page, opened in a browser context of its own (what the
// dialog after joining said is returned), and given the trip key by the owner's page unless `key` is false.
async function joinAs(role: "participant" | "viewer" | "editor", width = 390, height = 844, key = true) {
  const link = await invite(role), context = (await send("Target.createBrowserContext")).browserContextId as string, p = await page(width, height, true, context);
  const joined = await p.join(link); if (key) await handOver(owner!, p);
  return { page: p, context, joined };
}
// A group's trip removed: from the owner's screen (共有・管理, the title typed in) when the group says so, or else from the owner's
// page (it holds the cookie) when the group has ended or failed. Gone for everyone is checked from here, where there is none.
async function closeTrip(fromScreen: boolean) {
  if (!capsuleId) return;
  if (fromScreen) {
    await owner!.until(`!!document.querySelector('[data-action="manage"]')`, 20000); await owner!.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner!.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="purge"]')`);
    await owner!.evaluate(`document.querySelector('#dialog [data-action="purge"]').click()`); await owner!.until(`!!document.querySelector('#dialog form[data-form="purge"]')`);
    await owner!.evaluate(`(() => { document.querySelector('#dialog input[name="title"]').value = ${JSON.stringify(title)}; document.querySelector('#dialog form[data-form="purge"]').requestSubmit(); })()`);
    await owner!.until(`document.querySelector("main.empty h1")?.textContent === "カプセルを削除しました。"`);
    assert.equal((await fetch(`${origin}/v1/c/${capsuleId}`)).status, 410); console.log("Disposable test capsule removed from the screen; subsequent access returns 410."); capsuleId = "";
    return;
  }
  // A group that failed on the owner's requests a minute (429) is purged in the host's next minute.
  const purge = () => owner ? fromPage("purge", { title }).catch(() => undefined) : Promise.resolve(undefined);
  let purged = await purge(); if (purged?.status === 429) { await nextMinute(); purged = await purge(); }
  const gone = purged?.status === 200 && (await fetch(`${origin}/v1/c/${capsuleId}`)).status === 410;
  if (gone) console.log("Disposable test capsule removed; subsequent access returns 410."); else console.log(`Could not remove the test capsule ${capsuleId}: purge it by hand (title "${title}")`);
  capsuleId = "";
}
async function plan() {
  // The group's owner page (the module's `owner`, which the shared parts above use).
  const { owner, joined, authenticatorId, sealing } = await openTrip();
  // The dialog after joining tells the owner, and only the owner, that the passkey is also the check before important actions.
  assert.equal(joined.includes("オーナーは、招待の発行や削除などの前の本人確認にも使います。"), true);
  // (a) #689: the owner's first opening makes the trip's key and the seat's key pair in this browser: the seat shows its public keys
  // (the owner's list of invites), the page says this device holds the key, and the host was handed nothing it could open.
  await owner.until(`!!document.querySelector('[data-trip-key="held"]')`);
  assert.equal(await owner.evaluate(`document.querySelector('[data-trip-key="held"]').textContent`), "この端末に鍵がある");
  assert.deepEqual(await owner.evaluate(`(async () => { const g = await (await vfetch("/v1/c/${capsuleId}/grants")).json(), self = g.flatMap(x => x.members).find(m => m.self); return [Object.keys(self.publicKey ?? {}).sort(), self.publicKey?.x25519?.length, JSON.stringify(g).includes("wrapped")]; })()`), [["ed25519", "x25519"], 43, false]);
  assert.equal(await owner.evaluate(`document.querySelectorAll('.diary, [data-action="new-private"]').length`), 0, "the itinerary still contains a diary entry point");
  assert.equal(await owner.evaluate(`!!document.querySelector('.topbar [data-action="revise"]')`), false);
  // (i) an owner's important action: the first one, sealing the trip (openTrip's), asks to register a passkey on this phone, which
  // counts as the check; invites within five minutes ask nothing. The confirm() is answered yes and remembered (after each reload).
  assert.equal(await owner.evaluate(`[...document.querySelectorAll('[data-action="insert-private-item"]')].every(b => b.textContent.includes("試験機能") && b.getAttribute("aria-label").includes("試験機能"))`), true, "personal insertion entrances must show trial status");
  assert.deepEqual(sealing, { asked: ["この操作には、この端末でのパスキー（Face ID・指紋）の確認が要ります。パスキーを登録して続けますか？"], checks: 1, made: 1 });  // the one check is the new passkey's PRF output, asked once more to wrap the seat's keys (#689)
  assert.equal(await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).passkey)()`), true);
  await invite(); await invite("viewer"); await invite("editor"); assert.deepEqual(await owner.evaluate(`[window.asked.length, window.checks]`), [0, 0]);
  // (k) each theme's text against its own background (WCAG contrast, from the computed colours; a transparent background is
  // the parent's): a preview's banner, the day tabs and the notice from a file taken in on the top page, and the owner's
  // invite dialog's warning with the trip set to the theme (a change of settings, inside the passkey check's five minutes).
  // All four are printed so a change for one can be compared with the others before and after; night must reach 4.5.
  const ratio = (selector: string) => `(() => { const el = document.querySelector(${JSON.stringify(selector)}), rgb = s => s.match(/[\\d.]+/g).map(Number);
    const lum = c => { const [r, g, b] = c.map(x => (x /= 255) <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    let back = el; while (back && rgb(getComputedStyle(back).backgroundColor)[3] === 0) back = back.parentElement;
    const [a, b] = [lum(rgb(getComputedStyle(el).color)), lum(rgb(back ? getComputedStyle(back).backgroundColor : "rgb(255, 255, 255)"))];
    return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100; })()`;
  const parts = { "案内の見出し": ".preview-banner strong", "案内の本文": ".preview-banner p", "日付タブ（選択中）": ".day-tabs button.selected", "日付タブ（未選択）": ".day-tabs button:not(.selected)", "通知": "#message" };
  const setTheme = (preset: string) => setSpec(spec => { spec.theme.preset = preset; });
  const look = await page(390, 844, true), themed = join(profile, "themed.json"), ratios: Record<string, Record<string, number>> = {};
  for (const preset of ["paper", "postcard", "minimal", "night"] as const) {
    const trip = testTrip(day); trip.spec.theme.preset = preset; writeFileSync(themed, JSON.stringify(trip));
    await look.cdp("Page.navigate", { url: origin + "/" }); await look.until(`!!document.querySelector('[data-import="trip"]')`);
    const { root } = await look.cdp("DOM.getDocument"), { nodeId } = await look.cdp("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-import="trip"]' });
    await look.cdp("DOM.setFileInputFiles", { nodeId, files: [themed] });
    await look.until(`!!document.querySelector(".preview-banner") && ${message}.startsWith("まだ送信していません")`);
    ratios[preset] = Object.fromEntries(await Promise.all(Object.entries(parts).map(async ([name, selector]) => [name, await look.evaluate(ratio(selector))])));
    await setTheme(preset); await owner.evaluate(`document.querySelector('[data-action="reload"]').click()`); await owner.until(`document.body.dataset.theme === "${preset}"`);
    await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector("#dialog .warning")`);
    ratios[preset]!["警告"] = await owner.evaluate(ratio("#dialog .warning")); await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
    console.log(`${preset}: ${Object.entries(ratios[preset]!).map(([name, r]) => `${name} ${r}`).join(", ")}`);
  }
  await look.close(); await setTheme("paper"); await owner.reload();
  // (k2) 「ここで作る」: a creator who has no API key registered is asked for one and is not offered the wish box; a key the host
  // does not accept is answered in the host's words (this local host asks Anthropic, so offline it is the connection's words) and
  // nothing is stored. Generating with a real key is the user's to check.
  const assistHome = await page(390, 844, true);
  await assistHome.cdp("Page.navigate", { url: origin + "/" }); await assistHome.until(`!!document.querySelector('[data-assist-card] form[data-form="assist-key"]')`);
  assert.equal(await assistHome.evaluate(`!!document.querySelector("textarea[data-assist]")`), false);
  // The card says an unused key does not stay (#744).
  assert.ok((await assistHome.evaluate(`document.querySelector("[data-assist-card]").textContent`) as string).includes("30 日使わないと"), "the key card says an unused key is removed");
  await assistHome.evaluate(`(() => { const f = document.querySelector('[data-form="assist-key"]'); f.elements.key.value = "sk-ant-api03-" + "x".repeat(30); f.requestSubmit(); return true; })()`);
  await assistHome.until(`${message}.includes("使えません") || ${message}.includes("接続できませんでした")`, 30000);
  assert.equal(await assistHome.evaluate(`!!document.querySelector("textarea[data-assist]")`), false);
  await assistHome.close();
  for (const [name, r] of Object.entries(ratios.night!)) assert.ok(r >= 4.5, `night: ${name} has a contrast of ${r}, under 4.5`);
  // (l) 旅を保存, at 375px: the header's button opens a dialog with 「旅程のページを保存」, 「Markdown をコピー」 and, for the owner, 「ZIP を保存」 with a
  // line for each file of this trip's exports, nothing off the side. The trip is sealed, so the page makes them from what it opened
  // and asks the host for none (the same as the host's of the plain trip: the sealed group's (a')). With the clipboard allowed, the
  // Markdown is copied; without, the same text is shown selected. 共有・管理 leads to the same dialog. A trip whose exports are only
  // Markdown lists no index.html (set inside the passkey check's five minutes, as the themes are). 「旅程のページを保存」 downloads
  // trip-<初日>.html where the browser cannot share a file (headless Chrome has no navigator.share), and hands that file, as
  // text/html, to the share sheet where it can (navigator.share stubbed here).
  const files = ["README.md — メモや Markdown のアプリで読める旅行記です。", "trip.json — データの控えです（読むためのものではありません）。", "calendar.ics — 開くと、決定した予定をカレンダーに取り込めます。", "index.html — ブラウザで開くと、旅程のページとして読めます。"];
  const sealedSave = `[!!document.querySelector('#dialog [data-action="save-page"]'), !!document.querySelector('#dialog [data-action="copy-markdown"]'), !!document.querySelector('#dialog [data-action="save-zip"]'), !!document.querySelector('#dialog a[href$="/export"]'), [...document.querySelectorAll("#dialog li")].map(l => l.textContent)]`;
  const exportsAsked = () => owner.requests().filter(u => /\/export(\.md|\.html)?$/.test(new URL(u).pathname)).length, asked = exportsAsked();
  await owner.size(375, 812, true); await owner.reload(); await openSave(owner);
  assert.deepEqual(await owner.evaluate(sealedSave), [true, true, true, false, files]);
  assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the 旅を保存 dialog runs off the side of a 375px screen");
  await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }); await owner.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await owner.evaluate(`document.querySelector('#dialog [data-action="copy-markdown"]').click()`); await owner.until(`${message} === "旅程を Markdown でコピーしました。メモアプリなどに貼って残してください。"`);
  const text = await owner.evaluate(`navigator.clipboard.readText()`) as string; assert.match(text, new RegExp(`^---\ntitle: "${title}"`));
  await send("Browser.resetPermissions"); await owner.evaluate(`document.querySelector('#dialog [data-action="copy-markdown"]').click()`); await owner.until(`!!document.querySelector("#markdown-text")`);
  assert.deepEqual(await owner.evaluate(`(() => { const t = document.querySelector("#markdown-text"); return [t.value, t.selectionStart, t.selectionEnd === t.value.length, document.activeElement === t]; })()`), [text, 0, true, true]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector('#dialog [data-action="save"]')`);
  await openSave(owner, "#dialog "); assert.deepEqual(await owner.evaluate(sealedSave), [true, true, true, false, files]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  const setExports = (exports: string[]) => setSpec(spec => { spec.exports = exports; });
  await setExports(["markdown"]); await owner.reload(); await openSave(owner); assert.deepEqual(await owner.evaluate(sealedSave), [true, true, true, false, files.slice(0, 1)]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await setExports(["markdown", "json", "ics", "html"]); await owner.reload();
  const pageName = `trip-${seed.spec.trip.startsOn}.html`, pageDownloads = join(profile, "page-downloads"), pageFile = join(pageDownloads, pageName);
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: pageDownloads });
  await openSave(owner); await owner.evaluate(`document.querySelector('#dialog [data-action="save-page"]').click()`);
  for (let i = 0; i < 100 && !existsSync(pageFile); i++) await sleep(100);
  const tripPage = readFileSync(pageFile, "utf8");
  assert.ok(tripPage.startsWith("<!doctype html>") && tripPage.includes(`<h1>${title}</h1>`), "the downloaded trip page is not the trip's page");
  await owner.until(`${message} === "旅程のページを保存しました。ブラウザで開くと旅のしおりとして読めます。"`);
  await owner.evaluate(`(() => { window.shared = []; navigator.canShare = () => true; navigator.share = async d => { window.shared.push(d); }; return true; })()`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="save-page"]').click()`); await owner.until(`window.shared.length === 1`);
  assert.deepEqual(await owner.evaluate(`(async () => { const d = window.shared[0]; return [d.files.length, d.files[0].type, d.files[0].name, await d.files[0].text()]; })()`), [1, "text/html", pageName, tripPage]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await owner.reload();
  assert.equal(exportsAsked(), asked, "the sealed trip's page asked the host for an export");
  // The themes, 旅を保存 and the reloads above spend much of the owner's 120 requests a minute (see (j)): (p) starts in a fresh one.
  await nextMinute();
  // (p) 招待とオーナーの履歴, still at 375px and inside the passkey check's five minutes: the owner issues a participant invite
  // named 履歴確認用 and revokes it; 共有・管理 opened again lists the two first, newest first, each with the date and time, the
  // role, the link's name and this phone's member name and device, nothing off the side. The trip is sealed: its history names
  // the invite by id, and the host keeps nothing of a revoked one, so both its lines read （失効した招待） (as the sealed group's (u)).
  const historyInvite = `[...document.querySelectorAll("#dialog .grant")].find(g => g.querySelector("strong")?.textContent === "履歴確認用")`;
  await manageOpen();
  await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="grant"]'); f.elements.namedItem("role").value = "participant"; f.elements.namedItem("label").value = "履歴確認用"; f.requestSubmit(); return true; })()`);
  await owner.until(`!!document.querySelector("#issued-link")`); await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await manageOpen(); await owner.evaluate(`(() => { window.confirm = () => true; ${historyInvite}.querySelector('[data-action="revoke"]').click(); return true; })()`); await owner.until(`!!document.querySelector("#dialog details.history") && !${historyInvite}`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await manageOpen();
  const self = await owner.evaluate(`[...document.querySelectorAll("#dialog .member")].find(m => m.textContent.includes("（この端末）")).textContent.split("（この端末）")[0]`) as string;
  const historyLines = await owner.evaluate(`(() => { document.querySelector("#dialog details.history").open = true; return [...document.querySelectorAll("#dialog details.history li")].slice(0, 2).map(l => l.textContent); })()`) as string[];
  for (const [line, what] of [[historyLines[0], "招待を失効"], [historyLines[1], "招待を発行"]] as const) {
    for (const part of [what, "参加者", "（失効した招待）", self]) assert.ok(line?.includes(` · ${part}`), `the history line ${JSON.stringify(line)} does not name ${part}`);
    // It starts with the date and time, and ends with this phone's device after the member name.
    assert.match(line!, new RegExp(`^\\d{4}/\\d{1,2}/\\d{1,2} \\d{2}:\\d{2} · .* · ${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（[^（）]+）$`), `the history line ${JSON.stringify(line)} has no time or device`);
  }
  assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375 && document.querySelector("#dialog details.history").getBoundingClientRect().right <= 375`), true, "the history runs off the side of a 375px screen");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await owner.reload(); await owner.size(390, 844, true);
  // The dialogs and reloads above spend much of the owner's 120 requests a minute (see (j)): what follows starts in a fresh minute.
  await nextMinute();
  await owner.evaluate(heading); await sleep(200);
  // (a) by touch: the third item dropped before the first takes a time ahead of it, a placeholder, and the screen says so; a reload agrees.
  assert.equal(await owner.evaluate(order), "one,two,three"); assert.equal(await owner.evaluate(timeOf("one")), "09:00");
  await owner.drag('[data-item="three"] [data-drag]', (await owner.box('[data-item="one"]')).top + 5);
  await owner.until(`${message} === "三番目の予定を 08:30 ごろ に変えました。"`);
  assert.equal(await owner.evaluate(order), "three,one,two"); assert.equal(await owner.evaluate(timeOf("three")), "08:30 ごろ");
  await owner.reload(); assert.equal(await owner.evaluate(order), "three,one,two"); assert.equal(await owner.evaluate(timeOf("three")), "08:30 ごろ");
  // (b) by keyboard: ArrowDown on a focused grip moves one step down, and the focus stays on that grip.
  await owner.size(1280, 800, false); await owner.reload();
  await owner.evaluate(`document.querySelector('[data-item="three"] [data-drag]').focus()`); await owner.key("ArrowDown", 40);
  await owner.until(`${order} === "one,three,two"`); await owner.until(`${message} === "三番目の予定を 10:00 ごろ に変えました。"`);
  assert.equal(await owner.evaluate(`document.activeElement?.getAttribute("aria-label")`), "三番目の予定の順番を動かす");
  // (c) リスト: kept across a reload, the same grip works, a line opens its card.
  await owner.size(390, 844, true); await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await owner.until(`document.querySelectorAll(".timeline-list .row").length === 3`);
  await owner.reload(); assert.ok(await owner.evaluate(`!!document.querySelector(".timeline-list") && document.querySelector('[data-view="list"]').getAttribute("aria-pressed") === "true"`));
  await owner.evaluate(heading); await sleep(200); await owner.drag('[data-item="three"] [data-drag]', (await owner.box('[data-item="two"]')).bottom - 4);
  await owner.until(`${message} === "三番目の予定を 12:00 ごろ に変えました。"`); assert.equal(await owner.evaluate(order), "one,two,three");
  const line = await owner.box('[data-item="two"] [data-action="open-item"]'); await owner.evaluate(`(() => { const t = document.elementFromPoint(${line.x}, ${line.y}); t.closest('[data-action="open-item"]').click(); })()`);
  // The card is on screen and holds the focus (a short page cannot always bring it to the top; one that can puts it there to a
  // fraction of a pixel, hence -1).
  await owner.until(`!!document.querySelector(".timeline")`);
  assert.deepEqual(await owner.evaluate(`(() => { const b = document.getElementById("item-two").getBoundingClientRect(); return [b.top >= -1 && b.bottom <= innerHeight, document.activeElement?.id]; })()`), [true, "item-two"], "the tapped line's card is on screen in 詳細 and focused");
  // (e) items without a time, as a trip published before may hold (publishing now refuses them; an edit through the API does not).
  // The fifth has an end already (15:00), which the form keeps when it gives the start and moves along when the start changes.
  for (const [id, t, end] of [["four", "四番目の予定"], ["five", "五番目の予定", `${day}T15:00:00+09:00`]]) assert.equal((await fromPage("document", { type: "item", item: { id, title: t, day, kind: "activity", status: "confirmed", revision: 1, ...(end ? { endsAt: end } : {}) } }, "PATCH")).status, 200);
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`); await owner.reload();
  assert.equal(await owner.evaluate(order), "one,two,three,four,five"); assert.equal(await owner.evaluate(timeOf("four")), "時間未定");
  // Dragged before the second: an hour after the first (it has no end), a placeholder.
  // Both on screen and clear of the edges, where the page would scroll by itself (the "＋" between items make the day taller than the screen).
  await owner.evaluate(`(() => { document.querySelector('[data-item="two"]').scrollIntoView({ block: "start", behavior: "instant" }); scrollBy({ top: -120, behavior: "instant" }); })()`); await sleep(200); await owner.drag('[data-item="four"] [data-drag]', (await owner.box('[data-item="two"]')).top + 5);
  await owner.until(`${message} === "四番目の予定を 10:00 ごろ に変えました。"`); assert.equal(await owner.evaluate(order), "one,four,two,three,five");
  // (f) 「編集」 on an item without a time opens with the time it would get where it stands, marked a placeholder; saved as it is, it reads "ごろ".
  const field = `document.querySelector('#dialog input[name="time"]')`, box = `document.querySelector('#dialog input[name="tentative"]')`;
  await edit("five"); assert.deepEqual(await owner.evaluate(`[${field}.value, ${field}.required, ${box}.checked]`), ["13:00", true, true]);
  await owner.evaluate(submit); await owner.until(`${timeOf("five")} === "13:00 – 15:00 ごろ"`);
  const endOf = (id: string) => owner!.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).document.items.find(i => i.id === "${id}").endsAt)()`);
  assert.equal(await endOf("five"), `${day}T15:00:00+09:00`);
  await edit("five"); await owner.evaluate(`(() => { const t = ${field}; t.value = "13:30"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  await owner.evaluate(submit); await owner.until(`${timeOf("five")} === "13:30 – 15:30"`); assert.equal(await endOf("five"), `${day}T15:30:00+09:00`);
  // A new time takes the mark off, and the card loses its "ごろ".
  await edit("four"); assert.deepEqual(await owner.evaluate(`[${field}.value, ${box}.checked]`), ["10:00", true]);
  await owner.evaluate(`(() => { const t = ${field}; t.value = "10:15"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.equal(await owner.evaluate(`${box}.checked`), false);
  await owner.evaluate(submit); await owner.until(`${timeOf("four")} === "10:15"`);
  // (g) the end: typed in and shown as "11:00 – 12:00"; moved along with the start; refused before the start; emptied to drop it.
  // An end before the next start leaves the free time between the two, one after it marks the next as overlapping; only shown.
  const end = `document.querySelector('#dialog input[name="end"]')`, type = (input: string, value: string) => owner!.evaluate(`(() => { const t = ${input}; t.value = "${value}"; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const after = (id: string) => owner!.evaluate(`document.querySelector('[data-item="${id}"]').previousElementSibling?.classList.contains("gap") ? document.querySelector('[data-item="${id}"]').previousElementSibling.textContent : ""`);
  const overlaps = (id: string) => owner!.evaluate(`!!document.querySelector('[data-item="${id}"] .badge.overlap')`);
  await edit("two"); assert.equal(await owner.evaluate(`${end}.value`), ""); await type(end, "12:00");
  await owner.evaluate(submit); await owner.until(`${timeOf("two")} === "11:00 – 12:00"`); assert.equal(await endOf("two"), `${day}T12:00:00+09:00`);
  assert.equal(await owner.evaluate(order), "one,four,two,three,five"); assert.equal(await owner.evaluate(timeOf("three")), "12:00 ごろ"); assert.equal(await after("three"), ""); assert.equal(await overlaps("three"), false);
  await edit("two"); await type(field, "11:30"); assert.equal(await owner.evaluate(`${end}.value`), "12:30");
  await owner.evaluate(submit); await owner.until(`${timeOf("two")} === "11:30 – 12:30"`); assert.equal(await overlaps("three"), true);
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await owner.until(`!!document.querySelector(".timeline-list")`);
  assert.equal(await overlaps("three"), true);
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`); await owner.until(`!!document.querySelector(".timeline")`);
  // A cancelled item is not waited for: nothing is marked after it.
  const itemOf = async (id: string) => (await opened(owner!)).document.items.find((i: { id: string }) => i.id === id), two = await itemOf("two");
  assert.equal((await fromPage("document", { type: "item", item: { ...two, status: "cancelled" } }, "PATCH")).status, 200); await owner.reload();
  assert.equal(await overlaps("three"), false);
  assert.equal((await fromPage("document", { type: "item", item: { ...two, status: "confirmed" } }, "PATCH")).status, 200); await owner.reload();
  assert.equal(await overlaps("three"), true);
  await edit("two"); await type(end, "09:00"); await owner.evaluate(submit);
  await owner.until(`${message} === "終了時刻が開始時刻より前です"`); assert.equal(await endOf("two"), `${day}T12:30:00+09:00`);
  // A start that takes the end past midnight leaves no end in the box (nothing saved here).
  await type(end, "12:30"); await type(field, "23:30"); assert.equal(await owner.evaluate(`${end}.value`), "");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await edit("three"); await type(field, "13:15"); await owner.evaluate(submit); await owner.until(`${timeOf("three")} === "13:15"`);
  assert.equal(await owner.evaluate(order), "one,four,two,three,five"); assert.equal(await after("three"), "空き 45 分"); assert.equal(await overlaps("three"), false);
  // An item inside a long one is marked even after a shorter one that ends before it: four, 10:15 – 15:00, holds three's 13:15.
  await edit("four"); await type(end, "15:00"); await owner.evaluate(submit); await owner.until(`${timeOf("four")} === "10:15 – 15:00"`);
  assert.equal(await overlaps("three"), true); assert.equal(await after("three"), "");
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await owner.until(`!!document.querySelector(".timeline-list")`);
  assert.equal(await overlaps("three"), true); assert.equal(await after("three"), "");
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`); await owner.until(`!!document.querySelector(".timeline")`);
  await edit("four"); await type(end, ""); await owner.evaluate(submit); await owner.until(`${timeOf("four")} === "10:15"`);
  assert.equal(await after("three"), "空き 45 分"); assert.equal(await overlaps("three"), false);
  // A row dragged away and brought back saves nothing, and the free time is back where it was.
  await owner.evaluate(`document.querySelector('[data-item="three"]').scrollIntoView({ block: "center", behavior: "instant" })`); await sleep(200);
  const home = await owner.box('[data-item="three"]'), below = await owner.box('[data-item="five"]');
  await owner.drag('[data-item="three"] [data-drag]', below.y + 10, home.top + 5); await sleep(300);
  assert.equal(await owner.evaluate(order), "one,four,two,three,five"); assert.equal(await after("three"), "空き 45 分");
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await owner.until(`!!document.querySelector(".timeline-list")`);
  assert.equal(await after("three"), "空き 45 分"); assert.equal(await owner.evaluate(timeOf("two")), "11:30 – 12:30");
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`); await owner.until(`!!document.querySelector(".timeline")`);
  await edit("two"); await type(end, ""); await owner.evaluate(submit); await owner.until(`${timeOf("two")} === "11:30"`);
  assert.equal(await endOf("two"), undefined); assert.equal(await after("three"), "");
  // An end on the next day (a night's stay) is kept there by the form; one emptied and typed again is on the item's own day.
  assert.equal((await fromPage("document", { type: "item", item: { ...await itemOf("five"), endsAt: `${tripDay(day, 1)}T10:00:00+09:00` } }, "PATCH")).status, 200); await owner.reload();
  await edit("five"); assert.equal(await owner.evaluate(`${end}.value`), "10:00"); await owner.evaluate(submit); await owner.until(`!document.querySelector("#dialog").open`);
  assert.equal(await endOf("five"), `${tripDay(day, 1)}T10:00:00+09:00`);
  await edit("five"); await type(end, ""); await type(end, "16:00"); await owner.evaluate(submit); await owner.until(`${timeOf("five")} === "13:30 – 16:00"`);
  assert.equal(await endOf("five"), `${day}T16:00:00+09:00`);
  // (h) "＋" between items, on the second day: one after each item; the form opens with the start the host would give there, a
  // placeholder, and saved it goes right there. The heading's button offers the time after the day's last item.
  for (const [id, t, time] of [["p1", "朝の予定", "09:00"], ["p2", "昼の予定", "11:00"], ["p3", "午後の予定", "13:00"]]) assert.equal((await fromPage("document", { type: "item", item: { id, title: t, day: day2, startsAt: `${day2}T${time}:00+09:00`, kind: "activity", status: "confirmed", revision: 1 } }, "PATCH")).status, 200);
  await owner.reload(); await owner.evaluate(`document.querySelector('[data-action="day"][data-day="${day2}"]').click()`); await owner.until(`!!document.querySelector('[data-item="p1"]')`);
  assert.deepEqual(await owner.evaluate(`[...document.querySelectorAll('[data-action="insert-item"]')].map(b => b.dataset.after + ":" + b.getAttribute("aria-label"))`), ["p1:朝の予定の後に共有予定を追加", "p2:昼の予定の後に共有予定を追加", "p3:午後の予定の後に共有予定を追加"]);
  // Boundary entries must not add a row: compare every itinerary row with the entries removed.
  assert.equal(await owner.evaluate(compact), true);
  for (const width of [320, 375]) for (const display of ["list", "detail"]) {
    await owner.size(width, 812, true);
    await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="${display}"]').click()`);
    assert.equal(await owner.evaluate(compact), true, `${width}px ${display}: insertion targets overlap or overflow`);
    assert.equal(await owner.evaluate(headingTargets), true, `${width}px ${display}: heading targets overlap, overflow or are smaller than 44px`);
    assert.equal(await owner.evaluate(`document.querySelectorAll('[data-action="insert-private-item"]').length`), 3);
    assert.equal(await owner.evaluate(`[...document.querySelectorAll('[data-action="insert-private-item"]')].every(b => b.textContent.includes("試験機能") && b.getAttribute("aria-label").includes("試験機能"))`), true, `${display}: personal insertion entrances must show trial status`);
    await owner.evaluate(`document.querySelector('.row-title, .event-content h3').textContent = '長い予定のタイトル'.repeat(20)`);
    assert.equal(await owner.evaluate(compact), true);
    if (display === "list") assert.equal(await owner.evaluate(`(async () => {
      const row = document.querySelector('.row'), button = row.querySelector('[data-action="open-item"]'), saved = button.innerHTML;
      button.querySelector('.row-time').innerHTML = '09:30 –<br>10:10 ごろ';
      button.insertAdjacentHTML('beforeend', '<span class="badge provisional">候補・要確認</span><span class="badge overlap">前の予定と重なっています</span>');
      const gap = document.createElement('li'); gap.className = 'gap'; gap.textContent = '空き 12 時間 30 分'; row.nextElementSibling.after(gap);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const good = ${compact}; button.innerHTML = saved; gap.remove();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return good;
    })()`), true, `${width}px: boundary entries cover wrapped times, warnings or free-time text`);
    for (const [after, offered] of [["p1", "10:00"], ["p2", "12:00"], ["p3", "14:00"]]) {
      if (display === "list") {
        const selector = `[data-action="insert-private-item"][data-after="${after}"]`;
        await owner.evaluate(`document.querySelector('${selector}').scrollIntoView({block:'center'})`);
        const position: {x:number;bottom:number} = await owner.box(selector);
        const x: number = position.x, y: number = position.bottom+3;
        // Click the extended target below the visible pill; it must open this entry, not the next row.
        assert.equal(await owner.evaluate(`document.elementFromPoint(${x},${y})?.closest('button')?.dataset.action`), "insert-private-item", "the extended target is obscured by another row");
        await owner.cdp("Input.dispatchTouchEvent", {type:"touchStart", touchPoints:[{x,y}]});
        await owner.cdp("Input.dispatchTouchEvent", {type:"touchEnd", touchPoints:[]});
        await owner.until(`!!document.querySelector('#dialog [name=time]')`);
      } else await owner.evaluate(`document.querySelector('[data-action="insert-private-item"][data-after="${after}"]').click()`);
      assert.deepEqual(await owner.evaluate(`[document.querySelector('#dialog [name=time]').value, document.querySelector('#dialog [name=kind]').value, document.querySelectorAll('#dialog [type=radio]').length]`), [offered, "item", 0]);
      assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
      await owner.evaluate(`document.querySelector('#dialog [data-action=close]').click()`);
    }
  }
  await owner.evaluate(`document.querySelector('[data-action="new-private-item"]').click()`);
  assert.equal(await owner.evaluate(`document.querySelector('#dialog [name=time]').value`), "14:00");
  await owner.evaluate(`document.querySelector('#dialog [data-action=close]').click(); document.querySelector('[data-action=day][data-day="${tripDay(day, 2)}"]').click(); document.querySelector('[data-action="new-private-item"]').click()`);
  assert.equal(await owner.evaluate(`document.querySelector('#dialog [name=time]').value`), "09:00");
  await owner.evaluate(`document.querySelector('#dialog [data-action=close]').click(); document.querySelector('[data-action=day][data-day="${day2}"]').click()`);
  await owner.size(390, 844, true);

  const form = `document.querySelector('#dialog form[data-form="item"]')`, title2 = `document.querySelector('#dialog input[name="title"]')`;
  const plus = async (after: string) => { await owner!.evaluate(`document.querySelector('[data-action="insert-item"][data-after="${after}"]').click()`); await owner!.until(`!!${form}`); };
  await plus("p1"); assert.deepEqual(await owner.evaluate(`[${form}.dataset.after, ${field}.value, ${box}.checked, document.querySelector('#dialog input[name="day"]').value]`), ["p1", "10:00", true, day2]);
  const added = await owner.evaluate(`${form}.dataset.id`); await type(title2, "足した予定"); await owner.evaluate(submit);
  await owner.until(`${message} === "足した予定を 10:00 ごろ に置きました。"`);
  assert.equal(await owner.evaluate(order), `p1,${added},p2,p3`); assert.equal(await owner.evaluate(timeOf(added)), "10:00 ごろ");
  // In the list too: after the 11:00 one, before 13:00.
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await owner.until(`!!document.querySelector(".timeline-list")`);
  assert.equal(await owner.evaluate(`document.querySelectorAll('[data-action="insert-item"]').length`), 4); assert.equal(await owner.evaluate(compact), true);
  await plus("p2"); assert.equal(await owner.evaluate(`${field}.value`), "12:00"); const listed = await owner.evaluate(`${form}.dataset.id`); await type(title2, "リストから足した予定"); await owner.evaluate(submit);
  await owner.until(`${message} === "リストから足した予定を 12:00 ごろ に置きました。"`); assert.equal(await owner.evaluate(order), `p1,${added},p2,${listed},p3`);
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`); await owner.until(`!!document.querySelector(".timeline")`);
  // The heading's button: an hour after the day's last item.
  await owner.evaluate(`document.querySelector('[data-action="new-item"]').click()`); await owner.until(`!!${form}`);
  assert.deepEqual(await owner.evaluate(`[${form}.dataset.after, ${field}.value, ${box}.checked]`), ["p3", "14:00", true]);
  // A time typed over the offered one is the user's: the item goes where that time fits, decided (not after the last item).
  await type(title2, "早朝の予定"); await type(field, "08:00"); const early = await owner.evaluate(`${form}.dataset.id`); await owner.evaluate(submit);
  await owner.until(`${message} === "保存しました。"`); assert.equal(await owner.evaluate(order), `${early},p1,${added},p2,${listed},p3`); assert.equal(await owner.evaluate(timeOf(early)), "08:00");
  await owner.evaluate(`document.querySelector('[data-action="new-item"]').click()`); await owner.until(`!!${form}`);
  // Moved to another day in the form, it goes there by its time: the first day, 10:30, after the 10:15 item.
  await type(title2, "別の日の予定"); await owner.evaluate(`(() => { const d = document.querySelector('#dialog input[name="day"]'); d.value = "${day}"; })()`); await type(field, "10:30");
  // The save before left the same notice: clear it, so this waits for this save's, shown once the day is read again and redrawn
  // (a redraw after the focus below would replace the focused 編集).
  const moved = await owner.evaluate(`${form}.dataset.id`); await owner.evaluate(`${message} = ""; ${submit}`); await owner.until(`${message} === "保存しました。"`);
  assert.deepEqual(await owner.evaluate(`(async () => { const items = (await (await vfetch("/v1/c/${capsuleId}")).json()).document.items.filter(i => i.day === "${day}"); return [items.findIndex(i => i.id === "${moved}"), items.findIndex(i => i.id === "four")]; })()`).then((x: number[]) => x[0]! === x[1]! + 1), true);
  // By keyboard: Tab from the first card's 編集 reaches its "＋", and Enter opens the form.
  await owner.evaluate(`document.querySelector('[data-action="edit-item"][data-id="p1"]').focus()`); await owner.key("Tab", 9);
  await owner.until(`document.activeElement?.dataset.after === "p1"`); await owner.key("Enter", 13); await owner.until(`${form}?.dataset.after === "p1"`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  // An item added this way is dragged like any other: after the last, it takes the time after it.
  await owner.evaluate(`document.querySelector('[data-item="${added}"]').scrollIntoView({ block: "start", behavior: "instant" })`); await sleep(200);
  await owner.drag(`[data-item="${added}"] [data-drag]`, (await owner.box('[data-item="p2"]')).bottom - 4);
  await owner.until(`${message} === "足した予定を 11:30 ごろ に変えました。"`); assert.equal(await owner.evaluate(order), `${early},p1,p2,${added},${listed},p3`);
  // A crowded line on a narrow phone (an overlap and a placeholder badge, the "＋" beside it) still shows its title: the badges
  // go under it rather than squeezing it away.
  assert.equal((await fromPage("document", { type: "item", item: { ...await itemOf("p2"), endsAt: `${day2}T12:00:00+09:00` } }, "PATCH")).status, 200);
  await owner.size(360, 800, true); await owner.reload(); await owner.evaluate(`document.querySelector('[data-action="day"][data-day="${day2}"]').click()`);
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await owner.until(`!!document.querySelector('[data-item="${added}"] .badge.overlap')`);
  assert.equal(await owner.evaluate(`[...document.querySelectorAll(".timeline-list .row-title")].every(t => t.getBoundingClientRect().width >= 100)`), true);
  assert.equal(await owner.evaluate(compact), true); await owner.size(390, 844, true);
  // (i) 候補・相談: each column says under its heading what it is for (and that the 相談 stays out of the itinerary and the
  // travelogue), and on a 375px phone nothing runs off the side.
  await owner.size(375, 812, true); await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="ideas"]').click()`); await owner.until(`!!document.querySelector(".two-columns")`);
  assert.deepEqual(await owner.evaluate(`[...document.querySelectorAll(".two-columns > section")].map(s => [s.querySelector("h3").textContent, s.querySelector("h3 + p.muted")?.textContent])`), [
    ["候補ボード", "行きたい場所・やりたいことを書く所です。オーナー・編集者が「旅程に追加」すると予定になります。旅行記にも候補として載ります。"],
    ["みんなの相談", "決めたいこと・質問・ひとことを書く所です。旅程にも旅行記にも入りません。"]]);
  assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the 候補・相談 tab runs off the side of a 375px screen");
  // The owner's seat may make 120 requests a minute, counted in whole minutes; with the passkey checks above, this script is
  // faster than that, so the 準備 and 費用メモ part starts in a fresh minute (a second's margin for the clocks).
  await nextMinute();
  // (j) 準備 and 費用メモ, still at 375px: the owner renames a line, removes one and adds one, the form never running off the side;
  // saved, a reload shows the list so. A budget line added shows its amount in yen.
  // 足あと: the browser is given a position (or refused one) and 「ここにいる」 is pressed; the page lists every member's points.
  const fill = (row: string, name: string, value: string) => owner!.evaluate(`(() => { const t = document.querySelector('#dialog ${row} [name=${name}]'); t.value = ${JSON.stringify(value)}; t.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  const fits = `document.documentElement.scrollWidth <= 375 && [...document.querySelectorAll("#dialog [data-row]")].every(r => r.scrollWidth <= r.clientWidth)`;
  await tabTo(owner, "check", '[data-action="edit-checklist"]'); await owner.evaluate(`document.querySelector('[data-action="edit-checklist"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="checklist"]')`);
  await fill('[data-id="c1"]', "title", "集合場所と時刻を決める"); await owner.evaluate(`document.querySelector('#dialog [data-id="c2"] [data-action="remove-row"]').click()`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="add-row"]').click()`); await fill("[data-row]:last-child", "title", "充電器を持つ");
  assert.equal(await owner.evaluate(fits), true, "the checklist form runs off the side of a 375px screen");
  await owner.evaluate(`document.querySelector('#dialog form[data-form="checklist"]').requestSubmit()`); await owner.until(`${message} === "保存しました。"`);
  const checks = `[...document.querySelectorAll(".checks .check span")].map(t => t.textContent)`;
  await owner.reload(); await tabTo(owner, "check", ".checks");
  assert.deepEqual(await owner.evaluate(checks), ["集合場所と時刻を決める", "必要な予約を確認する", "充電器を持つ"]);
  await tabTo(owner, "budget", '[data-action="edit-budget"]'); await owner.evaluate(`document.querySelector('[data-action="edit-budget"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="budget"]')`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="add-row"]').click()`);
  // A line with an amount but no title is refused, not dropped: the form stays open with what was typed.
  await fill("[data-row]:last-child", "amount", "24000"); await fill("[data-row]:last-child", "description", "2 泊・1 人あたり");
  await owner.evaluate(`document.querySelector('#dialog form[data-form="budget"]').requestSubmit()`); await owner.until(`${message} === "題の無い行があります。題を入れるか、行を削除してください"`);
  assert.equal(await owner.evaluate(`document.querySelector('#dialog [data-row]:last-child [name=amount]').value`), "24000");
  await fill("[data-row]:last-child", "title", "宿");
  assert.equal(await owner.evaluate(fits), true, "the budget form runs off the side of a 375px screen");
  await owner.evaluate(`document.querySelector('#dialog form[data-form="budget"]').requestSubmit()`); await owner.until(`${message} === "保存しました。"`);
  await owner.reload(); await tabTo(owner, "budget", ".amount");
  assert.deepEqual(await owner.evaluate(`[...document.querySelectorAll(".grid .card")].map(c => [c.querySelector("h3").textContent, c.querySelector(".amount").textContent])`), [["宿", "¥24,000"]]);
  // (o) 候補・相談 posts, still at 375px: the owner changes a 候補's words (the form holds the words it had) and takes a 相談 out
  // after a confirm; a reload shows both so. A card with 「直す」「消す」 runs off neither the screen nor its own edge.
  const posts = `[...document.querySelectorAll(".two-columns > section")].map(s => [...s.querySelectorAll("article .entry-body")].map(p => p.textContent))`;
  await tabTo(owner, "ideas", '[data-action="rewrite-post"]');
  assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375 && [...document.querySelectorAll(".two-columns .card-bottom")].every(c => c.scrollWidth <= c.clientWidth)`), true, "a post with 「直す」「消す」 runs off the side of a 375px screen");
  await owner.evaluate(`document.querySelector('[data-action="rewrite-post"][data-id="idea"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="rewrite"]')`);
  assert.equal(await owner.evaluate(`document.querySelector('#dialog [name=body]').value`), "夜は星を見たい");
  await owner.evaluate(`(() => { const t = document.querySelector('#dialog [name=body]'); t.value = "夜は丘で星を見たい"; t.form.requestSubmit(); })()`); await owner.until(`${message} === "保存しました。"`);
  await owner.evaluate(answerYes); await owner.evaluate(`document.querySelector('[data-action="remove-post"][data-id="ask"]').click()`); await owner.until(`!document.querySelector('[data-id="ask"]')`);
  assert.equal(await owner.evaluate(`window.asked.at(-1)`), "この投稿を消しますか？取り消せません。");
  await owner.reload(); await tabTo(owner, "ideas", ".two-columns");
  assert.deepEqual(await owner.evaluate(posts), [["夜は丘で星を見たい"], []]);
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click()`);
  await owner.size(390, 844, true);
  console.log("Plan verification passed: the owner's first opening making the trip's key (the seat's public keys listed, 「この端末に鍵がある」), a passkey check before the owner's important actions (the first invite registers one, the second asks nothing), no チャットで直す in the owner's header, reordering by grip (touch) and by arrow key with the host's new time shown as a placeholder (ごろ), an item without a time given one by a drag and by the edit form (required, the placeholder box unticked by a new time), 詳細 / リスト kept across a reload and reordered from the list, a line opening its card, an end typed / moved with the start / refused before it / emptied with the free time and overlap shown in both views (after an item inside a long one too), shared/personal entries on list boundaries (zero extra height, unchanged row positions, targets at least 24px) and adding one there (the form offering the host's time, a placeholder; the heading's button after the last item; another day by its time; by keyboard; dragged like any other), the 候補・相談 tab saying what each column is for (nothing off the side at 375px), the night theme's preview banner, day tabs, notice and invite warning at a contrast of 4.5 or more, the owner adding, renaming and removing 準備 and 費用メモ lines (kept across a reload), the owner changing a 候補's words and removing a 相談 (kept across a reload, nothing off the side at 375px), 旅を保存 at 375px (the trip page saved as one file (downloaded, or handed to the share sheet as text/html) for every role, Markdown copied to the clipboard, or shown selected when the clipboard is refused; the ZIP and a line per file of the trip's exports for the owner only, the same dialog from 共有・管理), 招待とオーナーの履歴 in 共有・管理 at 375px (an invite issued and revoked from the screen listed first, newest first, with the date and time, the role, the link's name and this phone's member name and device).");
}
async function members() {
  const { owner } = await openTrip();
  // (d) a participant, in a browser context of their own, sees no grip but has the switch.
  const { page: member, context: memberContext, joined } = await joinAs("participant"); assert.equal(joined.includes("本人確認"), false);
  // A participant hands out no invite, so has no 共有・管理.
  assert.equal(await member.evaluate(`!!document.querySelector('[data-action="manage"]')`), false);
  // (d2) 足あと: the participant and then the owner press 「ここにいる」 where they are; the list grows one at a time, oldest first.
  // The map's parts (src/map.ts) are not fetched on the pages before the footprints page; the first opening of it fetches them.
  const mapFetched = (p: typeof owner) => p!.requests().some(u => new URL(u).pathname === "/map.js");
  assert.equal(mapFetched(member), false, "the map's script was fetched before the footprints page was shown");
  await locate(member, "granted", memberContext, 35.6812, 139.7671); await footprintsTab(member);
  // The template's trip has the trip-map page, which is the footprints page: no second 足あと tab (#583).
  assert.equal(await member.evaluate(`!!document.querySelector('[data-action="tab"][data-tab=":footprints"]')`), false);
  assert.equal(await member.evaluate(`document.querySelector(".empty")?.textContent`), "まだ足あとはありません。");
  await stepHere(member, 1); assert.equal(await member.evaluate(message), "足あとを残しました。");
  // The participant leaves their page on the story (#440) while the owner presses.
  await member.evaluate(`document.querySelector('[data-action="tab"][data-tab="story"]').click()`); await member.until(`!!document.querySelector(".story .row")`);
  assert.equal(mapFetched(owner), false, "the map's script was fetched before the footprints page was shown");
  await locate(owner, "granted", undefined, 35.6586, 139.7454); await footprintsTab(owner); await stepHere(owner, 2);
  const stepped = await owner.evaluate(footprintRows) as string[]; assert.equal(stepped[1], "オーナー"); assert.notEqual(stepped[0], "オーナー");
  assert.match(await owner.evaluate(`document.querySelector("[data-footprint] a").href`), /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=35\.6812%2C139\.7671$/);
  assert.equal(await owner.evaluate(`document.querySelector("[data-footprint] a").target`), "_blank");
  // The participant's page, left open, shows the owner's point at its next 20-second refresh (footprints move no revision): on the
  // story, and then on the footprints.
  await member.until(`document.querySelectorAll(".story .unplanned").length > 0 && [...document.querySelectorAll(".story .row")].some(r => r.textContent.includes("オーナー"))`, 25000); await footprintsTab(member);
  await member.until(`document.querySelectorAll("[data-footprint]").length === 2`, 25000); assert.deepEqual(await member.evaluate(footprintRows), stepped);
  // 消す: a participant on their own point only; the owner on every point.
  assert.deepEqual(await member.evaluate(removable), [true, false]); assert.deepEqual(await owner.evaluate(removable), [true, true]);
  // (d2b) 旅の記録 (#440), the story page the template puts in: the participant's point (東京駅) is the record of the plan going on
  // when it was pressed, and the owner's (東京タワー, about 3 km on) is a place no plan covers, before the first plan that starts
  // later; before 09:00 both are. The plans without a point read their time and title. At 375px nothing runs off the side.
  // The day's plans as the scenes above left them (moved, added, retimed), in the itinerary's order, and the two points.
  const v = await opened(owner), now = { items: (v.document.items as typeof seed.document.items).filter(i => i.day === day && i.status !== "cancelled"), at: v.footprints.map(f => f.at) };
  const pressed = now.at.map(t => +new Date(t));
  const hm = (t: number | string) => new Intl.DateTimeFormat("ja", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit" }).format(new Date(t));
  // Each point is the record of the plan going on (the last started), unless none has started, that plan has ended or it has one
  // already (the other is 3 km off).
  const plans = now.items, starts = (i: typeof plans[number]) => i.startsAt ? +new Date(i.startsAt) : Infinity, recorded = new Map<string, number>(), loose: number[] = [];
  for (const k of [0, 1]) { const under = plans.filter(i => starts(i) <= pressed[k]!).at(-1); if (under && !(under.endsAt && +new Date(under.endsAt) < pressed[k]!) && !recorded.has(under.id)) recorded.set(under.id, k); else loose.push(k); }
  const planned = (i: typeof plans[number]) => i.startsAt ? `${hm(i.startsAt)}${i.timeTentative ? " ごろ" : ""}` : "時間未定";
  const unplanned = (k: number) => ["row unplanned", `${hm(pressed[k]!)}予定になかったところ · ${stepped[k]}地図 ↗`], slot = (k: number) => plans.findIndex(i => starts(i) > pressed[k]!);
  const expected = [...plans.flatMap((i, n) => [...loose.filter(k => slot(k) === n).map(unplanned),
    recorded.has(i.id) ? ["row", `予定 ${planned(i)} / 記録 ${hm(pressed[recorded.get(i.id)!]!)}${i.title}`] : ["row plan-only", `${planned(i)}${i.title}`]]), ...loose.filter(k => slot(k) < 0).map(unplanned)];
  await tabTo(owner, "story", ".story .row");
  assert.deepEqual(await owner.evaluate(`[...document.querySelectorAll(".story")[0].querySelectorAll(".row")].map(r => [r.className, r.textContent])`), expected);
  assert.equal(await owner.evaluate(`document.querySelector(".story .unplanned a").target`), "_blank");
  assert.equal(await owner.evaluate(`document.querySelector(".content").textContent.includes("まだ足あとがありません")`), false);
  await owner.size(375, 812, true); assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the story runs off the side of a 375px screen"); await owner.size(390, 844, true);
  // Opened after the trip (the host's answer saying reflection, as the clock cannot be moved), the trip opens on its story; during
  // it, on the itinerary. Chosen once: after a press of the 旅程 tab, a reload keeps the 旅程.
  const ended = await owner.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `const real = window.fetch; window.fetch = async (...a) => { const r = await real(...a); if (!String(a[0]).split("?")[0].endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "reflection" }); };` });
  await owner.reload(); assert.equal(await owner.evaluate(shownTab), "story");
  await tabTo(owner, "days", ".timeline, .timeline-list"); await owner.evaluate(`document.querySelector('[data-action="reload"]').click()`); await owner.until(`${message} === "最新の内容を読み込みました。"`); assert.equal(await owner.evaluate(shownTab), "days");
  await owner.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: ended.identifier });
  await owner.reload(); assert.equal(await owner.evaluate(shownTab), "days");
  // (d3) 旅の足あと (#439), the trip-map page the template puts in: the two points (東京駅 and 東京タワー) are two dots, the page
  // says the lines are not the way taken, narrowed to the owner one dot is left, and its line in the list opens when, who, the
  // item going on then (when there is one) and the map in a new tab. At 375px nothing runs off the side.
  // Once the map is shown every request stays on this origin: the tiles, the worker, the stylesheet. The dots are MapLibre's
  // markers over its canvas, and the map says whose data it draws.
  await tabTo(owner, "map", ".trip-map .spot"); await owner.until(`${spots} === 2`);
  await owner.until(`!!document.querySelector(".trip-map .maplibregl-canvas") && (document.querySelector(".trip-map .maplibregl-ctrl-attrib")?.textContent ?? "").includes("© OpenStreetMap contributors")`);
  // The credit is a link to OpenStreetMap's copyright and licence page, opened in a new tab (#841).
  const credit = `document.querySelector('.trip-map .maplibregl-ctrl-attrib a[href="https://www.openstreetmap.org/copyright"]')`;
  assert.deepEqual(await owner.evaluate(`[${credit}?.textContent, ${credit}?.target, ${credit}?.relList.contains("noopener")]`), ["© OpenStreetMap contributors", "_blank", true]);
  await sleep(1000); const asked = owner.requests().filter(u => /^https?:/.test(u));
  assert.equal(asked.some(u => new URL(u).pathname === "/map.js"), true); assert.deepEqual(asked.filter(u => new URL(u).origin !== origin), [], "the map asked another origin");
  // The map files are the ones map/regions.json lists (#564): every one of them is asked for, and no other under /map/.
  const record = await fetch(origin + "/map/regions.json").then(r => r.ok ? r.json() : { files: [] }) as { files: { name: string }[] };
  // They are asked once the record has come, which may be after the canvas is up: wait for them (up to 10 s), then compare.
  const mapFiles = () => [...new Set(owner!.requests().map(u => new URL(u).pathname).filter(p => p.startsWith("/map/")))].sort();
  const recordFiles = ["/map/regions.json", ...record.files.map(f => `/map/${f.name}.pmtiles`)].sort();
  for (const end = Date.now() + 10000; Date.now() < end && mapFiles().join() !== recordFiles.join();) await sleep(200);
  assert.deepEqual(mapFiles(), recordFiles, "the map asked other files than the record lists");
  assert.equal(await owner.evaluate(`document.querySelector(".content").textContent.includes("実際に通った道ではありません")`), true);
  // (d3b) A map zoomed in keeps where it looks (#574): the owner double-clicks the map; the participant leaves a third point (浅草寺,
  // a minute after their first, the seat's limit) and the owner's page, redrawn at its 20-second refresh with three dots, still
  // looks at the same centre and zoom; taken out again, the same. The map writes where it looks on [data-map] (src/map.ts).
  const camera = `(({ center, zoom }) => [center, zoom])(document.querySelector("[data-map]").dataset)`;
  await owner.until(`!!document.querySelector("[data-map]").dataset.zoom`); const fitted = (await owner.evaluate(camera) as string[])[1]!;
  await owner.evaluate(`(() => { const c = document.querySelector(".trip-map .maplibregl-canvas"), r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return true; })()`);
  await owner.until(`+document.querySelector("[data-map]").dataset.zoom > ${fitted}`); await sleep(500); const zoomed = await owner.evaluate(camera);
  await advance(Math.max(0, pressed[0]! + 61000 - await hostNow())); await locate(member, "granted", memberContext, 35.7148, 139.7967); await stepHere(member, 3);
  await owner.until(`${spots} === 3 && !!document.querySelector("[data-map]").dataset.zoom`, 25000);
  assert.deepEqual(await owner.evaluate(camera), zoomed, "the map went back to all the points when another member's point came");
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelectorAll('[data-footprint]')[2].querySelector('[data-action="remove-footprint"]').click(); return true; })()`);
  await member.until(`document.querySelectorAll("[data-footprint]").length === 2`); await locate(member, "granted", memberContext, 35.6812, 139.7671);
  await owner.until(`${spots} === 2 && !!document.querySelector("[data-map]").dataset.zoom`, 25000);
  assert.deepEqual(await owner.evaluate(camera), zoomed, "the map went back to all the points when another member's point was taken out");
  await owner.evaluate(`document.querySelector('[data-action="map-by"][data-value="オーナー"]').click()`); await owner.until(`${spots} === 1`);
  // Narrowed, the map fits its points again: the owner's one point (東京タワー) at the closest zoom, not where it was zoomed in (#574).
  await owner.until(`!!document.querySelector("[data-map]").dataset.zoom`); assert.deepEqual(await owner.evaluate(camera), ["139.74540,35.65860", "15.00"]);
  // The filter narrows the rows under the map too (review on #586).
  assert.deepEqual(await owner.evaluate(footprintRows), ["オーナー"]);
  await owner.evaluate(`document.querySelector('.trip-map .spot').dispatchEvent(new MouseEvent("click", { bubbles: true }))`); await owner.until(`!!document.querySelector("#dialog [data-spot]")`);
  const seen = await opened(owner), at = +new Date((seen.footprints as Array<{ at: string; by: string }>).find(f => f.by === "オーナー")!.at);
  const going = (seen.document.items as typeof seed.document.items).filter(i => i.day === day && i.status !== "cancelled" && i.startsAt && +new Date(i.startsAt) <= at).sort((a, b) => +new Date(a.startsAt!) - +new Date(b.startsAt!)).at(-1), goingOn = going ? "予定: " + going.title : null;
  assert.deepEqual(await owner.evaluate(`(() => { const r = document.querySelector("#dialog [data-spot]"), small = [...r.querySelectorAll("small")].map(s => s.textContent); return [r.querySelector("strong").textContent, /\\d{2}:\\d{2}$/.test(small[0]), small[1] ?? null, r.querySelector("a").textContent, r.querySelector("a").target]; })()`), ["オーナー", true, goingOn, "地図 ↗", "_blank"]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.size(375, 812, true); assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the footprint map runs off the side of a 375px screen");
  await owner.evaluate(`document.querySelector('[data-action="map-by"][data-value=""]').click()`); await owner.until(`${spots} === 2`); await owner.size(390, 844, true);
  // A trip with no footprint yet (a new one, taken in on the top page and not published) has the map page, which says how to leave one.
  const fresh = await page(375, 812, true), freshFile = join(profile, "fresh.json"); writeFileSync(freshFile, JSON.stringify(testTrip(day)));
  await fresh.cdp("Page.navigate", { url: origin + "/" }); await fresh.until(`!!document.querySelector('[data-import="trip"]')`);
  { const { root } = await fresh.cdp("DOM.getDocument"), { nodeId } = await fresh.cdp("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-import="trip"]' }); await fresh.cdp("DOM.setFileInputFiles", { nodeId, files: [freshFile] }); }
  await fresh.until(`!!document.querySelector('[data-action="tab"][data-tab="map"]')`); await fresh.evaluate(`document.querySelector('[data-action="tab"][data-tab="map"]').click()`); await fresh.until(`!!document.querySelector(".content .empty")`);
  assert.deepEqual(await fresh.evaluate(`[document.querySelector(".content .empty").textContent, document.querySelector(".content").textContent.includes("「ここにいる」を押すと"), document.querySelectorAll(".trip-map").length, document.documentElement.scrollWidth <= 375]`), ["まだ足あとはありません。", true, 0, true]);
  // Its story, with no point yet: the plans only, and how to leave one.
  await fresh.evaluate(`document.querySelector('[data-action="tab"][data-tab="story"]').click()`); await fresh.until(`!!document.querySelector(".story .row")`);
  assert.deepEqual(await fresh.evaluate(`[[...document.querySelectorAll(".story .row")].every(r => r.classList.contains("plan-only")), document.querySelector(".content").textContent.includes("まだ足あとがありません。旅行期間中に足あとのページの『ここにいる』を押すと"), document.documentElement.scrollWidth <= 375]`), [true, true, true]);
  await fresh.close();
  for (const p of [owner, member]) await p.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click()`);
  assert.equal(await member.evaluate(`!!document.querySelector('.topbar [data-action="revise"]')`), false);
  assert.equal(await member.evaluate(`document.querySelectorAll("[data-drag], [data-item], [data-order-day], [data-action='insert-item']").length`), 0);
  await member.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await member.until(`document.querySelectorAll(".timeline-list .row").length === ${await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).document.items.filter(i => i.day === "${day}" && i.status !== "cancelled").length)()`)}`);
  assert.equal(await member.evaluate(`document.querySelectorAll("[data-drag], [data-order-day], [data-action='insert-item']").length`), 0);
  // (d5) 予定の場所 (#646): items with a position are marks of their own on the map, over the footprints. Two today and one tomorrow,
  // one cancelled (not drawn), one with no position (none). 「予定」「足あと」 switch each kind, the day narrows both.
  const placed = (id: string, title: string, at: string, extra: object = {}) => ({ id, title, day: at, kind: "activity", status: "confirmed", revision: 1, startsAt: `${at}T10:00:00+09:00`, place: { label: `${title}の場所`, lat: 35.68 + (id.length % 3) / 100, lng: 139.76 }, ...extra });
  for (const item of [placed("pl1", "地図の予定 A", day), placed("pl2", "地図の予定 B", day), placed("pl3", "地図の予定 C", day2), placed("pl4", "取り消した地図の予定", day, { status: "cancelled" }), { ...placed("pl5", "座標の無い予定", day), place: { label: "座標の無い場所" } }])
    assert.equal((await fromPage("document", { type: "item", item }, "PATCH")).status, 200);
  const marks = `document.querySelectorAll(".trip-map .plan").length`, showToggle = (kind: string) => `document.querySelector('[data-action="map-show"][data-value="${kind}"]').click()`;
  const dayButton = (d: string) => `document.querySelector('[data-action="map-day"][data-value="${d}"]').click()`;
  await owner.reload(); await tabTo(owner, "map", ".trip-map .plan"); await owner.until(`${marks} === 3`);
  assert.deepEqual(await owner.evaluate(`[${marks}, ${spots}, !!document.querySelector('[data-action="map-day"][data-value="${day2}"]')]`), [3, 2, true], "three plans (not the cancelled one nor the one without a position) over the footprints");
  await owner.evaluate(`document.querySelector('.trip-map .plan[data-plan="pl1"]').dispatchEvent(new MouseEvent("click", { bubbles: true }))`);
  await owner.until(`!!document.querySelector("#dialog [data-plan-dialog]")`);
  assert.equal(await owner.evaluate(`document.querySelector("#dialog [data-plan-dialog]").textContent.includes("地図の予定 A")`), true);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.evaluate(dayButton(day2)); await owner.until(`${marks} === 1`);
  await owner.evaluate(dayButton(day)); await owner.until(`${marks} === 2 && ${spots} === 2`);
  await owner.evaluate(dayButton("")); await owner.until(`${marks} === 3`);
  await owner.evaluate(showToggle("footprints")); await owner.until(`${spots} === 0 && ${marks} === 3`);
  await owner.evaluate(showToggle("footprints")); await owner.until(`${spots} === 2`);
  await owner.evaluate(showToggle("plans")); await owner.until(`${marks} === 0 && ${spots} === 2`);
  await owner.evaluate(showToggle("plans")); await owner.until(`${marks} === 3`);
  // The form keeps the position of a place whose name is not changed, and drops it with a new name.
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click()`); await owner.until(`!!document.querySelector('[data-action="day"][data-day="${day}"]')`);
  await owner.evaluate(`document.querySelector('[data-action="day"][data-day="${day}"]').click()`); await owner.until(`!!document.querySelector('[data-action="timeline-view"][data-view="detail"]')`);
  await owner.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`); await owner.until(`!!document.querySelector('[data-action="edit-item"][data-id="pl1"]')`);
  const placeOf = async (id: string) => (await opened(owner!)).document.items.find((i: { id: string }) => i.id === id).place;
  const kept = await placeOf("pl1") as { label: string; lat: number; lng: number };
  await edit("pl1"); await owner.evaluate(`(() => { document.querySelector('#dialog textarea[name="description"]').value = "メモだけ直した"; ${submit}; })()`);
  await owner.until(`!document.querySelector("#dialog[open]")`);
  assert.deepEqual(await placeOf("pl1"), kept, "the position stays when only the memo changed");
  await edit("pl1"); await owner.evaluate(`(() => { document.querySelector('#dialog input[name="place"]').value = "別の場所"; ${submit}; })()`);
  await owner.until(`!document.querySelector("#dialog[open]")`);
  assert.deepEqual(await placeOf("pl1"), { label: "別の場所" }, "a new name does not keep the old position");
  // A trip with no footprint yet, but plans with a position, has the map (and no switch: there is one kind to show).
  const fresh2 = await page(375, 812, true), fresh2File = join(profile, "fresh2.json"), withPositions = testTrip(day);
  withPositions.document.items[0]!.place = { label: "架空の駅", lat: 35.68, lng: 139.76 };
  writeFileSync(fresh2File, JSON.stringify(withPositions));
  await fresh2.cdp("Page.navigate", { url: origin + "/" }); await fresh2.until(`!!document.querySelector('[data-import="trip"]')`);
  { const { root } = await fresh2.cdp("DOM.getDocument"), { nodeId } = await fresh2.cdp("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-import="trip"]' }); await fresh2.cdp("DOM.setFileInputFiles", { nodeId, files: [fresh2File] }); }
  await fresh2.until(`!!document.querySelector('[data-action="tab"][data-tab="map"]')`); await fresh2.evaluate(`document.querySelector('[data-action="tab"][data-tab="map"]').click()`); await fresh2.until(`document.querySelectorAll(".trip-map .plan").length === 1`);
  assert.deepEqual(await fresh2.evaluate(`[document.querySelectorAll(".trip-map .spot").length, !!document.querySelector('[data-action="map-show"]'), document.documentElement.scrollWidth <= 375]`), [0, true, true]);
  await fresh2.close();
  // The map's script not reached (the connection dropped; a reload, so that the script the footprints page loaded in (d2) is not
  // kept): the box says so, and the rows under it still list every footprint.
  // Not loaded (#676): the box says so with 「もう一度」, the list stays, and each press asks again under a URL of its own, so a
  // browser that keeps a failed module (Chrome up to 155) loads it too, with no page reading in between.
  await member.cdp("Network.setBlockedURLs", { urls: ["*/map.js*"] }); await member.reload(); await tabTo(member, "map", ".trip-map");
  const failed = `document.querySelector(".trip-map").textContent.startsWith("地図を読み込めませんでした。") && !!document.querySelector('.trip-map [data-action="map-retry"]')`;
  await member.until(failed);
  assert.equal(await member.evaluate(`document.querySelectorAll("[data-footprint]").length`), 2);
  for (let n = 0; n < 2; n++) {
    await member.evaluate(`window.__retry = document.querySelector('[data-action="map-retry"]'); window.__retry.click()`);
    await member.until(`${failed} && document.querySelector('[data-action="map-retry"]') !== window.__retry`);
  }
  assert.equal(await member.evaluate(`document.querySelectorAll("[data-footprint]").length`), 2);
  await member.evaluate(`window.__mapKept = 1`); await member.cdp("Network.setBlockedURLs", { urls: [] });
  await member.evaluate(`document.querySelector('[data-action="map-retry"]').click()`); await member.until(`!!document.querySelector(".trip-map canvas")`);
  assert.equal(await member.evaluate(`window.__mapKept`), 1, "the page was not read again");
  assert.equal(await member.evaluate(`document.querySelectorAll('.trip-map [data-action="map-retry"], .trip-map p').length`), 0, "the failure is gone once the map is drawn");
  assert.equal(await member.evaluate(`document.querySelectorAll("[data-footprint]").length`), 2); await member.cdp("Network.setBlockedURLs", { urls: [] });
  // …nor a way to change the checklist (ticking is theirs) or the budget.
  await tabTo(member, "check", ".checks"); assert.equal(await member.evaluate(`!!document.querySelector('[data-action="edit-checklist"]')`), false);
  await tabTo(member, "budget", `.navigation [aria-current="page"][data-tab="budget"]`); assert.equal(await member.evaluate(`!!document.querySelector('[data-action="edit-budget"]')`), false);
  // …nor 「直す」「消す」 on a 候補 they see.
  await tabTo(member, "ideas", ".two-columns"); assert.deepEqual(await member.evaluate(`[document.querySelectorAll(".two-columns article").length, document.querySelectorAll('[data-action="rewrite-post"], [data-action="remove-post"]').length]`), [seed.document.suggestions.length + seed.document.comments.length, 0]);
  // (l, continued) …but they save the trip page and the Markdown like everyone: their 旅を保存 has both and no ZIP, nothing off the side at 375px.
  await member.size(375, 812, true); await member.reload(); await openSave(member); assert.deepEqual(await member.evaluate(saveDialog), [true, true, false, [], false]);
  assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= 375`), true, "a participant's 旅を保存 runs off the side of a 375px screen");
  const { page: viewer, context: viewerContext } = await joinAs("viewer", 375, 812);
  // A viewer reads both footprints and has no 「ここにいる」.
  await footprintsTab(viewer); assert.equal(await viewer.evaluate(`!!document.querySelector('[data-action="footprint-here"]')`), false);
  assert.deepEqual(await viewer.evaluate(footprintRows), stepped);
  await viewer.close(); await dispose(viewerContext);
  // A seat leaves a point once a minute, and the participant's last (浅草寺 in (d3b), taken out) is not that old yet.
  await advance(61000);
  // (d4) at 390px, as before the groups: (l, continued) leaves the phone at 375px.
  await member.size(390, 844, true);
  // (d4) 開いたときに足あとを残す (#481), on the participant's phone (position allowed since (d2), its point there at 東京駅 minutes
  // ago). Off by default, opening leaves nothing; turned on, nothing yet. Opened again where the last point is, nothing (under 15
  // minutes and 300 m); opened 1 km off at 皇居, one point marked 自動, and opened again or shown again (visibilitychange) nothing
  // more. 消す takes it out; shown again then, one more, taken out too. Turned off while the position is on its way, nothing. With
  // the position not allowed, opening asks for nothing (no getCurrentPosition) and leaves nothing; turned off, nothing; once sharing
  // has ended, coming back sends no point. Waits of 2 s stand for "nothing happened".
  const count = `(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).footprints.length)()`;
  const autoBox = `document.querySelector('[data-action="auto-footprint"]')`;
  const stays = async (n: number) => { await sleep(2000); assert.equal(await member.evaluate(count), n); };
  await member.reload(); await footprintsTab(member); await stays(2);
  assert.deepEqual(await member.evaluate(`[${autoBox}.checked, document.querySelector(".content").textContent.includes("画面を閉じている間は残りません")]`), [false, true]);
  await member.evaluate(`${autoBox}.click()`); await member.until(`${message} === "次に旅行のページを開いた時から、足あとを自動で残します。"`);
  assert.equal(await member.evaluate(`${autoBox}.checked`), true); await stays(2);
  await member.reload(); await stays(2);
  await locate(member, "granted", memberContext, 35.6852, 139.7528); await member.reload(); await member.until(`${count}.then(n => n === 3)`);
  await footprintsTab(member);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll("[data-footprint] small")].map(s => s.textContent.endsWith(" · 自動"))`), [false, false, true]);
  assert.equal(await member.evaluate(`${autoBox}.checked`), true);
  await member.reload(); await stays(3);
  await member.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`); await stays(3);
  await footprintsTab(member); await member.evaluate(`(() => { window.confirm = () => true; document.querySelectorAll('[data-action="remove-footprint"]')[1].click(); return true; })()`);
  await member.until(`${message} === "足あとを消しました。"`); assert.equal(await member.evaluate(count), 2);
  // Taken out of the map and the rows under it alike (#583).
  await member.until(`document.querySelectorAll("[data-footprint]").length === 2 && document.querySelectorAll(".trip-map .spot").length === 2`);
  // Shown again with the point at 皇居 gone, so due: one point marked 自動, which 消す takes out again.
  await member.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`); await member.until(`${count}.then(n => n === 3)`);
  await footprintsTab(member); await member.until(`document.querySelectorAll("[data-footprint]").length === 3`);
  assert.equal(await member.evaluate(`document.querySelectorAll("[data-footprint] small")[2].textContent.endsWith(" · 自動")`), true);
  await member.evaluate(`document.querySelectorAll('[data-action="remove-footprint"]')[1].click()`);
  await member.until(`${message} === "足あとを消しました。"`); assert.equal(await member.evaluate(count), 2);
  // Turned off while the position is on its way (held back 4 s here): the fix comes back after and nothing is sent.
  const held = await member.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `const ask = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation); navigator.geolocation.getCurrentPosition = (ok, ...a) => ask(p => setTimeout(() => ok(p), 4000), ...a);` });
  await member.reload(); await footprintsTab(member); await member.evaluate(`${autoBox}.click()`); assert.equal(await member.evaluate(`${autoBox}.checked`), false);
  await sleep(3000); await stays(2);
  await member.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: held.identifier });
  await member.reload(); await footprintsTab(member); await member.evaluate(`${autoBox}.click()`); await member.until(`${message} === "次に旅行のページを開いた時から、足あとを自動で残します。"`);
  // From here every opening would be due (皇居 is 1 km from the last point), so each "nothing" is the setting's doing.
  const { identifier } = await member.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.asked = 0; const ask = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation); navigator.geolocation.getCurrentPosition = (...a) => { window.asked++; return ask(...a); };` });
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "prompt", origin, browserContextId: memberContext });
  await member.reload(); await stays(2); assert.equal(await member.evaluate(`window.asked`), 0);
  await member.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier });
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "granted", origin, browserContextId: memberContext });
  await footprintsTab(member); await member.evaluate(`${autoBox}.click()`); assert.equal(await member.evaluate(`${autoBox}.checked`), false);
  await member.reload(); await stays(2);
  await footprintsTab(member); await member.evaluate(`${autoBox}.click()`); await member.until(`${message} === "次に旅行のページを開いた時から、足あとを自動で残します。"`);
  await member.evaluate(`(() => { const real = window.fetch; window.sentPoints = 0; window.fetch = async (...a) => { if (String(a[0]).split("?")[0].endsWith("/footprints")) window.sentPoints++; const r = await real(...a); if (!String(a[0]).split("?")[0].endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "frozen" }); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`document.querySelector(".lifecycle").textContent.includes("共有終了")`);
  await member.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`); await stays(2); assert.equal(await member.evaluate(`window.sentPoints`), 0);
  // Off again for the steps below, which reload this page.
  await member.evaluate(`localStorage.removeItem("auto-footprint:${capsuleId}")`); await member.reload(); await stays(2);
  await member.close(); await dispose(memberContext);
  // (m) The editor revises the shared plan from the header, while settings stay the owner's, and can undo once.
  const { page: editor, context: editorContext, joined: editorJoined } = await joinAs("editor");
  // The editor's passkey is also the check before handing out and revoking its invites, and its join dialog says so.
  assert.equal(editorJoined.includes("編集者は、招待の発行・失効の前の本人確認にも使います。"), true);
  // An editor whose browser refuses the position: 「ここにいる」 says why and how to allow it, and nothing is left.
  await locate(editor, "denied", editorContext); await footprintsTab(editor);
  await editor.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await editor.until(`(${message} ?? "").startsWith("位置の許可がありません")`);
  assert.equal(await editor.evaluate(`document.querySelectorAll("[data-footprint]").length`), 2);
  assert.equal((await editor.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).footprints.length)()`)), 2);
  // Allowed, but the fix is 2 km off: nothing is left, and it says so.
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "granted", origin, browserContextId: editorContext });
  await editor.cdp("Emulation.setGeolocationOverride", { latitude: 35.6812, longitude: 139.7671, accuracy: 2000 });
  await editor.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await editor.until(`(${message} ?? "").startsWith("位置の精度が低い（約2.0 km）")`);
  assert.equal(await editor.evaluate(`document.querySelectorAll("[data-footprint]").length`), 2);
  // Given a good fix in 新宿, the editor leaves a third point: the map shows three dots, and narrowed to the editor one.
  await editor.cdp("Emulation.setGeolocationOverride", { latitude: 35.6896, longitude: 139.7006, accuracy: 20 }); await stepHere(editor, 3);
  // Pressed again within the minute, the host refuses it and the page says why; no point is added (src/cloud-host.ts FOOTPRINT_EVERY).
  await editor.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await editor.until(`${message} === "足あとは1分に1回までです"`);
  assert.equal(await editor.evaluate(`document.querySelectorAll("[data-footprint]").length`), 3);
  assert.equal((await editor.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).footprints.length)()`)), 3);
  const editorPoint = (await editor.evaluate(footprintRows) as string[])[2]!;
  await tabTo(editor, "map", ".trip-map .spot"); await editor.until(`${spots} === 3`);
  await editor.evaluate(`document.querySelector('[data-action="map-by"][data-value=${JSON.stringify(editorPoint)}]').click()`); await editor.until(`${spots} === 1`);
  // The owner leaves a second point 2–3 m from the first at 東京タワー (the same to 4 decimals, src/footprints.ts `spotsOf`): the owner's two points make one line, they are one
  // dot holding two ids, and that dot, pressed on the map, shows both. (Not at 東京駅: the host stamps the time,
  // and the two points can be a minute apart, which makes 3 km a 150 km/h move and cuts the line.) Narrowed to the day (every
  // point is today's) all three dots stay.
  await locate(owner, "granted", undefined, 35.65862, 139.74542); await footprintsTab(owner); await stepHere(owner, 4);
  await tabTo(owner, "map", ".trip-map .spot"); await owner.until(`${spots} === 3`);
  assert.deepEqual(await owner.evaluate(`[${spots}, document.querySelector(".trip-map").dataset.lines.split(" ").map(Number), document.querySelectorAll('.trip-map .spot[data-ids*=" "]').length]`), [3, [2], 1]);
  await owner.evaluate(`document.querySelector('.trip-map .spot[data-ids*=" "]').dispatchEvent(new MouseEvent("click", { bubbles: true }))`); await owner.until(`document.querySelectorAll("#dialog [data-spot]").length === 2`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.evaluate(`document.querySelector('[data-action="map-day"][data-value="${day}"]').click()`); await owner.until(`document.querySelector('[data-action="map-day"][data-value="${day}"]').getAttribute("aria-pressed") === "true"`);
  assert.equal(await owner.evaluate(spots), 3);
  // A point of another day: the host stamps every point with its own clock, so the page's answer is given one more, 1 km north a
  // day earlier, for this page only (the next reload drops it). The day buttons then narrow to it (one dot) and to today (three).
  const yesterday = new Date(Date.parse(`${day}T12:00:00+09:00`) - 86400000).toISOString().slice(0, 10);
  // The trip is sealed: the point and its name are sealed for the new id with the trip key, as a member's browser seals one.
  await owner.evaluate(`(async () => { ${await tripKeysCode()}
    const k = globalThis.tripKeys, id = "${capsuleId}", v = await (await vfetch("/v1/c/" + id)).json(), s = v.seatKey, p = v.footprints[0];
    const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
    const trip = await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation), at = await k.openPoint(trip, id, p.id, p.point), g = v.sealed.generation;
    window.yesterday = { point: await k.sealPoint(trip, id, g, "yesterday", { ...at, lat: at.lat + 0.01 }), by: await k.sealName(trip, id, g, "footprint", "yesterday", await k.openName(trip, id, "footprint", p.id, p.by)) };
    return true; })()`);
  await owner.evaluate(`(() => { const real = window.realFetch = window.fetch; window.fetch = async (url, init) => { const r = await real(url, init); if (String(url).split("?")[0] !== "/v1/c/${capsuleId}" || (init?.method ?? "GET") !== "GET") return r;
    const v = await r.json(), p = v.footprints[0]; v.footprints.unshift({ ...p, id: "yesterday", at: new Date(Date.parse(p.at) - 86400000).toISOString(), ...window.yesterday, mine: false });
    return new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } }); }; return true; })()`);
  await owner.evaluate(`document.querySelector('[data-action="reload"]').click()`); await owner.until(`!!document.querySelector('[data-action="map-day"][data-value="${yesterday}"]')`);
  await owner.evaluate(`document.querySelector('[data-action="map-day"][data-value=""]').click()`); await owner.until(`${spots} === 4`);
  await owner.evaluate(`document.querySelector('[data-action="map-day"][data-value="${yesterday}"]').click()`); await owner.until(`${spots} === 1`);
  assert.equal(await owner.evaluate(`document.querySelectorAll("[data-footprint]").length`), 1);
  await owner.evaluate(`document.querySelector('[data-action="map-day"][data-value="${day}"]').click()`); await owner.until(`${spots} === 3`);
  assert.equal(await owner.evaluate(`document.querySelectorAll("[data-footprint]").length`), 4);
  // A narrowing whose points are gone is dropped by the page, and the map fits again (#574 review on #602): narrowed to the other
  // day (one dot, at the closest zoom) and zoomed out with shift and a double click, the page reads the host's answer as it is
  // (no such point) and draws all three dots as it fits them.
  await owner.until(`!!document.querySelector("[data-map]").dataset.zoom`); const fitAll = await owner.evaluate(camera);
  await owner.evaluate(`document.querySelector('[data-action="map-day"][data-value="${yesterday}"]').click()`); await owner.until(`${spots} === 1 && !!document.querySelector("[data-map]").dataset.zoom`);
  const day1 = (await owner.evaluate(camera) as string[])[1]!;
  await owner.evaluate(`(() => { const c = document.querySelector(".trip-map .maplibregl-canvas"), r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, shiftKey: true })); return true; })()`);
  await owner.until(`+document.querySelector("[data-map]").dataset.zoom < ${day1}`); await sleep(500);
  await owner.evaluate(`(() => { window.fetch = window.realFetch; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await owner.until(`!document.querySelector('[data-action="map-day"][data-value="${yesterday}"]') && ${spots} === 3 && !!document.querySelector("[data-map]").dataset.zoom`);
  assert.deepEqual(await owner.evaluate(camera), fitAll, "the map kept where it looked when the page dropped a narrowing whose points were gone");
  // With showTrack false (a change of the Spec, inside the owner's passkey check's five minutes) the same points draw no line,
  // and the note no longer speaks of lines.
  // The checks above and the handoff before them take most of the five minutes: a new check (one more invite) starts another five.
  if (await hostNow() - checkedAt > 200000) { await owner.evaluate(answerYes); await invite(); checkedAt = await hostNow(); }
  await setSpec(spec => { spec.modules.find((m: any) => m.id === "map").showTrack = false; }); await owner.reload(); await tabTo(owner, "map", ".trip-map .spot"); await owner.until(`${spots} === 3`);
  assert.deepEqual(await owner.evaluate(`[${spots}, document.querySelector(".trip-map").dataset.lines, document.querySelector(".content").textContent.includes("実際に通った道")]`), [3, "", false]);
  await setSpec(spec => { spec.modules.find((m: any) => m.id === "map").showTrack = true; }); await owner.reload();
  // A trip without the trip-map page (one made before #439 has none in its Spec) shows the same map on its 足あと page, over the
  // list. A page cannot be taken out of a Spec (src/cloud-host.ts), so here it is taken out of the navigation, which the page reads.
  await setSpec(spec => { spec.navigation = spec.navigation.filter((n: string) => n !== "map"); }); await owner.reload();
  await footprintsTab(owner); await owner.until(`document.querySelectorAll(".content .trip-map .spot").length === 3 && !!document.querySelector(".trip-map .maplibregl-canvas")`);
  assert.deepEqual(await owner.evaluate(`[!!document.querySelector('[data-action="tab"][data-tab="map"]'), document.querySelectorAll("[data-footprint]").length]`), [false, 4]);
  await setSpec(spec => { spec.navigation.splice(spec.navigation.indexOf("memories"), 0, "map"); }); await owner.reload();
  await editor.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click()`);
  const editorCounts = await editor.evaluate(entryCounts); assert.equal(editorCounts[0], 1); assert.equal(editorCounts[1], 1); assert.ok(editorCounts[2] > 0); assert.equal(editorCounts[2], editorCounts[3]);
  for (const width of [320, 375]) { await editor.size(width, 812, true); assert.equal(await editor.evaluate(headingTargets), true); assert.equal(await editor.evaluate(compact), true); }

  assert.equal(await editor.evaluate(`!!document.querySelector('.topbar [data-action="revise"]')`), true);
  await editor.evaluate(`document.querySelector('.topbar [data-action="revise"]').click()`);
  await editor.until(`document.querySelector("#dialog").open`);
  assert.equal(await editor.evaluate(`[...document.querySelectorAll("#dialog p")].some(p => p.textContent === "編集者が直せるのは予定・候補・相談・準備リスト・メモ・費用メモです。題・日程・期限・ページなどの設定は今のまま残ります。")`), true);
  assert.equal(await editor.evaluate(`!!document.querySelector('#dialog [data-action="undo"]')`), false);
  // 自分の API キーで、ここで直す (#658): without a key of the editor's own, the dialog asks for one and does not offer to revise;
  // a key of the wrong shape changes nothing (a well-formed one would ask Anthropic, and the passkey check's five minutes are short).
  // The trip is sealed, so the browser checks the key's shape itself and says so in the dialog.
  assert.equal(await editor.evaluate(`!!document.querySelector('#dialog form[data-form="revise-key"]') && !document.querySelector('#dialog [data-action="revise-assist"]')`), true);
  await editor.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="revise-key"]'); f.elements.key.value = "sk-ant-x"; f.requestSubmit(); return true; })()`);
  await editor.until(`document.querySelector("#dialog").textContent.includes("この API キーは使えません")`);
  assert.equal(await editor.evaluate(`!!document.querySelector('#dialog [data-action="revise-assist"]')`), false);
  const current = await opened(editor);
  const answer = revisable(current.spec, current.document), first = answer.document.items.find(i => i.id === "one")!;
  const originalStart = first.startsAt!;
  first.startsAt = new Date(Date.parse(originalStart) + 30 * 60000).toISOString();
  answer.spec.title = "別の題";
  const editorReply = "```json\n" + JSON.stringify(answer) + "\n```";
  await editor.evaluate(`(() => { document.querySelector("#dialog [data-revise-paste]").value = ${JSON.stringify(editorReply)}; document.querySelector('#dialog [data-action="revise-check"]').click(); })()`);
  await editor.until(`!!document.querySelector('.revise-diff form[data-form="revise"]')`);
  assert.equal(await editor.evaluate(`[...document.querySelectorAll(".revise-diff .diff strong")].some(s => s.textContent === "題")`), false);
  assert.equal(await editor.evaluate(`document.querySelector(".revise-diff").textContent.includes("一番目の予定")`), true);
  await editor.evaluate(`(() => { const f = document.querySelector('.revise-diff form[data-form="revise"]'); f.querySelector('input[type="checkbox"]').checked = true; f.requestSubmit(); })()`);
  await editor.until(`${message} === "反映しました。「チャットで直す」から 1 つ前に戻せます。"`);
  const editorState = async () => { const v = await opened(editor); return [v.spec.title, v.document.items.find((i: { id: string }) => i.id === "one").startsAt]; };
  assert.deepEqual(await editorState(), [title, first.startsAt]);
  await editor.evaluate(`document.querySelector('.topbar [data-action="revise"]').click()`);
  await editor.until(`!!document.querySelector('#dialog [data-action="undo"]')`);
  assert.equal(await editor.evaluate(`document.querySelector('#dialog [data-action="undo"]').textContent`), "1 つ前に戻す");
  await editor.evaluate(`document.querySelector('#dialog [data-action="undo"]').click()`);
  await editor.until(`!!document.querySelector('#dialog form[data-form="undo"]')`);
  await editor.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="undo"]'); f.querySelector('input[type="checkbox"]').checked = true; f.requestSubmit(); })()`);
  await editor.until(`${message} === "1 つ前に戻しました。"`);
  assert.deepEqual(await editorState(), [title, originalStart]);
  // (m, continued) 共有・管理 for the editor (#200): its own invites, 閲覧者 the only role, none of the owner's actions or history.
  // Its first invite registers the editor's passkey (its own authenticator answers, yes to the confirm); the owner's dialog then
  // says who handed that invite out, and the editor revokes it.
  await editor.cdp("WebAuthn.enable"); await editor.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  const editorInvite = `[...document.querySelectorAll("#dialog .grant")].find(g => g.querySelector("strong")?.textContent === "編集者の招待確認")`;
  const editorManage = async () => { await editor.evaluate(`document.querySelector('[data-action="manage"]').click()`); await editor.until(`!!document.querySelector('#dialog form[data-form="grant"]')`); };
  await editor.evaluate(`window.confirm = () => true`); await editorManage();
  assert.deepEqual(await editor.evaluate(`[...document.querySelectorAll('#dialog select[name="role"] option')].map(o => o.value)`), ["viewer"]);
  assert.equal(await editor.evaluate(`!!document.querySelector('#dialog details.history, #dialog .admin-actions, #dialog [data-action="rename-member"]')`), false);
  await editor.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="grant"]'); f.elements.namedItem("label").value = "編集者の招待確認"; f.requestSubmit(); return true; })()`);
  await editor.until(`!!document.querySelector("#issued-link")`); await editor.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await editorManage(); assert.deepEqual(await editor.evaluate(`[...document.querySelectorAll("#dialog .grant strong")].map(s => s.textContent)`), ["編集者の招待確認"]);
  const issuer = await editor.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}/grants")).json())[0].issuedBy)()`) as { id: string; label: string };
  const editorName = await openedName(editor, "member", issuer.id, issuer.label);
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector("#dialog details.history")`);
  assert.equal(await owner.evaluate(`${editorInvite}.textContent.includes(${JSON.stringify(`発行: ${editorName}`)})`), true);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  // A revoked invite leaves the list: the host drops revoked grants from what it keeps.
  await editor.evaluate(`${editorInvite}.querySelector('[data-action="revoke"]').click()`); await editor.until(`!!document.querySelector('#dialog form[data-form="grant"]') && !${editorInvite}`);
  await editor.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await editor.close();
  // (j2) The <geolocation> element (#675, #760), on a page of the editor's browser that has it (Chrome 153 does; the pages above had
  // it taken away and ran the button). Allowed: the page keeps the button (the element is there, hidden) and it leaves a point.
  // Refused: opening the page shows the element in the button's place and how to allow it again without asking, and turning the
  // switch on says the same and leaves the switch off. Allowed again, the button is back without opening the page again.
  const element = await page(1000, 900, false, editorContext, true);
  const toFootprints = async () => { await element.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` }); await element.until(`!!document.querySelector(".timeline, .timeline-list")`); await footprintsTab(element); await element.until(`!!document.querySelector("geolocation")`); };
  const shown = (button: boolean) => element.until(`JSON.stringify(["[data-geo-button]", "[data-geo-place]", "[data-geo-denied]"].map(s => !document.querySelector(s).hidden)) === '${JSON.stringify([button, !button, !button])}'`);
  await element.cdp("Emulation.setGeolocationOverride", { latitude: 35.6896, longitude: 139.7006, accuracy: 20 });
  await advance(61000);   // A seat leaves a point once a minute, and the editor's last is not that old yet.
  await toFootprints(); await shown(true); const rows = await element.evaluate(`document.querySelectorAll("[data-footprint]").length`) as number;
  await element.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await element.until(`document.querySelectorAll("[data-footprint]").length === ${rows + 1}`);
  await element.until(`${message} === "足あとを残しました。"`);
  await element.evaluate(`(() => { window.confirm = () => true; [...document.querySelectorAll('[data-action="remove-footprint"]')].at(-1).click(); return true; })()`); await element.until(`document.querySelectorAll("[data-footprint]").length === ${rows}`);
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "denied", origin, browserContextId: editorContext });
  await element.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.asked = 0; const ask = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation); navigator.geolocation.getCurrentPosition = (...a) => { window.asked++; return ask(...a); };` });
  await toFootprints(); await shown(false);
  assert.deepEqual(await element.evaluate(`[window.asked, document.querySelector("[data-geo-denied]").textContent]`), [0, "位置の許可がありません。「ここにいる」の横の位置のボタンを押して、許可し直してください。"]);
  await element.evaluate(`document.querySelector('[data-action="auto-footprint"]').click()`); await element.until(`(${message} ?? "").startsWith("位置の許可がありません。「ここにいる」の横の位置のボタンを押して")`);
  assert.deepEqual(await element.evaluate(`[document.querySelector('[data-action="auto-footprint"]').checked, document.querySelectorAll("[data-footprint]").length]`), [false, rows]);
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "granted", origin, browserContextId: editorContext });
  await shown(true);
  await element.close(); await dispose(editorContext);
  console.log("Members verification passed: 足あと (a participant and the owner press ここにいる and both read the two points, oldest first, the map in a new tab; 開いたときに足あとを残す off by default, on for the participant's phone: one point marked 自動 on opening 1 km from the last, none under 15 minutes and 300 m, one more on showing again once due, none on showing again too soon, without the permission (nothing asked), turned off (even while the position is on its way) or once sharing has ended; a viewer reads them without the button; an editor refused the position, or given one 2 km off, is told why and leaves nothing; 消す on one's own point only, the owner's on every point; an open page redrawn with another's point), 旅の足あと (the points as dots over the host's own map (MapLibre's canvas and the OpenStreetMap credit linking to its copyright page; its script not fetched before the map is shown, and nothing asked of another origin), two and then three, zoomed in and kept so while another member's point comes and goes, fitted again when narrowed, narrowed to one member and to the day, one member's line, a dot of two points pressed on the map, a dot's footprints with the time, the item going on and the map, the note that the lines are not the way taken, nothing off the side at 375px, a trip with no footprint saying how to leave one, and a trip without the map page showing the map on 足あと), the editor's header チャットで直す (scope note, no title diff, apply and undo), no such header entry for a participant, the editor's 共有・管理 (viewer invites only, one issued and revoked, the owner seeing who handed it out) and none for a participant, no shared insertion target, grip, list form or 「直す」「消す」 for a participant.");
}
async function seat() {
  const { owner } = await openTrip();
  const { page: member, context: memberContext } = await joinAs("participant", 390, 844, false);  // its key is handed over below
  // (d) #689: a seat that is not the owner's holds no key yet: the page says it waits, and the sealed plan does not open without it.
  assert.deepEqual(await member.evaluate(`[document.querySelector('[data-trip-key]')?.dataset.tripKey, document.querySelector('[data-trip-key]')?.textContent, !!document.querySelector(".timeline, .timeline-list")]`), ["waiting", "鍵を待っています。鍵を持つメンバーと確認コードを伝え合うと受け取れます", false]);
  // (d2) #690: the confirmation-code handoff between two browsers (docs/ephemeral-trip-capsule.md「5.1 旅行の鍵と受け渡し」). The participant presses
  // 鍵を受け取る, the owner sees the seat waiting and presses 渡す. A wrong code puts nothing on the seat and says so; trying
  // again changes the commitment; then each types the other's code and the participant opens the plan with the key.
  const wrongCode = "確認コードが違います。もう一度やり直してください";
  const seatJson = (b: NonNullable<typeof owner>) => b.evaluate(`(async () => await (await vfetch("/v1/c/${capsuleId}")).json())()`) as Promise<any>;
  // Both screens show their code; on a timeout, what the other screen shows too.
  const bothShowCodes = async () => { for (const [b, other] of [[owner!, member], [member, owner!]] as const) await b.until(`!!document.querySelector("#dialog [data-handoff-own]")`, 20000).catch(async err => { throw new Error(`${(err as Error).message} | the other screen: ${await other.evaluate(`document.querySelector("#dialog")?.open ? document.querySelector("#dialog").innerText : "(no dialog)"`)}`); }); };
  await member.evaluate(`document.querySelector('[data-action="receive-key"]').click()`);
  await owner.evaluate(`(window.stale = true, location.reload())`); await owner.until(`!window.stale && !!document.querySelector("[data-handoff-waiting]")`, 20000);  // not the old page, which may already show the seat
  assert.equal(await owner.evaluate(`document.querySelector("[data-handoff-waiting]").textContent.endsWith("が鍵を待っています")`), true);
  const waitingId = await owner.evaluate(`document.querySelector("[data-handoff-waiting]").dataset.handoffWaiting`) as string;
  const firstCommitment = ((await seatJson(owner)).waiting.find((w: any) => w.id === waitingId).handoff.commitment) as string;
  assert.match(firstCommitment, /^[A-Za-z0-9_-]{43}$/);
  await owner.evaluate(`document.querySelector('footer [data-action="give-key"]').click()`);
  await bothShowCodes();
  const [giverCode, memberCode] = [await ownCode(owner), await ownCode(member)];
  assert.match(giverCode, /^\d{6}$/); assert.match(memberCode, /^\d{6}$/);
  // The dialog tells that the code is no secret, asks to type the other's, and has no button that says it matches.
  for (const b of [owner, member]) {
    const dialogText = await b.evaluate(`document.querySelector("#dialog").innerText`) as string;
    assert.equal(dialogText.includes("このコードは秘密ではありません。旅行の連絡に使っているチャット（LINE など）に貼るか、口頭で伝えてください。"), true);
    assert.equal(dialogText.includes("相手の画面に出ているコードを聞いて、下に入力してください。"), true);
    assert.equal(await b.evaluate(`[...document.querySelectorAll("#dialog button")].some(x => /一致/.test(x.textContent))`), false);
  }
  await typeCode(owner, memberCode === "000000" ? "000001" : "000000");  // a wrong code from the giver
  await owner.until(`document.querySelector("#dialog").textContent.includes(${JSON.stringify(wrongCode)})`, 20000);
  assert.equal((await seatJson(member)).seatKey, null, "a key was put on the seat after a wrong code");
  // The participant, told nothing came, tries again: a new attempt and a new commitment.
  await member.evaluate(`document.querySelector("#dialog").close()`);
  await member.evaluate(`document.querySelector('[data-action="receive-key"]').click()`);
  await owner.until(`!!document.querySelector('#dialog [data-action="give-key"]')`);
  let secondCommitment = firstCommitment;
  for (let i = 0; i < 20 && secondCommitment === firstCommitment; i++) { await new Promise(r => setTimeout(r, 500)); secondCommitment = (await seatJson(owner)).waiting.find((w: any) => w.id === waitingId).handoff?.commitment ?? firstCommitment; }
  assert.notEqual(secondCommitment, firstCommitment);
  await owner.evaluate(`document.querySelector('#dialog [data-action="give-key"]').click()`);
  await bothShowCodes();
  const [giver2, member2] = [await ownCode(owner), await ownCode(member)];
  await typeCode(owner, member2); await typeCode(member, giver2);
  await member.until(`!!document.querySelector('[data-trip-key="held"]')`, 30000);
  const got = await seatJson(member);
  assert.match(got.seatKey.wrapped, /^v1\./); assert.equal(got.seatKey.edges.length, 1);
  assert.equal(got.handoff, null);
  const gave = await seatJson(owner);
  assert.equal(gave.seatKey.edges.some((x: any) => x.seat === waitingId), true);
  assert.equal(await member.evaluate(`!!document.querySelector(".timeline, .timeline-list")`), true);
  // The plan opened with the key: (n) and (m), on it.
  // (n) reads the day's lines in リスト, the participant's choice (kept by the page) as (d) makes it in members.
  await member.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await member.until(`!!document.querySelector(".timeline-list")`);
  // (m) ログアウト: the participant adds a passkey from the footer (their own virtual authenticator answers), signs out from the
  // footer after a confirm() saying the passkey brings them back, and lands on the top page with the trip gone from its list.
  // Opening the trip again says why it cannot be opened, and 「パスキーで戻る」 returns this browser to the same seat.
  await member.cdp("WebAuthn.enable"); const { authenticatorId: memberAuthenticator } = await member.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  // The confirm() is answered yes and kept in sessionStorage: signing out leaves the page before it could be read here.
  const answerAndKeep = `(() => { window.confirm = m => { sessionStorage.setItem("asked", m); return true; }; return true; })()`;
  await member.evaluate(answerAndKeep); await member.evaluate(`document.querySelector('footer [data-action="passkey-register"]').click()`);
  await member.until(`(${message} ?? "").startsWith("パスキーを登録しました")`);
  // The check before important actions is the owner's only, so the participant's notice does not mention it.
  assert.equal((await member.evaluate(message) as string).includes("本人確認"), false);
  await member.evaluate(answerAndKeep); await member.evaluate(`document.querySelector('footer [data-action="signout"]').click()`);
  await member.until(`location.pathname === "/" && !!document.querySelector("main .content h1")`);
  assert.equal(await member.evaluate(`sessionStorage.getItem("asked")`), "この端末からログアウトしますか？登録したパスキーで、この旅行の「パスキーで戻る」から戻れます。");
  assert.equal(await member.evaluate(`!!document.querySelector('a[href="/c/${capsuleId}"]')`), false, "the trip is still listed on the top page after signing out");
  await member.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` }); await member.until(`document.querySelector("main.empty h1")?.textContent === "しおりを開けませんでした。"`);
  assert.equal(await member.evaluate(`document.querySelector("main.empty").textContent.includes("30 日使わなかったか、ログアウトしたか、失効しました。パスキーを登録していれば「パスキーで戻る」、なければオーナーに新しい招待を頼んでください。")`), true);
  await member.evaluate(`document.querySelector('[data-action="passkey-login"]').click()`); await member.until(`!!document.querySelector(".timeline, .timeline-list")`);
  assert.equal(await member.evaluate(`(async () => (await vfetch("/v1/c/${capsuleId}")).status)()`), 200);
  // (n) the participant's own plan and diary, sealed in this browser (#343). the personal plan heading asks the seat's passkey
  // (the authenticator answers, with PRF) for a memo key once and saves a plan that goes among the day's items by its time,
  // marked 自分だけ, in the list and on the cards; nothing the page sends holds the words, and a reload reads them again. A diary
  // entry is written, changed and removed; a plan keeps what its form does not show. With the memo key gone from this browser
  // and the passkey from the device, the entries say この端末では読めません and can only be removed. The owner sees none of it.
  // Personal feature notices precede every input and explain the stored protection's limits.
  const privateNotice = "試験機能です。機微な情報は入力しないでください。";
  const privateProtection = "このサービスに保存した題・本文・場所は暗号化され、同行者・オーナー・サービスの運用者には読めません。日付・時刻などは暗号化されません。機微な情報を安心して保管できることを保証するものではありません。";
  const assertPrivateNotice = async (scope: string, inputs: string, protection = true) => {
    assert.equal(await member.evaluate(`(() => { const root = document.querySelector(${JSON.stringify(scope)}), note = [...root.querySelectorAll('.warning')].find(n => n.textContent === ${JSON.stringify(privateNotice)}); return !!note && root.querySelectorAll(${JSON.stringify(inputs)}).length > 0 && [...root.querySelectorAll(${JSON.stringify(inputs)})].every(input => !!(note.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)) && ${protection} === root.textContent.includes(${JSON.stringify(privateProtection)}); })()`), true, `${scope}: personal notice must precede inputs and state the protection's limits`);
    assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, `${scope}: personal notice overflows the screen`);
  };
  assert.equal(await member.evaluate(`document.querySelector('[data-action="new-private-item"]').textContent.includes('試験機能') && document.querySelector('[data-action="revise-private"]').textContent.includes('試験機能')`), true);
  const openPrivate = async (action: string, id = "") => { await member.evaluate(`document.querySelector('#app [data-action="${action}"]${id ? `[data-id="${id}"]` : ""}').click()`); await member.until(`!!document.querySelector('#dialog form[data-form="private"]')`); await assertPrivateNotice("#dialog form", "[name=title], [name=body]"); };
  const savePrivate = async (values: Record<string, string>, kind = "item") => {
    const savedId = await member.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="private"], .diary form[data-form="private"]'); const choice = f.querySelector('input[name=kind][value=${kind}]'); if (choice.type === 'radio') choice.checked = true; f.dispatchEvent(new Event("change")); for (const [k, v] of Object.entries(${JSON.stringify(values)})) f.querySelector('[name=' + k + ']').value = v; const id = f.dataset.id; document.querySelector("#message").textContent = ""; f.requestSubmit(); return id; })()`);
    // The screen says 保存しました。 once it has read the trip again after the save (src/client.ts savePrivate): the notice is
    // emptied before sending, so the one left by the save before does not pass for this one (#924, as #838).
    await member.until(`${message} === "保存しました。" && (${JSON.stringify(kind)} !== "diary" || document.querySelector(".diary form")?.dataset.id !== ${JSON.stringify(savedId)})`, 20000);
  };
  const sending = `(() => { window.sent = []; const real = window.fetch; window.fetch = (u, o) => { if (String(u).split("?")[0].endsWith("/private")) window.sent.push(String(o?.body ?? "")); return real(u, o); }; return true; })()`;
  await member.evaluate(sending); await openPrivate("new-private-item");
  assert.equal(await member.evaluate(`document.querySelector('#dialog form[data-form="private"]').textContent.includes("同行者・オーナー・サービスの運用者には読めません。日付・時刻などは暗号化されません。機微な情報を安心して保管できることを保証するものではありません。この席のパスキーで鍵をかけます。パスキーを失うと、あなたにも読めなくなります。")`), true);
  await member.size(375, 812, true); assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the private entry form runs off the side of a 375px screen");
  await savePrivate({ time: "10:00", title: "自分だけの予定の目印", body: "自分だけの本文" });
  const sent = await member.evaluate(`window.sent`) as string[];
  assert.deepEqual(sent.map(b => JSON.parse(b).type), ["key", "put"]); assert.equal(sent.some(b => b.includes("自分だけの予定の目印") || b.includes("自分だけの本文")), false, "the page sent a private entry's words to the host");
  // Among the day's lines, right after the last shared one starting by 10:00 and before the first one after it.
  const lines = await member.evaluate(`[...document.querySelectorAll(".timeline-list .row")].map(r => [r.querySelector(".row-time").textContent.slice(0, 5), r.querySelector(".row-title").textContent])`) as [string, string][];
  const mineAt = lines.findIndex(([, t]) => t === "自分だけの予定の目印");
  assert.ok(mineAt > 0 && lines[mineAt - 1]![0] <= "10:00" && (mineAt === lines.length - 1 || lines[mineAt + 1]![0] > "10:00"), `the private plan is not in its place by time: ${JSON.stringify(lines)}`);
  assert.equal(await member.evaluate(`document.querySelectorAll(".timeline-list .row.private .badge.private").length`), 1);
  assert.equal(await member.evaluate(`document.querySelector(".row.private").textContent.includes("試験機能")`), true);
  await member.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`); await member.until(`!!document.querySelector(".timeline")`);
  assert.equal(await member.evaluate(`document.querySelectorAll(".timeline .event.private .badge.private").length`), 1);
  assert.equal(await member.evaluate(`document.querySelector(".event.private").textContent.includes("試験機能")`), true);
  assert.equal(await member.evaluate(`document.querySelectorAll(".timeline .event.private [data-drag], .timeline .event.private [data-item]").length`), 0);
  // What the host keeps is ciphertext; this browser reads it again after a reload, with no passkey asked.
  assert.equal(await member.evaluate(`(async () => JSON.stringify((await (await vfetch("/v1/c/${capsuleId}")).json()).private))()`).then((t: string) => t.includes("自分だけの予定の目印")), false);
  await member.reload(); assert.deepEqual(await member.evaluate(`[...document.querySelectorAll(".event.private h3")].map(h => h.textContent)`), ["自分だけの予定の目印"]);
  for (const width of [320, 375]) for (const display of ["list", "detail"]) {
    await member.size(width, 812, true);
    await member.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="${display}"]').click()`);
    assert.equal(await member.evaluate(compact), true, `${width}px ${display}: mixed personal/shared rows overflow`);
    assert.equal(await member.evaluate(`document.querySelectorAll('[data-action="insert-item"], [data-action="new-item"]').length`), 0);
    assert.ok(await member.evaluate(`document.querySelectorAll('[data-action="insert-private-item"]').length`) > 0);
  }
  await member.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="detail"]').click()`);

  // A position's offered time is saved without adding a position field to the personal entry.
  const firstShared = await member.evaluate(`document.querySelector('[data-action="insert-private-item"]').dataset.after`);
  await member.evaluate(`document.querySelector('[data-action="insert-private-item"][data-after="${firstShared}"]').click()`);
  const positioned = await member.evaluate(`document.querySelector('#dialog form').dataset.id`);
  const offered = await member.evaluate(`document.querySelector('#dialog [name=time]').value`);
  await savePrivate({ title: "位置からの個人予定" });
  assert.equal(await member.evaluate(`(async () => (await (await vfetch('/v1/c/${capsuleId}')).json()).private.find(p => p.id === '${positioned}').startsAt)()`), `${day}T${offered}:00+09:00`);
  await openPrivate("edit-private", positioned);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('#dialog [data-action="remove-private"]').click(); })()`);
  await member.until(`!document.querySelector('#app [data-id="${positioned}"]')`);
  // 「自分のメモを保存 ↓」 downloads a file the page made from what it opened (Chrome saves it into the profile's directory here);
  // the host has no such file to give.
  const downloads = join(profile, "downloads"), saved = join(downloads, `trip-${day}-private.md`);
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, browserContextId: memberContext });
  await member.evaluate(`document.querySelector('[data-action="save-private"]').click()`);
  for (let i = 0; i < 100 && !existsSync(saved); i++) await sleep(100);
  const file = readFileSync(saved, "utf8");
  assert.ok(file.includes("# 画面確認用（自動削除）（自分のメモ）") && file.includes("自分だけの予定の目印") && file.includes("自分だけの本文"), `the saved Markdown lacks the entry: ${file}`);
  assert.equal(await member.evaluate(`(async () => (await vfetch("/v1/c/${capsuleId}/private.md")).status)()`), 404);
  await member.reload();
  assert.equal(await member.evaluate(`document.querySelectorAll('.diary, [data-action="new-private"]').length`), 0, "the itinerary still has a diary entry point");
  const diaryTab = async () => { await member.evaluate(`document.querySelector('[data-action=tab][data-tab=memories]').click()`); await member.until(`!!document.querySelector('.diary')`); };
  const plansTab = async () => { await member.evaluate(`document.querySelector('[data-action=tab][data-tab=days]').click()`); };
  const openDiary = async (id = "") => { await diaryTab(); if (id) { await member.evaluate(`document.querySelector('.diary [data-action="edit-private"][data-id="${id}"]').click()`); await member.until(`document.querySelector('.diary form')?.dataset.id === '${id}'`); } };
  const readDiary = async (expression: string) => { await diaryTab(); const result = await member.evaluate(expression); await plansTab(); return result; };
  await openDiary(); await member.evaluate(sending);
  await assertPrivateNotice(".diary", "[name=body]");
  assert.equal(await member.evaluate(`document.querySelector(".shared-memories").textContent.includes("試験機能")`), false);
  assert.deepEqual(await member.evaluate(`[document.querySelector('.diary form [name=kind]').value, document.querySelectorAll('.diary form [name=title], .diary form [name=time], .diary form [name=author], .diary form [type=radio]').length]`), ["diary", 0]);
  assert.equal(await member.evaluate(`document.querySelector('.shared-memories').textContent.includes('この旅行のメンバーに共有します。') && document.querySelector('.diary').textContent.includes('自分だけに保存します。')`), true);
  for (const width of [320, 375]) { await member.size(width, 812, true); assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true); }
  await member.evaluate(`(() => { const f = document.querySelector('.shared-memories form'); f.querySelector('[name=author]').value = '架空メンバー'; f.querySelector('[name=body]').value = '共有する思い出の目印'; f.requestSubmit(); })()`);
  await member.until(`document.querySelector('.shared-memories').textContent.includes('共有する思い出の目印')`);
  await savePrivate({ body: "日記の目印" }, "diary");
  assert.equal(await member.evaluate(`window.sent.some(b => b.includes("日記の目印"))`), false);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll(".diary .diary-entry .entry-body")].map(x => x.textContent)`), ["日記の目印"]);
  const diaryId = await member.evaluate(`document.querySelector('.diary [data-action="edit-private"]').dataset.id`) as string;
  await openDiary(diaryId); await assertPrivateNotice(".diary", "[name=body]"); await savePrivate({ body: "書き直した日記の目印" }, "diary");
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll(".diary .diary-entry .entry-body")].map(x => x.textContent)`), ["書き直した日記の目印"]);
  assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the diary runs off the side of a 375px screen");
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('.diary [data-action="remove-private"]').click(); })()`); await member.until(`document.querySelectorAll(".diary .diary-entry").length === 0`);
  // Existing encrypted diaries with titles and places are injected without using the new form.
  const oldDiaries = `(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("capsule", 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const kept = await new Promise(ok => { const q = db.transaction("private-keys").objectStore("private-keys").get("${capsuleId}"); q.onsuccess = () => ok(q.result); }); db.close();
    const enc = t => new TextEncoder().encode(t), b64 = b => { let t = ""; for (const c of new Uint8Array(b)) t += String.fromCharCode(c); return btoa(t).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
    const codes = [];
    for (const [id, day] of [["old-diary-one", "${day}"], ["old-diary-two", "${day2}"]]) {
      const e = { id, kind: "diary", day };
      const seal = async (text, field) => { const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc([e.id, field, e.kind, e.day, undefined, undefined].join("/")) }, kept.key, enc(text))), out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return "v1." + b64(out); };
      const entry = { ...e, title: await seal("旧日記の題 " + id, "title"), body: await seal("旧日記本文 " + id, "body"), place: await seal(JSON.stringify({ label: "日記の場所" }), "place") };
      codes.push((await vfetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "put", entry }) })).status);
    }
    return codes;
  })()`;
  assert.deepEqual(await member.evaluate(oldDiaries), [200, 200]);
  console.log("Diary verification: encrypted legacy fixtures inserted");
  await owner.reload(); await owner.evaluate(`document.querySelector('[data-action=tab][data-tab=memories]').click()`);
  assert.equal(await owner.evaluate(`document.querySelectorAll('.diary-entry').length`), 0, "another member can see the injected private diaries");
  await owner.evaluate(`document.querySelector('[data-action=tab][data-tab=days]').click()`);

  // Disable shared reflection on the Host through navigation. Also exercise a valid response with no reflection module.
  const memoriesView = await opened(owner), originalMemoriesSpec = memoriesView.spec;
  const memoriesTabs = seed.spec.navigation.filter((n: string) => photosPageShown(memoriesView) || seed.spec.modules.find((m: any) => m.id === n)?.kind !== "moments").length;
  for (const missingModule of [false, true]) {
    await setSpec(spec => { spec.navigation = spec.navigation.filter((n: string) => !spec.modules.some((m: any) => m.id === n && m.kind === 'reflection')); });
    const disabledSpec = await owner.evaluate(`(async () => JSON.stringify((await (await vfetch('/v1/c/${capsuleId}')).json()).spec))()`);
    assert.equal((await fromPage("document", { type: "reflect", author: "検証", body: "投稿できない思い出" }, "PATCH")).status, 403);
    await member.reload();
    if (missingModule) {
      await member.evaluate(`(() => { window.beforeMemoriesFetch = window.fetch; window.fetch = async (...a) => { const r = await window.beforeMemoriesFetch(...a); if (!String(a[0]).split("?")[0].endsWith('/v1/c/${capsuleId}')) return r; const v = await r.json(); v.spec.modules = v.spec.modules.filter(m => m.kind !== 'reflection'); return Response.json(v); }; document.querySelector('[data-action=reload]').click(); })()`);
      await sleep(300);
    }
    // The memories tab comes back after the Spec's pages, last; the trip has a trip-map page, so no 足あと tab follows it (#583).
    // With photos off and none put up, the photos page is not shown either (#957, `pageModules` in src/client.ts).
    assert.equal(await member.evaluate(`document.querySelectorAll('.navigation [data-action=tab]').length`), memoriesTabs, "a missing memories tab was not supplemented");
    await member.evaluate(`[...document.querySelectorAll('.navigation [data-action=tab]')].at(-1).click()`);
    await member.until(`!!document.querySelector('.diary')`);
    assert.equal(await member.evaluate(`document.querySelectorAll('.shared-memories form, [data-action=include]').length`), 0, "disabled shared reflection still exposes write controls");
    assert.deepEqual(await member.evaluate(`[...document.querySelectorAll('.diary .entry-body')].map(p => p.textContent)`), ["旧日記本文 old-diary-one"]);
    await member.evaluate(`document.querySelector('.diary [data-action=edit-private][data-id=old-diary-one]').click()`);
    await member.until(`document.querySelector('.diary form')?.dataset.id === 'old-diary-one'`);
    await savePrivate({ body: "旧日記本文 old-diary-one" }, "diary");
    assert.equal(await owner.evaluate(`(async () => JSON.stringify((await (await vfetch('/v1/c/${capsuleId}')).json()).spec))()`), disabledSpec, "diary editing changed the stored Spec");
    await owner.reload(); await owner.evaluate(`[...document.querySelectorAll('.navigation [data-action=tab]')].at(-2).click()`);
    assert.equal(await owner.evaluate(`document.querySelectorAll('.shared-memories form, [data-action=include]').length`), 0, "the owner has disabled shared write controls");
    if (missingModule) await member.evaluate(`window.fetch = window.beforeMemoriesFetch`);
    await setSpec(spec => Object.assign(spec, originalMemoriesSpec));
  }
  console.log("Diary verification: hidden and absent reflection modules retain diary read/edit without changing Spec");
  await member.reload(); await member.evaluate(sending); await openDiary();
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll('.diary .entry-body')].map(p => p.textContent)`), ["旧日記本文 old-diary-one"]);
  await member.evaluate(`(() => { const s = document.querySelector('[data-diary-day]'); s.value = '${day2}'; s.dispatchEvent(new Event('change', { bubbles:true })); })()`);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll('.diary .entry-body')].map(p => p.textContent)`), ["旧日記本文 old-diary-two"]);
  await openDiary("old-diary-two");
  assert.equal(await member.evaluate(`document.querySelector('.diary form [name=body]').value`), "旧日記本文 old-diary-two");
  await member.evaluate(`document.querySelector('[data-action=cancel-diary]').click()`);
  assert.equal(await member.evaluate(`document.querySelector('.diary form [name=body]').value`), "");
  await openDiary("old-diary-two"); await savePrivate({ day, body: "編集した旧日記本文" }, "diary");
  assert.equal(await member.evaluate(`document.querySelector('[data-diary-day]').value`), day);
  assert.deepEqual(await member.evaluate(`(() => { const entry = document.querySelector('.diary [data-id="old-diary-two"][data-action="edit-private"]').closest('.diary-entry'); return [entry.querySelector('strong').textContent, entry.querySelector('.entry-body').textContent, new URL(entry.querySelector('.links a').href).searchParams.get('query')]; })()`), ["旧日記の題 old-diary-two", "編集した旧日記本文", "日記の場所"]);
  assert.equal(await member.evaluate(`window.sent.some(b => b.includes('旧日記本文') || b.includes('旧日記の題') || b.includes('日記の場所'))`), false);
  await member.evaluate(`(() => { window.diaryFetch = window.fetch; window.fetch = async (...a) => { const r = await window.diaryFetch(...a); if (!String(a[0]).split("?")[0].endsWith('/v1/c/${capsuleId}')) return r; return Response.json({ ...await r.json(), state: 'frozen' }); }; document.querySelector('[data-action=reload]').click(); })()`);
  await member.until(`document.querySelector('.lifecycle').textContent.includes('共有終了')`);
  assert.deepEqual(await member.evaluate(`[document.querySelectorAll('.diary form, .diary [data-action="edit-private"], .diary [data-action="remove-private"]').length, document.querySelectorAll('.diary-entry').length, !!document.querySelector('.diary [data-action="save-private"]')]`), [0, 2, true]);
  await member.evaluate(`window.fetch = window.diaryFetch; document.querySelector('[data-action=reload]').click()`);
  await member.until(`!!document.querySelector('.diary form')`);
  for (const id of ["old-diary-one", "old-diary-two"]) {
    await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('.diary [data-action="remove-private"][data-id="${id}"]').click(); })()`);
    await member.until(`!document.querySelector('.diary [data-id="${id}"]')`);
  }
  await plansTab();
  console.log("Diary verification: dates, legacy title/place, privacy and frozen controls passed");
  // (n, continued) 「チャットで直す」 on the diary card (#427). The dialog says the chat can read what is copied and how many entries
  // this browser cannot open (one sealed with another key, put here); the copy holds this seat's readable entries and the shared
  // plan as a reference. A pasted answer (a plan's and a diary entry's words changed, a plan added) shows 追加 and 変更 and sends nothing; closed,
  // nothing changed. Applied, it goes as one apply sealed in the page: the plans show among the day's items marked 自分だけ, the
  // diary entry its new words, the unreadable entry stays, and no marker is in anything the page sent. A viewer opens it too.
  const sentAll = `(() => { window.sentAll = []; const real = window.fetch; window.fetch = (u, o) => { window.sentAll.push(String(o?.body ?? "")); return real(u, o); }; Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, writable: true, value: async t => { window.copied = t; } }); return true; })()`;
  const otherKey = `(async () => (await vfetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "put", entry: { id: "other-key", kind: "diary", day: "${day}", title: "v1.${"A".repeat(40)}", body: "v1.${"A".repeat(40)}" } }) })).status)()`;
  await openDiary(); await savePrivate({ body: "直す前の日記の目印" }, "diary");
  await plansTab();
  assert.equal(await member.evaluate(otherKey), 200); await member.reload(); await member.evaluate(sentAll);
  const reviseOpen = async () => { await member.evaluate(`document.querySelector('[data-action="revise-private"]').click()`); await member.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="copy-revise-private"]')`); };
  await reviseOpen();
  await assertPrivateNotice("#dialog", "[data-revise-request], [data-action=copy-revise-private]", false);
  assert.deepEqual(await member.evaluate(`[document.querySelector("#dialog").textContent.includes("コピーした文はチャットのサービスに渡り、そのサービスには読めます。運用者に読めないのはこのサービスの中に置いたものだけです。"), document.querySelector("#dialog").textContent.includes("この端末で読めない 1 件は含めず、反映しても消えません。"), document.documentElement.scrollWidth <= innerWidth]`), [true, true, true]);
  await member.evaluate(`document.querySelector('#dialog [data-action="copy-revise-private"]').click()`); await member.until(`!!window.copied`);
  const copied = await member.evaluate(`window.copied`) as string, copiedOwn = JSON.parse(/```json\n(.*)\n```\n$/.exec(copied)![1]!) as { entries: Array<Record<string, string>> };
  assert.ok(copied.includes("## 共有の予定（参照）") && copied.includes("一番目の予定"), `the copy lacks the shared plan: ${copied}`);
  assert.deepEqual(copiedOwn.entries.map(x => x.title || x.body), ["自分だけの予定の目印", "直す前の日記の目印"]);
  // If clipboard permission is refused, the manual-copy screen keeps the same notice before its text.
  await member.evaluate(`(() => { window.privateWriteText = navigator.clipboard.writeText; navigator.clipboard.writeText = async () => { throw new Error('clipboard refused'); }; document.querySelector('#dialog [data-action="copy-revise-private"]').click(); })()`);
  await member.until(`!!document.querySelector('#revise-text')`);
  await assertPrivateNotice("#dialog", "#revise-text", false);
  assert.equal(await member.evaluate(`document.querySelector('#dialog').textContent.includes('コピーした文はチャットのサービスには読めます。')`), true);
  await member.evaluate(`(() => { navigator.clipboard.writeText = window.privateWriteText; document.querySelector('#dialog [data-action=close]').click(); })()`);
  await reviseOpen();
  const reply = `直しました。\n\n\`\`\`json\n${JSON.stringify({ schemaVersion: 1, entries: [{ ...copiedOwn.entries[0], body: "チャットで直した本文の目印" }, { ...copiedOwn.entries[1], body: "チャットで直した日記の目印" }, { kind: "item", day, startsAt: `${day}T16:00:00+09:00`, title: "チャットで足した目印", body: "" }] })}\n\`\`\``;
  const pasteReply = async () => { await member.evaluate(`(() => { document.querySelector("#dialog [data-revise-paste]").value = ${JSON.stringify(reply)}; document.querySelector('#dialog [data-action="revise-private-check"]').click(); return true; })()`); await member.until(`!document.querySelector("#dialog .revise-diff").hidden`); };
  await pasteReply();
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll("#dialog .revise-diff h4")].map(h => h.textContent)`), ["追加（1 件）", "変更（2 件）"]);
  assert.deepEqual(await member.evaluate(`window.sentAll.filter(Boolean)`), [], "the page sent something before 反映する");
  const diaryBodies = `[...document.querySelectorAll(".diary .diary-entry:not(.locked) .entry-body")].map(x => x.textContent)`;
  const privatePlans = `[...document.querySelectorAll(".timeline .event.private:not(.locked)")].map(c => [c.querySelector("h3").textContent, c.querySelector("p").textContent, !!c.querySelector(".badge.private")])`;
  await member.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  assert.deepEqual([await member.evaluate(privatePlans), await readDiary(diaryBodies)], [[["自分だけの予定の目印", "自分だけの本文", true]], ["直す前の日記の目印"]]);
  await reviseOpen(); await pasteReply();
  await member.evaluate(`document.querySelector('#dialog form[data-form="revise-private"]').requestSubmit()`);
  await member.until(`${message} === "反映しました。" && !document.querySelector("#dialog").open`, 20000);
  assert.deepEqual(await member.evaluate(privatePlans), [["自分だけの予定の目印", "チャットで直した本文の目印", true], ["チャットで足した目印", "", true]]);
  assert.deepEqual(await readDiary(diaryBodies), ["チャットで直した日記の目印"]);
  assert.equal(await readDiary(`document.querySelectorAll(".diary .diary-entry.locked").length`), 1);
  await diaryTab();
  assert.equal(await member.evaluate(`document.querySelector('.diary .private-locked').textContent`), '自分の日記のうち 1 件は、この端末では読めません。');
  await member.evaluate(`document.querySelector('.diary-entry.locked [data-action="edit-private"]').click()`);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll('#dialog [data-action]')].map(b => b.dataset.action)`), ['close', 'read-private', 'remove-private']);
  await member.evaluate(`document.querySelector('#dialog [data-action=close]').click()`); await plansTab();
  console.log("Diary verification: unreadable controls passed");

  const bodies = (await member.evaluate(`window.sentAll.filter(Boolean)`) as string[]);
  assert.deepEqual(bodies.map(b => JSON.parse(b).type), ["apply"]); assert.equal(bodies.some(b => b.includes("目印")), false, "the page sent a private entry's words to the host");
  // The answer lost after the host stored it (copied again, one plan added): the page does not say nothing changed, and reads the
  // list again, which has it.
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (u, o) => { const r = await real(u, o); if (String(u).split("?")[0].endsWith("/private") && o?.method === "PATCH") { window.fetch = real; throw new TypeError("Failed to fetch"); } return r; }; window.copied = ""; return true; })()`);
  await reviseOpen(); await member.evaluate(`document.querySelector('#dialog [data-action="copy-revise-private"]').click()`); await member.until(`!!window.copied`);
  const again = JSON.parse(/```json\n(.*)\n```\n$/.exec(await member.evaluate(`window.copied`) as string)![1]!).entries as unknown[];
  const lost = `\`\`\`json\n${JSON.stringify({ schemaVersion: 1, entries: [...again, { kind: "item", day, startsAt: `${day}T17:00:00+09:00`, title: "応答が失われた目印", body: "" }] })}\n\`\`\``;
  await member.evaluate(`(() => { document.querySelector("#dialog [data-revise-paste]").value = ${JSON.stringify(lost)}; document.querySelector('#dialog [data-action="revise-private-check"]').click(); return true; })()`); await member.until(`!document.querySelector("#dialog .revise-diff").hidden`);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll("#dialog .revise-diff h4")].map(h => h.textContent)`), ["追加（1 件）"]);
  await member.evaluate(`document.querySelector('#dialog form[data-form="revise-private"]').requestSubmit()`);
  await member.until(`${message}.startsWith("反映できたか確かめられませんでした。") && !document.querySelector("#dialog").open`, 20000);
  assert.deepEqual((await member.evaluate(privatePlans) as string[][]).map(([t]) => t), ["自分だけの予定の目印", "チャットで足した目印", "応答が失われた目印"]);
  // Lost again, and the list cannot be read again either: the page does not offer a retry from the list it still shows.
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (u, o) => { const r = await real(u, o); if (String(u).split("?")[0].endsWith("/private") && o?.method === "PATCH") { window.fetch = async (v, p) => { if (String(v).split("?")[0].endsWith("/v1/c/${capsuleId}")) { window.fetch = real; throw new TypeError("Failed to fetch"); } return real(v, p); }; throw new TypeError("Failed to fetch"); } return r; }; window.copied = ""; return true; })()`);
  await reviseOpen(); await member.evaluate(`document.querySelector('#dialog [data-action="copy-revise-private"]').click()`); await member.until(`!!window.copied`);
  const third = JSON.parse(/```json\n(.*)\n```\n$/.exec(await member.evaluate(`window.copied`) as string)![1]!).entries as unknown[];
  const unread = `\`\`\`json\n${JSON.stringify({ schemaVersion: 1, entries: [...third, { kind: "item", day, startsAt: `${day}T18:00:00+09:00`, title: "読み直せない目印", body: "" }] })}\n\`\`\``;
  await member.evaluate(`(() => { document.querySelector("#dialog [data-revise-paste]").value = ${JSON.stringify(unread)}; document.querySelector('#dialog [data-action="revise-private-check"]').click(); return true; })()`); await member.until(`!document.querySelector("#dialog .revise-diff").hidden`);
  await member.evaluate(`document.querySelector('#dialog form[data-form="revise-private"]').requestSubmit()`);
  await member.until(`${message}.startsWith("反映できたか確かめられず、一覧も読み込めませんでした。") && !document.querySelector("#dialog").open`, 20000);
  await member.reload(); assert.equal((await member.evaluate(privatePlans) as string[][]).some(([t]) => t === "読み直せない目印"), true);
  // Back to the one plan the steps below expect.
  const extra = await member.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).private.filter(p => p.id !== ${JSON.stringify(copiedOwn.entries[0]!.id)}).map(p => p.id))()`) as string[];
  assert.equal(extra.length, 5); for (const x of extra) assert.equal(await member.evaluate(`(async () => (await vfetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "remove", id: ${JSON.stringify(x)} }) })).status)()`), 200);
  await member.reload();
  // A viewer opens it too: the first time registers the seat's passkey (yes to the confirm) and makes its memo key. The key's
  // hand-over reads both pages again, which the counts per minute above leave no room for: it starts in a fresh minute.
  await nextMinute(); const { page: viewer, context: viewerContext } = await joinAs("viewer", 375, 812);
  const viewerCounts = await viewer.evaluate(entryCounts); assert.equal(viewerCounts[0], 0); assert.equal(viewerCounts[1], 1); assert.equal(viewerCounts[2], 0); assert.ok(viewerCounts[3] > 0);
  assert.equal(await viewer.evaluate(headingTargets), true);
  await viewer.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click()`);

  await viewer.cdp("WebAuthn.enable"); await viewer.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  await viewer.evaluate(`(() => { window.confirm = () => true; document.querySelector('[data-action="revise-private"]').click(); return true; })()`);
  await viewer.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="copy-revise-private"]')`, 20000);
  assert.equal(await viewer.evaluate(`(async () => !!(await (await vfetch("/v1/c/${capsuleId}")).json()).privateKey)()`), true);
  await viewer.close(); await dispose(viewerContext);
  // A plan with an end and a place (fields this form does not show), its times in UTC with seconds, sealed here with the memo key
  // this browser keeps, keeps them as written through an edit of its words, and the form deletes it.
  const fullPlan = `(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("capsule", 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const kept = await new Promise(ok => { const q = db.transaction("private-keys").objectStore("private-keys").get("${capsuleId}"); q.onsuccess = () => ok(q.result); }); db.close();
    const enc = t => new TextEncoder().encode(t), b64 = b => { let t = ""; for (const c of new Uint8Array(b)) t += String.fromCharCode(c); return btoa(t).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
    const e = { id: "full-plan", kind: "item", day: "${day}", startsAt: "${day}T03:00:00Z", endsAt: "${day}T04:00:45.250Z" };
    const seal = async (text, field) => { const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc([e.id, field, e.kind, e.day, e.startsAt, e.endsAt].join("/")) }, kept.key, enc(text))), out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return "v1." + b64(out); };
    const entry = { ...e, title: await seal("終わりと場所のある予定", "title"), body: await seal("前の本文", "body"), place: await seal(JSON.stringify({ label: "駅" }), "place") };
    return (await vfetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "put", entry }) })).status;
  })()`;
  assert.equal(await member.evaluate(fullPlan), 200);
  await member.reload(); await openPrivate("edit-private", "full-plan"); await savePrivate({ body: "直した本文" });
  assert.deepEqual(await member.evaluate(`(() => { const c = document.getElementById("private-full-plan"); return [c.querySelector("p").textContent, c.querySelector(".event-time").firstChild.textContent, !!c.querySelector(".links a")]; })()`), ["直した本文", "12:00 – 13:00", true]);
  const timesOf = `(async () => { const p = (await (await vfetch("/v1/c/${capsuleId}")).json()).private.find(p => p.id === "full-plan"); return [p.startsAt, p.endsAt]; })()`;
  assert.deepEqual(await member.evaluate(timesOf), [`${day}T03:00:00Z`, `${day}T04:00:45.250Z`]);
  // Its start moved two hours later takes the end along, as the shared items' form does.
  await openPrivate("edit-private", "full-plan"); await savePrivate({ time: "14:00" });
  assert.equal(await member.evaluate(`document.querySelector("#private-full-plan .event-time").firstChild.textContent`), "14:00 – 15:00");
  assert.deepEqual(await member.evaluate(timesOf), [`${day}T14:00:00+09:00`, `${day}T06:00:45.250Z`]);
  await openPrivate("edit-private", "full-plan"); await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('#dialog [data-action="remove-private"]').click(); })()`);
  await member.until(`!document.querySelector('#app [data-id="full-plan"]')`);
  // Once sharing has ended (the page is told so by its own fetch here), a seat whose day has plans but no diary entry still
  // gets the card with 「自分のメモを保存 ↓」, and nothing to add or revise with.
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (...a) => { const r = await real(...a); if (!String(a[0]).split("?")[0].endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "frozen" }); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`document.querySelector(".lifecycle").textContent.includes("共有終了")`);
  assert.deepEqual(await readDiary(`[document.querySelectorAll(".diary .diary-entry").length, !!document.querySelector('.diary [data-action="save-private"]'), !!document.querySelector('.diary form'), !!document.querySelector('[data-action="revise-private"]')]`), [0, true, false, false]);
  await member.reload();
  // IndexedDB failing inside its own callback does not leave the page waiting: the entries show, unreadable, from nothing kept.
  await member.evaluate(`(() => { IDBDatabase.prototype.transaction = () => { throw new Error("broken store"); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`!!document.querySelector(".private-locked")`); await member.reload();
  // A browser that lost its storage with the cookie kept: the page offers 「パスキーで鍵を取り戻す」. Cancelled, the page stays as it was
  // and the seat's key is unchanged; pressed again, one check brings the key back and draws the plan with the member's own entry,
  // without signing out or reading the page again, its footprint too. Its ceremonies share the login limit of 15 a minute: they start in a fresh one.
  await nextMinute();
  await locate(member, "granted", memberContext); await footprintsTab(member); await stepHere(member, 1);
  await member.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
  await member.reload();
  assert.deepEqual(await member.evaluate(`[document.querySelector('[data-sealed="locked"]')?.textContent, !!document.querySelector('footer [data-action="restore-key"]')]`), ["この端末には旅行の鍵がありません。登録したパスキーで取り戻せます", true]);
  const seatKeyNow = `(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).seatKey)()`, seatKeyBefore = await member.evaluate(seatKeyNow);
  await member.evaluate(`(() => { navigator.credentials.get = () => Promise.reject(new DOMException("", "NotAllowedError")); document.querySelector('footer [data-action="restore-key"]').click(); return true; })()`);
  await member.until(`(${message} ?? "") === "パスキーの操作を中止しました。"`, 20000);
  assert.equal(await member.evaluate(`!!document.querySelector('[data-sealed="locked"]')`), true);
  assert.deepEqual(await member.evaluate(seatKeyNow), seatKeyBefore);
  await member.reload(); await member.evaluate(`document.querySelector('footer [data-action="restore-key"]').click()`);
  await member.until(`!!document.querySelector('[data-trip-key="held"]')`, 20000);
  await member.until(`[...document.querySelectorAll(".event.private h3")].map(h => h.textContent).join() === "自分だけの予定の目印"`, 20000);
  assert.equal(await member.evaluate(`!!document.querySelector('[data-sealed="locked"]')`), false);
  await footprintsTab(member); await member.until(`document.querySelectorAll("[data-footprint]").length === 1`);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('[data-action="remove-footprint"]').click(); return true; })()`); await member.until(`document.querySelectorAll("[data-footprint]").length === 0`);
  // Replacing the passkey of a seat whose entries are sealed rewraps the memo key for the new one: with the old passkey gone from
  // the device and this browser's copy of the key too, 「パスキーで戻る」 with the new passkey reads the entries at once.
  // Its ceremonies (three for the replacement, two to come back) share the login limit of 15 a minute: they start in a fresh one.
  await nextMinute();
  const before = (await member.cdp("WebAuthn.getCredentials", { authenticatorId: memberAuthenticator })).credentials.map((x: { credentialId: string }) => x.credentialId);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="passkey-register"]').click(); return true; })()`);
  await member.until(`(${message} ?? "").startsWith("この端末のパスキーに登録し直しました")`, 20000);
  for (const credentialId of before) await member.cdp("WebAuthn.removeCredential", { authenticatorId: memberAuthenticator, credentialId });
  await locate(member, "granted", memberContext); await footprintsTab(member); await stepHere(member, 1);
  await member.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="signout"]').click(); return true; })()`);
  await member.until(`location.pathname === "/"`); await member.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` });
  await member.until(`!!document.querySelector('[data-action="passkey-login"]')`); await member.evaluate(`document.querySelector('[data-action="passkey-login"]').click()`);
  // The key back, the plan and the member's own entry are drawn without reading the page again (#1030), on the page a reload opens,
  // and the footprint left before the storage was lost too (#1047).
  await member.until(`!!document.querySelector('[data-trip-key="held"]')`, 20000);
  await member.until(`[...document.querySelectorAll(".event.private h3")].map(h => h.textContent).join() === "自分だけの予定の目印"`, 20000);
  const memberTab = await member.evaluate(shownTab);
  await footprintsTab(member); await member.until(`document.querySelectorAll("[data-footprint]").length === 1`);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('[data-action="remove-footprint"]').click(); return true; })()`); await member.until(`document.querySelectorAll("[data-footprint]").length === 0`);
  await member.reload(); assert.equal(await member.evaluate(shownTab), memberTab);
  // After sharing ends an unreadable entry opens to 「パスキーで読む」 alone: the host would refuse removing it.
  await member.evaluate(forgetMemoKey); await member.reload();
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (...a) => { const r = await real(...a); if (!String(a[0]).split("?")[0].endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "frozen" }); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`document.querySelector(".lifecycle").textContent.includes("共有終了")`);
  await member.evaluate(`document.querySelector('.event.private.locked [data-action="edit-private"]').click()`); await member.until(`!!document.querySelector('#dialog [data-action="read-private"]')`);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll("#dialog [data-action]")].map(b => b.dataset.action)`), ["close", "read-private"]);
  await member.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await member.reload();
  // This browser loses the memo key and the device its passkey: the plan stays where it was, marked, its words gone, and the day
  // says how many cannot be read. Opened, it offers 「パスキーで読む」 and 「削除」 only; removing it leaves none.
  await member.evaluate(forgetMemoKey);
  for (const { credentialId } of (await member.cdp("WebAuthn.getCredentials", { authenticatorId: memberAuthenticator })).credentials) await member.cdp("WebAuthn.removeCredential", { authenticatorId: memberAuthenticator, credentialId });
  await member.reload();
  assert.deepEqual(await member.evaluate(`[[...document.querySelectorAll(".event.private.locked h3")].map(h => h.textContent), document.querySelector(".private-locked")?.textContent, document.body.textContent.includes("自分だけの予定の目印")]`), [["この端末では読めません"], "自分だけの予定のうち 1 件は、この端末では読めません。", false]);
  assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= innerWidth`), true, "an unreadable entry runs off the side of a 375px screen");
  // With nothing this browser can open, there is nothing to save, and the card says why.
  assert.deepEqual(await member.evaluate(`[!!document.querySelector('[data-action="save-private"]'), document.querySelector(".private-tools").textContent.includes("この端末では自分のメモを読めないため保存できません。")]`), [false, true]);
  await member.evaluate(`document.querySelector('.event.private.locked [data-action="edit-private"]').click()`); await member.until(`!!document.querySelector('#dialog [data-action="read-private"]')`);
  assert.deepEqual(await member.evaluate(`[document.querySelector("#dialog").textContent.includes("このメモは、この席のパスキーで開くと読めます。"), [...document.querySelectorAll("#dialog [data-action]")].map(b => b.dataset.action), document.documentElement.scrollWidth <= innerWidth]`), [true, ["close", "read-private", "remove-private"], true]);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('#dialog [data-action="remove-private"]').click(); })()`); await member.until(`document.querySelectorAll("#app .event.private").length === 0 && !document.querySelector(".private-locked")`);
  await member.size(390, 844, true);
  await owner.reload(); assert.equal(await owner.evaluate(`document.querySelectorAll(".badge.private, .diary-entry").length`), 0);
  await owner.evaluate(`document.querySelector('[data-action=tab][data-tab=memories]').click()`);
  assert.equal(await owner.evaluate(`document.querySelectorAll('.diary-entry').length`), 0);
  await owner.evaluate(`document.querySelector('[data-action=tab][data-tab=days]').click()`);
  assert.equal(await owner.evaluate(`document.body.textContent.includes("自分だけの予定の目印")`), false);
  await member.close(); await dispose(memberContext);
  console.log("Seat verification passed: a participant's page saying 鍵を待っています, then 鍵を受け取る and the owner's 渡す (the codes typed into each other's screen, a wrong one putting nothing on the seat and a new commitment on trying again, then the key held with an edge on both seats), a participant signing out from the footer (the confirm names the way back, the top page no longer lists the trip, the trip says why it cannot be opened) and coming back with 「パスキーで戻る」 (with the storage lost too: the plan, the own entry and a footprint drawn without a reload), a participant's browser that lost its storage taking the key back with 「パスキーで鍵を取り戻す」 (cancelled: the page and the seat's key unchanged; then the plan, the own entry and a footprint drawn without a reload), a participant's own plan among the day's items (marked 自分だけ, no grip) and diary written, changed and removed, revised with a chat (the note that the chat reads the copy, the unreadable count, the diff before anything is sent, one sealed apply changing a plan and a diary entry and adding a plan, a viewer opening it with a first passkey), sealed by the page (a memo key from the passkey's PRF, no words sent, read again after a reload), unreadable ones (key and passkey gone) marked and removable, none of it shown to the owner.");
}
async function passkey() {
  const { owner, authenticatorId } = await openTrip();
  // (c) #689: a passkey that gives no PRF output cannot wrap the seat's private key, so the seat has public keys and the wrapped trip
  // key only, and this browser holds the private key in IndexedDB alone. Its own disposable trip and browser context.
  {
    // The page first and the trip in the try: a trip published is purged whatever fails after it.
    const soloContext = (await send("Target.createBrowserContext")).browserContextId as string, solo = await page(390, 844, true, soloContext);
    await solo.cdp("WebAuthn.enable"); await solo.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false } });
    let bare: { id: string; url: string } | undefined, done = 0;
    try {
      const made = await fetch(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) });
      assert.equal(made.status, 201); bare = await made.json() as { id: string; url: string };
      const read = `(async () => { const v = await (await vfetch("/v1/c/${bare.id}")).json(); return [!!v.seatKey, !!v.seatKey?.secret, v.keyed]; })()`;
      await solo.join(bare.url); await solo.until(`!!document.querySelector('[data-trip-key="held"]')`);
      assert.deepEqual(await solo.evaluate(read), [true, false, true]);
      await solo.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="passkey-register"]').click(); return true; })()`);
      await solo.until(`(${message} ?? "").startsWith("パスキーを登録しました")`, 20000);
      assert.deepEqual(await solo.evaluate(read), [true, false, true], "a passkey without PRF must leave no wrapped private key on the seat");
      await solo.reload(); await solo.until(`!!document.querySelector('[data-trip-key="held"]')`);
      // Its storage lost, nothing on the seat for a passkey to open: no 「パスキーで鍵を取り戻す」, the footer as before.
      await solo.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
      await solo.reload(); await solo.until(`!!document.querySelector('[data-trip-key="missing"]')`);
      assert.equal(await solo.evaluate(`!!document.querySelector('[data-action="restore-key"]')`), false);
    } finally {
      // A passkey check is due before a purge (428): a run that failed before the passkey was registered registers it here.
      const purge = async () => !bare ? 200 : await solo.evaluate(`(async () => { const v = await (await vfetch("/v1/c/${bare!.id}")).json(); return (await vfetch("/v1/c/${bare!.id}/purge", { method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify({ title: ${JSON.stringify(title)} }) })).status; })()`).catch(() => 0);
      done = await purge();
      // A run that failed before the owner link was joined has no cookie to purge with: joined first.
      if (done !== 200 && done !== 428 && bare) { await solo.join(bare.url).catch(() => undefined); done = await purge(); }
      if (done === 428) { await solo.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="passkey-register"]').click(); return true; })()`).catch(() => undefined); await solo.until(`(${message} ?? "").startsWith("パスキーを登録しました")`, 20000).catch(() => undefined); done = await purge(); }
      await solo.close(); await dispose(soloContext);
      if (done !== 200) console.log(`Could not remove the second test capsule ${bare?.id}: purge it by hand (title "${title}").`);
    }
    assert.equal(done, 200, `could not purge the second test capsule ${bare?.id} by hand`);
  }
  // (i, continued) past the five minutes, a purge from the screen checks this phone's passkey (the authenticator answers; nothing
  // is asked with confirm()) and then purges.
  const left = checkedAt + 5 * 60000 + 2000 - await hostNow(); if (left > 0) { console.log(`Advancing the host clock ${Math.ceil(left / 1000)} s for the passkey check to lapse…`); await advance(left); }
  // The replacement, the return with the passkey (b) and the purge are some ten ceremonies, which share the login limit of 15 a
  // minute: they start early in a minute, as the member's replacement below does (#689).
  { const into = await hostNow() % 60000; if (into > 20000) await advance(61000 - into); }
  // (i, continued) "パスキーを登録し直す" says what it takes, then the OS checks the current passkey and makes the new one. The old
  // phone is then lost: its passkey is taken off the authenticator, so the purge below can only be checked by the new one.
  await owner.reload(); await owner.evaluate(answerYes);
  const wrapped = `(async () => !!(await (await vfetch("/v1/c/${capsuleId}")).json()).seatKey?.secret)()`;
  assert.equal(await owner.evaluate(wrapped), true, "the seat's keys were not wrapped by the owner's passkey before its replacement");
  // The browser's copy of the seat's keys is gone (IndexedDB cleared, the cookie kept): the replacement opens them from the
  // current passkey's PRF first, so the host's wrapped secret is not dropped with nothing to wrap again (#689).
  await owner.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
  const replaced = (await owner.cdp("WebAuthn.getCredentials", { authenticatorId })).credentials.map((x: { credentialId: string }) => x.credentialId);
  await owner.evaluate(`document.querySelector('[data-action="passkey-register"]').click()`); await owner.until(`(${message} ?? "").startsWith("この端末のパスキーに登録し直しました")`);
  assert.equal((await owner.evaluate(message) as string).endsWith("招待の発行や削除などの前の本人確認にも使います。"), true);
  assert.deepEqual(await owner.evaluate(`[window.asked, window.checks, window.made]`), [["今のパスキーで本人確認してから、この端末のパスキーに置き換えます。前に登録したパスキーでは戻れなくなります。今のパスキーを失った場合は、オーナーに失効と再招待を頼んでください。続けますか？"], 2, 1]);  // the current passkey's check, then the new one's PRF output for the seat's keys (#689)
  for (const credentialId of replaced) await owner.cdp("WebAuthn.removeCredential", { authenticatorId, credentialId });
  // (b) #689: the replacement wrapped the seat's private key with the new passkey's PRF. With the IndexedDB gone and the seat signed
  // out, 「パスキーで戻る」 opens it with the one check and the page says this device holds the key again.
  assert.equal(await owner.evaluate(wrapped), true);
  await owner.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
  await owner.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="signout"]').click(); return true; })()`);
  await owner.until(`location.pathname === "/"`); await owner.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` });
  await owner.until(`!!document.querySelector('[data-action="passkey-login"]')`); await owner.evaluate(`document.querySelector('[data-action="passkey-login"]').click()`);
  await owner.until(`!!document.querySelector('[data-trip-key="held"]')`, 20000);
  // The key back, the plan is drawn without reading the page again (#1030), on the page a reload opens.
  await owner.until(`!!document.querySelector(".timeline, .timeline-list")`, 20000); assert.equal(await owner.evaluate(`!!document.querySelector('[data-sealed="locked"]')`), false);
  const ownerTab = await owner.evaluate(shownTab); await owner.reload(); assert.equal(await owner.evaluate(shownTab), ownerTab);
  await closeTrip(true);
  console.log("Passkey verification passed: a replacement of the owner's passkey past the check's five minutes (the current passkey checked, a new one made), a passkey without PRF leaving no wrapped private key on the seat (and no 「パスキーで鍵を取り戻す」 once the storage is lost), the owner coming back with 「パスキーで戻る」 after IndexedDB and the cookie were cleared and holding the key again, the trip then removed from the owner's screen.");
}
async function sealed() {
  const { owner } = await openTrip();
  // (s) #691: the trip sealed by its owner's page as the seat is taken (openTrip: the banner's 移す), the host holding no plain word
  // of it. The screen draws the plan from what it opens, adds with "＋" at the time it offered, moves by the grip, promotes a
  // suggestion to the end of its day, makes 旅を保存 and チャットで直す itself, and does not send a purge with another title.
  const keysCode = await tripKeysCode();
  const plainWords = [title, ...seed.document.items.map(i => i.title)];
  assert.deepEqual(await owner.evaluate(`(async () => { const t = await (await vfetch("/v1/c/${capsuleId}")).text(); return [JSON.parse(t).sealed?.generation, ${JSON.stringify(plainWords)}.filter(w => t.includes(w))]; })()`), [1, []], "the host holds a plain word of the sealed trip");
  // What the host holds of the trip, read from the owner's page: the generation and which of the words are there in plain
  // (`window.plainWords`, replaced by the words to look for).
  const stored = `(async () => { const t = await (await vfetch("/v1/c/${capsuleId}")).text(); return [JSON.parse(t).sealed?.generation, window.plainWords.filter(w => t.includes(w))]; })()`;
  // The trip as the page opens it: what the page makes 旅を保存 (a') and チャットで直す (r) from.
  const openedTrip = await opened(owner);
  // Each answer is a copy: revisable() hands back the trip's own lists, and an answer's edits must not change the next one's.
  const sealedAnswer = structuredClone(revisable(openedTrip.spec, openedTrip.document)), renamed = { trip: `${title}（直した題）`, item: "暗号化した旅行で直した予定", idea: "暗号化した旅行で直した候補" };
  assert.ok(sealedAnswer.document.items.length > 1 && sealedAnswer.document.suggestions.length > 0 && sealedAnswer.document.comments.length > 0, "the trip needs items, a suggestion and a talk to revise");
  sealedAnswer.spec.title = renamed.trip; sealedAnswer.document.items[0]!.title = renamed.item; sealedAnswer.document.suggestions[0]!.body = renamed.idea; sealedAnswer.document.comments.shift();
  const sealedReply = "```json\n" + JSON.stringify(sealedAnswer) + "\n```";
  const reviseFrom = async (p: NonNullable<typeof owner>) => {
    if (await p.evaluate(`!!document.querySelector('.topbar [data-action="revise"]')`)) await p.evaluate(`document.querySelector('.topbar [data-action="revise"]').click()`);
    else { await p.evaluate(`document.querySelector('[data-action="manage"]').click()`); await p.until(`!!document.querySelector('#dialog [data-action="revise"]')`); await p.evaluate(`document.querySelector('#dialog [data-action="revise"]').click()`); }
    await p.until(`!!document.querySelector("#dialog [data-revise-paste]")`);
  };
  const pasteAnswer = async (p: NonNullable<typeof owner>, reply: string) => {
    // The notice is cleared first: the one a paste before left would otherwise end the wait before this check is done.
    await p.evaluate(`(() => { document.querySelector("#message").textContent = ""; document.querySelector("#dialog [data-revise-paste]").value = ${JSON.stringify(reply)}; document.querySelector('#dialog [data-action="revise-check"]').click(); return true; })()`);
    await p.until(`!document.querySelector(".revise-diff").hidden || ${message} === "貼った内容を確認してください。"`);
    return await p.evaluate(`document.querySelector(".revise-diff").hidden ? "" : document.querySelector(".revise-diff").innerText`) as string;
  };
  // (a) Drawn from what the page opened: the title, and the day's items in their order.
  await owner.evaluate(`document.querySelector('[data-action="day"][data-day="${day}"]').click()`); await owner.until(`!!document.querySelector('[data-order-day] [data-item]')`);
  assert.equal(await owner.evaluate(`document.querySelector(".hero h1").textContent`), title);
  assert.equal(await owner.evaluate(order), (openedTrip.document.items as typeof seed.document.items).filter(i => i.day === day).map(i => i.id).join());
  // (a') 旅を保存 of the sealed trip, made by the page from what it opened (#785): the trip page, the Markdown and the ZIP's files
  // are those src/export.ts makes of the opened trip; the page asks the host for none of export, export.md or export.html. The
  // ZIP's README.md and index.html are the two.
  const sealedHtml = tripHtml(openedTrip.spec, openedTrip.document), sealedMd = tripMarkdown(openedTrip.spec, openedTrip.document);
  const exportsAsked = (p: typeof owner) => p!.requests().filter(u => /\/export(\.md|\.html)?$/.test(new URL(u).pathname)).length, ownerAsked = exportsAsked(owner);
  const sealedDownloads = join(profile, "sealed-downloads"), sealedName = `trip-${seed.spec.trip.startsOn}`;
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: sealedDownloads });
  await openSave(owner);
  assert.deepEqual(await owner.evaluate(`[!!document.querySelector('#dialog [data-action="save-zip"]'), !!document.querySelector('#dialog a[href$="/export"]'), !!document.querySelector("#dialog [data-unreadable-save]")]`), [true, false, false]);
  await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await owner.evaluate(`document.querySelector('#dialog [data-action="copy-markdown"]').click()`); await owner.until(`${message} === "旅程を Markdown でコピーしました。メモアプリなどに貼って残してください。"`);
  assert.equal(await owner.evaluate(`navigator.clipboard.readText()`), sealedMd, "the sealed trip's Markdown is not the export's of the opened trip");
  await send("Browser.resetPermissions");
  await owner.evaluate(`document.querySelector('#dialog [data-action="save-page"]').click()`);
  for (let i = 0; i < 100 && !existsSync(join(sealedDownloads, `${sealedName}.html`)); i++) await sleep(100);
  assert.equal(readFileSync(join(sealedDownloads, `${sealedName}.html`), "utf8"), sealedHtml, "the sealed trip's page is not the export's of the opened trip");
  await owner.evaluate(`document.querySelector('#dialog [data-action="save-zip"]').click()`);
  const sealedZip = join(sealedDownloads, `${sealedName}.zip`), files = Object.keys(await exportFiles(capsuleId, openedTrip.spec, openedTrip.document, new Date().toISOString()));
  for (let i = 0; i < 100 && !existsSync(sealedZip); i++) await sleep(100); await sleep(300);
  const unzip = (...args: string[]) => { const r = Bun.spawnSync(["unzip", ...args]); assert.equal(r.exitCode, 0, `unzip ${args.join(" ")}`); return r.stdout.toString(); };
  assert.deepEqual(unzip("-Z1", sealedZip).split("\n").filter(Boolean), files, "the sealed trip's ZIP does not hold the export's files");
  assert.ok(unzip("-Z1", sealedZip).split("\n").includes("manifest.json"));
  assert.equal(unzip("-p", sealedZip, "README.md"), sealedMd); assert.equal(unzip("-p", sealedZip, "index.html"), sealedHtml);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  assert.equal(exportsAsked(owner), ownerAsked, "the sealed trip's page asked the host for an export");
  // A member who takes the trip's key by the codes, as in (d2), on a page of their own.
  const takeKey = async (role: string) => {
    const link = await invite(role), context = (await send("Target.createBrowserContext")).browserContextId as string, reader = Object.assign(await page(390, 844, true, context), { context });
    await reader.cdp("Page.navigate", { url: link }); await reader.until(`!!document.querySelector('[data-action="join"]')`);
    await reader.evaluate(`document.querySelector('[data-action="join"]').click()`); await reader.until(`!!document.querySelector('[data-action="receive-key"]')`, 20000);
    await reader.evaluate(`document.querySelector('[data-action="receive-key"]').click()`); await reader.until(`document.querySelector("#dialog")?.textContent.includes("「渡す」を押してもらってください")`, 20000);
    await owner!.evaluate(`(window.stale = true, location.reload())`); await owner!.until(`!window.stale && !!document.querySelector("[data-handoff-waiting]")`, 20000);
    // The seat waiting with a commitment is the new one's: the participant above, whose key was removed, waits too.
    const readerSeat = (await owner!.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).waiting.filter(w => w.handoff?.commitment).map(w => w.id))()`) as string[]);
    assert.equal(readerSeat.length, 1);
    await owner!.evaluate(`document.querySelector('footer [data-action="give-key"][data-id="${readerSeat[0]}"]').click()`);
    for (const b of [owner!, reader]) await b.until(`!!document.querySelector("#dialog [data-handoff-own]")`, 20000);
    const [ownerCode, readerCode] = [await ownCode(owner!), await ownCode(reader)];
    await typeCode(owner!, readerCode); await typeCode(reader, ownerCode);
    await reader.until(`!!document.querySelector('[data-trip-key="held"]')`, 30000);
    return reader;
  };
  // A participant who took the key by the codes: the trip page and the Markdown, the same as the owner's; no ZIP; no export
  // asked of the host. (The participant of the scenes above no longer holds the key.)
  const reader = await takeKey("participant");
  await reader.reload(); await openSave(reader);
  assert.deepEqual(await reader.evaluate(`[!!document.querySelector('#dialog [data-action="save-page"]'), !!document.querySelector('#dialog [data-action="copy-markdown"]'), !!document.querySelector('#dialog [data-action="save-zip"]'), !!document.querySelector('#dialog a[href$="/export"]')]`), [true, true, false, false]);
  await reader.evaluate(`document.querySelector('#dialog [data-action="copy-markdown"]').click()`); await reader.until(`!!document.querySelector("#markdown-text")`);
  assert.equal(await reader.evaluate(`document.querySelector("#markdown-text").value`), sealedMd, "the participant's Markdown of the sealed trip is not the host's export.md");
  assert.equal(exportsAsked(reader), 0, "the participant's page asked the host for an export");
  // (t) #693: 足あと of the sealed trip, as (d2)–(d4) for the plain one, from what the pages open: the owner and then the
  // participant press 「ここにいる」 and both read the two points, oldest first, with the map in a new tab and two dots; narrowed to
  // the owner one dot, and to the day both; the participant's phone leaves one point marked 自動 on opening 1 km away, and 消す
  // takes it out. The host holds no coordinate and no plain name of a point. Starts in a fresh minute (see (j)).
  await nextMinute();
  const sealedPoints = `(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).footprints.length)()`;
  await locate(owner, "granted", undefined, 35.6586, 139.7454); await footprintsTab(owner);
  assert.equal(await owner.evaluate(`document.querySelectorAll("[data-footprint]").length`), 0);
  await stepHere(owner, 1); assert.equal(await owner.evaluate(message), "足あとを残しました。");
  await reader.reload(); await locate(reader, "granted", reader.context, 35.6812, 139.7671); await footprintsTab(reader); await reader.until(`document.querySelectorAll("[data-footprint]").length === 1`);
  await stepHere(reader, 2);
  const sealedRows = await reader.evaluate(footprintRows) as string[]; assert.equal(sealedRows[0], "オーナー"); assert.notEqual(sealedRows[1], "オーナー");
  await owner.until(`document.querySelectorAll("[data-footprint]").length === 2`, 25000); assert.deepEqual(await owner.evaluate(footprintRows), sealedRows);
  assert.match(await owner.evaluate(`document.querySelector("[data-footprint] a").href`), /query=35\.6586%2C139\.7454$/);
  assert.deepEqual(await owner.evaluate(removable), [true, true]); assert.deepEqual(await reader.evaluate(removable), [false, true]);
  await owner.until(`${spots} === 2`);
  await owner.evaluate(`document.querySelector('[data-action="map-by"][data-value="オーナー"]').click()`); await owner.until(`${spots} === 1 && document.querySelectorAll("[data-footprint]").length === 1`);
  await owner.evaluate(`document.querySelector('[data-action="map-by"][data-value=""]').click()`); await owner.until(`${spots} === 2`);
  await owner.evaluate(`document.querySelector('[data-action="map-day"][data-value="' + new Date().toLocaleDateString("sv", { timeZone: "${seed.spec.timezone}" }) + '"]').click()`); await owner.until(`${spots} === 2 && document.querySelectorAll("[data-footprint]").length === 2`);
  await owner.evaluate(`document.querySelector('[data-action="map-day"][data-value=""]').click()`);
  await reader.evaluate(`localStorage.setItem("auto-footprint:${capsuleId}", "1")`); await advance(61000);  // past the participant's minute
  await locate(reader, "granted", reader.context, 35.6852, 139.7528); await reader.reload(); await reader.until(`${sealedPoints}.then(n => n === 3)`, 20000);
  await footprintsTab(reader); await reader.until(`document.querySelectorAll("[data-footprint]").length === 3`);
  assert.deepEqual(await reader.evaluate(`[...document.querySelectorAll("[data-footprint] small")].map(s => s.textContent.endsWith(" · 自動"))`), [false, false, true]);
  await reader.evaluate(`(() => { window.confirm = () => true; document.querySelectorAll('[data-action="remove-footprint"]')[1].click(); return true; })()`);
  await reader.until(`${message} === "足あとを消しました。"`); assert.equal(await reader.evaluate(sealedPoints), 2);
  await reader.evaluate(`localStorage.removeItem("auto-footprint:${capsuleId}")`);
  assert.deepEqual(await owner.evaluate(`(async () => { const t = await (await vfetch("/v1/c/${capsuleId}")).text(), v = JSON.parse(t);
    return [["35.6586", "139.7454", "35.6812", "139.7671", "35.6852"].filter(w => t.includes(w)), v.footprints.every(p => /^v1\.1\./.test(p.point) && /^v1\.1\./.test(p.by) && !("lat" in p))]; })()`), [[], true], "the host holds a plain point of the sealed trip");
  await nextMinute();
  // (t2) #447: 写真 of the sealed trip. The participant, the owner and then the viewer's pages: pictures made in the page (a canvas)
  // get the EXIF of a phone's camera put in by this script (a time and a place; and the turn a phone writes for a portrait, Orientation
  // 6) and go up by the file field. They lay out by when they were taken, the viewer has no field to add one, the images the screen
  // shows have no EXIF and the portrait stands upright, what the host holds is ciphertext, and 消す is the uploader's and the owner's
  // (an editor's is the host's test). The 375px page does not run off the side.
  const tripDay = day.replaceAll("-", ":");
  assert.equal(await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).photos)()`), true, "verify:ui の写真の場面は、写真を有効にした host（CAPSULE_PHOTOS=1 の bun run dev）に向けてください");
  const jpegIn = (p: NonNullable<typeof owner>, width: number, height: number) => p.evaluate(`(async () => { const c = document.createElement("canvas"); c.width = ${width}; c.height = ${height}; const x = c.getContext("2d");
    x.fillStyle = "#3a7"; x.fillRect(0, 0, ${width}, ${height}); x.fillStyle = "#e83"; x.fillRect(0, 0, ${width} / 2, ${height} / 2);
    const u = new Uint8Array(await (await new Promise(r => c.toBlob(r, "image/jpeg", 0.9))).arrayBuffer()); let s = ""; for (const v of u) s += String.fromCharCode(v); return btoa(s); })()`) as Promise<string>;
  // An EXIF APP1 (little endian): IFD0 with the turn and pointers, the Exif IFD with DateTimeOriginal and its offset, a GPS IFD.
  const exifOf = (a: { orientation?: number; taken: string; offset: string; gps?: { lat: number; lng: number } }) => {
    type Entry = { tag: number; type: number; count: number; bytes: number[] };
    const u16 = (n: number) => [n & 255, n >> 8], u32 = (n: number) => [n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24];
    const ascii = (s: string): Entry["bytes"] => [...Buffer.from(s + "\0")], rationals = (v: Array<[number, number]>) => v.flatMap(([n, d]) => [...u32(n), ...u32(d)]);
    const ifd = (entries: Entry[], at: number) => {
      const head = [...u16(entries.length)], tail: number[] = [], tailAt = at + 2 + entries.length * 12 + 4;
      for (const e of entries) {
        head.push(...u16(e.tag), ...u16(e.type), ...u32(e.count));
        if (e.bytes.length <= 4) head.push(...e.bytes, ...Array(4 - e.bytes.length).fill(0));
        else { head.push(...u32(tailAt + tail.length)); tail.push(...e.bytes, ...(e.bytes.length % 2 ? [0] : [])); }
      }
      return [...head, 0, 0, 0, 0, ...tail];
    };
    const degrees = (v: number): Array<[number, number]> => { const d = Math.floor(Math.abs(v)), m = Math.floor((Math.abs(v) - d) * 60), s = Math.round(((Math.abs(v) - d) * 60 - m) * 60 * 10000); return [[d, 1], [m, 1], [s, 10000]]; };
    const size0 = 2 + 12 * (1 + (a.orientation ? 1 : 0) + (a.gps ? 1 : 0)) + 4, exifAt = 8 + size0;
    const exif = (at: number) => ifd([{ tag: 0x9003, type: 2, count: 20, bytes: ascii(a.taken) }, { tag: 0x9011, type: 2, count: 7, bytes: ascii(a.offset) }], at);
    const gpsAt = exifAt + exif(exifAt).length;
    const gps = a.gps && ifd([{ tag: 1, type: 2, count: 2, bytes: ascii(a.gps.lat < 0 ? "S" : "N") }, { tag: 2, type: 5, count: 3, bytes: rationals(degrees(a.gps.lat)) }, { tag: 3, type: 2, count: 2, bytes: ascii(a.gps.lng < 0 ? "W" : "E") }, { tag: 4, type: 5, count: 3, bytes: rationals(degrees(a.gps.lng)) }], gpsAt);
    const root = ifd([...a.orientation ? [{ tag: 0x0112, type: 3, count: 1, bytes: u16(a.orientation) }] : [], { tag: 0x8769, type: 4, count: 1, bytes: u32(exifAt) }, ...gps ? [{ tag: 0x8825, type: 4, count: 1, bytes: u32(gpsAt) }] : []], 8);
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, ...root, ...exif(exifAt), ...gps ?? []];
    const payload = [...Buffer.from("Exif\0\0"), ...tiff];
    return Uint8Array.from([0xff, 0xe1, ...[(payload.length + 2) >> 8, (payload.length + 2) & 255], ...payload]);
  };
  const withExif = (b64: string, exif: Uint8Array) => { const jpeg = Buffer.from(b64, "base64"); return Buffer.concat([jpeg.subarray(0, 2), exif, jpeg.subarray(2)]).toString("base64"); };
  const photoTab = async (p: NonNullable<typeof owner>) => { await p.evaluate(`document.querySelector('[data-action="tab"][data-tab="photos"]').click()`); await p.until(`[...document.querySelectorAll("h2")].some(h => h.textContent === "旅の写真")`); await p.evaluate(`document.querySelector(".content").scrollIntoView()`); };
  const attach = (p: NonNullable<typeof owner>, files: Array<{ name: string; b64: string }>) => p.evaluate(`(() => { const dt = new DataTransfer(); for (const f of ${JSON.stringify(files)}) dt.items.add(new File([Uint8Array.from(atob(f.b64), c => c.charCodeAt(0))], f.name, { type: "image/jpeg" }));
    const i = document.querySelector('input[data-upload="photos"]'); i.files = dt.files; i.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const photoIds = `[...document.querySelectorAll(".photo")].map(b => b.dataset.id)`, photoRecords = `(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).media)()`;
  const loaded = (n: number) => `document.querySelectorAll("img[data-thumb]").length === ${n} && [...document.querySelectorAll("img[data-thumb]")].every(i => i.complete && i.naturalWidth > 0)`;
  const landscape = withExif(await jpegIn(reader, 640, 480), exifOf({ taken: `${tripDay} 10:15:00`, offset: "+09:00", gps: { lat: 35.6586, lng: 139.7454 } }));
  const portrait = withExif(await jpegIn(reader, 640, 480), exifOf({ orientation: 6, taken: `${tripDay} 09:05:00`, offset: "+09:00" }));
  const ownerPhoto = withExif(await jpegIn(owner, 480, 480), exifOf({ taken: `${tripDay} 11:30:00`, offset: "+09:00" }));
  const viewer = await takeKey("viewer");
  // The participant puts two up (the later first); the viewer's page, opened after, shows both thumbnails, the earlier one first, and has no field.
  await reader.reload(); await photoTab(reader);
  assert.equal(await reader.evaluate(`!!document.querySelector('input[data-upload="photos"]')`), true);
  await attach(reader, [{ name: "a.jpg", b64: landscape }, { name: "b.jpg", b64: portrait }]);
  await reader.until(`${message} === "2 枚を上げました。" && ${loaded(2)}`, 30000);
  const records = await reader.evaluate(photoRecords) as Array<{ id: string; capturedAt: string; location?: string; width: number; height: number; mine: boolean }>;
  assert.equal(records.length, 2);
  const byTime = [...records].sort((x, y) => +new Date(x.capturedAt) - +new Date(y.capturedAt)).map(r => r.id);
  assert.deepEqual(await reader.evaluate(photoIds), byTime);
  const [turned, flat] = [records.find(r => r.height > r.width)!, records.find(r => r.width >= r.height)!];
  assert.ok(turned && flat, "the portrait (Orientation 6) was not kept upright");
  assert.equal(flat.capturedAt, `${day}T10:15:00+09:00`); assert.match(flat.location!, /^v1\.1\./); assert.equal(turned.location, undefined);
  await viewer.reload(); await photoTab(viewer); await viewer.until(loaded(2), 30000);
  assert.deepEqual(await viewer.evaluate(photoIds), byTime);
  assert.equal(await viewer.evaluate(`!!document.querySelector('input[data-upload="photos"]')`), false);
  // What the screen shows has no EXIF (the page drew it again), and the portrait stands upright: the image the screen opens is taller than wide.
  // The page's policy lets it fetch nothing but its own host (and Anthropic), so the bytes of a blob: image are read from the Blob the
  // page made: `URL.createObjectURL` is wrapped before the photo is opened, and keeps each Blob by its URL.
  const shown = (p: NonNullable<typeof owner>, pid: string) => p.evaluate(`(async () => { if (!window.blobs) { window.blobs = new Map(); const make = URL.createObjectURL.bind(URL); URL.createObjectURL = b => { const u = make(b); window.blobs.set(u, b); return u; }; }
    document.querySelector('.photo[data-id="${pid}"]').click(); await new Promise(ok => { const t = setInterval(() => { const i = document.querySelector("#dialog img[data-display]"); if (i && i.complete && i.naturalWidth > 0) { clearInterval(t); ok(); } }, 50); });
    const i = document.querySelector("#dialog img[data-display]"), b = new Uint8Array(await window.blobs.get(i.src).arrayBuffer());
    return { w: i.naturalWidth, h: i.naturalHeight, jpeg: b[0] === 255 && b[1] === 216, exif: new TextDecoder("latin1").decode(b).includes("Exif"), url: i.src.slice(0, 5), remove: !!document.querySelector('#dialog [data-action="photo-remove"]'), where: !![...document.querySelectorAll("#dialog a")].find(a => a.textContent.includes("地図")) }; })()`) as Promise<{ w: number; h: number; jpeg: boolean; exif: boolean; url: string; remove: boolean; where: boolean }>;
  const closeDialog = (p: NonNullable<typeof owner>) => p.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  const upright = await shown(viewer, turned.id);
  assert.deepEqual([upright.jpeg, upright.exif, upright.url, upright.w < upright.h, upright.remove, upright.where], [true, false, "blob:", true, false, false]);
  await closeDialog(viewer);
  // A photo opened and closed before its image is ready, and another opened at once: the first one's late image does not take the second's.
  await viewer.evaluate(`(() => { document.querySelector('.photo[data-id="${turned.id}"]').click(); setTimeout(() => document.querySelector('#dialog [data-action="close"]')?.click(), 0); setTimeout(() => document.querySelector('.photo[data-id="${flat.id}"]').click(), 5); return true; })()`);
  await viewer.until(`(() => { const i = document.querySelector("#dialog img[data-display]"); return !!i && i.complete && i.naturalWidth > 0 && i.naturalWidth > i.naturalHeight; })()`, 20000);
  await closeDialog(viewer);
  const place = await shown(viewer, flat.id); assert.deepEqual([place.jpeg, place.exif, place.where, place.w > place.h], [true, false, true, true]); await closeDialog(viewer);
  // The host holds ciphertext: the image is no JPEG and has no EXIF, the position is not in the trip, the time is.
  assert.deepEqual(await viewer.evaluate(`(async () => { const text = await (await vfetch("/v1/c/${capsuleId}")).text(); const b = new Uint8Array(await (await vfetch("/v1/c/${capsuleId}/media/${flat.id}/display")).arrayBuffer());
    return [b[0] === 255 && b[1] === 216, new TextDecoder("latin1").decode(b).includes("Exif"), text.includes("35.6586") || text.includes("139.7454"), text.includes("${day}T10:15:00+09:00")]; })()`), [false, false, false, true]);
  // 消す: the participant has it for their own and not for another's; the owner's photo is the owner's and an editor's to take out.
  await owner.reload(); await photoTab(owner); await attach(owner, [{ name: "c.jpg", b64: ownerPhoto }]);
  await owner.until(`${message} === "1 枚を上げました。" && ${loaded(3)}`, 30000);
  await owner.size(375, 812, true); assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the photos page runs off the side at 375px"); await owner.size(390, 844, true);
  // The viewer's page, still on 写真, is redrawn by the 20-second refresh with the photo another member put up (photos move no revision).
  await viewer.until(`${photoIds}.length === 3`, 30000);
  const ownerId = ((await owner.evaluate(photoRecords)) as Array<{ id: string; mine: boolean }>).find(r => r.mine)!.id;
  await reader.reload(); await photoTab(reader); await reader.until(loaded(3), 30000);
  assert.equal((await shown(reader, ownerId)).remove, false); await closeDialog(reader);
  assert.equal((await shown(reader, flat.id)).remove, true);
  await reader.evaluate(`document.querySelector('#dialog [data-action="photo-remove"]').click()`);
  assert.equal(await reader.evaluate(`document.querySelector('#dialog [data-action="photo-remove"]').textContent`), "もう一度押すと消します"); assert.equal((await reader.evaluate(photoRecords) as unknown[]).length, 3);
  await reader.evaluate(`document.querySelector('#dialog [data-action="photo-remove"]').click()`); await reader.until(`${message} === "写真を消しました。" && ${photoIds}.length === 2`, 20000);
  assert.equal((await viewer.evaluate(`(async () => (await vfetch("/v1/c/${capsuleId}/media/${flat.id}/display", { cache: "reload" })).status)()`)), 404);  // not the copy the page may keep for an hour
  await owner.reload(); await photoTab(owner); await owner.until(loaded(2), 30000);
  assert.equal((await shown(owner, turned.id)).remove, true);
  await owner.evaluate(`document.querySelector('#dialog [data-action="photo-remove"]').click()`); await owner.evaluate(`document.querySelector('#dialog [data-action="photo-remove"]').click()`);
  await owner.until(`${message} === "写真を消しました。" && ${photoIds}.length === 1`, 20000);
  await viewer.until(`${photoIds}.length === 1`, 30000);  // and by the removals
  // (u) #693: 招待とメンバー and the history of the sealed trip, from what the owner's page opens. (1) Opened, it shows every
  // member's and invite's name opened, and the names the host gave the seats are put back sealed. (2) The participant renamed
  // 暗号化確認さん shows so, the host holding no such word. (3) An invite 暗号化確認用 issued makes the history's first line as in
  // (p); revoked, the host keeps no record of it, so both its lines read （失効した招待）, the host's history holding no such word.
  // (4) The participant's seat revoked reads （失効したメンバー）.
  const readerSeat = (await reader.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).self.id)()`)) as string;
  const hostText = (path: string) => owner!.evaluate(`(async () => await (await vfetch("/v1/c/${capsuleId}/${path}")).text())()`) as Promise<string>;
  await owner.reload(); await owner.evaluate(answerYes); await manageOpen();
  assert.ok((JSON.parse(await hostText("grants")) as Array<{ members: Array<{ label: string }> }>).flatMap(g => g.members).every(m => /^v1\.1\./.test(m.label)), "a member's name is held plain");
  const shownNames = await owner.evaluate(`[...document.querySelectorAll("#dialog .member, #dialog .grant > div > strong")].map(m => m.textContent)`) as string[];
  assert.ok(shownNames.length > 2 && shownNames.every(n => !n.includes("v1.") && !n.includes("（開けない名前）")), `names not opened: ${JSON.stringify(shownNames)}`);
  const sealedSelf = await owner.evaluate(`[...document.querySelectorAll("#dialog .member")].find(m => m.textContent.includes("（この端末）")).textContent.split("（この端末）")[0]`) as string;
  assert.equal(sealedSelf, "オーナー");
  await owner.evaluate(`(() => { window.prompt = () => "暗号化確認さん"; document.querySelector('#dialog [data-action="rename-member"][data-id="${readerSeat}"]').click(); return true; })()`);
  await owner.until(`[...document.querySelectorAll("#dialog .member")].some(m => m.textContent.startsWith("暗号化確認さん · "))`);
  assert.equal((await hostText("grants")).includes("暗号化確認さん"), false, "the host holds the new name plain");
  const sealedInvite = `[...document.querySelectorAll("#dialog .grant")].find(g => g.querySelector("strong")?.textContent === "暗号化確認用")`;
  await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="grant"]'); f.elements.namedItem("role").value = "participant"; f.elements.namedItem("label").value = "暗号化確認用"; f.requestSubmit(); return true; })()`);
  await owner.until(`!!document.querySelector("#issued-link")`); await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await manageOpen(); await owner.until(`!!${sealedInvite}`);
  const sealedHistory = (n: number) => owner!.evaluate(`(() => { document.querySelector("#dialog details.history").open = true; return [...document.querySelectorAll("#dialog details.history li")].slice(0, ${n}).map(l => l.textContent); })()`) as Promise<string[]>;
  const historyLine = (what: string, name: string) => new RegExp(`^\\d{4}/\\d{1,2}/\\d{1,2} \\d{2}:\\d{2} · ${what} · 参加者 · ${name} · オーナー（[^（）]+）$`);
  assert.match((await sealedHistory(1))[0]!, historyLine("招待を発行", "暗号化確認用"));
  await owner.evaluate(`(() => { window.confirm = () => true; ${sealedInvite}.querySelector('[data-action="revoke"]').click(); return true; })()`); await owner.until(`!!document.querySelector("#dialog details.history") && !${sealedInvite}`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await manageOpen();
  const sealedLines = await sealedHistory(2);
  for (const [line, what] of [[sealedLines[0], "招待を失効"], [sealedLines[1], "招待を発行"]] as const)
    assert.match(line!, historyLine(what, "（失効した招待）"), `the sealed trip's history line ${JSON.stringify(line)}`);
  assert.equal((await hostText("history")).includes("暗号化確認用"), false, "the host's history holds the invite's name plain");
  // (q2) #842: this participant's browser holds the seat's keys and lists the trip. A 401 that does not say the seat is gone (a
  // cookie the host does not know, answered as one unused for 30 days is) takes the trip off the list and keeps the keys, so the
  // cookie back (as 「パスキーで戻る」 gives one) opens the trip with the key at once.
  await reader.evaluate(`localStorage.setItem("auto-footprint:${capsuleId}", "1")`);
  assert.deepEqual(await reader.evaluate(storedFor(capsuleId)), { keys: [`seat:${capsuleId}`], listed: true, footprint: "1" });
  const readerCookie = ((await reader.cdp("Network.getCookies", { urls: [`${origin}/v1/c/${capsuleId}`] })).cookies as Array<{ name: string; value: string }>).find(c => c.name === `capsule_${capsuleId}`)!;
  const setReaderCookie = (value: string) => reader.cdp("Network.setCookie", { name: readerCookie.name, value, url: `${origin}/v1/c/${capsuleId}`, path: `/v1/c/${capsuleId}`, httpOnly: true, sameSite: "Strict" });
  await setReaderCookie("x".repeat(43)); await reader.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` }); await reader.until(`document.querySelector("main.empty h1")?.textContent === "しおりを開けませんでした。"`);
  assert.deepEqual(await reader.evaluate(storedFor(capsuleId)), { keys: [`seat:${capsuleId}`], listed: false, footprint: "1" }, "a 401 without seat: \"gone\" took the keys");
  await setReaderCookie(readerCookie.value); await reader.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` }); await reader.until(`!!document.querySelector('[data-trip-key="held"]')`, 20000);
  await owner.evaluate(`(() => { window.confirm = () => true; [...document.querySelectorAll("#dialog .member")].find(m => m.textContent.startsWith("暗号化確認さん · ")).querySelector('[data-action="revoke-member"]').click(); return true; })()`);
  await owner.until(`![...document.querySelectorAll("#dialog .member")].some(m => m.textContent.startsWith("暗号化確認さん · "))`);
  // That seat held the key, so the owner's page replaced it (#695): the trip is of generation 2 from here on.
  assert.equal(await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).sealed.generation)()`), 2, "the key was not replaced after a seat holding it was revoked");
  // …and the photo that was there went with it: its key (the one that opens its images) is of generation 2, the images as they were (#447).
  assert.deepEqual(await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).media.map(p => /^v1\\.2\\./.test(p.key)))()`), [true], "the photo's key was not sealed again with the new trip key");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await manageOpen();
  assert.match(await owner.evaluate(`(() => { document.querySelector("#dialog details.history").open = true; return document.querySelector("#dialog details.history li").textContent; })()`) as string, / · メンバーを失効 · 参加者 · （失効したメンバー） · オーナー（[^（）]+）$/);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await nextMinute();
  // (q2, continued) The revoked participant's browser opens the trip: it says why it cannot, as before, and keeps nothing of it.
  await reader.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` }); await reader.until(`document.querySelector("main.empty h1")?.textContent === "しおりを開けませんでした。"`);
  assert.equal(await reader.evaluate(`document.querySelector("main.empty").textContent.includes("この端末の登録は失効したか、期限が切れました")`), true);
  assert.deepEqual(await reader.evaluate(storedFor(capsuleId)), nothing, "the revoked participant's browser kept the trip's keys or row");
  await reader.close(); await dispose(reader.context); await owner.reload(); await owner.evaluate(answerYes);
  // (r) #786: チャットで直す and 1 つ前に戻す of the sealed trip, by the page from what it opened (spec「5.3 暗号化した旅行で Host にできないこと」). (1) The text copied is the
  // host's of the same trip while it was plain. (2) The same answer gives the same diff; another title for the large change is not
  // sent; the right one applies it, and a reload shows it. (3) An editor may not go back over the owner's change of settings.
  // (4) The owner goes back. (5) An editor's answer that renames the trip changes its items only. (6) A paste with an http link or
  // past 200,000 bytes is refused here. Through it all, no GET revise or revise/check is asked, and neither what the host holds
  // nor what the pages send holds the new words.
  const reviseAsked = (p: NonNullable<typeof owner>, path: RegExp) => p.requests().filter(u => path.test(new URL(u).pathname)).length;
  const keepSent = `(() => { window.sentBodies = []; const f = window.fetch; window.fetch = (u, o) => { if (o?.body && !String(u?.url ?? u).startsWith("https://api.anthropic.com/")) window.sentBodies.push(String(o.body)); return f(u, o); }; return true; })()`;
  const askedBefore = { check: reviseAsked(owner, /\/revise\/check$/), revise: reviseAsked(owner, /\/revise$/) };
  const newWords = [renamed.trip, renamed.item, renamed.idea, "編集者が直した予定"];
  const sentWords = async (p: NonNullable<typeof owner>) => (await p.evaluate(`window.sentBodies`) as string[]).filter(b => newWords.some(w => b.includes(w)));
  await reviseFrom(owner);
  await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  await owner.evaluate(`document.querySelector('#dialog [data-action="copy-revise"]').click()`); await owner.until(`${message} === "今の旅程と直し方をコピーしました。チャットに貼って、直してほしいことを書いてください。"`);
  const now = await opened(owner);
  assert.equal(await owner.evaluate(`navigator.clipboard.readText()`), reviseText(now.spec, now.document, false), "the sealed trip's text to copy is not the one the trip makes");
  await send("Browser.resetPermissions");
  const shownDiff = await pasteAnswer(owner, sealedReply);
  assert.ok(shownDiff.includes(renamed.item) && shownDiff.includes("大きな変更です"), "the sealed trip's diff of the answer");
  await owner.evaluate(keepSent);
  const reviseForm = `document.querySelector('.revise-diff form[data-form="revise"]')`;
  await owner.evaluate(`(() => { ${reviseForm}.elements.title.value = "違う題"; ${reviseForm}.requestSubmit(); return true; })()`);
  await owner.until(`${message} === "確認用のタイトルが一致しません。今の題を入力してください"`);
  assert.equal(reviseAsked(owner, /\/revise$/), askedBefore.revise, "a large change with another title was sent, or the text to copy asked of the host");
  await owner.evaluate(`(() => { ${reviseForm}.elements.title.value = ${JSON.stringify(title)}; ${reviseForm}.requestSubmit(); return true; })()`);
  await owner.until(`${message} === "反映しました。「共有・管理」から 1 つ前に戻せます。"`);
  assert.deepEqual(await sentWords(owner), [], "the page sent a new word in plain");
  assert.deepEqual(await owner.evaluate(stored.replace("window.plainWords", JSON.stringify(newWords))), [2, []], "the host holds a new word in plain");
  await owner.reload(); await owner.evaluate(answerYes);
  assert.equal(await owner.evaluate(`document.querySelector(".hero h1").textContent`), renamed.trip);
  assert.equal(await owner.evaluate(`document.body.textContent.includes(${JSON.stringify(renamed.item)})`), true);
  const sealedEditor = await takeKey("editor"); await sealedEditor.reload();
  await reviseFrom(sealedEditor); await sealedEditor.until(`!!document.querySelector('#dialog [data-action="undo"]')`);
  await sealedEditor.evaluate(`document.querySelector('#dialog [data-action="undo"]').click()`); await sealedEditor.until(`${message} === "設定も戻るため、オーナーだけが戻せます"`);
  await owner.reload(); await owner.evaluate(answerYes);
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector('#dialog [data-action="undo"]')`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="undo"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="undo"]')`);
  await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="undo"]'); f.elements.title.value = ${JSON.stringify(renamed.trip)}; f.requestSubmit(); return true; })()`);
  await owner.until(`${message} === "1 つ前に戻しました。"`);
  // Read again from the host (the closed dialog still holds the diff's words).
  await owner.reload(); await owner.evaluate(answerYes);
  assert.equal(await owner.evaluate(`document.querySelector(".hero h1").textContent`), title);
  assert.equal(await owner.evaluate(`document.body.textContent.includes(${JSON.stringify(renamed.item)})`), false, "the undo did not bring the item's title back");
  const editorAnswer = structuredClone(revisable(openedTrip.spec, openedTrip.document)); editorAnswer.spec.title = "編集者が変えた題"; editorAnswer.document.items[1]!.title = "編集者が直した予定";
  await sealedEditor.reload(); await sealedEditor.evaluate(keepSent); await reviseFrom(sealedEditor);
  const editorDiff = await pasteAnswer(sealedEditor, "```json\n" + JSON.stringify(editorAnswer) + "\n```");
  assert.ok(editorDiff.includes("編集者が直した予定") && !editorDiff.includes("編集者が変えた題"), "an editor's diff shows the change of the trip's title");
  await sealedEditor.evaluate(`(() => { const f = document.querySelector('.revise-diff form[data-form="revise"]'); f.querySelector('input[type="checkbox"]').checked = true; f.requestSubmit(); return true; })()`);
  await sealedEditor.until(`${message} === "反映しました。「チャットで直す」から 1 つ前に戻せます。"`);
  assert.deepEqual(await sentWords(sealedEditor), [], "the editor's page sent a new word in plain");
  await owner.reload(); await owner.evaluate(answerYes);
  assert.equal(await owner.evaluate(`document.querySelector(".hero h1").textContent`), title);
  assert.equal(await owner.evaluate(`document.body.textContent.includes("編集者が直した予定")`), true);
  const unsafe = structuredClone(revisable(openedTrip.spec, openedTrip.document)); unsafe.document.items[0]!.place = { label: "場所", publicUrl: "http://example.com/plain" };
  await reviseFrom(owner);
  assert.equal(await pasteAnswer(owner, "```json\n" + JSON.stringify(unsafe) + "\n```"), "", "an answer with an http link was taken");
  assert.equal(await pasteAnswer(owner, "あ".repeat(70_000)), "", "an answer past 200,000 bytes was taken");
  assert.equal(await owner.evaluate(`document.querySelector("#dialog .paste-problems:not(.assist-problems)").textContent`), "貼り付けが長すぎます。旅程の部分だけを貼ってください");
  // One POST revise each, the one applied; no GET revise, no revise/check.
  assert.deepEqual([reviseAsked(owner, /\/revise\/check$/) - askedBefore.check, reviseAsked(owner, /\/revise$/) - askedBefore.revise, reviseAsked(sealedEditor, /\/revise(\/check)?$/)], [0, 1, 1], "the host was asked to make or check a revise");
  assert.deepEqual(await owner.evaluate(stored.replace("window.plainWords", JSON.stringify(newWords))), [2, []], "the host holds a new word in plain");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await sealedEditor.close(); await dispose(sealedEditor.context);
  await owner.reload(); await owner.evaluate(answerYes);
  // (r2) #787 (回答 B): 「ここで直す」 of the sealed trip goes from the page to Anthropic, whose part is answered here (CDP Fetch):
  // GET /v1/models takes the key, POST /v1/messages answers the trip with one item renamed. (1) The key is checked there and put
  // on the seat wrapped (no sk-ant- in what the page sends; assistWrapped is v1.). (2) The trip's title and the request go to
  // Anthropic with the key. (3) The answer goes to the same diff and is applied. (4) Nothing the page sends the host holds the
  // title, the request or the key, and the host's revise/assist is not asked. (5) No other outside origin is asked.
  // The SDK sends the key as Authorization: Bearer (1.x; 0.x sent it as x-api-key, #1039).
  const fakeKey = `sk-ant-verify-${"x".repeat(40)}`, withKey = `Bearer ${fakeKey}`, assistRequest = "一番目の予定の題をここで直して", assisted = "ここで直した予定";
  const assistAnswer = structuredClone(revisable(openedTrip.spec, openedTrip.document)); assistAnswer.document.items[1]!.title = "編集者が直した予定"; assistAnswer.document.items[0]!.title = assisted;
  const toAnthropic: Array<{ method: string; url: string; headers: Record<string, string>; body: string }> = [];
  // The headers named one by one, as the SDK 1.1.0 page asks for them in the preflight (#1053): "*" does not take in
  // Authorization by the Fetch spec (Chrome lets it through, a browser that keeps the spec does not), and Chrome stops the
  // request when one header asked for is not named.
  const cors = [{ name: "Access-Control-Allow-Origin", value: origin }, { name: "Access-Control-Allow-Headers", value: "anthropic-dangerous-direct-browser-access, anthropic-version, authorization, content-type, x-stainless-arch, x-stainless-lang, x-stainless-os, x-stainless-package-version, x-stainless-retry-count, x-stainless-runtime, x-stainless-runtime-version, x-stainless-timeout" }, { name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" }, { name: "Content-Type", value: "application/json" }];
  const answerAnthropic = ({ requestId, request }: { requestId: string; request: { method: string; url: string; headers: Record<string, string>; postData?: string } }) => {
    toAnthropic.push({ method: request.method, url: request.url, headers: Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v])), body: request.postData ?? "" });
    const answer = request.method === "OPTIONS" ? "" : new URL(request.url).pathname === "/v1/models" ? JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null })
      : JSON.stringify({ id: "msg_verify", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "```json\n" + JSON.stringify(assistAnswer) + "\n```" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } });
    void owner!.cdp("Fetch.fulfillRequest", { requestId, responseCode: request.method === "OPTIONS" ? 204 : 200, responseHeaders: cors, body: Buffer.from(answer).toString("base64") });
  };
  paused.set(owner.session, answerAnthropic);
  await owner.cdp("Fetch.enable", { patterns: [{ urlPattern: "https://api.anthropic.com/*" }] });
  const outsideBefore = owner.requests().filter(u => !u.startsWith(origin) && !/^(data|blob|about):/.test(u)).length, assistAsked = reviseAsked(owner, /\/revise\/assist/);
  await owner.evaluate(keepSent); await reviseFrom(owner);
  await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="revise-key"]'); f.elements.key.value = ${JSON.stringify(fakeKey)}; f.requestSubmit(); return true; })()`);
  await owner.until(`${message} === "API キーを登録しました。"`, 20000);
  assert.ok(toAnthropic.some(r => r.method === "GET" && r.url.startsWith("https://api.anthropic.com/v1/models") && r.headers.authorization === withKey), "the key was not checked with Anthropic");
  assert.match(await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).assistWrapped)()`) as string, /^v1\./);
  await owner.until(`!!document.querySelector('#dialog [data-action="revise-assist"]')`);
  await owner.evaluate(`(() => { document.querySelector("#dialog [data-revise-request]").value = ${JSON.stringify(assistRequest)}; document.querySelector('#dialog [data-action="revise-assist"]').click(); return true; })()`);
  await owner.until(`!!document.querySelector('.revise-diff form[data-form="revise"]')`, 30000);
  const sentOut = toAnthropic.find(r => r.method === "POST" && r.url.startsWith("https://api.anthropic.com/v1/messages"));
  assert.ok(sentOut && sentOut.body.includes(title) && sentOut.body.includes(assistRequest) && sentOut.headers.authorization === withKey, "the trip and the request did not go to Anthropic with the key");
  // Today's date first, as the host's revise/assist sends it (#658). The sealed trip's page builds it with the browser's clock
  // (src/client.ts sealedAssist), which this script does not move.
  assert.ok(sentOut.body.includes(JSON.stringify(`今日は ${localDay(Date.now(), "Asia/Tokyo")} です。`).slice(1, -1)), "today's date did not go first, as the host sends it");
  await owner.evaluate(`(() => { const f = document.querySelector('.revise-diff form[data-form="revise"]'); f.querySelector('input[type="checkbox"]').checked = true; f.requestSubmit(); return true; })()`);
  await owner.until(`${message} === "反映しました。「共有・管理」から 1 つ前に戻せます。"`);
  assert.deepEqual((await owner.evaluate(`window.sentBodies`) as string[]).filter(b => [title, assistRequest, assisted, "sk-ant-"].some(w => b.includes(w))), [], "the page sent the host a word, the request or the key in plain");
  assert.equal(reviseAsked(owner, /\/revise\/assist/), assistAsked, "the host's revise/assist was asked");
  assert.deepEqual([...new Set(owner.requests().filter(u => !u.startsWith(origin) && !/^(data|blob|about):/.test(u)).slice(outsideBefore).map(u => new URL(u).origin))], ["https://api.anthropic.com"]);
  await owner.cdp("Fetch.disable"); paused.delete(owner.session);
  await owner.reload(); await owner.evaluate(answerYes);
  assert.equal(await owner.evaluate(`document.body.textContent.includes(${JSON.stringify(assisted)})`), true);
  assert.deepEqual(await owner.evaluate(stored.replace("window.plainWords", JSON.stringify([assisted, assistRequest, "sk-ant-"]))), [2, []], "the host holds the answer, the request or the key in plain");
  // (6) The opened key is kept in memory only: after the reload, 「ここで直す」 opens the wrapped key again with the passkey and
  // goes to Anthropic with it (the answer is the one already applied, so the diff says nothing changes).
  const assistsBefore = toAnthropic.length;
  paused.set(owner.session, answerAnthropic); await owner.cdp("Fetch.enable", { patterns: [{ urlPattern: "https://api.anthropic.com/*" }] });
  await reviseFrom(owner); await owner.until(`!!document.querySelector('#dialog [data-action="revise-assist"]')`);
  await owner.evaluate(`(() => { document.querySelector("#dialog [data-revise-request]").value = ${JSON.stringify(assistRequest)}; document.querySelector('#dialog [data-action="revise-assist"]').click(); return true; })()`);
  await owner.until(`!document.querySelector(".revise-diff").hidden`, 30000);
  assert.deepEqual(toAnthropic.slice(assistsBefore).filter(r => r.method === "POST").map(r => r.headers.authorization), [withKey], "after a reload the key was not opened again and sent");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await owner.cdp("Fetch.disable"); paused.delete(owner.session);
  await owner.reload(); await owner.evaluate(answerYes);
  // The revises and 「ここで直す」 above spend much of the owner's requests a minute (see (j)): what follows starts in a fresh one.
  await nextMinute();
  // (b) "＋" after the day's first item: the form's time is the one the host then gives there; the grip moves it after the next one.
  const sealedForm = `document.querySelector('#dialog form[data-form="item"]')`, sealedTitle = `document.querySelector('#dialog input[name="title"]')`;
  const firstAfter = await owner.evaluate(`document.querySelector('[data-action="insert-item"]').dataset.after`) as string;
  await owner.evaluate(`document.querySelector('[data-action="insert-item"][data-after="${firstAfter}"]').click()`); await owner.until(`!!${sealedForm}`);
  const sOffered = await owner.evaluate(`document.querySelector('#dialog input[name="time"]').value`) as string, sealedAdded = await owner.evaluate(`${sealedForm}.dataset.id`) as string;
  await owner.evaluate(`(() => { const t = ${sealedTitle}; t.value = "暗号化した旅行の予定"; t.dispatchEvent(new Event("input", { bubbles: true })); ${sealedForm}.requestSubmit(); })()`);
  await owner.until(`${message} === "暗号化した旅行の予定を ${sOffered} ごろ に置きました。"`);
  const sRows = (await owner.evaluate(order) as string).split(",");
  assert.equal(sRows[sRows.indexOf(firstAfter) + 1], sealedAdded); assert.equal(await owner.evaluate(timeOf(sealedAdded)), `${sOffered} ごろ`);
  assert.deepEqual(await owner.evaluate(stored.replace("window.plainWords", JSON.stringify(["暗号化した旅行の予定"]))), [2, []]);
  const nextRow = sRows[sRows.indexOf(sealedAdded) + 1]!; assert.ok(nextRow, "the day needs an item after the added one");
  await owner.evaluate(`document.querySelector('[data-item="${sealedAdded}"]').scrollIntoView({ block: "start", behavior: "instant" })`); await sleep(200);
  await owner.drag(`[data-item="${sealedAdded}"] [data-drag]`, (await owner.box(`[data-item="${nextRow}"]`)).bottom - 4);
  await owner.until(`/^暗号化した旅行の予定を .+ に変えました。$/.test(${message})`);
  const sMoved = (await owner.evaluate(order) as string).split(","); assert.equal(sMoved[sMoved.indexOf(nextRow) + 1], sealedAdded);
  // (c) A suggestion, sealed as the screen seals a post, added to the first day: last of that day, titled by its words.
  const idea = "暗号化した旅行の候補";
  const [ideaStatus, ideaId] = await owner.evaluate(`(async () => { ${keysCode}
    const k = globalThis.tripKeys, id = "${capsuleId}", v = await (await vfetch("/v1/c/" + id)).json(), s = v.seatKey;
    const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
    const trip = await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation), plain = await k.openTrip(trip, id, v);
    const op = await k.sealOperation(trip, id, s.generation, { type: "suggest", author: "オーナー", body: "${idea}" }, plain.document);
    return [(await vfetch("/v1/c/" + id + "/document", { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify(op) })).status, op.id];
  })()`) as [number, string];
  assert.equal(ideaStatus, 200);
  // Another member's change reaches this page by the 20-second refresh, opened as a reload opens it (never drawn as ciphertext).
  await owner.until(`document.querySelector("footer").textContent.includes("revision " + ${JSON.stringify(String(await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).document.revision)()`)))})`, 30000);
  assert.equal(await owner.evaluate(`document.querySelector(".hero h1").textContent`), title);
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="ideas"]').click()`); await owner.until(`!!document.querySelector('[data-action="promote"][data-id="${ideaId}"]')`);
  await owner.evaluate(`document.querySelector('[data-action="promote"][data-id="${ideaId}"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="promote"]')`);
  await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="promote"]'); f.elements.day.value = "${day}"; f.requestSubmit(); })()`);
  await owner.until(`${message} === "保存しました。"`);
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click(); document.querySelector('[data-action="day"][data-day="${day}"]').click()`);
  await owner.until(`!!document.querySelector('[data-order-day] [data-item]')`);
  const promotedId = await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).document.suggestions.find(s => s.id === "${ideaId}").itemId)()`) as string;
  assert.equal((await owner.evaluate(order) as string).split(",").at(-1), promotedId);
  assert.ok((await owner.evaluate(`document.querySelector('[data-item="${promotedId}"]').textContent`) as string).includes(idea));
  // (c') A 準備 line whose ciphertext was moved from another record does not open: the page counts it and offers no edit of the
  // whole list, which would drop it. The trip's own notes ciphertext is put on the first line, as an operator could. It is put
  // there while チャットで直す is open: the answer pasted then is checked against the trip reloaded with that line, and refused
  // with why, not offered as a change that would drop the line; nothing is sent. The revises above spend much of the owner's
  // requests a minute (see (j)): this and (d) start in a fresh one.
  await nextMinute();
  await reviseFrom(owner); const revisesBefore = reviseAsked(owner, /\/revise$/);
  assert.equal(await owner.evaluate(`(async () => { const v = await (await vfetch("/v1/c/${capsuleId}")).json();
    const checklist = v.document.checklist.map((c, n) => ({ id: c.id, title: n === 0 ? v.document.notes : c.title }));
    return (await vfetch("/v1/c/${capsuleId}/document", { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify({ type: "checklist", checklist }) })).status; })()`), 200);
  assert.equal(await pasteAnswer(owner, sealedReply), "", "an answer was offered against a trip with a record this browser cannot open");
  assert.equal(await owner.evaluate(`document.querySelector("#dialog .paste-problems:not(.assist-problems)")?.textContent`), "この端末で開けない記録があるため、チャットで直す・1 つ前に戻すは使えません（反映すると、その記録が消えるため）。");
  assert.equal(reviseAsked(owner, /\/revise$/), revisesBefore, "a revise was sent with a record this browser cannot open");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.reload(); await owner.evaluate(answerYes);
  assert.equal(await owner.evaluate(`document.querySelector("[data-unreadable]")?.textContent`), "この端末で開けない記録が 1 件あります");
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="check"]').click()`); await owner.until(`!!document.querySelector(".checks")`);
  assert.equal(await owner.evaluate(`!!document.querySelector('[data-action="edit-checklist"]')`), false);
  // (d) With a record that does not open, no チャットで直す or 1 つ前に戻す (the trip sent back would drop it): not in the header,
  // and 共有・管理 says why. 旅を保存 is there and says the record is left out.
  assert.deepEqual(await owner.evaluate(`[!!document.querySelector('.topbar [data-action="save"]'), !!document.querySelector('.topbar [data-action="revise"]')]`), [true, false]);
  await openSave(owner); assert.equal(await owner.evaluate(`document.querySelector("#dialog [data-unreadable-save]")?.textContent`), "この端末で開けない記録 1 件は、保存する内容に入りません");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="purge"]')`);
  assert.deepEqual(await owner.evaluate(`[!!document.querySelector('#dialog [data-action="save"]'), !!document.querySelector('#dialog [data-action="revise"], #dialog [data-action="undo"]'), !!document.querySelector('#dialog [data-sealed="manage"]')]`), [true, false, true]);
  // (e) A purge with another title is not sent: the screen compares it, the host cannot.
  await owner.evaluate(`document.querySelector('#dialog [data-action="purge"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="purge"]')`);
  await owner.evaluate(`(() => { document.querySelector('#dialog input[name="title"]').value = "違う題"; document.querySelector('#dialog form[data-form="purge"]').requestSubmit(); })()`);
  await owner.until(`${message} === "確認用のタイトルが一致しません"`);
  assert.equal((await fetch(`${origin}/v1/c/${capsuleId}`)).status, 401, "the capsule is still there (401 without a cookie)");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.reload(); await owner.evaluate(answerYes);
  // (t3) #451: the photos under the day's items. On the trip's last day the owner puts items at 11:00, 13:00 and 15:30 by the form
  // (the page seals them); the participant puts up photos taken at 11:03, 13:02, 15:41 and 00:30 (before the day's first item) and
  // one without a time. 詳細 shows each under its item, the 00:30 one under 予定の前, and the one without a time on the photos page
  // only; リスト shows 📷 1 on the 13:00 row. The participant puts the 13:02 one under the 15:30 item with the caption イカ, which the
  // host holds sealed and the page shows after a reload too; the owner's photo has no such form on the participant's page. The day
  // does not run off the side at 375px. Last of the sealed trip's scenes, as the items it adds would change what the ones above compare.
  const member = await takeKey("participant");
  const lastDay = await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).spec.trip.endsOn)()`) as string, lastTaken = lastDay.replaceAll("-", ":"), on = (time: string) => +new Date(`${lastDay}T${time}:00+09:00`);
  const dayItems = async () => new Map(await owner.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).json()).document.items.filter(i => i.day === "${lastDay}" && i.status !== "cancelled" && i.startsAt).map(i => [i.id, i.startsAt]))()`) as Array<[string, string]>);
  const crowded = [...(await dayItems()).values()].filter(t => [["00:00", "00:30"], ["11:00", "11:03"], ["13:00", "13:02"], ["15:30", "15:41"]].some(([a, b]) => +new Date(t) >= on(a!) && +new Date(t) <= on(b!)));
  assert.deepEqual(crowded, [], "the last day has an item where this scene's photos go");
  const pickDay = async (p: NonNullable<typeof owner>, view: "detail" | "list" = "detail") => {
    await tabTo(p, "days", ".timeline, .timeline-list");
    await p.evaluate(`document.querySelector('[data-action="day"][data-day="${lastDay}"]').click()`); await p.until(`document.querySelector('[data-action="day"][data-day="${lastDay}"]')?.getAttribute("aria-pressed") === "true"`);
    await p.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="${view}"]').click()`); await p.until(`!!document.querySelector("${view === "detail" ? ".timeline" : ".timeline-list"}")`);
  };
  await owner.reload(); await pickDay(owner);
  const planned: Record<string, string> = {};
  for (const [time, name] of [["11:00", "写真確認 唐津"], ["13:00", "写真確認 呼子"], ["15:30", "写真確認 糸島"]] as const) {
    await owner.evaluate(`document.querySelector('[data-action="new-item"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="item"]')`);
    const iid = planned[time] = await owner.evaluate(`document.querySelector('#dialog form[data-form="item"]').dataset.id`) as string;
    await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="item"]'); for (const [k, v] of [["title", ${JSON.stringify(name)}], ["day", "${lastDay}"], ["time", "${time}"]]) { const i = f.elements.namedItem(k); i.value = v; i.dispatchEvent(new Event("input", { bubbles: true })); } f.requestSubmit(); return true; })()`);
    for (let i = 0; i < 100 && !(await dayItems()).has(iid); i++) await sleep(200);
    assert.equal(+new Date((await dayItems()).get(iid)!), on(time), `the ${time} item was not saved at ${time}`);
    await owner.until(`!document.querySelector("#dialog")?.open`);
  }
  const shot = async (time?: string) => { const b = await jpegIn(member, 320, 240); return time ? withExif(b, exifOf({ taken: `${lastTaken} ${time}:00`, offset: "+09:00" })) : b; };
  const shots = [{ name: "d.jpg", b64: await shot("11:03") }, { name: "e.jpg", b64: await shot("13:02") }, { name: "f.jpg", b64: await shot("15:41") }, { name: "g.jpg", b64: await shot("00:30") }, { name: "h.jpg", b64: await shot() }];
  await member.reload(); await photoTab(member); await attach(member, shots);
  await member.until(`${message} === "5 枚を上げました。" && ${loaded(6)}`, 60000);
  const mineNow = (await member.evaluate(photoRecords) as Array<{ id: string; capturedAt?: string; mine: boolean; itineraryItemId?: string; caption?: string }>).filter(r => r.mine);
  const at = (time: string) => mineNow.find(r => r.capturedAt === `${lastDay}T${time}:00+09:00`)!.id, untimed = mineNow.find(r => !r.capturedAt)!.id;
  assert.equal(mineNow.length, 5);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll('[data-photo-day="unknown"] .photo')].map(b => b.dataset.id)`), [untimed], "the photo without a time is not under 時刻の分からない写真");
  const under = (iid: string) => `[...document.querySelectorAll('[id="item-${iid}"] .event-photos .photo')].map(b => b.dataset.id)`;
  await pickDay(member); await member.until(loaded(4), 30000);
  assert.deepEqual(await member.evaluate(`[${under(planned["11:00"]!)}, ${under(planned["13:00"]!)}, ${under(planned["15:30"]!)}, [...document.querySelectorAll("[data-photos-before] .photo")].map(b => b.dataset.id), !!document.querySelector('.timeline .photo[data-id="${untimed}"]')]`),
    [[at("11:03")], [at("13:02")], [at("15:41")], [at("00:30")], false], "the photos are not under the items they were taken at");
  await pickDay(member, "list");
  assert.equal(await member.evaluate(`document.querySelector('[data-action="open-item"][data-id="${planned["13:00"]}"] .row-photos')?.textContent`), "📷 1");
  // Put under the 15:30 item by hand, with a caption.
  await pickDay(member); await member.until(loaded(4), 30000);
  await member.evaluate(`document.querySelector('.photo[data-id="${at("13:02")}"]').click()`); await member.until(`!!document.querySelector('#dialog form[data-form="photo"]')`);
  await member.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="photo"]'); f.elements.namedItem("item").value = "${planned["15:30"]}"; f.elements.namedItem("caption").value = "イカ"; ${message} = ""; f.requestSubmit(); return true; })()`);
  await member.until(`${message} === "写真を直しました。"`, 20000);
  const moved = (await member.evaluate(photoRecords) as typeof mineNow).find(r => r.id === at("13:02"))!;
  assert.equal(moved.itineraryItemId, planned["15:30"]); assert.match(moved.caption!, /^v1\.2\./);  // the key was replaced in (u)
  assert.equal((await member.evaluate(`(async () => (await (await vfetch("/v1/c/${capsuleId}")).text()).includes("イカ"))()`)), false, "the host holds the caption plain");
  const captions = (iid: string) => `[...document.querySelectorAll('[id="item-${iid}"] figcaption')].map(c => c.textContent)`;
  for (const fresh of [false, true]) {
    if (fresh) { await member.reload(); await pickDay(member); }
    await member.until(`${loaded(4)} && ${captions(planned["15:30"]!)}.join() === "イカ"`, 30000);
    assert.deepEqual(await member.evaluate(`[${under(planned["13:00"]!)}, ${under(planned["15:30"]!)}]`), [[], [at("13:02"), at("15:41")]]);
  }
  await member.size(375, 812, true); assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the day with photos runs off the side at 375px"); await member.size(390, 844, true);
  await photoTab(member); await member.until(loaded(6), 30000);
  await member.evaluate(`document.querySelector('.photo[data-id="${ownerId}"]').click()`); await member.until(`!!document.querySelector("#dialog img[data-display]")`);
  assert.equal(await member.evaluate(`!!document.querySelector('#dialog form[data-form="photo"]')`), false, "the participant may choose the item of the owner's photo"); await closeDialog(member);
  // The photo without a time, put under the 11:00 item by hand, is there and still under 時刻の分からない写真. A caption past 160
  // characters is not sent; an emptied one is taken off.
  const photoForm = (pid: string) => member.evaluate(`(async () => { document.querySelector('.photo[data-id="${pid}"]').click(); for (let i = 0; i < 100 && !document.querySelector('#dialog form[data-form="photo"]'); i++) await new Promise(r => setTimeout(r, 100)); return true; })()`);
  const sendForm = (fields: Record<string, string>) => member.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="photo"]'); for (const [k, v] of Object.entries(${JSON.stringify(fields)})) f.elements.namedItem(k).value = v; ${message} = ""; f.requestSubmit(); return true; })()`);
  await photoForm(untimed); await sendForm({ item: planned["11:00"]!, caption: "あ".repeat(161) });
  await member.until(`${message} === "一言は 160 字までです"`);
  assert.equal((await member.evaluate(photoRecords) as typeof mineNow).find(r => r.id === untimed)!.itineraryItemId, undefined, "the form sent something with a caption too long");
  await sendForm({ item: planned["11:00"]!, caption: "" }); await member.until(`${message} === "写真を直しました。"`, 20000);
  await member.until(`[...document.querySelectorAll('[data-photo-day="unknown"] .photo')].map(b => b.dataset.id).join() === "${untimed}"`);
  await photoForm(at("13:02")); await sendForm({ caption: "" }); await member.until(`${message} === "写真を直しました。"`, 20000);
  assert.equal((await member.evaluate(photoRecords) as typeof mineNow).find(r => r.id === at("13:02"))!.caption, undefined, "the emptied caption is still on the photo");
  await pickDay(member); await member.until(loaded(5), 30000);
  assert.deepEqual(await member.evaluate(`[${under(planned["11:00"]!)}, ${captions(planned["15:30"]!)}]`), [[at("11:03"), untimed], []]);
  await member.close(); await dispose(member.context); await owner.reload(); await owner.evaluate(answerYes);
  console.log("Sealed trip verification: sealed from the page (no plain word held by the host), drawn the same, \"＋\" at the offered time, moved by the grip, a change by the 20-second refresh opened (not drawn as ciphertext), a suggestion promoted last of its day, a 準備 line that does not open counted with no edit of the whole list (and named in 旅を保存), 旅を保存 made by the page (the trip page, the Markdown and the ZIP the host gave for the same trip while plain, none asked of the host; for a participant who took the key, the page and the Markdown without a ZIP), チャットで直す made by the page (the host's text and diff of the same trip while plain, a large change's other title not sent, applied and gone back by the owner, an editor's change of the title left out and the owner's change of settings not gone back by an editor, an http link and a paste past 200,000 bytes refused, no GET revise or revise/check asked, no new word sent or held in plain), ここで直す from the page to Anthropic (answered by CDP: the key checked there and kept wrapped, the trip and the request sent with it, the answer applied through the same diff, none of them sent to or held by the host, no other outside origin), no チャットで直す while a record does not open, 写真 (two pictures with a camera's EXIF put up from the participant's page, laid out by the time taken with the portrait upright, none of the viewer's page's field, no EXIF in what the screen shows and ciphertext at the host with no position, 消す by its uploader and the owner and not another's, nothing off the side at 375px), a purge with another title not sent");
  // (w) #842: the top page forgets a trip it lists that is past its deletion, with what this browser kept for it, without the trip
  // being opened, and after another trip's page wrote the list back first; the live trip stays listed with its keys.
  const pastId = "0".repeat(32);
  await owner.evaluate(`(async () => { localStorage.setItem("capsules", JSON.stringify([...JSON.parse(localStorage.getItem("capsules") ?? "[]"), { id: "${pastId}", title: "削除予定を過ぎた旅行", startsOn: "2020-01-01", endsOn: "2020-01-02", purgeAt: "2020-01-03T00:00:00.000Z" }])); localStorage.setItem("auto-footprint:${pastId}", "1");
    await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const t = q.result.transaction("private-keys", "readwrite"); t.objectStore("private-keys").put("x", "${pastId}"); t.objectStore("private-keys").put("x", "seat:${pastId}"); t.oncomplete = () => { q.result.close(); ok(true); }; t.onerror = () => no(t.error); }; }); return true; })()`);
  assert.deepEqual(await owner.evaluate(storedFor(pastId)), { keys: [pastId, `seat:${pastId}`], listed: true, footprint: "1" });
  await owner.reload(); await owner.cdp("Page.navigate", { url: `${origin}/` }); await owner.until(`!!document.querySelector("main .content h1")`);
  assert.deepEqual(await owner.evaluate(storedFor(pastId)), nothing, "the top page kept a trip past its deletion");
  const ownerKept = await owner.evaluate(storedFor(capsuleId)) as { keys: string[]; listed: boolean };
  assert.deepEqual([ownerKept.keys.includes(`seat:${capsuleId}`), ownerKept.listed], [true, true], "the top page took the live trip's keys or row");
  assert.equal(await owner.evaluate(`!!document.querySelector('a[href="/c/${capsuleId}"]')`), true, "the top page no longer lists the live trip");
  await owner.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` }); await owner.until(`!!document.querySelector('[data-trip-key="held"]')`, 20000); await owner.evaluate(answerYes);
  const deleted = capsuleId; await closeTrip(true);
  // (w, continued) The owner's own browser keeps nothing of the trip it deleted.
  assert.deepEqual(await owner.evaluate(storedFor(deleted)), nothing, "the owner's browser kept the deleted trip's keys or row"); assert.deepEqual(await owner.evaluate(`[window.asked, window.checks]`), [[], 0]);  // the purge is inside the five minutes of the owner's last check above, so it asks for none
  console.log("Kept by the browser: what a browser keeps for a trip (#842: a 401 not saying the seat is gone taking the trip off the list and keeping the keys, the cookie back opening it with the key; a revoked participant's browser saying why it cannot open the trip and keeping no key, row or 開いたときに足あとを残す of it; the top page forgetting a trip past its deletion with its keys after another trip's page wrote the list back, the live trip kept; the owner's browser keeping nothing of the trip it deleted, and a member's opening a deleted trip to 410 keeping nothing either).");
  // (v) The first seal (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」), on trips and browsers of their own. (a) A trip not sealed draws the
  // banner alone on its owner's page; 移す registers the passkey as the check and seals it: reloaded, the title and the items are
  // drawn, the host's answer holding none of them plain. (b) A member takes the key by the codes and reads the trip. (x) #842:
  // deleting the trip clears it from the owner's browser, and the member's browser that still had a seat opens it to 410 and
  // keeps nothing of it either. (d) Without WebAuthn, the owner of another trip is told the trip opens once sealed in a browser
  // with passkeys, nothing else drawn.
  {
    const publish = async () => { const r = await fetch(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) }); assert.equal(r.status, 201); return await r.json() as { id: string; url: string }; };
    const browser = async () => { const context = (await send("Target.createBrowserContext")).browserContextId as string; return Object.assign(await page(390, 844, true, context), { context }); };
    const purgeFrom = async (p: Awaited<ReturnType<typeof browser>>) => {
      // The passkey ceremony needs the page in front: a page opened after it (the one without WebAuthn) took the focus.
      await p.cdp("Page.bringToFront"); await p.evaluate(answerYes); await p.evaluate(`document.querySelector('[data-action="manage"]').click()`); await p.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="purge"]')`);
      await p.evaluate(`document.querySelector('#dialog [data-action="purge"]').click()`); await p.until(`!!document.querySelector('#dialog form[data-form="purge"]')`);
      await p.evaluate(`(() => { document.querySelector('#dialog input[name="title"]').value = ${JSON.stringify(title)}; document.querySelector('#dialog form[data-form="purge"]').requestSubmit(); return true; })()`);
      await p.until(`document.querySelector("main.empty h1")?.textContent === "カプセルを削除しました。"`, 30000);
    };
    // The passkey ceremonies below share the login limit of 15 a minute with the ones just before: they start in a fresh minute.
    await nextMinute();
    const moving = await publish(), other = await publish(), mover = await browser(), member = await browser();
    let movedDone = false, otherDone = false, otherOwner = mover;
    try {
      await mover.cdp("WebAuthn.enable"); await mover.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
      await mover.join(moving.url); await mover.until(`!!document.querySelector('[data-trip-key="held"]')`); await mover.evaluate(answerYes);
      // (a)
      assert.equal(await mover.evaluate(`document.querySelector('[data-seal="owner"]')?.innerText.includes("この旅行を、メンバーにだけ読める形にします") ?? false`), true, "the owner's page offers to seal the trip");
      assert.equal(await mover.evaluate(`!!document.querySelector(".hero, .timeline, .timeline-list, [data-action='manage']")`), false, "a trip not sealed draws more than the banner");
      await sealFromBanner(mover);
      assert.equal(await mover.evaluate(`document.querySelector(".hero h1").textContent`), title);
      assert.equal(await mover.evaluate(`!!document.querySelector('[data-seal]')`), false, "a sealed trip offers to seal it again");
      const plainWords = [title, ...seed.document.items.map(i => i.title)];
      assert.deepEqual(await mover.evaluate(`(async () => { const t = await (await vfetch("/v1/c/${moving.id}")).text(); return [JSON.parse(t).sealed?.generation, ${JSON.stringify(plainWords)}.filter(w => t.includes(w))]; })()`), [1, []], "the host holds a plain word of the sealed trip");
      // (b)
      await mover.evaluate(`document.querySelector('[data-action="manage"]').click()`); await mover.until(`!!document.querySelector('#dialog form[data-form="grant"]')`);
      await mover.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="grant"]'); f.elements.namedItem("role").value = "participant"; f.requestSubmit(); return true; })()`); await mover.until(`!!document.querySelector("#issued-link")`, 20000);
      const link = await mover.evaluate(`document.querySelector("#issued-link").value`) as string; await mover.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
      await member.join(link); await handOver(mover, member);
      assert.equal(await member.evaluate(`document.querySelector(".hero h1").textContent`), title);
      // (x) #842: deleting the trip clears it from the owner's browser, and the member's browser that still had a seat opens it
      // to 410 and keeps nothing of it either.
      await member.evaluate(`localStorage.setItem("auto-footprint:${moving.id}", "1")`);
      assert.deepEqual(await member.evaluate(storedFor(moving.id)), { keys: [`seat:${moving.id}`], listed: true, footprint: "1" });
      assert.equal((await mover.evaluate(storedFor(moving.id)) as { keys: string[] }).keys.includes(`seat:${moving.id}`), true);
      await mover.reload(); await purgeFrom(mover); movedDone = true;
      assert.deepEqual(await mover.evaluate(storedFor(moving.id)), nothing, "the owner's browser kept the deleted trip's keys or row");
      await member.cdp("Page.navigate", { url: `${origin}/c/${moving.id}` }); await member.until(`document.querySelector("main.empty h1")?.textContent === "しおりを開けませんでした。"`);
      assert.equal(await member.evaluate(`document.querySelector("main.empty").textContent.includes("この旅のカプセルは削除されました")`), true);
      assert.deepEqual(await member.evaluate(storedFor(moving.id)), nothing, "the member's browser kept the deleted trip's keys or row");
      await member.close();
      // (d) A page that has no WebAuthn, in a context of its own whose other page has an authenticator: the cookie is shared, so
      // that page seals the trip and then deletes it (a fresh authenticator registers the passkey the seal checks, as in (a)).
      otherOwner = await browser();
      await otherOwner.cdp("WebAuthn.enable"); await otherOwner.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
      const bare = Object.assign(await page(390, 844, true, otherOwner.context), { context: otherOwner.context });
      await bare.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `delete window.PublicKeyCredential;` });
      await bare.join(other.url);
      assert.equal(await bare.evaluate(`document.querySelector('[data-seal="no-passkey"]')?.textContent`), "この旅行は、パスキーの使えるブラウザ（Safari・Chrome など）で開いてください");
      assert.equal(await bare.evaluate(`!!document.querySelector(".hero")`), false, "a trip not sealed is drawn without WebAuthn"); await bare.close();
      await otherOwner.cdp("Page.navigate", { url: `${origin}/c/${other.id}` }); await otherOwner.until(drawn); await otherOwner.evaluate(answerYes); await sealFromBanner(otherOwner); await purgeFrom(otherOwner); otherDone = true;
    } finally {
      for (const [done, trip, by] of [[movedDone, moving, mover], [otherDone, other, otherOwner]] as const) if (!done) try { await by.cdp("Page.navigate", { url: `${origin}/c/${trip.id}` }); await by.until(`!!document.querySelector('[data-action="manage"]')`, 20000); await purgeFrom(by); if (trip === moving) movedDone = true; else otherDone = true; } catch { /* reported below */ }
      for (const p of new Set([mover, member, otherOwner])) { await p.close(); await dispose(p.context); }
      if (!movedDone || !otherDone) console.log(`Could not remove the move scene's test capsules (${[!movedDone && moving.id, !otherDone && other.id].filter(Boolean).join(", ")}): purge them by hand (title "${title}").`);
    }
  }
  console.log("Move verification: a plain trip moved by its owner with the passkey check (drawn the same, both points kept, no plain word, point or name held by the host), the participant told before and asked for the key after, the key handed over by the codes; without WebAuthn the owner told to use another browser and the trip left plain.");
  // (w) #695: the trip key replaced (docs/ephemeral-trip-capsule.md「5.5 旅行の鍵を替える」), on a trip and browsers of their own: the owner moves the trip,
  // and participants take the key by the codes. (1) 替える: B revoked from 招待とメンバー, the owner's page replaces the key
  // (「旅行の鍵を替えました」): every ciphertext the host holds is of generation 2, A reads the trip on reloading, and the key of
  // generation 1 taken out of B's page opens none of it. (2) たどれない席: A gives the key to C, then A is revoked: the owner's
  // page says one member takes the key again, lists C as waiting, and C takes the key by the codes. (3) 期限: D's invite ends 75 s
  // later on the host's clock; past it, the owner's page replaces the key on reloading.
  {
    const keeperTrip = await (async () => { const r = await fetch(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) }); assert.equal(r.status, 201); return await r.json() as { id: string; url: string }; })();
    const browser = async () => { const context = (await send("Target.createBrowserContext")).browserContextId as string; return Object.assign(await page(390, 844, true, context), { context }); };
    type B = Awaited<ReturnType<typeof browser>>;
    const tripId = keeperTrip.id, keeper = await browser(), members: B[] = [];
    let purged = false;
    // What the host holds of the trip, read from the owner's page: the generation and every ciphertext's generation.
    const held = async () => await keeper.evaluate(`(async () => { const t = await (await vfetch("/v1/c/${tripId}")).text(); return [JSON.parse(t).sealed?.generation, [...new Set([...t.matchAll(/v1\\.(\\d+)\\./g)].map(m => Number(m[1])))]]; })()`) as [number, number[]];
    const seatOf = async (b: B) => await b.evaluate(`(async () => (await (await vfetch("/v1/c/${tripId}")).json()).self.id)()`) as string;
    const enter = async (url: string) => {
      const b = await browser(); members.push(b);
      await b.cdp("Page.navigate", { url }); await b.until(`!!document.querySelector('[data-action="join"]')`);
      await b.evaluate(`document.querySelector('[data-action="join"]').click()`); await b.until(`!!document.querySelector('[data-action="receive-key"]')`, 20000);
      await b.evaluate(`document.querySelector('#dialog [data-action="close"]')?.click()`); return b;
    };
    const issue = async (expiresAt?: number) => {
      const r = await keeper.evaluate(`(async () => { const r = await vfetch("/v1/c/${tripId}/grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "participant", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: ${expiresAt ? `new Date(${expiresAt}).toISOString()` : "(await (await vfetch('/v1/c/" + tripId + "')).json()).spec.lifecycle.purgeAt"}, confirm: true }) }); return { status: r.status, body: await r.json() }; })()`) as { status: number; body: { url: string } };
      assert.equal(r.status, 201, "an invite of the sealed trip"); return r.body.url;
    };
    // 鍵を受け取る on the member's page, 渡す on the giver's, the codes typed into each other's screen.
    const handOver = async (giver: B, member: B) => {
      const seat = await seatOf(member);
      await member.reload().catch(() => undefined); await member.until(`!!document.querySelector('[data-action="receive-key"]')`, 20000);
      await member.evaluate(`document.querySelector('[data-action="receive-key"]').click()`); await member.until(`document.querySelector("#dialog")?.textContent.includes("「渡す」を押してもらってください")`, 20000);
      await giver.cdp("Page.reload"); await giver.until(`!!document.querySelector('footer [data-action="give-key"][data-id="${seat}"]')`, 20000);
      await giver.evaluate(`document.querySelector('footer [data-action="give-key"][data-id="${seat}"]').click()`);
      for (const b of [giver, member]) await b.until(`!!document.querySelector("#dialog [data-handoff-own]")`, 20000);
      const [g, m] = [await ownCode(giver), await ownCode(member)];
      await typeCode(giver, m); await typeCode(member, g);
      await member.until(`!!document.querySelector('[data-trip-key="held"]')`, 30000);
      return seat;
    };
    const revoke = async (seat: string) => {
      await keeper.cdp("Page.bringToFront"); await keeper.evaluate(answerYes); await keeper.evaluate(`document.querySelector("#message").textContent = ""`);
      await keeper.evaluate(`document.querySelector('[data-action="manage"]').click()`); await keeper.until(`!!document.querySelector('#dialog [data-action="revoke-member"][data-id="${seat}"]')`, 20000);
      await keeper.evaluate(`document.querySelector('#dialog [data-action="revoke-member"][data-id="${seat}"]').click()`);
    };
    const reads = async (b: B) => { await b.reload(); return [await b.evaluate(`document.querySelector(".hero h1")?.textContent`), await b.evaluate(`!!document.querySelector('[data-trip-key="held"]')`)]; };
    await nextMinute();
    try {
      await keeper.cdp("WebAuthn.enable"); await keeper.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
      await keeper.join(keeperTrip.url); await keeper.until(`!!document.querySelector('[data-trip-key="held"]')`); await keeper.evaluate(answerYes);
      await keeper.evaluate(`document.querySelector('[data-action="seal-trip"]').click()`);
      await keeper.until(`${message} === "旅行を、メンバーにだけ読める形にしました。"`, 30000); await keeper.reload(); await keeper.evaluate(answerYes);
      assert.deepEqual(await held(), [1, [1]]);
      // (1)
      const a = await enter(await issue()), b = await enter(await issue());
      await handOver(keeper, a); const bSeat = await handOver(keeper, b);
      const oldKey = await b.evaluate(`(async () => { ${keysCode}
        const k = globalThis.tripKeys, id = "${tripId}";
        const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
        const s = (await (await vfetch("/v1/c/" + id)).json()).seatKey, key = await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation, true);
        return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey("raw", key)))); })()`) as string;
      await revoke(bSeat);
      await keeper.until(`${message} === "旅行の鍵を替えました。"`, 30000);
      assert.deepEqual(await held(), [2, [2]], "every ciphertext the host holds is of the next generation");
      assert.deepEqual(await reads(a), [title, true], "the remaining participant reads the trip on reloading");
      const stale = await crypto.subtle.importKey("raw", Buffer.from(oldKey, "base64"), "AES-GCM", false, ["decrypt"]);
      const now = await keeper.evaluate(`(async () => { const v = await (await vfetch("/v1/c/${tripId}")).json(); return { title: v.spec.title, notes: v.document.notes }; })()`) as { title: string; notes: string };
      await assert.rejects(openField(stale, tripId, "spec", "spec", "title", now.title), "the revoked participant's key opens the new title");
      await assert.rejects(openField(stale, tripId, "notes", "notes", "body", now.notes), "the revoked participant's key opens the new notes");
      // (2)
      await nextMinute();
      const c = await enter(await issue()), cSeat = await handOver(a, c);
      await revoke(await seatOf(a));
      await keeper.until(`${message} === "旅行の鍵を替えました。1 人は確認コードで鍵を受け取り直します。"`, 30000);
      assert.deepEqual(await held(), [3, [3]]);
      await keeper.evaluate(`document.querySelector('#dialog [data-action="close"]')?.click()`); await keeper.reload();
      assert.equal(await keeper.evaluate(`!!document.querySelector('[data-handoff-waiting="${cSeat}"]')`), true, "the seat the owner could not reach waits for the key");
      // C's open page learns it by the 20-second refresh: the key it opened before is of the older generation, so it asks for the new one.
      await c.until(`!!document.querySelector('[data-action="receive-key"]') && !document.querySelector('[data-trip-key="held"]')`, 40000);
      await handOver(keeper, c);
      assert.deepEqual(await reads(c), [title, true]);
      // (3)
      await nextMinute();
      const d = await enter(await issue(await hostNow() + 75000)); await handOver(keeper, d);
      await advance(76000);
      await keeper.cdp("Page.bringToFront"); await keeper.evaluate(`document.querySelector("#message").textContent = ""`); await keeper.cdp("Page.reload");
      await keeper.until(`(document.querySelector("#message")?.textContent ?? "").startsWith("旅行の鍵を替えました")`, 30000);
      assert.deepEqual(await held(), [4, [4]], "the key replaced after an invite ended before the trip's deletion");
      assert.deepEqual(await reads(c), [title, true]);
      // Done: the owner purges it.
      await keeper.evaluate(answerYes); await keeper.evaluate(`document.querySelector('[data-action="manage"]').click()`); await keeper.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="purge"]')`);
      await keeper.evaluate(`document.querySelector('#dialog [data-action="purge"]').click()`); await keeper.until(`!!document.querySelector('#dialog form[data-form="purge"]')`);
      await keeper.evaluate(`(() => { document.querySelector('#dialog input[name="title"]').value = ${JSON.stringify(title)}; document.querySelector('#dialog form[data-form="purge"]').requestSubmit(); return true; })()`);
      await keeper.until(`document.querySelector("main.empty h1")?.textContent === "カプセルを削除しました。"`, 30000); purged = true;
    } finally {
      if (!purged) try { const v = await keeper.evaluate(`(async () => { const v = await (await vfetch("/v1/c/${tripId}")).json(); return (await vfetch("/v1/c/${tripId}/purge", { method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify({ title: ${JSON.stringify(title)} }) })).status; })()`); purged = v === 200; } catch { /* reported below */ }
      for (const p of [keeper, ...members]) { await p.close(); await dispose(p.context); }
      if (!purged) console.log(`Could not remove the rekey scene's test capsule ${tripId}: purge it by hand (title "${title}").`);
    }
  }
  console.log("Rekey verification: 替える (a participant revoked from 招待とメンバー: the owner's page replaced the key, every ciphertext the host holds of the next generation, the remaining participant reading the trip on reloading, the revoked one's key opening none of it), たどれない席 (the member reached only through the revoked one told to take the key again, waiting on the owner's page and taking it by the codes), 期限 (an invite ending before the trip's deletion: the key replaced when the owner next opened the trip).");
  // (x) #695: the new owner asked, on a trip and browsers of their own. (1) owner の交換を止める: with no other seat holding the
  // key, 交換 of the owner invite is stopped with the host's words, the invite left as it was. (2) owner の交換: A holds the key,
  // the owner invite is handed over, the new owner takes the key from A by the codes and is asked 「鍵を替えますか」: 鍵を替える
  // moves the generation on and A reads it on reloading. Handed over once more, 替えない keeps the generation, and a reload asks
  // nothing. (3) 作り直し: a participant who took the key registers a passkey afterwards: its pair is made again with `since`, and
  // when the owner next replaces the key (A revoked), that seat is wrapped too and reads the trip.
  {
    const askTrip = await (async () => { const r = await fetch(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) }); assert.equal(r.status, 201); return await r.json() as { id: string; url: string }; })();
    type B = Awaited<ReturnType<typeof page>> & { context: string };
    const opened: B[] = [], tripId = askTrip.id;
    const browser = async (): Promise<B> => { const context = (await send("Target.createBrowserContext")).browserContextId as string; const b = Object.assign(await page(390, 844, true, context), { context }); opened.push(b); return b; };
    const withPasskey = async (b: B) => { await b.cdp("WebAuthn.enable"); await b.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } }); return b; };
    const view = async (b: B) => await b.evaluate(`(async () => await (await vfetch("/v1/c/${tripId}")).json())()`) as any;
    const generation = async (b: B) => (await view(b)).sealed?.generation as number;
    const enter = async (url: string, b?: B) => {
      b ??= await browser();
      await b.cdp("Page.navigate", { url }); await b.until(`!!document.querySelector('[data-action="join"]')`);
      await b.evaluate(`document.querySelector('[data-action="join"]').click()`); await b.until(`!!document.querySelector('[data-action="receive-key"]')`, 20000);
      await b.evaluate(`document.querySelector('#dialog [data-action="close"]')?.click()`); await b.evaluate(answerYes); return b;
    };
    const issue = async (from: B) => {
      const r = await from.evaluate(`(async () => { const r = await vfetch("/v1/c/${tripId}/grants", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "participant", id: crypto.randomUUID().replaceAll("-", ""), expiresAt: (await (await vfetch("/v1/c/${tripId}")).json()).spec.lifecycle.purgeAt, confirm: true }) }); return { status: r.status, body: await r.json() }; })()`) as { status: number; body: { url: string } };
      assert.equal(r.status, 201, "an invite of the sealed trip"); return r.body.url;
    };
    const handOver = async (giver: B, member: B) => {
      const seat = (await view(member)).self.id as string;
      await member.cdp("Page.reload"); await member.until(`!!document.querySelector('[data-action="receive-key"]')`, 20000);
      await member.evaluate(`document.querySelector('[data-action="receive-key"]').click()`); await member.until(`document.querySelector("#dialog")?.textContent.includes("「渡す」を押してもらってください")`, 20000);
      await giver.cdp("Page.reload"); await giver.until(`!!document.querySelector('footer [data-action="give-key"][data-id="${seat}"]')`, 20000);
      await giver.evaluate(`document.querySelector('footer [data-action="give-key"][data-id="${seat}"]').click()`);
      for (const b of [giver, member]) await b.until(`!!document.querySelector("#dialog [data-handoff-own]")`, 20000);
      const [g, m] = [await ownCode(giver), await ownCode(member)];
      await typeCode(giver, m); await typeCode(member, g);
      await member.until(`!!document.querySelector('[data-trip-key="held"]')`, 30000);
      return seat;
    };
    // 交換 of the owner invite from 招待とメンバー: the link shown, or the notice when the screen stops it.
    const handOverOwner = async (from: B) => {
      // Read again first: the screen stops it by the seats it last read.
      await from.cdp("Page.bringToFront"); await from.reload(); await from.evaluate(answerYes); await from.evaluate(`document.querySelector("#message").textContent = ""`);
      await from.evaluate(`document.querySelector('[data-action="manage"]').click()`); await from.until(`!!document.querySelector('#dialog [data-action="rotate"][data-role="owner"]')`, 20000);
      await from.evaluate(`document.querySelector('#dialog [data-action="rotate"][data-role="owner"]').click()`);
      await from.until(`!!document.querySelector("#issued-link") || (document.querySelector("#message")?.textContent ?? "") !== ""`, 20000);
      return await from.evaluate(`document.querySelector("#issued-link")?.value ?? ""`) as string;
    };
    const asked = (b: B) => b.evaluate(`document.querySelector("#dialog")?.open && document.querySelector("#dialog").textContent.includes("前のオーナーの端末で読める鍵のままです")`) as Promise<boolean>;
    let last: B | undefined, purged = false;
    await nextMinute();
    try {
      const first = await withPasskey(await browser()); last = first;
      await first.join(askTrip.url); await first.until(`!!document.querySelector('[data-trip-key="held"]')`); await first.evaluate(answerYes);
      await first.evaluate(`document.querySelector('[data-action="seal-trip"]').click()`);
      await first.until(`${message} === "旅行を、メンバーにだけ読める形にしました。"`, 30000); await first.reload(); await first.evaluate(answerYes);
      // (1)
      const ownerGrant = async (b: B) => (await b.evaluate(`(async () => (await (await vfetch("/v1/c/${tripId}/grants")).json()).filter(g => g.role === "owner").map(g => g.id + ":" + (g.revoked ?? "")))()`)) as string[];
      const before = await ownerGrant(first);
      assert.equal(await handOverOwner(first), "", "交換 of the owner invite went on with no other seat holding the key");
      assert.equal(await first.evaluate(message), "鍵を持つメンバーが他にいないため、交換すると旅程をだれも読めなくなります。先に別の端末かメンバーに鍵を渡してください");
      assert.deepEqual(await ownerGrant(first), before, "the owner invite changed");
      await first.evaluate(`document.querySelector('#dialog [data-action="close"]')?.click()`);
      // (2)
      const a = await enter(await issue(first)); await handOver(first, a);
      const g1 = await generation(first), link1 = await handOverOwner(first);
      assert.ok(link1, "the owner invite was not handed over with A holding the key");
      const second = await withPasskey(await browser()); last = second; await enter(link1, second);
      await handOver(a, second);
      await second.until(`document.querySelector("#dialog")?.open && document.querySelector("#dialog").textContent.includes("前のオーナーの端末で読める鍵のままです")`, 20000);
      await second.evaluate(answerYes); await second.evaluate(`document.querySelector('#dialog [data-action="rekey"]').click()`);
      await second.until(`(document.querySelector("#message")?.textContent ?? "").startsWith("旅行の鍵を替えました")`, 30000);
      assert.equal(await generation(second), g1 + 1, "鍵を替える did not move the generation on");
      await a.reload(); assert.equal(await a.evaluate(`document.querySelector(".hero h1")?.textContent`), title);
      await nextMinute();
      const link2 = await handOverOwner(second); assert.ok(link2);
      const third = await withPasskey(await browser()); last = third; await enter(link2, third);
      await handOver(a, third);
      await third.until(`document.querySelector("#dialog")?.open && document.querySelector("#dialog").textContent.includes("前のオーナーの端末で読める鍵のままです")`, 20000);
      await third.evaluate(answerYes); await third.evaluate(`document.querySelector('#dialog [data-action="rekey-keep"]').click()`);
      await third.until(`${message} === "鍵はそのままです"`, 30000);
      assert.equal(await generation(third), g1 + 1, "替えない moved the generation");
      await third.reload(); await sleep(500); assert.equal(await asked(third), false, "替えない asked again");
      // (3)
      await nextMinute();
      const p = await withPasskey(await enter(await issue(third))), pSeat = await handOver(third, p);
      const pair = (await view(p)).seatKey.x25519 as string;
      await p.evaluate(answerYes); await p.evaluate(`document.querySelector('footer [data-action="passkey-register"]').click()`);
      await p.until(`(document.querySelector("#message")?.textContent ?? "").startsWith("パスキーを登録しました")`, 30000);
      const listed = (await view(third)).seats.find((x: { id: string }) => x.id === pSeat);
      assert.ok(listed.since && listed.x25519 !== pair && listed.since.x25519 === pair, "the pair made again carries since");
      await third.cdp("Page.bringToFront"); await third.evaluate(answerYes); await third.evaluate(`document.querySelector("#message").textContent = ""`);
      await third.evaluate(`document.querySelector('[data-action="manage"]').click()`);
      const aSeat = (await view(a)).self.id as string;
      await third.until(`!!document.querySelector('#dialog [data-action="revoke-member"][data-id="${aSeat}"]')`, 20000);
      await third.evaluate(`document.querySelector('#dialog [data-action="revoke-member"][data-id="${aSeat}"]').click()`);
      await third.until(`${message} === "旅行の鍵を替えました。"`, 30000);
      const pv = await view(p); assert.equal(pv.seatKey.generation, pv.sealed.generation, "the seat made again was not wrapped");
      await p.reload(); assert.equal(await p.evaluate(`document.querySelector(".hero h1")?.textContent`), title);
      // Closed first, and the 「完全に削除」 waited for in the dialog the press opened: a closed one keeps what it showed (#1027).
      await third.evaluate(`document.querySelector('#dialog [data-action="close"]')?.click()`); await third.until(`!document.querySelector("#dialog").open`);
      await third.evaluate(answerYes); await third.evaluate(`document.querySelector('[data-action="manage"]').click()`); await third.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="purge"]')`);
      await third.evaluate(`document.querySelector('#dialog [data-action="purge"]').click()`); await third.until(`!!document.querySelector('#dialog form[data-form="purge"]')`);
      await third.evaluate(`(() => { document.querySelector('#dialog input[name="title"]').value = ${JSON.stringify(title)}; document.querySelector('#dialog form[data-form="purge"]').requestSubmit(); return true; })()`);
      await third.until(`document.querySelector("main.empty h1")?.textContent === "カプセルを削除しました。"`, 30000); purged = true;
    } finally {
      if (!purged && last) try { const v = await last.evaluate(`(async () => { const v = await (await vfetch("/v1/c/${tripId}")).json(); return (await vfetch("/v1/c/${tripId}/purge", { method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify({ title: ${JSON.stringify(title)} }) })).status; })()`); purged = v === 200; } catch { /* reported below */ }
      for (const b of opened) { await b.close(); await dispose(b.context); }
      if (!purged) console.log(`Could not remove the owner hand-over scene's test capsule ${tripId}: purge it by hand (title "${title}").`);
    }
  }
  console.log("Owner hand-over verification: owner の交換を止める (交換 of the owner invite stopped with no other seat holding the key, the invite unchanged), owner の交換 (the new owner taking the key from a member by the codes and asked 鍵を替えますか: replaced, the member reading the next generation; handed over again, kept with the generation unchanged and not asked again), 作り直し (a participant registering a passkey after taking the key: its pair made again with since, wrapped when the owner next replaced the key, and reading the trip).");
}

// The creator's screens (#995): a creator made from an enrollment link the loopback bun run dev hands out (src/local-identity.ts,
// the IAM publisher's on AWS) with a passkey of this page's virtual authenticator, another device added, the right to create handed
// to the group's owner by a delegation link (on the clipboard only), and that delegate revoked. No trip is published for it: who
// may create is read from GET /v1/account (canCreate, creator). Creators cannot be removed, so they stay in the dev data's registry.
async function creator() {
  const label = "画面確認の作成者", delegate = `${label} の委任`, pages: Array<NonNullable<typeof owner> & { context: string }> = [];
  // A browser of its own (its cookies and passkeys), with a virtual authenticator, the clipboard allowed and the passkeys it makes counted.
  const browser = async () => {
    const context = (await send("Target.createBrowserContext")).browserContextId as string, p = Object.assign(await page(390, 844, true, context), { context });
    pages.push(p); await opening(p); await send("Browser.grantPermissions", { origin, browserContextId: context, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    return p;
  };
  const opening = async (p: NonNullable<typeof owner>) => {
    await p.cdp("WebAuthn.enable"); await p.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    await p.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
    await p.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `window.made = 0; { const create = navigator.credentials.create.bind(navigator.credentials); navigator.credentials.create = o => { window.made++; return create(o); }; }` });
  };
  const account = (p: NonNullable<typeof owner>) => p.evaluate(`(async () => await (await fetch("/v1/account")).json())()`) as Promise<{ canCreate: boolean; creator: { label: string; delegated: boolean; delegates: Array<{ label: string }> } | null }>;
  const heading = `document.querySelector("main h1")?.textContent`, text = `document.body.innerText`;
  const go = async (p: NonNullable<typeof owner>, url: string) => { await p.cdp("Page.bringToFront"); await p.cdp("Page.navigate", { url }); };
  // The link a page copied (never printed), read from the same page's clipboard after the screen said it was copied.
  const copied = async (p: NonNullable<typeof owner>, said: string) => {
    await p.until(`(${message} ?? "").startsWith(${JSON.stringify(said)})`, 20000);
    // Compared in the page, so that no expression here (named in an error) holds the link.
    assert.equal(await p.evaluate(`(async () => { const u = await navigator.clipboard.readText(); return ${text}.includes(u) || ${text}.includes(new URL(u).hash.slice(1)); })()`), false, "a copied link is on the screen");
    return await p.evaluate(`navigator.clipboard.readText()`) as string;
  };
  // The enrollment screen's passkey made, and the top page after it.
  const register = async (p: NonNullable<typeof owner>, title: string) => {
    await p.until(`${heading} === ${JSON.stringify(title)} && !!document.querySelector('[data-action="creator-register"]')`, 20000);
    await p.evaluate(`document.querySelector('[data-action="creator-register"]').click()`);
  };
  const card = (name: string) => `[...document.querySelectorAll(".card p")].some(p => p.textContent === "作成者: " + ${JSON.stringify(name)})`;
  try {
    // (a) the enrollment link from the loopback host (the script's request, with no cookie), opened in A's browser: a passkey made
    // there, the top page then shows A's creator card, and the host answers A as a creator that may hand the right on.
    const enrolled = await fetch(origin + "/v1/creators/enroll", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ label, confirm: true }) });
    if (enrolled.status !== 201) throw new Error(`verify:ui creator はループバックの bun run dev に向けてください（POST /v1/creators/enroll が ${enrolled.status}）`);
    const a = await browser(); await go(a, (await enrolled.json() as { url: string }).url);
    await register(a, "作成者として登録する"); await a.until(card(label), 20000);
    assert.equal(await a.evaluate(`location.hash`), ""); assert.deepEqual(await a.evaluate(`window.made`), 1);
    assert.deepEqual(((await account(a)).creator), { label, delegated: false, delegates: [] });
    // (b) 別の端末を追加: the link on A's clipboard, opened in A2's browser, which becomes the same creator with a passkey of its own.
    await a.evaluate(`document.querySelector('[data-action="creator-add-device"]').click()`);
    const device = await copied(a, "登録リンクをコピーしました（画面には表示しません）。");
    const a2 = await browser(); await go(a2, device); await register(a2, "作成者として登録する"); await a2.until(card(label), 20000);
    assert.equal((await account(a2)).creator?.label, label);
    // (c) the group's trip, its owner B; A hands B the right to create. Something that is no trip's URL is refused on the screen;
    // the trip's URL puts a delegation link for it on A's clipboard, and not on the screen.
    await openTrip(); const tripUrl = `${origin}/c/${capsuleId}`;
    await nextMinute(); await a.cdp("Page.bringToFront");
    await a.evaluate(`(() => { document.querySelector("[data-delegate-trip]").value = "週末の旅行"; document.querySelector('[data-action="creator-delegate"]').click(); return true; })()`);
    await a.until(`${message} === "旅行の URL を貼ってください"`);
    await a.evaluate(`(() => { document.querySelector("[data-delegate-trip]").value = ${JSON.stringify(tripUrl)}; document.querySelector('[data-action="creator-delegate"]').click(); return true; })()`);
    const delegation = await copied(a, "委任リンクをコピーしました（画面には表示しません）。");
    assert.ok(delegation.startsWith(`${tripUrl}#delegate=`), "the delegation link is not for the group's trip");
    // (d) a browser without the trip's owner seat is stopped before its OS makes a passkey.
    const c = await browser(); await go(c, delegation);
    await c.until(`${heading} === "作成権限を受け取る" && !!document.querySelector(".warning")`, 20000);
    assert.deepEqual(await c.evaluate(`[!!document.querySelector('[data-action="creator-register"]'), window.made]`), [false, 0]);
    // (e) B's own trip tab (another tab of the owner's browser, with a passkey of its own) given the link as a new fragment: the page
    // is read afresh as the delegation screen, and stays so through the page's reading every 20 seconds after the trip changed
    // (from the owner's other tab). Before #203's review (c392ef1) the trip was drawn back over it here.
    const b = Object.assign(await page(390, 844, true), { context: "" }); pages.push(b); await opening(b); await go(b, tripUrl); await b.until(drawn, 20000);
    await b.cdp("Page.navigate", { url: tripUrl + new URL(delegation).hash });  // the fragment only: the same page, its hashchange
    await b.until(`${heading} === "作成権限を受け取る" && !!document.querySelector('[data-action="creator-register"]')`, 20000);
    const preset = (await opened(owner!)).spec.theme.preset as string;
    await setSpec(spec => { spec.theme.preset = preset === "night" ? "minimal" : "night"; }); await b.cdp("Page.bringToFront"); await sleep(21000);
    assert.equal(await b.evaluate(heading), "作成権限を受け取る", "the delegation screen was drawn over after the trip changed");
    await register(b, "作成権限を受け取る");
    // Taken, the page goes to the top afresh: the delegate's card, no 作成権限を分ける (a delegate cannot hand it on), the link gone
    // from the address bar; and it stays the top page through the next readings, the trip changed again.
    await b.until(`location.pathname === "/" && ${card(delegate)}`, 20000);
    assert.deepEqual(await b.evaluate(`[location.hash, !!document.querySelector("[data-delegate-trip]")]`), ["", false]);
    assert.equal((await account(b)).creator?.delegated, true);
    await setSpec(spec => { spec.theme.preset = preset; }); await b.cdp("Page.bringToFront"); await sleep(21000);
    assert.deepEqual(await b.evaluate(`[location.pathname, ${card(delegate)}, !!document.querySelector(".timeline, .timeline-list")]`), ["/", true, false], "the trip was drawn over the top page after taking the right");
    // The same link again is refused as used, before any passkey.
    await go(b, delegation); await b.until(`(document.querySelector(".warning")?.textContent ?? "").includes("使用済み")`, 20000);
    assert.equal(await b.evaluate(`!!document.querySelector('[data-action="creator-register"]')`), false);
    // (f) A revokes the delegate from 分けた作成者 (the confirm() answered yes): gone from the list, and B may no longer create.
    await nextMinute(); await a.cdp("Page.bringToFront"); await a.cdp("Page.reload"); await a.until(`!!document.querySelector('[data-action="creator-revoke-delegate"]')`, 20000);
    assert.deepEqual(await a.evaluate(`[...document.querySelectorAll('[data-action="creator-revoke-delegate"]')].map(x => x.dataset.title)`), [delegate]);
    await a.evaluate(answerYes); await a.evaluate(`document.querySelector('[data-action="creator-revoke-delegate"]').click()`);
    await a.until(`${message} === "作成権限を失効しました。"`, 20000);
    assert.deepEqual(await a.evaluate(`[window.asked.length, document.querySelectorAll('[data-action="creator-revoke-delegate"]').length]`), [1, 0]);
    assert.deepEqual([(await account(a)).creator?.delegates, (await account(b)).canCreate], [[], false]);
    // A signs out (the creator itself stays in the registry): the cookie gone, the loopback host answers for the page again.
    await a.evaluate(`document.querySelector('[data-action="creator-signout"]').click()`); await a.until(`${message} === "サインアウトしました。"`, 20000);
    assert.deepEqual([(await account(a)).creator ?? null, await a.evaluate(card(label))], [null, false]);
  } finally {
    for (const p of pages) { await p.close(); if (p.context) await dispose(p.context); }
  }
  console.log("Creator verification: an enrollment link from the loopback host made a creator with a passkey (the creator card), 別の端末を追加 (the link on the clipboard only, a second browser the same creator), 作成権限を分ける (a non-URL refused, the delegation link on the clipboard only), a browser without the owner seat stopped before making a passkey, the link opened in the owner's trip tab read afresh and kept through the trip changing, taken there to a top page that stays (the delegate's card, no 作成権限を分ける), the used link refused, the delegate revoked from 分けた作成者 (no longer able to create), and the creator signed out.");
}

try {
  for (const name of chosen.length ? chosen : Object.keys(groups)) {
    const started = Date.now();
    try { await groups[name]!(); } finally { await closeTrip(false); await owner?.close(); owner = undefined; }
    console.log(`[${name}] ${Math.round((Date.now() - started) / 1000)} s`);
  }
} finally {
  console.log(`Pages open at once, at most: ${peak}`);
  try { await send("Browser.close"); } catch { /* already gone */ }
  chrome.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true });
}
