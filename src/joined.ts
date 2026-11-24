// The trips this browser has joined, as the top page lists them (localStorage `capsules`, src/client.ts).
export type Joined = { id: string; title: string; startsOn: string; endsOn: string; purgeAt: string; passkey?: string };
// The ones past their deletion time: the host has deleted them or will at its next sweep, so this browser forgets them.
export function expiredIn(list: Joined[], now: number): string[] { return list.filter(t => !(+new Date(t.purgeAt) > now)).map(t => t.id); }
// A trip's row as this browser lists it after reading the trip: the title it opened, kept on this browser only (docs/ephemeral-trip-capsule.md §1.4).
// `passkey`: the credential ID of the passkey this browser last used on the seat, which forgetTrip tells the OS to drop; the host never returns it, so the previous row's is kept.
// Not opened (no key, or the wrong one): the title last opened here, else a fixed word, never the ciphertext. The dates are always the ones just read.
export function listedRow(prev: Joined | undefined, now: Joined, opened: boolean): Joined { return { ...now, title: opened ? now.title : prev?.title ?? "暗号化した旅行", ...(now.passkey ?? prev?.passkey ? { passkey: now.passkey ?? prev?.passkey } : {}) }; }
