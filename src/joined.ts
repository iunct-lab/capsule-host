// The trips this browser has joined, as the top page lists them (localStorage `capsules`, src/client.ts).
export type Joined = { id: string; title: string; startsOn: string; endsOn: string; purgeAt: string };
// The ones past their deletion time: the host has deleted them or will at its next sweep, so this browser forgets them.
export function expiredIn(list: Joined[], now: number): string[] { return list.filter(t => !(+new Date(t.purgeAt) > now)).map(t => t.id); }
