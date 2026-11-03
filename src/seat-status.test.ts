import { test, expect } from "bun:test";
import { linkNote, memberTags, revokeConfirm, revokeNote, waitingSeats, type ListedGrant } from "./seat-status";

// Noon UTC: the same day from UTC-11 to UTC+11, so the day told does not move with the test machine's zone.
const oct30 = Date.UTC(2026, 9, 30, 12), nov1 = Date.UTC(2026, 10, 1, 12);
const keyed = { label: "メンバー7", keyed: true, seen: nov1 }, lost = { label: "メンバー4", keyed: false, seen: oct30 }, old = { label: "メンバー5", keyed: false };
const pending = { label: "メンバー8", pending: true };

test("memberTags tells a sealed trip's seats holding the key from those waiting, and the day each was last opened", () => {
  expect(memberTags(keyed, true)).toEqual([{ kind: "keyed", text: "鍵あり" }, { kind: "seen", text: "最後に開いた日 11/1" }]);
  expect(memberTags(lost, true)).toEqual([{ kind: "waiting", text: "鍵待ち" }, { kind: "seen", text: "最後に開いた日 10/30" }]);
  // A seat stored before `seen` was kept has no day; one awaiting approval reads nothing yet, so no key is told.
  expect(memberTags(old, true)).toEqual([{ kind: "waiting", text: "鍵待ち" }]);
  expect(memberTags(pending, true)).toEqual([]);
});

test("memberTags tells no key on a plain trip", () => {
  expect(memberTags(keyed, false)).toEqual([{ kind: "seen", text: "最後に開いた日 11/1" }]);
  expect(memberTags(old, false)).toEqual([]);
});

test("revokeNote counts the seats an invite's 失効 shuts out, and those holding the key on a sealed trip", () => {
  const g: ListedGrant = { role: "editor", members: [keyed, lost, old] };
  expect(revokeNote(g, true)).toBe("失効すると 3 席（うち鍵あり 1 席）が入れなくなります");
  expect(revokeNote(g, false)).toBe("失効すると 3 席が入れなくなります");
  expect(revokeNote({ members: [] }, true)).toBe("失効しても入れなくなる席はありません");
  expect(revokeNote({ members: [] }, false)).toBe("失効しても入れなくなる席はありません");
});

test("linkNote tells an invite carrying the key and who still waits, and one left without it", () => {
  expect(linkNote({ role: "participant", members: [], carriesKey: true }, true, ["メンバー4", "メンバー5"])).toBe("旅行の鍵を載せたリンク · 鍵待ち 2 人（メンバー4、メンバー5）");
  expect(linkNote({ role: "participant", members: [keyed], carriesKey: true }, true, [])).toBe("旅行の鍵を載せたリンク · 鍵待ち 0 人");
  // The key was replaced since: the link gives nothing to whoever opens it now.
  expect(linkNote({ role: "participant", members: [], carriesKey: false }, true, ["メンバー4"])).toBe("旅行の鍵を載せていません");
  // Seats came from it: it is told by their tags, not as a link.
  expect(linkNote({ role: "editor", members: [lost], carriesKey: false }, true, ["メンバー4"])).toBe("");
  // An owner invite never carries the key; a plain trip has none.
  expect(linkNote({ role: "owner", members: [], carriesKey: false }, true, [])).toBe("");
  expect(linkNote({ role: "participant", members: [], carriesKey: false }, false, [])).toBe("");
});

test("waitingSeats names every listed seat without the key, this one's included, and none awaiting approval", () => {
  const self = { label: "オーナー（この端末）", keyed: false, seen: nov1 };
  expect(waitingSeats([{ role: "owner", members: [self] }, { role: "editor", members: [keyed, lost, old, pending] }, { members: [] }])).toEqual(["オーナー（この端末）", "メンバー4", "メンバー5"]);
  expect(waitingSeats([{ members: [keyed] }])).toEqual([]);
});

test("revokeConfirm names each seat it shuts out, with its key and the day it was last opened", () => {
  expect(revokeConfirm({ members: [keyed, lost, old, pending] }, true)).toBe([
    "この招待リンクと、そこから登録した全員を失効させますか？",
    "失効する席（4 席）:",
    "・メンバー7 · 鍵あり · 最後に開いた日 11/1",
    "・メンバー4 · 鍵待ち · 最後に開いた日 10/30",
    "・メンバー5 · 鍵待ち",
    "・メンバー8 · 承認待ち",
  ].join("\n"));
  expect(revokeConfirm({ members: [keyed, old] }, false)).toBe("この招待リンクと、そこから登録した全員を失効させますか？\n失効する席（2 席）:\n・メンバー7 · 最後に開いた日 11/1\n・メンバー5");
  expect(revokeConfirm({ members: [] }, true)).toBe("この招待リンクと、そこから登録した全員を失効させますか？\n失効しても入れなくなる席はありません");
});
