import { randomBytes } from "node:crypto";
import { writeFile, readFile, chmod } from "node:fs/promises";
import { invoke } from "./invoke";
import { source } from "./source";
import { validate, untimed } from "../src/schema";
import { publishHash } from "../src/validate";
const [input, functionName, profile, region = "ap-northeast-1", approvedHash] = process.argv.slice(2);
if (!input || !functionName || !profile) throw new Error("Usage: bun aws/publish.ts input.json function profile region [approved-sha256]");
const raw = JSON.parse(await readFile(input, "utf8"));
const validated = validate(raw.spec, raw.document, Date.now()), missing = untimed(validated.document);
if (missing.length) throw new Error(`開始時刻の無い予定があります: ${missing.map(m => m.path).join(", ")}`);
const hash = publishHash(validated);
const destination = input + ".owner.json", operationFile = input + ".operation";
// Written once, next to the input, with the same 0600 as the owner link. Keeping it is what makes a retry safe.
const save = async (file: string, contents: string, flag: "wx" | "w" = "wx") => { await writeFile(file, contents, { mode: 0o600, flag }); await chmod(file, 0o600); };
const detail = (r: { body?: { error?: string } }) => r.body?.error ? `: ${r.body.error}` : "";
// The Host checks its input strictly, so a publisher newer than the deployed Host is refused with a bare 400 (#103).
// Compare what both were built from before a hash is shown; there is no flag to skip this.
const stop = (message: string): never => { console.error(message + "まだ送信していません。"); process.exit(1); };
const local = source();
// What can be told from here alone comes first, before AWS is asked anything.
if (local.src === "unknown") stop("手元のsrcをgitから読めないため、配置済みのHostと同じか確かめられません。このリポジトリのgitの作業ツリーで実行してください。");
if (local.src.endsWith("-dirty")) stop("手元のsrcに未コミットの変更があるため、配置済みのHostと同じか確かめられません。コミットするか戻してから実行してください。");
const deployed: { src?: string } = await invoke(functionName, profile, region, { path: "/v1/version", payload: {} }).then(r => r.body ?? {}, (e: Error) => {
  if (!e.message.includes("Unsupported publisher path")) throw e;
  return stop("配置済みのHostが古く、何から作ったかを返せません。Hostを配置し直してください（aws/README.md「配置手順」）。");
});
if (deployed.src !== local.src) stop(`配置済みのHostと手元（${local.commit}）でsrcが違います（Host ${deployed.src ?? "unknown"} / 手元 ${local.src}）。同じsrcで使ってください: Hostを手元のコミットで配置し直す（aws/README.md「配置手順」）か、手元をそのHostを配置したコミット（srcのツリーハッシュが同じならどのコミットでもよい）に合わせる（git fetch のあと git switch --detach <コミット>）。`);
if (approvedHash !== hash) {
  console.log(`検証済み旅程 SHA-256: ${hash}\n内容・共有範囲を確認して、このハッシュを末尾に指定してください。まだ送信していません。`);
} else if (await Bun.file(destination).exists()) {
  console.log(`発行済みです。ownerリンクは ${destination} にあります。作り直したい場合はそのファイルと ${operationFile} を消してから実行してください。`);
} else {
  // The same operation id on every retry: the Host derives the capsule id from it, so a lost response cannot become a second trip.
  const existed = await Bun.file(operationFile).exists();
  // A blank file is what a run killed mid-write leaves behind. It names no publication, so replacing it loses nothing.
  let operationId = existed ? (await Bun.file(operationFile).text()).trim() : "";
  if (!operationId) { operationId = randomBytes(16).toString("hex"); await save(operationFile, operationId, existed ? "w" : "wx"); }
  const result = await invoke(functionName, profile, region, { payload: { ...validated, confirm: true, operationId } });
  if (result.statusCode === 201) {
    await save(destination, JSON.stringify(result.body, null, 2));
    console.log("発行完了。ownerリンクは入力ファイル隣の .owner.json に保存しました（秘密のためログには表示しません）。最初に開いた1台だけがオーナーになります。3日以内に普段使う端末で開いてください。");
  } else if (result.statusCode === 200 && result.body?.replayed) {
    // The earlier attempt had succeeded and its owner link went down with the lost response. While nobody holds the owner
    // seat, the retry itself carries a fresh link (the lost one no longer works); once someone does, ask /recover for one.
    const id: string = result.body.id;
    if (!/^[a-f0-9]{32}$/.test(id ?? "")) throw new Error("Hostが想定外のカプセルIDを返しました。発行されたか AWS 側で確認してください。");
    let link: { grantId: string; url: string } = result.body, recovered = false;
    if (!link.url) {
      const r = await invoke(functionName, profile, region, { path: `/v1/c/${id}/recover`, payload: { confirm: true } });
      if (r.statusCode !== 201) throw new Error(`ownerリンクの再発行に失敗しました (${r.statusCode})${detail(r)}`);
      link = r.body; recovered = true;
    }
    // Either way the link we hold is the only live owner invite. If it cannot be stored, say what to run: otherwise the
    // capsule is left with no owner anyone can reach.
    try { await save(destination, JSON.stringify({ id, grantId: link.grantId, url: link.url }, null, 2)); }
    catch (e) { throw new Error(`ownerリンクを再発行しましたが ${destination} に保存できず、そのリンクは失われました（${(e as Error).message}）。\n  bun aws/recover.ts ${id} ${functionName} ${profile} ${region}\nで出し直してください。`); }
    console.log(`前回の発行が成功していました。ownerリンクを再発行して入力ファイル隣の .owner.json に保存しました（秘密のためログには表示しません）。${recovered ? "前のリンクを開いた端末があれば、その登録は無効になります。" : "前のリンクはもう使えません。受付期限は最初の発行から3日のままなので、早めに開いてください。"}`);
  } else throw new Error([
    `発行に失敗しました (${result.statusCode})${detail(result)}`,
    result.statusCode === 409 ? `前回この操作IDで発行した旅程と内容が違います。同じ旅程を再実行するなら入力を戻し、別の旅程として出すなら ${operationFile} を消してから実行してください。` : "",
    result.statusCode === 410 ? `この操作IDで発行した旅行は削除済みです。改めて発行するなら ${operationFile} を消してから実行してください。` : "",
  ].filter(Boolean).join("\n"));
}
