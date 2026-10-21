import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testTrip, tripDay } from "./test-fixture";
import { localDay } from "./schema";
import { revisable } from "./revise";

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
// Last, the trip sealed under the trip's key from the owner's page (#691): drawn from what the page opens, "＋", the grip, a promoted
// suggestion, no 旅を保存 or チャットで直す, and a purge with another title not sent.
// A disposable fictional capsule, purged at the end; no link or cookie is printed. No dependency: Bun has WebSocket and fetch, and Chrome is found on this machine (or named in CHROME_PATH).
const origin = process.env.CAPSULE_ORIGIN ?? "http://localhost:47840";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Verification is restricted to a local host");
const chromePath = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
if (!chromePath) throw new Error("Chrome not found. Set CHROME_PATH to the browser's executable");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
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
ws.addEventListener("message", m => { const d = JSON.parse(String(m.data)), w = waiting.get(d.id); if (w) { waiting.delete(d.id); d.error ? w.reject(new Error(d.error.message)) : w.resolve(d.result); }
  if (d.method === "Network.requestWillBeSent" && d.sessionId) asked.set(d.sessionId, [...asked.get(d.sessionId) ?? [], d.params.request.url]); });
// A browser that went away must not leave a call waiting for ever: the cleanup below still has to run and name the capsule.
const dropAll = (why: string) => { for (const [id, w] of waiting) { waiting.delete(id); w.reject(new Error(why)); } };
ws.addEventListener("close", () => dropAll("Chrome closed the connection")); ws.addEventListener("error", () => dropAll("Chrome connection failed"));
const send = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
  if (ws.readyState !== WebSocket.OPEN) return reject(new Error("Chrome is not connected"));
  const id = ++seq, timer = setTimeout(() => { if (waiting.delete(id)) reject(new Error(`${method} did not answer in 30 s`)); }, 30000);
  waiting.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
// A page has no <geolocation> element unless asked for (`element`): the scenes before the element's own run the button every other
// browser has, and its absence is what they check (#675).
async function page(width: number, height: number, mobile: boolean, context?: string, element = false) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank", ...(context ? { browserContextId: context } : {}) });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method: string, params: object = {}) => send(method, params, sessionId);
  await s("Page.enable"); await s("Runtime.enable"); await s("Network.enable");
  if (!element) await s("Page.addScriptToEvaluateOnNewDocument", { source: `delete window.HTMLGeolocationElement;` });
  const requests = () => asked.get(sessionId) ?? [];
  const size = async (w: number, h: number, touch: boolean) => { await s("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: touch }); await s("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: 1 }); };
  await size(width, height, mobile);
  const evaluate = async (expression: string) => { const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  const until = async (expression: string, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await evaluate(expression)) return; await sleep(100); } throw new Error("timed out waiting for: " + expression + " | dialog: " + await evaluate(`(document.querySelector("#dialog")?.open ? "open " : "closed ") + (document.querySelector("#dialog")?.innerText ?? "")`).catch(() => "?") + " | notice: " + await evaluate(`[...document.querySelectorAll(".notice,[role=status],[role=alert]")].map(x => x.textContent).join(" / ")`).catch(() => "?")); };
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
  const join = async (url: string) => { await s("Page.navigate", { url }); await until(`!!document.querySelector('[data-action="join"]')`); await evaluate(`document.querySelector('[data-action="join"]').click()`); await until(`!!document.querySelector(".timeline, .timeline-list")`); const shown = await evaluate(`document.querySelector("#dialog").textContent`) as string; await evaluate(`document.querySelector('#dialog [data-action="close"]')?.click()`); await sleep(200); return shown; };
  const reload = async () => { await s("Page.reload"); await sleep(300); await until(`!!document.querySelector(".timeline, .timeline-list")`); };
  // A real press (CDP input): the <geolocation> element only answers a trusted one.
  const press = async (selector: string) => {
    // The page settles (the map above loads) after the element is first in view: press where it is once it has stayed in one place.
    const where = () => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center", behavior: "instant" }); const b = e.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()`) as Promise<number[]>;
    let at = await where();
    // A <geolocation> element answers only once it has validated itself, which it does in view.
    await until(`document.querySelector(${JSON.stringify(selector)}).isValid !== false`); for (let i = 0; i < 50; i++) { await sleep(200); const now = await where(); if (now[0] === at[0] && now[1] === at[1]) break; at = now; }
    for (const type of ["mousePressed", "mouseReleased"]) await s("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 });
  };
  return { evaluate, until, key, box, drag, join, reload, size, requests, press, cdp: s };
}
// What the day's rows say, whichever way they are shown.
const order = `[...document.querySelectorAll("[data-order-day] [data-item]")].map(r => r.dataset.item).join()`;
const message = `document.querySelector("#message").textContent`;
const timeOf = (id: string) => `document.querySelector('[data-item="${id}"] .event-time, [data-item="${id}"] .row-time').firstChild.textContent`;
const heading = `document.querySelector(".section-heading").scrollIntoView({ block: "start" })`;

