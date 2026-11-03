// What 共有・管理 tells of each seat and invite (src/client.ts manage): whether a seat holds the trip key, when it was last
// opened, and who an invite's 失効 shuts out. Names are as the screen shows them (opened from a sealed trip already).
export type ListedMember = { label: string; keyed?: boolean; seen?: number; pending?: boolean };
export type ListedGrant = { role?: string; members: ListedMember[]; carriesKey?: boolean };
export type Tag = { kind: "keyed" | "waiting" | "seen"; text: string };

// The host records `seen` once a day at most (SEEN_EVERY), so the day is all that is told.
const shortDay = (t: number) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };

// 「鍵あり」/「鍵待ち」 on a sealed trip (none for a seat awaiting approval: it reads nothing yet), and the day it was last opened if known.
export function memberTags(m: ListedMember, sealed: boolean): Tag[] {
  const tags: Tag[] = [];
  if (sealed && !m.pending) tags.push(m.keyed ? { kind: "keyed", text: "鍵あり" } : { kind: "waiting", text: "鍵待ち" });
  if (m.seen !== undefined) tags.push({ kind: "seen", text: `最後に開いた日 ${shortDay(m.seen)}` });
  return tags;
}

// Revoking an invite revokes every seat registered from it (src/cloud-host.ts POST revoke).
export function revokeNote(g: ListedGrant, sealed: boolean): string {
  if (!g.members.length) return "失効しても入れなくなる席はありません";
  return `失効すると ${g.members.length} 席${sealed ? `（うち鍵あり ${g.members.filter(m => m.keyed).length} 席）` : ""}が入れなくなります`;
}

// The seats listed waiting for the key, by name: counted from the list itself, so the count agrees with the seats' tags whether
// or not the seat reading it holds the key (view.waiting is told only to one that does, and leaves that seat out).
export function waitingSeats(grants: ListedGrant[]): string[] { return grants.flatMap(g => g.members.filter(m => !m.keyed && !m.pending).map(m => m.label)); }

// Whether the invite hands the trip key to whoever opens it, and who is still waiting for it. An invite left without the key
// (replaced since) is told only while no seat came from it: it is the one whose purpose is gone. Nothing on a plain trip.
export function linkNote(g: ListedGrant, sealed: boolean, waiting: string[]): string {
  if (!sealed || g.role === "owner") return "";
  if (g.carriesKey) return `旅行の鍵を載せたリンク · 鍵待ち ${waiting.length} 人${waiting.length ? `（${waiting.join("、")}）` : ""}`;
  return g.members.length ? "" : "旅行の鍵を載せていません";
}

// The question asked before an invite is revoked: the seats it shuts out, one a line.
export function revokeConfirm(g: ListedGrant, sealed: boolean): string {
  const lines = g.members.map(m => `・${[m.label, m.pending ? "承認待ち" : sealed ? (m.keyed ? "鍵あり" : "鍵待ち") : "", m.seen !== undefined ? `最後に開いた日 ${shortDay(m.seen)}` : ""].filter(Boolean).join(" · ")}`);
  return `この招待リンクと、そこから登録した全員を失効させますか？\n${g.members.length ? `失効する席（${g.members.length} 席）:\n${lines.join("\n")}` : "失効しても入れなくなる席はありません"}`;
}