let capsuleId = "", owner: Awaited<ReturnType<typeof page>> | undefined, checkedAt = 0;
// The page talks to the host with its own cookie; the script never sees it. An owner's important action sent this way past the
// passkey check's five minutes is answered 428: like the screen, it checks the passkey (the authenticator answers) and sends the
// action once more, so a slow run does not fail a scene that is not about the check (#759). The check's time is kept for (i).
const sendFromPage = (action: string, body: object, method: string) => owner!.evaluate(`(async () => { const revision = (await (await fetch("/v1/c/${capsuleId}")).json()).document.revision; const r = await fetch("/v1/c/${capsuleId}/${action}", { method: "${method}", headers: { "Content-Type": "application/json", "If-Match": '"' + revision + '"' }, body: ${JSON.stringify(JSON.stringify(body))} }); return { status: r.status, body: await r.json() }; })()`) as Promise<{ status: number; body: any }>;
const checkFromPage = () => owner!.evaluate(`(async () => {
  const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""), unb64 = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const post = (path, body) => fetch("/v1/c/${capsuleId}/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const { challenge, rpId } = await (await post("passkey/challenge", {})).json();
  const c = await navigator.credentials.get({ publicKey: { challenge: unb64(challenge), rpId, userVerification: "required" } }), r = c.response;
  return (await post("passkey/verify", { challenge, id: c.id, clientDataJSON: b64(r.clientDataJSON), authenticatorData: b64(r.authenticatorData), signature: b64(r.signature) })).status;
})()`) as Promise<number>;
const fromPage = async (action: string, body: object, method = "POST") => {
  const first = await sendFromPage(action, body, method); if (first.status !== 428) return first;
  assert.equal(await checkFromPage(), 200, `the passkey check before ${method} ${action}`); checkedAt = Date.now();
  return sendFromPage(action, body, method);
};
try {
  const created = await fetch(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) });
  assert.equal(created.status, 201); const c = await created.json() as { id: string; url: string }; capsuleId = c.id;
  owner = await page(390, 844, true);
  // The dialog after joining tells the owner, and only the owner, that the passkey is also the check before important actions.
  assert.equal((await owner.join(c.url)).includes("オーナーは、招待の発行や削除などの前の本人確認にも使います。"), true);
  // (a) #689: the owner's first opening makes the trip's key and the seat's key pair in this browser: the seat shows its public keys
  // (the owner's list of invites), the page says this device holds the key, and the host was handed nothing it could open.
  await owner.until(`!!document.querySelector('[data-trip-key="held"]')`);
  assert.equal(await owner.evaluate(`document.querySelector('[data-trip-key="held"]').textContent`), "この端末に鍵がある");
  assert.deepEqual(await owner.evaluate(`(async () => { const g = await (await fetch("/v1/c/${capsuleId}/grants")).json(), self = g.flatMap(x => x.members).find(m => m.self); return [Object.keys(self.publicKey ?? {}).sort(), self.publicKey?.x25519?.length, JSON.stringify(g).includes("wrapped")]; })()`), [["ed25519", "x25519"], 43, false]);
  assert.equal(await owner.evaluate(`document.querySelectorAll('.diary, [data-action="new-private"]').length`), 0, "the itinerary still contains a diary entry point");
  assert.equal(await owner.evaluate(`!!document.querySelector('.topbar [data-action="revise"]')`), false);
  // (i) an owner's important action: the first invite asks to register a passkey on this phone, which counts as the check, and
  // is then issued; a second within five minutes asks nothing. The confirm() is answered yes and remembered (after each reload).
  await owner.cdp("WebAuthn.enable"); const { authenticatorId } = await owner.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  // The OS's passkey checks and creations are counted too: the authenticator answers them silently, so a count is the only way
  // to see they were asked.
  const answerYes = `(() => { window.asked ??= []; window.confirm = m => { window.asked.push(m); return true; }; window.checks = 0; window.made = 0; const get = navigator.credentials.get.bind(navigator.credentials); navigator.credentials.get = o => { window.checks++; return get(o); }; const create = navigator.credentials.create.bind(navigator.credentials); navigator.credentials.create = o => { window.made++; return create(o); }; return true; })()`;
  const invite = async (role = "participant") => {
    await owner!.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner!.until(`!!document.querySelector('#dialog form[data-form="grant"]')`);
    await owner!.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="grant"]'); f.elements.namedItem("role").value = "${role}"; f.requestSubmit(); return true; })()`); await owner!.until(`!!document.querySelector("#issued-link")`);
    const url = await owner!.evaluate(`document.querySelector("#issued-link").value`) as string; await owner!.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); return url;
  };
  await owner.evaluate(answerYes); await invite(); checkedAt = Date.now();
  assert.equal(await owner.evaluate(`[...document.querySelectorAll('[data-action="insert-private-item"]')].every(b => b.textContent.includes("試験機能") && b.getAttribute("aria-label").includes("試験機能"))`), true, "personal insertion entrances must show trial status");
  assert.deepEqual(await owner.evaluate(`window.asked`), ["この操作には、この端末でのパスキー（Face ID・指紋）の確認が要ります。パスキーを登録して続けますか？"]);
  assert.equal(await owner.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).passkey)()`), true);
  const participantLink = await invite(), viewerLink = await invite("viewer"), editorLink = await invite("editor"); assert.deepEqual(await owner.evaluate(`[window.asked.length, window.checks]`), [1, 1]);  // the one check is the new passkey's PRF output, asked once more to wrap the seat's keys (#689)
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
  // The trip's Spec changed from the owner's page (a change of settings: inside the passkey check's five minutes).
  const setSpec = async (change: (spec: any) => void) => { const spec = await owner!.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).spec)()`); change(spec); assert.equal((await fromPage("spec", { spec, confirm: true }, "PATCH")).status, 200); };
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
  await look.cdp("Page.close"); await setTheme("paper"); await owner.reload();
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
  await assistHome.cdp("Page.close");
  for (const [name, r] of Object.entries(ratios.night!)) assert.ok(r >= 4.5, `night: ${name} has a contrast of ${r}, under 4.5`);
  // (l) 旅を保存, at 375px: the header's button opens a dialog with 「旅程のページを保存」, 「Markdown をコピー」 and, for the owner, 「ZIP を保存」 with a
  // line for each file of this trip's exports, nothing off the side. With the clipboard allowed, the copy is the host's
  // export.md; without, the same text is shown selected. 共有・管理 leads to the same dialog. A trip whose exports are only
  // Markdown lists no index.html (set inside the passkey check's five minutes, as the themes are). 「旅程のページを保存」 downloads
  // trip-<初日>.html holding the host's export.html where the browser cannot share a file (headless Chrome has no navigator.share),
  // and hands that file, as text/html, to the share sheet where it can (navigator.share stubbed here).
  const saveDialog = `[!!document.querySelector('#dialog [data-action="save-page"]'), !!document.querySelector('#dialog [data-action="copy-markdown"]'), !!document.querySelector('#dialog a[href$="/export"]'), [...document.querySelectorAll("#dialog li")].map(l => l.textContent), [...document.querySelectorAll("#dialog p")].some(p => p.textContent.includes("スマホでは「ファイル」アプリ（iPhone）やファイルマネージャ（Android）で ZIP をタップすると展開されます。"))]`;
  const files = ["README.md — メモや Markdown のアプリで読める旅行記です。", "trip.json — データの控えです（読むためのものではありません）。", "calendar.ics — 開くと、決定した予定をカレンダーに取り込めます。", "index.html — ブラウザで開くと、旅程のページとして読めます。"];
  const openSave = async (p: typeof owner, from = "") => { await p!.evaluate(`document.querySelector('${from}[data-action="save"]').click()`); await p!.until(`!!document.querySelector('#dialog [data-action="copy-markdown"]')`); };
  const markdown = `(async () => (await (await fetch("/v1/c/${capsuleId}/export.md")).json()).text)()`;
  await owner.size(375, 812, true); await owner.reload(); await openSave(owner);
  assert.deepEqual(await owner.evaluate(saveDialog), [true, true, true, files, true]);
  assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375`), true, "the 旅を保存 dialog runs off the side of a 375px screen");
  const text = await owner.evaluate(markdown) as string; assert.match(text, new RegExp(`^---\ntitle: "${title}"`));
  await send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }); await owner.cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await owner.evaluate(`document.querySelector('#dialog [data-action="copy-markdown"]').click()`); await owner.until(`${message} === "旅程を Markdown でコピーしました。メモアプリなどに貼って残してください。"`);
  assert.equal(await owner.evaluate(`navigator.clipboard.readText()`), text);
  await send("Browser.resetPermissions"); await owner.evaluate(`document.querySelector('#dialog [data-action="copy-markdown"]').click()`); await owner.until(`!!document.querySelector("#markdown-text")`);
  assert.deepEqual(await owner.evaluate(`(() => { const t = document.querySelector("#markdown-text"); return [t.value, t.selectionStart, t.selectionEnd === t.value.length, document.activeElement === t]; })()`), [text, 0, true, true]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector('#dialog [data-action="save"]')`);
  await openSave(owner, "#dialog "); assert.deepEqual(await owner.evaluate(saveDialog), [true, true, true, files, true]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  const setExports = (exports: string[]) => setSpec(spec => { spec.exports = exports; });
  await setExports(["markdown"]); await owner.reload(); await openSave(owner); assert.deepEqual(await owner.evaluate(saveDialog), [true, true, true, files.slice(0, 1), true]);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await setExports(["markdown", "json", "ics", "html"]); await owner.reload();
  const pageName = `trip-${seed.spec.trip.startsOn}.html`, pageDownloads = join(profile, "page-downloads"), pageFile = join(pageDownloads, pageName);
  const tripPage = await owner.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}/export.html")).json()).text)()`) as string;
  assert.ok(tripPage.startsWith("<!doctype html>") && tripPage.includes(`<h1>${title}</h1>`), "export.html is not the trip page");
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: pageDownloads });
  await openSave(owner); await owner.evaluate(`document.querySelector('#dialog [data-action="save-page"]').click()`);
  for (let i = 0; i < 100 && !existsSync(pageFile); i++) await sleep(100);
  assert.equal(readFileSync(pageFile, "utf8"), tripPage, "the downloaded trip page is not the host's export.html");
  await owner.until(`${message} === "旅程のページを保存しました。ブラウザで開くと旅のしおりとして読めます。"`);
  await owner.evaluate(`(() => { window.shared = []; navigator.canShare = () => true; navigator.share = async d => { window.shared.push(d); }; return true; })()`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="save-page"]').click()`); await owner.until(`window.shared.length === 1`);
  assert.deepEqual(await owner.evaluate(`(async () => { const d = window.shared[0]; return [d.files.length, d.files[0].type, d.files[0].name, await d.files[0].text()]; })()`), [1, "text/html", pageName, tripPage]);
  // A trip page that could not be fetched when the dialog opened is fetched again by the tap, and the failure is not left unhandled.
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.evaluate(`(() => { window.unhandled = 0; addEventListener("unhandledrejection", () => window.unhandled++); window.realFetch = window.fetch; window.fetch = (u, ...r) => String(u).endsWith("/export.html") ? Promise.reject(new TypeError("offline")) : window.realFetch(u, ...r); window.shared = []; return true; })()`);
  await openSave(owner); await sleep(300); await owner.evaluate(`(() => { window.fetch = window.realFetch; return true; })()`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="save-page"]').click()`); await owner.until(`window.shared.length === 1`);
  assert.deepEqual(await owner.evaluate(`(async () => [await window.shared[0].files[0].text(), window.unhandled])()`), [tripPage, 0]);
  // A tap that had to wait for the trip page may lose the browser's permission to open the share sheet (NotAllowedError, stubbed
  // here): the page then asks for one more tap instead of downloading, and that tap, with the page at hand, shares it.
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.evaluate(`(() => { window.fetch = (u, ...r) => String(u).endsWith("/export.html") ? new Promise(ok => setTimeout(ok, 1500)).then(() => window.realFetch(u, ...r)) : window.realFetch(u, ...r); window.shared = []; window.refused = 0; navigator.share = async d => { if (!window.refused++) throw new DOMException("no activation", "NotAllowedError"); window.shared.push(d); }; return true; })()`);
  await openSave(owner); await owner.evaluate(`document.querySelector('#dialog [data-action="save-page"]').click()`);
  await owner.until(`${message} === "旅程のページの用意ができました。もう一度押すと共有できます。"`); assert.deepEqual(await owner.evaluate(`[window.refused, window.shared.length]`), [1, 0]);
  await owner.evaluate(`(() => { window.fetch = window.realFetch; document.querySelector('#dialog [data-action="save-page"]').click(); return true; })()`); await owner.until(`window.shared.length === 1`);
  assert.equal(await owner.evaluate(`window.shared[0].files[0].text()`), tripPage);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await owner.reload();
  // (p) 招待とオーナーの履歴, still at 375px and inside the passkey check's five minutes: the owner issues a participant invite
  // named 履歴確認用 and revokes it; 共有・管理 opened again lists the two first, newest first, each with the date and time, the
  // role, the link's name and this phone's member name and device, nothing off the side.
  const manageOpen = async () => { await owner!.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner!.until(`!!document.querySelector("#dialog details.history")`); };
  const historyInvite = `[...document.querySelectorAll("#dialog .grant")].find(g => g.querySelector("strong")?.textContent === "履歴確認用")`;
  await manageOpen();
  await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="grant"]'); f.elements.namedItem("role").value = "participant"; f.elements.namedItem("label").value = "履歴確認用"; f.requestSubmit(); return true; })()`);
  await owner.until(`!!document.querySelector("#issued-link")`); await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await manageOpen(); await owner.evaluate(`(() => { window.confirm = () => true; ${historyInvite}.querySelector('[data-action="revoke"]').click(); return true; })()`); await owner.until(`!!document.querySelector("#dialog details.history") && !${historyInvite}`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await manageOpen();
  const self = await owner.evaluate(`[...document.querySelectorAll("#dialog .member")].find(m => m.textContent.includes("（この端末）")).textContent.split("（この端末）")[0]`) as string;
  const historyLines = await owner.evaluate(`(() => { document.querySelector("#dialog details.history").open = true; return [...document.querySelectorAll("#dialog details.history li")].slice(0, 2).map(l => l.textContent); })()`) as string[];
  for (const [line, what] of [[historyLines[0], "招待を失効"], [historyLines[1], "招待を発行"]] as const) {
    for (const part of [what, "参加者", "履歴確認用", self]) assert.ok(line?.includes(` · ${part}`), `the history line ${JSON.stringify(line)} does not name ${part}`);
    // It starts with the date and time, and ends with this phone's device after the member name.
    assert.match(line!, new RegExp(`^\\d{4}/\\d{1,2}/\\d{1,2} \\d{2}:\\d{2} · .* · ${self.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}（[^（）]+）$`), `the history line ${JSON.stringify(line)} has no time or device`);
  }
  assert.equal(await owner.evaluate(`document.documentElement.scrollWidth <= 375 && document.querySelector("#dialog details.history").getBoundingClientRect().right <= 375`), true, "the history runs off the side of a 375px screen");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await owner.reload(); await owner.size(390, 844, true);
  // The dialogs and reloads above spend much of the owner's 120 requests a minute (see (j)): what follows starts in a fresh minute.
  await sleep(61000 - Date.now() % 60000);
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
  const edit = async (id: string) => { await owner!.evaluate(`document.querySelector('[data-action="edit-item"][data-id="${id}"]').click()`); await owner!.until(`!!document.querySelector('#dialog form[data-form="item"]')`); };
  const field = `document.querySelector('#dialog input[name="time"]')`, box = `document.querySelector('#dialog input[name="tentative"]')`;
  const submit = `document.querySelector('#dialog form[data-form="item"]').requestSubmit()`;
  await edit("five"); assert.deepEqual(await owner.evaluate(`[${field}.value, ${field}.required, ${box}.checked]`), ["13:00", true, true]);
  await owner.evaluate(submit); await owner.until(`${timeOf("five")} === "13:00 – 15:00 ごろ"`);
  const endOf = (id: string) => owner!.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).document.items.find(i => i.id === "${id}").endsAt)()`);
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
  const itemOf = (id: string) => owner!.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).document.items.find(i => i.id === "${id}"))()`), two = await itemOf("two");
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
  const day2 = tripDay(day, 1);
  for (const [id, t, time] of [["p1", "朝の予定", "09:00"], ["p2", "昼の予定", "11:00"], ["p3", "午後の予定", "13:00"]]) assert.equal((await fromPage("document", { type: "item", item: { id, title: t, day: day2, startsAt: `${day2}T${time}:00+09:00`, kind: "activity", status: "confirmed", revision: 1 } }, "PATCH")).status, 200);
  await owner.reload(); await owner.evaluate(`document.querySelector('[data-action="day"][data-day="${day2}"]').click()`); await owner.until(`!!document.querySelector('[data-item="p1"]')`);
  assert.deepEqual(await owner.evaluate(`[...document.querySelectorAll('[data-action="insert-item"]')].map(b => b.dataset.after + ":" + b.getAttribute("aria-label"))`), ["p1:朝の予定の後に共有予定を追加", "p2:昼の予定の後に共有予定を追加", "p3:午後の予定の後に共有予定を追加"]);
  // Boundary entries must not add a row: compare every itinerary row with the entries removed.
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
  const moved = await owner.evaluate(`${form}.dataset.id`); await owner.evaluate(submit); await owner.until(`${message} === "保存しました。"`);
  assert.deepEqual(await owner.evaluate(`(async () => { const items = (await (await fetch("/v1/c/${capsuleId}")).json()).document.items.filter(i => i.day === "${day}"); return [items.findIndex(i => i.id === "${moved}"), items.findIndex(i => i.id === "four")]; })()`).then((x: number[]) => x[0]! === x[1]! + 1), true);
  // Wait for the modal to close; a previous identical save notice can still be visible while the request is pending.
  await owner.until(`!document.querySelector("#dialog").open`);
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
  await sleep(61000 - Date.now() % 60000);
  // (j) 準備 and 費用メモ, still at 375px: the owner renames a line, removes one and adds one, the form never running off the side;
  // saved, a reload shows the list so. A budget line added shows its amount in yen.
  // 足あと: the browser is given a position (or refused one) and 「ここにいる」 is pressed; the page lists every member's points.
  const footprintRows = `[...document.querySelectorAll("[data-footprint]")].map(r => r.querySelector("strong").textContent)`;
  const locate = async (p: typeof owner, setting: "granted" | "denied", context?: string, latitude = 35.6812, longitude = 139.7671) => {
    await send("Browser.setPermission", { permission: { name: "geolocation" }, setting, origin, ...(context ? { browserContextId: context } : {}) });
    await p!.cdp("Emulation.setGeolocationOverride", { latitude, longitude, accuracy: 20 });
  };
  // The footprints page is the Spec's trip-map page; a trip without one has the screen's 足あと tab instead (#583).
  const footprintsTab = async (p: typeof owner) => { await p!.evaluate(`(document.querySelector('[data-action="tab"][data-tab="map"]') ?? document.querySelector('[data-action="tab"][data-tab=":footprints"]')).click()`); await p!.until(`[...document.querySelectorAll("h2")].some(h => h.textContent === "足あと")`); };
  const stepHere = async (p: typeof owner, count: number) => { await p!.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await p!.until(`document.querySelectorAll("[data-footprint]").length === ${count}`); };
  const tabTo = async (p: typeof owner, name: string, ready: string) => { await p!.evaluate(`document.querySelector('[data-action="tab"][data-tab="${name}"]').click()`); await p!.until(`!!document.querySelector(${JSON.stringify(ready)})`); };
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
  // (d) a participant, in a browser context of their own, sees no grip but has the switch.
  const memberContext = (await send("Target.createBrowserContext")).browserContextId as string, member = await page(390, 844, true, memberContext); assert.equal((await member.join(participantLink)).includes("本人確認"), false);
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
  const removable = `[...document.querySelectorAll("[data-footprint]")].map(r => !!r.querySelector('[data-action="remove-footprint"]'))`;
  assert.deepEqual(await member.evaluate(removable), [true, false]); assert.deepEqual(await owner.evaluate(removable), [true, true]);
  // (d2b) 旅の記録 (#440), the story page the template puts in: the participant's point (東京駅) is the record of the plan going on
  // when it was pressed, and the owner's (東京タワー, about 3 km on) is a place no plan covers, before the first plan that starts
  // later; before 09:00 both are. The plans without a point read their time and title. At 375px nothing runs off the side.
  // The day's plans as the scenes above left them (moved, added, retimed), in the itinerary's order, and the two points.
  const now = await owner.evaluate(`(async () => { const v = await (await fetch("/v1/c/${capsuleId}")).json(); return { items: v.document.items.filter(i => i.day === "${day}" && i.status !== "cancelled"), at: v.footprints.map(f => f.at) }; })()`) as { items: typeof seed.document.items; at: string[] };
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
  const shownTab = `document.querySelector('.navigation [aria-current="page"]').dataset.tab`;
  const ended = await owner.cdp("Page.addScriptToEvaluateOnNewDocument", { source: `const real = window.fetch; window.fetch = async (...a) => { const r = await real(...a); if (!String(a[0]).endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "reflection" }); };` });
  await owner.reload(); assert.equal(await owner.evaluate(shownTab), "story");
  await tabTo(owner, "days", ".timeline, .timeline-list"); await owner.evaluate(`document.querySelector('[data-action="reload"]').click()`); await owner.until(`${message} === "最新の内容を読み込みました。"`); assert.equal(await owner.evaluate(shownTab), "days");
  await owner.cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: ended.identifier });
  await owner.reload(); assert.equal(await owner.evaluate(shownTab), "days");
  // (d3) 旅の足あと (#439), the trip-map page the template puts in: the two points (東京駅 and 東京タワー) are two dots, the page
  // says the lines are not the way taken, narrowed to the owner one dot is left, and its line in the list opens when, who, the
  // item going on then (when there is one) and the map in a new tab. At 375px nothing runs off the side.
  // Once the map is shown every request stays on this origin: the tiles, the worker, the stylesheet. The dots are MapLibre's
  // markers over its canvas, and the map says whose data it draws.
  const spots = `document.querySelectorAll(".trip-map .spot").length`;
  await tabTo(owner, "map", ".trip-map .spot"); await owner.until(`${spots} === 2`);
  await owner.until(`!!document.querySelector(".trip-map .maplibregl-canvas") && (document.querySelector(".trip-map .maplibregl-ctrl-attrib")?.textContent ?? "").includes("© OpenStreetMap contributors")`);
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
  await sleep(Math.max(0, pressed[0]! + 61000 - Date.now())); await locate(member, "granted", memberContext, 35.7148, 139.7967); await stepHere(member, 3);
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
  const goingOn = await owner.evaluate(`(async () => { const v = await (await fetch("/v1/c/${capsuleId}")).json(), t = +new Date(v.footprints.find(f => f.by === "オーナー").at);
    const i = v.document.items.filter(i => i.day === "${day}" && i.status !== "cancelled" && i.startsAt && +new Date(i.startsAt) <= t).sort((a, b) => +new Date(a.startsAt) - +new Date(b.startsAt)).at(-1); return i ? "予定: " + i.title : null; })()`);
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
  await fresh.cdp("Page.close");
  for (const p of [owner, member]) await p.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click()`);
  assert.equal(await member.evaluate(`!!document.querySelector('.topbar [data-action="revise"]')`), false);
  assert.equal(await member.evaluate(`document.querySelectorAll("[data-drag], [data-item], [data-order-day], [data-action='insert-item']").length`), 0);
  await member.evaluate(`document.querySelector('[data-action="timeline-view"][data-view="list"]').click()`); await member.until(`document.querySelectorAll(".timeline-list .row").length === 6`);
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
  const placeOf = (id: string) => owner!.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).document.items.find(i => i.id === "${id}").place)()`);
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
  await fresh2.cdp("Page.close");
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
  await tabTo(member, "budget", ".amount"); assert.equal(await member.evaluate(`!!document.querySelector('[data-action="edit-budget"]')`), false);
  // …nor 「直す」「消す」 on a 候補 they see.
  await tabTo(member, "ideas", ".two-columns"); assert.deepEqual(await member.evaluate(`[document.querySelectorAll(".two-columns article").length, document.querySelectorAll('[data-action="rewrite-post"], [data-action="remove-post"]').length]`), [1, 0]);
  // (l, continued) …but they save the trip page and the Markdown like everyone: their 旅を保存 has both and no ZIP, nothing off the side at 375px.
  await member.size(375, 812, true); await member.reload(); await openSave(member); assert.deepEqual(await member.evaluate(saveDialog), [true, true, false, [], false]);
  assert.equal(await member.evaluate(`document.documentElement.scrollWidth <= 375`), true, "a participant's 旅を保存 runs off the side of a 375px screen");
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
  assert.equal(await member.evaluate(`(async () => (await fetch("/v1/c/${capsuleId}")).status)()`), 200);
  // (d) #689: a seat that is not the owner's holds no key yet: the page says it waits, and the plan reads as it did.
  assert.deepEqual(await member.evaluate(`[document.querySelector('[data-trip-key]')?.dataset.tripKey, document.querySelector('[data-trip-key]')?.textContent, !!document.querySelector(".timeline, .timeline-list")]`), ["waiting", "鍵を待っています。鍵を持つメンバーと確認コードを伝え合うと受け取れます", true]);
  // (d2) #690: the confirmation-code handoff between two browsers (docs/design/trip-e2e.md §2.1 案 A). The participant presses
  // 鍵を受け取る, the owner sees the seat waiting and presses 渡す. A wrong code puts nothing on the seat and says so; trying
  // again changes the commitment; then each types the other's code and the participant opens the plan with the key.
  const wrongCode = "確認コードが違います。もう一度やり直してください";
  const seatJson = (b: NonNullable<typeof owner>) => b.evaluate(`(async () => await (await fetch("/v1/c/${capsuleId}")).json())()`) as Promise<any>;
  const typeCode = (b: NonNullable<typeof owner>, value: string) => b.evaluate(`(() => { const i = document.querySelector("[data-handoff-input]"); i.value = ${JSON.stringify(value)}; document.querySelector('#dialog [data-action="handoff-submit"]').click(); return true; })()`);
  // Both screens show their code; on a timeout, what the other screen shows too.
  const bothShowCodes = async () => { for (const [b, other] of [[owner!, member], [member, owner!]] as const) await b.until(`!!document.querySelector("#dialog [data-handoff-own]")`, 20000).catch(async err => { throw new Error(`${(err as Error).message} | the other screen: ${await other.evaluate(`document.querySelector("#dialog")?.open ? document.querySelector("#dialog").innerText : "(no dialog)"`)}`); }); };
  const ownCode = (b: NonNullable<typeof owner>) => b.evaluate(`document.querySelector("#dialog [data-handoff-own]").textContent.trim()`) as Promise<string>;
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
    const savedId = await member.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="private"], .diary form[data-form="private"]'); const choice = f.querySelector('input[name=kind][value=${kind}]'); if (choice.type === 'radio') choice.checked = true; f.dispatchEvent(new Event("change")); for (const [k, v] of Object.entries(${JSON.stringify(values)})) f.querySelector('[name=' + k + ']').value = v; const id = f.dataset.id; f.requestSubmit(); return id; })()`);
    await member.until(`${message} === "保存しました。" && !document.querySelector("#dialog").open && (${JSON.stringify(kind)} !== "diary" || document.querySelector(".diary form")?.dataset.id !== ${JSON.stringify(savedId)})`, 20000);
  };
  const sending = `(() => { window.sent = []; const real = window.fetch; window.fetch = (u, o) => { if (String(u).endsWith("/private")) window.sent.push(String(o?.body ?? "")); return real(u, o); }; return true; })()`;
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
  assert.equal(await member.evaluate(`(async () => JSON.stringify((await (await fetch("/v1/c/${capsuleId}")).json()).private))()`).then((t: string) => t.includes("自分だけの予定の目印")), false);
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
  assert.equal(await member.evaluate(`(async () => (await (await fetch('/v1/c/${capsuleId}')).json()).private.find(p => p.id === '${positioned}').startsAt)()`), `${day}T${offered}:00+09:00`);
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
  assert.equal(await member.evaluate(`(async () => (await fetch("/v1/c/${capsuleId}/private.md")).status)()`), 404);
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
      codes.push((await fetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "put", entry }) })).status);
    }
    return codes;
  })()`;
  assert.deepEqual(await member.evaluate(oldDiaries), [200, 200]);
  console.log("Diary verification: encrypted legacy fixtures inserted");
  await owner.reload(); await owner.evaluate(`document.querySelector('[data-action=tab][data-tab=memories]').click()`);
  assert.equal(await owner.evaluate(`document.querySelectorAll('.diary-entry').length`), 0, "another member can see the injected private diaries");
  await owner.evaluate(`document.querySelector('[data-action=tab][data-tab=days]').click()`);

  // Disable shared reflection on the Host through navigation. Also exercise a valid response with no reflection module.
  const originalMemoriesSpec = await owner.evaluate(`(async () => (await (await fetch('/v1/c/${capsuleId}')).json()).spec)()`);
  for (const missingModule of [false, true]) {
    await setSpec(spec => { spec.navigation = spec.navigation.filter((n: string) => !spec.modules.some((m: any) => m.id === n && m.kind === 'reflection')); });
    const disabledSpec = await owner.evaluate(`(async () => JSON.stringify((await (await fetch('/v1/c/${capsuleId}')).json()).spec))()`);
    assert.equal((await fromPage("document", { type: "reflect", author: "検証", body: "投稿できない思い出" }, "PATCH")).status, 403);
    await member.reload();
    if (missingModule) {
      await member.evaluate(`(() => { window.beforeMemoriesFetch = window.fetch; window.fetch = async (...a) => { const r = await window.beforeMemoriesFetch(...a); if (!String(a[0]).endsWith('/v1/c/${capsuleId}')) return r; const v = await r.json(); v.spec.modules = v.spec.modules.filter(m => m.kind !== 'reflection'); return Response.json(v); }; document.querySelector('[data-action=reload]').click(); })()`);
      await sleep(300);
    }
    // The memories tab comes back after the Spec's pages, last; the trip has a trip-map page, so no 足あと tab follows it (#583).
    assert.equal(await member.evaluate(`document.querySelectorAll('.navigation [data-action=tab]').length`), seed.spec.navigation.length, "a missing memories tab was not supplemented");
    await member.evaluate(`[...document.querySelectorAll('.navigation [data-action=tab]')].at(-1).click()`);
    await member.until(`!!document.querySelector('.diary')`);
    assert.equal(await member.evaluate(`document.querySelectorAll('.shared-memories form, [data-action=include]').length`), 0, "disabled shared reflection still exposes write controls");
    assert.deepEqual(await member.evaluate(`[...document.querySelectorAll('.diary .entry-body')].map(p => p.textContent)`), ["旧日記本文 old-diary-one"]);
    await member.evaluate(`document.querySelector('.diary [data-action=edit-private][data-id=old-diary-one]').click()`);
    await member.until(`document.querySelector('.diary form')?.dataset.id === 'old-diary-one'`);
    await savePrivate({ body: "旧日記本文 old-diary-one" }, "diary");
    assert.equal(await owner.evaluate(`(async () => JSON.stringify((await (await fetch('/v1/c/${capsuleId}')).json()).spec))()`), disabledSpec, "diary editing changed the stored Spec");
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
  await member.evaluate(`(() => { window.diaryFetch = window.fetch; window.fetch = async (...a) => { const r = await window.diaryFetch(...a); if (!String(a[0]).endsWith('/v1/c/${capsuleId}')) return r; return Response.json({ ...await r.json(), state: 'frozen' }); }; document.querySelector('[data-action=reload]').click(); })()`);
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
  const otherKey = `(async () => (await fetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "put", entry: { id: "other-key", kind: "diary", day: "${day}", title: "v1.${"A".repeat(40)}", body: "v1.${"A".repeat(40)}" } }) })).status)()`;
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
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (u, o) => { const r = await real(u, o); if (String(u).endsWith("/private") && o?.method === "PATCH") { window.fetch = real; throw new TypeError("Failed to fetch"); } return r; }; window.copied = ""; return true; })()`);
  await reviseOpen(); await member.evaluate(`document.querySelector('#dialog [data-action="copy-revise-private"]').click()`); await member.until(`!!window.copied`);
  const again = JSON.parse(/```json\n(.*)\n```\n$/.exec(await member.evaluate(`window.copied`) as string)![1]!).entries as unknown[];
  const lost = `\`\`\`json\n${JSON.stringify({ schemaVersion: 1, entries: [...again, { kind: "item", day, startsAt: `${day}T17:00:00+09:00`, title: "応答が失われた目印", body: "" }] })}\n\`\`\``;
  await member.evaluate(`(() => { document.querySelector("#dialog [data-revise-paste]").value = ${JSON.stringify(lost)}; document.querySelector('#dialog [data-action="revise-private-check"]').click(); return true; })()`); await member.until(`!document.querySelector("#dialog .revise-diff").hidden`);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll("#dialog .revise-diff h4")].map(h => h.textContent)`), ["追加（1 件）"]);
  await member.evaluate(`document.querySelector('#dialog form[data-form="revise-private"]').requestSubmit()`);
  await member.until(`${message}.startsWith("反映できたか確かめられませんでした。") && !document.querySelector("#dialog").open`, 20000);
  assert.deepEqual((await member.evaluate(privatePlans) as string[][]).map(([t]) => t), ["自分だけの予定の目印", "チャットで足した目印", "応答が失われた目印"]);
  // Lost again, and the list cannot be read again either: the page does not offer a retry from the list it still shows.
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (u, o) => { const r = await real(u, o); if (String(u).endsWith("/private") && o?.method === "PATCH") { window.fetch = async (v, p) => { if (String(v).endsWith("/v1/c/${capsuleId}")) { window.fetch = real; throw new TypeError("Failed to fetch"); } return real(v, p); }; throw new TypeError("Failed to fetch"); } return r; }; window.copied = ""; return true; })()`);
  await reviseOpen(); await member.evaluate(`document.querySelector('#dialog [data-action="copy-revise-private"]').click()`); await member.until(`!!window.copied`);
  const third = JSON.parse(/```json\n(.*)\n```\n$/.exec(await member.evaluate(`window.copied`) as string)![1]!).entries as unknown[];
  const unread = `\`\`\`json\n${JSON.stringify({ schemaVersion: 1, entries: [...third, { kind: "item", day, startsAt: `${day}T18:00:00+09:00`, title: "読み直せない目印", body: "" }] })}\n\`\`\``;
  await member.evaluate(`(() => { document.querySelector("#dialog [data-revise-paste]").value = ${JSON.stringify(unread)}; document.querySelector('#dialog [data-action="revise-private-check"]').click(); return true; })()`); await member.until(`!document.querySelector("#dialog .revise-diff").hidden`);
  await member.evaluate(`document.querySelector('#dialog form[data-form="revise-private"]').requestSubmit()`);
  await member.until(`${message}.startsWith("反映できたか確かめられず、一覧も読み込めませんでした。") && !document.querySelector("#dialog").open`, 20000);
  await member.reload(); assert.equal((await member.evaluate(privatePlans) as string[][]).some(([t]) => t === "読み直せない目印"), true);
  // Back to the one plan the steps below expect.
  const extra = await member.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).private.filter(p => p.id !== ${JSON.stringify(copiedOwn.entries[0]!.id)}).map(p => p.id))()`) as string[];
  assert.equal(extra.length, 5); for (const x of extra) assert.equal(await member.evaluate(`(async () => (await fetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "remove", id: ${JSON.stringify(x)} }) })).status)()`), 200);
  await member.reload();
  // A viewer opens it too: the first time registers the seat's passkey (yes to the confirm) and makes its memo key.
  const viewer = await page(375, 812, true, (await send("Target.createBrowserContext")).browserContextId); await viewer.join(viewerLink);
  const viewerCounts = await viewer.evaluate(entryCounts); assert.equal(viewerCounts[0], 0); assert.equal(viewerCounts[1], 1); assert.equal(viewerCounts[2], 0); assert.ok(viewerCounts[3] > 0);
  assert.equal(await viewer.evaluate(headingTargets), true);
  // A viewer reads both footprints and has no 「ここにいる」.
  await footprintsTab(viewer); assert.equal(await viewer.evaluate(`!!document.querySelector('[data-action="footprint-here"]')`), false);
  assert.deepEqual(await viewer.evaluate(footprintRows), stepped);
  await viewer.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click()`);

  await viewer.cdp("WebAuthn.enable"); await viewer.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true } });
  await viewer.evaluate(`(() => { window.confirm = () => true; document.querySelector('[data-action="revise-private"]').click(); return true; })()`);
  await viewer.until(`document.querySelector("#dialog").open && !!document.querySelector('#dialog [data-action="copy-revise-private"]')`, 20000);
  assert.equal(await viewer.evaluate(`(async () => !!(await (await fetch("/v1/c/${capsuleId}")).json()).privateKey)()`), true);
  // A plan with an end and a place (fields this form does not show), its times in UTC with seconds, sealed here with the memo key
  // this browser keeps, keeps them as written through an edit of its words, and the form deletes it.
  const fullPlan = `(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("capsule", 1); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const kept = await new Promise(ok => { const q = db.transaction("private-keys").objectStore("private-keys").get("${capsuleId}"); q.onsuccess = () => ok(q.result); }); db.close();
    const enc = t => new TextEncoder().encode(t), b64 = b => { let t = ""; for (const c of new Uint8Array(b)) t += String.fromCharCode(c); return btoa(t).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, ""); };
    const e = { id: "full-plan", kind: "item", day: "${day}", startsAt: "${day}T03:00:00Z", endsAt: "${day}T04:00:45.250Z" };
    const seal = async (text, field) => { const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc([e.id, field, e.kind, e.day, e.startsAt, e.endsAt].join("/")) }, kept.key, enc(text))), out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return "v1." + b64(out); };
    const entry = { ...e, title: await seal("終わりと場所のある予定", "title"), body: await seal("前の本文", "body"), place: await seal(JSON.stringify({ label: "駅" }), "place") };
    return (await fetch("/v1/c/${capsuleId}/private", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "put", entry }) })).status;
  })()`;
  assert.equal(await member.evaluate(fullPlan), 200);
  await member.reload(); await openPrivate("edit-private", "full-plan"); await savePrivate({ body: "直した本文" });
  assert.deepEqual(await member.evaluate(`(() => { const c = document.getElementById("private-full-plan"); return [c.querySelector("p").textContent, c.querySelector(".event-time").firstChild.textContent, !!c.querySelector(".links a")]; })()`), ["直した本文", "12:00 – 13:00", true]);
  const timesOf = `(async () => { const p = (await (await fetch("/v1/c/${capsuleId}")).json()).private.find(p => p.id === "full-plan"); return [p.startsAt, p.endsAt]; })()`;
  assert.deepEqual(await member.evaluate(timesOf), [`${day}T03:00:00Z`, `${day}T04:00:45.250Z`]);
  // Its start moved two hours later takes the end along, as the shared items' form does.
  await openPrivate("edit-private", "full-plan"); await savePrivate({ time: "14:00" });
  assert.equal(await member.evaluate(`document.querySelector("#private-full-plan .event-time").firstChild.textContent`), "14:00 – 15:00");
  assert.deepEqual(await member.evaluate(timesOf), [`${day}T14:00:00+09:00`, `${day}T06:00:45.250Z`]);
  await openPrivate("edit-private", "full-plan"); await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('#dialog [data-action="remove-private"]').click(); })()`);
  await member.until(`!document.querySelector('#app [data-id="full-plan"]')`);
  // Once sharing has ended (the page is told so by its own fetch here), a seat whose day has plans but no diary entry still
  // gets the card with 「自分のメモを保存 ↓」, and nothing to add or revise with.
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (...a) => { const r = await real(...a); if (!String(a[0]).endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "frozen" }); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`document.querySelector(".lifecycle").textContent.includes("共有終了")`);
  assert.deepEqual(await readDiary(`[document.querySelectorAll(".diary .diary-entry").length, !!document.querySelector('.diary [data-action="save-private"]'), !!document.querySelector('.diary form'), !!document.querySelector('[data-action="revise-private"]')]`), [0, true, false, false]);
  await member.reload();
  // IndexedDB failing inside its own callback does not leave the page waiting: the entries show, unreadable, from nothing kept.
  await member.evaluate(`(() => { IDBDatabase.prototype.transaction = () => { throw new Error("broken store"); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`!!document.querySelector(".private-locked")`); await member.reload();
  // Replacing the passkey of a seat whose entries are sealed rewraps the memo key for the new one: with the old passkey gone from
  // the device and this browser's copy of the key too, 「パスキーで戻る」 with the new passkey reads the entries at once.
  // Its ceremonies (three for the replacement, two to come back) share the login limit of 15 a minute: they start in a fresh one.
  await sleep(61000 - Date.now() % 60000);
  const before = (await member.cdp("WebAuthn.getCredentials", { authenticatorId: memberAuthenticator })).credentials.map((x: { credentialId: string }) => x.credentialId);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="passkey-register"]').click(); return true; })()`);
  await member.until(`(${message} ?? "").startsWith("この端末のパスキーに登録し直しました")`, 20000);
  for (const credentialId of before) await member.cdp("WebAuthn.removeCredential", { authenticatorId: memberAuthenticator, credentialId });
  await member.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
  await member.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="signout"]').click(); return true; })()`);
  await member.until(`location.pathname === "/"`); await member.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` });
  await member.until(`!!document.querySelector('[data-action="passkey-login"]')`); await member.evaluate(`document.querySelector('[data-action="passkey-login"]').click()`);
  await member.until(`[...document.querySelectorAll(".event.private h3")].map(h => h.textContent).join() === "自分だけの予定の目印"`, 20000);
  // After sharing ends an unreadable entry opens to 「パスキーで読む」 alone: the host would refuse removing it.
  await member.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`); await member.reload();
  await member.evaluate(`(() => { const real = window.fetch; window.fetch = async (...a) => { const r = await real(...a); if (!String(a[0]).endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "frozen" }); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`document.querySelector(".lifecycle").textContent.includes("共有終了")`);
  await member.evaluate(`document.querySelector('.event.private.locked [data-action="edit-private"]').click()`); await member.until(`!!document.querySelector('#dialog [data-action="read-private"]')`);
  assert.deepEqual(await member.evaluate(`[...document.querySelectorAll("#dialog [data-action]")].map(b => b.dataset.action)`), ["close", "read-private"]);
  await member.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`); await member.reload();
  // This browser loses the memo key and the device its passkey: the plan stays where it was, marked, its words gone, and the day
  // says how many cannot be read. Opened, it offers 「パスキーで読む」 and 「削除」 only; removing it leaves none.
  await member.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
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
  // (d4) 開いたときに足あとを残す (#481), on the participant's phone (position allowed since (d2), its point there at 東京駅 minutes
  // ago). Off by default, opening leaves nothing; turned on, nothing yet. Opened again where the last point is, nothing (under 15
  // minutes and 300 m); opened 1 km off at 皇居, one point marked 自動, and opened again or shown again (visibilitychange) nothing
  // more. 消す takes it out; shown again then, one more, taken out too. Turned off while the position is on its way, nothing. With
  // the position not allowed, opening asks for nothing (no getCurrentPosition) and leaves nothing; turned off, nothing; once sharing
  // has ended, coming back sends no point. Waits of 2 s stand for "nothing happened".
  const count = `(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).footprints.length)()`;
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
  await member.evaluate(`(() => { const real = window.fetch; window.sentPoints = 0; window.fetch = async (...a) => { if (String(a[0]).endsWith("/footprints")) window.sentPoints++; const r = await real(...a); if (!String(a[0]).endsWith("/v1/c/${capsuleId}")) return r; const v = await r.json(); return Response.json({ ...v, state: "frozen" }); }; document.querySelector('[data-action="reload"]').click(); return true; })()`);
  await member.until(`document.querySelector(".lifecycle").textContent.includes("共有終了")`);
  await member.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`); await stays(2); assert.equal(await member.evaluate(`window.sentPoints`), 0);
  // Off again for the steps below, which reload this page.
  await member.evaluate(`localStorage.removeItem("auto-footprint:${capsuleId}")`); await member.reload(); await stays(2);
  // (m) The editor revises the shared plan from the header, while settings stay the owner's, and can undo once.
  const editorContext = (await send("Target.createBrowserContext")).browserContextId as string, editor = await page(390, 844, true, editorContext);
  // The editor's passkey is also the check before handing out and revoking its invites, and its join dialog says so.
  assert.equal((await editor.join(editorLink)).includes("編集者は、招待の発行・失効の前の本人確認にも使います。"), true);
  // An editor whose browser refuses the position: 「ここにいる」 says why and how to allow it, and nothing is left.
  await locate(editor, "denied", editorContext); await footprintsTab(editor);
  await editor.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await editor.until(`(${message} ?? "").startsWith("位置の許可がありません")`);
  assert.equal(await editor.evaluate(`document.querySelectorAll("[data-footprint]").length`), 2);
  assert.equal((await editor.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).footprints.length)()`)), 2);
  // Allowed, but the fix is 2 km off: nothing is left, and it says so.
  await send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "granted", origin, browserContextId: editorContext });
  await editor.cdp("Emulation.setGeolocationOverride", { latitude: 35.6812, longitude: 139.7671, accuracy: 2000 });
  await editor.evaluate(`document.querySelector('[data-action="footprint-here"]').click()`); await editor.until(`(${message} ?? "").startsWith("位置の精度が低い（約2.0 km）")`);
  assert.equal(await editor.evaluate(`document.querySelectorAll("[data-footprint]").length`), 2);
  // Given a good fix in 新宿, the editor leaves a third point: the map shows three dots, and narrowed to the editor one.
  await editor.cdp("Emulation.setGeolocationOverride", { latitude: 35.6896, longitude: 139.7006, accuracy: 20 }); await stepHere(editor, 3);
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
  await owner.evaluate(`(() => { const real = window.realFetch = window.fetch; window.fetch = async (url, init) => { const r = await real(url, init); if (url !== "/v1/c/${capsuleId}" || (init?.method ?? "GET") !== "GET") return r;
    const v = await r.json(), p = v.footprints[0]; v.footprints.unshift({ ...p, id: "yesterday", at: new Date(Date.parse(p.at) - 86400000).toISOString(), lat: p.lat + 0.01, mine: false });
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
  if (Date.now() - checkedAt > 200000) { await owner.evaluate(answerYes); await invite(); checkedAt = Date.now(); }
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
  assert.equal(await editor.evaluate(`!!document.querySelector('#dialog form[data-form="revise-key"]') && !document.querySelector('#dialog [data-action="revise-assist"]')`), true);
  await editor.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="revise-key"]'); f.elements.key.value = "sk-ant-x"; f.requestSubmit(); return true; })()`);
  await editor.until(`${message}.includes("確認")`);
  assert.equal(await editor.evaluate(`!!document.querySelector('#dialog [data-action="revise-assist"]')`), false);
  const current = await editor.evaluate(`(async () => await (await fetch("/v1/c/${capsuleId}")).json())()`);
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
  const editorState = `(async () => { const v = await (await fetch("/v1/c/${capsuleId}")).json(); return [v.spec.title, v.document.items.find(i => i.id === "one").startsAt]; })()`;
  assert.deepEqual(await editor.evaluate(editorState), [title, first.startsAt]);
  await editor.evaluate(`document.querySelector('.topbar [data-action="revise"]').click()`);
  await editor.until(`!!document.querySelector('#dialog [data-action="undo"]')`);
  assert.equal(await editor.evaluate(`document.querySelector('#dialog [data-action="undo"]').textContent`), "1 つ前に戻す");
  await editor.evaluate(`document.querySelector('#dialog [data-action="undo"]').click()`);
  await editor.until(`!!document.querySelector('#dialog form[data-form="undo"]')`);
  await editor.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="undo"]'); f.querySelector('input[type="checkbox"]').checked = true; f.requestSubmit(); })()`);
  await editor.until(`${message} === "1 つ前に戻しました。"`);
  assert.deepEqual(await editor.evaluate(editorState), [title, originalStart]);
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
  const editorName = await editor.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}/grants")).json())[0].issuedBy.label)()`) as string;
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector("#dialog details.history")`);
  assert.equal(await owner.evaluate(`${editorInvite}.textContent.includes(${JSON.stringify(`発行: ${editorName}`)})`), true);
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  // A revoked invite leaves the list: the host drops revoked grants from what it keeps.
  await editor.evaluate(`${editorInvite}.querySelector('[data-action="revoke"]').click()`); await editor.until(`!!document.querySelector('#dialog form[data-form="grant"]') && !${editorInvite}`);
  await editor.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  // (j2) The <geolocation> element (#675, #760), on a page of the editor's browser that has it (Chrome 153 does; the pages above had
  // it taken away and ran the button). Allowed: the page keeps the button (the element is there, hidden) and it leaves a point.
  // Refused: opening the page shows the element in the button's place and how to allow it again without asking, and turning the
  // switch on says the same and leaves the switch off. Allowed again, the button is back without opening the page again.
  const element = await page(1000, 900, false, editorContext, true);
  const toFootprints = async () => { await element.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` }); await element.until(`!!document.querySelector(".timeline, .timeline-list")`); await footprintsTab(element); await element.until(`!!document.querySelector("geolocation")`); };
  const shown = (button: boolean) => element.until(`JSON.stringify(["[data-geo-button]", "[data-geo-place]", "[data-geo-denied]"].map(s => !document.querySelector(s).hidden)) === '${JSON.stringify([button, !button, !button])}'`);
  await element.cdp("Emulation.setGeolocationOverride", { latitude: 35.6896, longitude: 139.7006, accuracy: 20 });
  await sleep(61000);   // A seat leaves a point once a minute, and the editor's last is not that old yet.
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
  await element.cdp("Page.navigate", { url: "about:blank" });
  // (c) #689: a passkey that gives no PRF output cannot wrap the seat's private key, so the seat has public keys and the wrapped trip
  // key only, and this browser holds the private key in IndexedDB alone. Its own disposable trip and browser context.
  {
    const made = await fetch(origin + "/v1/publish", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ ...seed, confirm: true }) });
    assert.equal(made.status, 201); const bare = await made.json() as { id: string; url: string };
    const solo = await page(390, 844, true, (await send("Target.createBrowserContext")).browserContextId);
    const read = `(async () => { const v = await (await fetch("/v1/c/${bare.id}")).json(); return [!!v.seatKey, !!v.seatKey?.secret, v.keyed]; })()`;
    try {
      await solo.join(bare.url); await solo.until(`!!document.querySelector('[data-trip-key="held"]')`);
      await solo.cdp("WebAuthn.enable"); await solo.cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: false } });
      assert.deepEqual(await solo.evaluate(read), [true, false, true]);
      await solo.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="passkey-register"]').click(); return true; })()`);
      await solo.until(`(${message} ?? "").startsWith("パスキーを登録しました")`, 20000);
      assert.deepEqual(await solo.evaluate(read), [true, false, true], "a passkey without PRF must leave no wrapped private key on the seat");
      await solo.reload(); await solo.until(`!!document.querySelector('[data-trip-key="held"]')`);
    } finally {
      const done = await solo.evaluate(`(async () => { const v = await (await fetch("/v1/c/${bare.id}")).json(); return (await fetch("/v1/c/${bare.id}/purge", { method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify({ title: ${JSON.stringify(title)} }) })).status; })()`).catch(() => 0);
      assert.equal(done, 200, `could not purge the second test capsule ${bare.id} by hand`);
    }
  }
  // (i, continued) past the five minutes, a purge from the screen checks this phone's passkey (the authenticator answers; nothing
  // is asked with confirm()) and then purges.
  const left = checkedAt + 5 * 60000 + 2000 - Date.now(); if (left > 0) { console.log(`Waiting ${Math.ceil(left / 1000)} s for the passkey check to lapse…`); await sleep(left); }
  // The replacement, the return with the passkey (b) and the purge are some ten ceremonies, which share the login limit of 15 a
  // minute: they start early in a minute, as the member's replacement below does (#689).
  { const into = Date.now() % 60000; if (into > 20000) await sleep(61000 - into); }
  // (i, continued) "パスキーを登録し直す" says what it takes, then the OS checks the current passkey and makes the new one. The old
  // phone is then lost: its passkey is taken off the authenticator, so the purge below can only be checked by the new one.
  await owner.reload(); await owner.evaluate(answerYes);
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
  assert.equal(await owner.evaluate(`(async () => !!(await (await fetch("/v1/c/${capsuleId}")).json()).seatKey?.secret)()`), true);
  await owner.evaluate(`new Promise(ok => { const q = indexedDB.deleteDatabase("capsule"); q.onsuccess = q.onerror = q.onblocked = () => ok(true); })`);
  await owner.evaluate(`(() => { window.confirm = () => true; document.querySelector('footer [data-action="signout"]').click(); return true; })()`);
  await owner.until(`location.pathname === "/"`); await owner.cdp("Page.navigate", { url: `${origin}/c/${capsuleId}` });
  await owner.until(`!!document.querySelector('[data-action="passkey-login"]')`); await owner.evaluate(`document.querySelector('[data-action="passkey-login"]').click()`);
  await owner.until(`!!document.querySelector('[data-trip-key="held"]')`, 20000);
  await owner.reload(); await owner.evaluate(answerYes);
  // (s) #691: the trip sealed under the trip's key. The screen has no way to start it (§6 の 6), so this page does what the owner's
  // browser will: src/trip-keys.ts is loaded into the page, the seat's private key in IndexedDB opens the trip key, the plan read
  // from the host is sealed and opened back before it is sent, and POST seal goes after the passkey check (as an owner's action).
  // Then the screen draws the plan as before from what it opens, adds with "＋" at the time it offered, moves by the grip,
  // promotes a suggestion to the end of its day, shows no 旅を保存 / チャットで直す, and does not send a purge with another title.
  const entryDir = mkdtempSync(join(tmpdir(), "capsule-verify-seal-")), entry = join(entryDir, "entry.ts");
  writeFileSync(entry, `import * as k from ${JSON.stringify(join(import.meta.dir, "trip-keys.ts"))}; (globalThis as any).tripKeys = k;`);
  const keysBuild = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife" }); rmSync(entryDir, { recursive: true, force: true });
  assert.ok(keysBuild.success, "src/trip-keys.ts did not build for the page");
  // Loaded again in each expression that uses it, so it is there whatever the page did in between.
  const keysCode = await keysBuild.outputs[0]!.text();
  await owner.evaluate(`document.querySelector('[data-action="day"][data-day="${day}"]').click()`); await owner.until(`!!document.querySelector('[data-order-day] [data-item]')`);
  const shownBefore = await owner.evaluate(order) as string;
  assert.equal(await owner.evaluate(`(async () => { ${keysCode}
    const k = globalThis.tripKeys, id = "${capsuleId}";
    const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
    const v = await (await fetch("/v1/c/" + id)).json(), s = v.seatKey;
    const trip = await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation);
    const sealed = await k.sealTrip(trip, id, s.generation, { spec: v.spec, document: v.document }), back = await k.openTrip(trip, id, sealed);
    if (!back || back.unreadable.length || back.spec.title !== v.spec.title || back.document.items.map(i => i.id + i.title).join() !== v.document.items.map(i => i.id + i.title).join()) return "did not open back";
    window.plainWords = [v.spec.title, ...v.document.items.map(i => i.title)];
    window.sealBody = JSON.stringify({ generation: s.generation, ...sealed, confirm: true });
    return "ok";
  })()`), "ok");
  const sealIt = () => owner!.evaluate(`(async () => { const revision = (await (await fetch("/v1/c/${capsuleId}")).json()).document.revision; return (await fetch("/v1/c/${capsuleId}/seal", { method: "POST", headers: { "Content-Type": "application/json", "If-Match": '"' + revision + '"' }, body: window.sealBody })).status; })()`) as Promise<number>;
  let sealedStatus = await sealIt(); if (sealedStatus === 428) { assert.equal(await checkFromPage(), 200); checkedAt = Date.now(); sealedStatus = await sealIt(); }
  assert.equal(sealedStatus, 200, "POST seal");
  const stored = `(async () => { const t = await (await fetch("/v1/c/${capsuleId}")).text(); return [JSON.parse(t).sealed?.generation, window.plainWords.filter(w => t.includes(w))]; })()`;
  assert.deepEqual(await owner.evaluate(stored.replace("window.plainWords", JSON.stringify(await owner.evaluate("window.plainWords")))), [1, []], "the host holds a plain word of the sealed trip");
  // (a) Drawn from what the page opened: the same title and the same day.
  await owner.reload(); await owner.evaluate(answerYes);
  await owner.evaluate(`document.querySelector('[data-action="day"][data-day="${day}"]').click()`); await owner.until(`!!document.querySelector('[data-order-day] [data-item]')`);
  assert.equal(await owner.evaluate(`document.querySelector(".hero h1").textContent`), title); assert.equal(await owner.evaluate(order), shownBefore);
  // (b) "＋" after the day's first item: the form's time is the one the host then gives there; the grip moves it after the next one.
  const sealedForm = `document.querySelector('#dialog form[data-form="item"]')`, sealedTitle = `document.querySelector('#dialog input[name="title"]')`;
  const firstAfter = await owner.evaluate(`document.querySelector('[data-action="insert-item"]').dataset.after`) as string;
  await owner.evaluate(`document.querySelector('[data-action="insert-item"][data-after="${firstAfter}"]').click()`); await owner.until(`!!${sealedForm}`);
  const sOffered = await owner.evaluate(`document.querySelector('#dialog input[name="time"]').value`) as string, sealedAdded = await owner.evaluate(`${sealedForm}.dataset.id`) as string;
  await owner.evaluate(`(() => { const t = ${sealedTitle}; t.value = "暗号化した旅行の予定"; t.dispatchEvent(new Event("input", { bubbles: true })); ${sealedForm}.requestSubmit(); })()`);
  await owner.until(`${message} === "暗号化した旅行の予定を ${sOffered} ごろ に置きました。"`);
  const sRows = (await owner.evaluate(order) as string).split(",");
  assert.equal(sRows[sRows.indexOf(firstAfter) + 1], sealedAdded); assert.equal(await owner.evaluate(timeOf(sealedAdded)), `${sOffered} ごろ`);
  assert.deepEqual(await owner.evaluate(stored.replace("window.plainWords", JSON.stringify(["暗号化した旅行の予定"]))), [1, []]);
  const nextRow = sRows[sRows.indexOf(sealedAdded) + 1]!; assert.ok(nextRow, "the day needs an item after the added one");
  await owner.evaluate(`document.querySelector('[data-item="${sealedAdded}"]').scrollIntoView({ block: "start", behavior: "instant" })`); await sleep(200);
  await owner.drag(`[data-item="${sealedAdded}"] [data-drag]`, (await owner.box(`[data-item="${nextRow}"]`)).bottom - 4);
  await owner.until(`/^暗号化した旅行の予定を .+ に変えました。$/.test(${message})`);
  const sMoved = (await owner.evaluate(order) as string).split(","); assert.equal(sMoved[sMoved.indexOf(nextRow) + 1], sealedAdded);
  // (c) A suggestion, sealed as the screen seals a post, added to the first day: last of that day, titled by its words.
  const idea = "暗号化した旅行の候補";
  const [ideaStatus, ideaId] = await owner.evaluate(`(async () => { ${keysCode}
    const k = globalThis.tripKeys, id = "${capsuleId}", v = await (await fetch("/v1/c/" + id)).json(), s = v.seatKey;
    const kept = await new Promise((ok, no) => { const q = indexedDB.open("capsule", 1); q.onerror = () => no(q.error); q.onsuccess = () => { const r = q.result.transaction("private-keys").objectStore("private-keys").get("seat:" + id); r.onsuccess = () => { q.result.close(); ok(r.result); }; r.onerror = () => no(r.error); }; });
    const trip = await k.unwrapTripKey(s.wrapped, s.ephemeral, kept.secret.x25519, id, s.generation), plain = await k.openTrip(trip, id, v);
    const op = await k.sealOperation(trip, id, s.generation, { type: "suggest", author: "オーナー", body: "${idea}" }, plain.document);
    return [(await fetch("/v1/c/" + id + "/document", { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify(op) })).status, op.id];
  })()`) as [number, string];
  assert.equal(ideaStatus, 200);
  // Another member's change reaches this page by the 20-second refresh, opened as a reload opens it (never drawn as ciphertext).
  await owner.until(`document.querySelector("footer").textContent.includes("revision " + ${JSON.stringify(String(await owner.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).document.revision)()`)))})`, 30000);
  assert.equal(await owner.evaluate(`document.querySelector(".hero h1").textContent`), title);
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="ideas"]').click()`); await owner.until(`!!document.querySelector('[data-action="promote"][data-id="${ideaId}"]')`);
  await owner.evaluate(`document.querySelector('[data-action="promote"][data-id="${ideaId}"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="promote"]')`);
  await owner.evaluate(`(() => { const f = document.querySelector('#dialog form[data-form="promote"]'); f.elements.day.value = "${day}"; f.requestSubmit(); })()`);
  await owner.until(`${message} === "保存しました。"`);
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="days"]').click(); document.querySelector('[data-action="day"][data-day="${day}"]').click()`);
  await owner.until(`!!document.querySelector('[data-order-day] [data-item]')`);
  const promotedId = await owner.evaluate(`(async () => (await (await fetch("/v1/c/${capsuleId}")).json()).document.suggestions.find(s => s.id === "${ideaId}").itemId)()`) as string;
  assert.equal((await owner.evaluate(order) as string).split(",").at(-1), promotedId);
  assert.ok((await owner.evaluate(`document.querySelector('[data-item="${promotedId}"]').textContent`) as string).includes(idea));
  // (c') A 準備 line whose ciphertext was moved from another record does not open: the page counts it and offers no edit of the
  // whole list, which would drop it. The trip's own notes ciphertext is put on the first line, as an operator could.
  assert.equal(await owner.evaluate(`(async () => { const v = await (await fetch("/v1/c/${capsuleId}")).json();
    const checklist = v.document.checklist.map((c, n) => ({ id: c.id, title: n === 0 ? v.document.notes : c.title }));
    return (await fetch("/v1/c/${capsuleId}/document", { method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": '"' + v.document.revision + '"' }, body: JSON.stringify({ type: "checklist", checklist }) })).status; })()`), 200);
  await owner.reload(); await owner.evaluate(answerYes);
  assert.equal(await owner.evaluate(`document.querySelector("[data-unreadable]")?.textContent`), "この端末で開けない記録が 1 件あります");
  await owner.evaluate(`document.querySelector('[data-action="tab"][data-tab="check"]').click()`); await owner.until(`!!document.querySelector(".checks")`);
  assert.equal(await owner.evaluate(`!!document.querySelector('[data-action="edit-checklist"]')`), false);
  // (d) No 旅を保存 or チャットで直す for a sealed trip, in the header or under 共有・管理, which says why.
  assert.equal(await owner.evaluate(`!!document.querySelector('.topbar [data-action="save"], .topbar [data-action="revise"]')`), false);
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector('#dialog [data-action="purge"]')`);
  assert.deepEqual(await owner.evaluate(`[!!document.querySelector('#dialog [data-action="save"], #dialog [data-action="revise"], #dialog [data-action="undo"]'), !!document.querySelector('#dialog [data-sealed="manage"]')]`), [false, true]);
  // (e) A purge with another title is not sent: the screen compares it, the host cannot.
  await owner.evaluate(`document.querySelector('#dialog [data-action="purge"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="purge"]')`);
  await owner.evaluate(`(() => { document.querySelector('#dialog input[name="title"]').value = "違う題"; document.querySelector('#dialog form[data-form="purge"]').requestSubmit(); })()`);
  await owner.until(`${message} === "確認用のタイトルが一致しません"`);
  assert.equal((await fetch(`${origin}/v1/c/${capsuleId}`)).status, 401, "the capsule is still there (401 without a cookie)");
  await owner.evaluate(`document.querySelector('#dialog [data-action="close"]').click()`);
  await owner.reload(); await owner.evaluate(answerYes);
  console.log("Sealed trip verification: sealed from the page (no plain word held by the host), drawn the same, \"＋\" at the offered time, moved by the grip, a change by the 20-second refresh opened (not drawn as ciphertext), a suggestion promoted last of its day, a 準備 line that does not open counted with no edit of the whole list, no 旅を保存 / チャットで直す, a purge with another title not sent");
  await owner.evaluate(`document.querySelector('[data-action="manage"]').click()`); await owner.until(`!!document.querySelector('#dialog [data-action="purge"]')`);
  await owner.evaluate(`document.querySelector('#dialog [data-action="purge"]').click()`); await owner.until(`!!document.querySelector('#dialog form[data-form="purge"]')`);
  await owner.evaluate(`(() => { document.querySelector('#dialog input[name="title"]').value = ${JSON.stringify(title)}; document.querySelector('#dialog form[data-form="purge"]').requestSubmit(); })()`);
  await owner.until(`document.querySelector("main.empty h1")?.textContent === "カプセルを削除しました。"`); assert.deepEqual(await owner.evaluate(`[window.asked, window.checks]`), [[], 0]);  // 「パスキーで戻る」 (b) was this passkey's check, so the purge asks for none (it was 1 before #689)
  assert.equal((await fetch(`${origin}/v1/c/${capsuleId}`)).status, 410); console.log("Disposable test capsule removed from the screen; subsequent access returns 410."); capsuleId = "";
  console.log("UI verification passed: 足あと (a participant and the owner press ここにいる and both read the two points, oldest first, the map in a new tab; 開いたときに足あとを残す off by default, on for the participant's phone: one point marked 自動 on opening 1 km from the last, none under 15 minutes and 300 m, one more on showing again once due, none on showing again too soon, without the permission (nothing asked), turned off (even while the position is on its way) or once sharing has ended; a viewer reads them without the button; an editor refused the position, or given one 2 km off, is told why and leaves nothing; 消す on one's own point only, the owner's on every point; an open page redrawn with another's point), 旅の足あと (the points as dots over the host's own map (MapLibre's canvas and the OpenStreetMap credit; its script not fetched before the map is shown, and nothing asked of another origin), two and then three, zoomed in and kept so while another member's point comes and goes, fitted again when narrowed, narrowed to one member and to the day, one member's line, a dot of two points pressed on the map, a dot's footprints with the time, the item going on and the map, the note that the lines are not the way taken, nothing off the side at 375px, a trip with no footprint saying how to leave one, and a trip without the map page showing the map on 足あと), the editor's header チャットで直す (scope note, no title diff, apply and undo), no such header entry for the owner or participant, the editor's 共有・管理 (viewer invites only, one issued and revoked, the owner seeing who handed it out) and none for a participant, reordering by grip (touch) and by arrow key with the host's new time shown as a placeholder (ごろ), an item without a time given one by a drag and by the edit form (required, the placeholder box unticked by a new time), 詳細 / リスト kept across a reload and reordered from the list, a line opening its card, an end typed / moved with the start / refused before it / emptied with the free time and overlap shown in both views (after an item inside a long one too), shared/personal entries on list boundaries (zero extra height, unchanged row positions, targets at least 24px) and adding one there (the form offering the host's time, a placeholder; the heading's button after the last item; another day by its time; by keyboard; dragged like any other), the 候補・相談 tab saying what each column is for (nothing off the side at 375px), the night theme's preview banner, day tabs, notice and invite warning at a contrast of 4.5 or more, the owner adding, renaming and removing 準備 and 費用メモ lines (kept across a reload), the owner changing a 候補's words and removing a 相談 (kept across a reload, nothing off the side at 375px), 旅を保存 at 375px (the trip page saved as one file (downloaded, or handed to the share sheet as text/html) for every role, Markdown copied to the clipboard, or shown selected when the clipboard is refused; the ZIP and a line per file of the trip's exports for the owner only, the same dialog from 共有・管理), 招待とオーナーの履歴 in 共有・管理 at 375px (an invite issued and revoked from the screen listed first, newest first, with the date and time, the role, the link's name and this phone's member name and device), no shared insertion target, grip, list form or 「直す」「消す」 for a participant, a passkey check before the owner's important actions (the first invite registers one, the second asks nothing, a replacement past five minutes checks the current passkey and makes a new one, a purge then checks the new one), the owner's first opening making the trip's key (the seat's public keys listed, 「この端末に鍵がある」, a participant's page saying 鍵を待っています, then 鍵を受け取る and the owner's 渡す: the codes typed into each other's screen, a wrong one putting nothing on the seat and a new commitment on trying again, then the key held with an edge on both seats), a passkey without PRF leaving no wrapped private key on the seat, the owner coming back with 「パスキーで戻る」 after IndexedDB and the cookie were cleared and holding the key again, a participant signing out from the footer (the confirm names the way back, the top page no longer lists the trip, the trip says why it cannot be opened) and coming back with 「パスキーで戻る」., a participant's own plan among the day's items (marked 自分だけ, no grip) and diary written, changed and removed, revised with a chat (the note that the chat reads the copy, the unreadable count, the diff before anything is sent, one sealed apply changing a plan and a diary entry and adding a plan, a viewer opening it with a first passkey), sealed by the page (a memo key from the passkey's PRF, no words sent, read again after a reload), unreadable ones (key and passkey gone) marked and removable, none of it shown to the owner");
} finally {
  if (capsuleId) {
    // Purged from the page (it holds the cookie); gone for everyone is checked from here, where there is none.
    const purged = owner ? await fromPage("purge", { title }).catch(() => undefined) : undefined;
    const gone = purged?.status === 200 && (await fetch(`${origin}/v1/c/${capsuleId}`)).status === 410;
    if (gone) console.log("Disposable test capsule removed; subsequent access returns 410."); else console.log(`Could not remove the test capsule ${capsuleId}: purge it by hand (title "${title}")`);
  }
  try { await send("Browser.close"); } catch { /* already gone */ }
  chrome.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true });
}
