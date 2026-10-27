// A Domain Kit: one kind of capsule (the trip is src/trip-kit.ts), registered by its `kind` in src/kits.ts. The host
// (src/cloud-host.ts) keeps the invites, seats, deadline and deletion the same for every kind; the shape of the Spec and
// the Document, what a member may do to them, and what they read as are the kit's. How to add one: docs/domain-kit.md.
import type { ZodType } from "zod";
export type Role = "owner" | "editor" | "participant" | "viewer";
export type State = "active" | "reflection" | "frozen" | "purged";
// What the host reads of every capsule, whatever its kind: the kind that holds the rest, the title typed to confirm a purge
// (ciphertext in a sealed capsule, which the screen compares), the deletion date, and the document's version for If-Match.
export type Envelope = { kind: string; title: string; lifecycle: { purgeAt: string } };
export type Versioned = { revision: number };
// A request a kit turns down, with the status and the sentence the member is answered with.
export class Refused extends Error { constructor(public status: number, message: string) { super(message); } }
export function refuse(status: number, message: string): never { throw new Refused(status, message); }
// The host's answer to a pasted or generated capsule (POST /v1/check): `messages` say what is wrong, `trip` is what was checked.
export type Judged = { ok: true; trip: { spec: unknown; document: unknown } } | { ok: false; reason?: string; messages?: string[] };
// A member's request of the document (PATCH document): who asks (`seat`, the member's `Session.id`, and the role), when, and
// the capsule as it stands. `sealed`: its words are ciphertext the host cannot read.
export type Asked<S, D> = { spec: S; document: D; created: number; sealed: boolean; role: Role; state: State; seat: string; now: number };
// A capsule as a revise or an undo reads it: `previous` is the step back the kit kept (`revise.step`).
export type Kept<S, D> = { spec: S; document: D; previous?: unknown; created: number };
// The next capsule, and what changes, as the screen shows it before saving. `purgeAt`: the deadline moves (an important
// action, checked by passkey). `large`: the title must be typed to confirm it.
export type Revised<S, D> = { ok: true; next: { spec: S; document: D }; diff: { purgeAt?: unknown; large: boolean } };

export type DomainKit<S extends Envelope = Envelope, D extends Versioned = Versioned> = {
  kind: string;
  // A new capsule as published: its rules, and what publishing alone asks. A refusal is a Refused with the publisher's sentence.
  publish(spec: unknown, document: unknown, now: number): { spec: S; document: D };
  // The rules a kept capsule obeys after every change, plain or (`sealed`) with its words as ciphertext. Throws when broken.
  validate(spec: unknown, document: unknown, createdAt: number, sealed: boolean): { spec: S; document: D };
  // Where the capsule is in its life: read-only once frozen, gone once purged. `forced` is the owner's ending of sharing.
  stateOf(spec: S, forced: string | null, now: number): State;
  accent(spec: S): string;
  // Why a change of the settings is refused (a page with posts dropped, a deadline in the past), or nothing.
  refusal(before: S, after: S, now: number): string | undefined;
  // The days the capsule is about, in the zone they are counted in, for what happens only within them (a footprint, a
  // member's own entry) and for the creator's list. A kind without dates has none, and those are not offered.
  period?(spec: S): { startsOn: string; endsOn: string; timezone: string };
  // Whether the document holds the item a photo is put under. A kind without items has no such place.
  hasItem?(document: D, id: string): boolean;
  // A plain capsule taken out: the ZIP and its name, and its Markdown and HTML alone.
  exports?: { zip(id: string, spec: S, document: D, updatedAt: string): Promise<Uint8Array>; name(spec: S): string; markdown(spec: S, document: D): string; html(spec: S, document: D): string };
  // Making one with a chat assistant: the instructions a creator copies, and what the host's own generation is told.
  recipe: { text: string; generate: string };
  // A pasted or generated answer, checked as publishing checks it.
  judge(text: string, now: number): Judged;
  // Applies one request of a member to the document in place, and checks the result as `validate` does, the version moving
  // by one. Who may ask what is the kit's; the host has refused a viewer and a frozen capsule already. The returned fields
  // are told back with the version.
  apply(asked: Asked<S, D>, input: unknown): Record<string, unknown>;
  // Revising with a chat assistant, and going back one step. A kind without it answers these with 404.
  revise?: {
    // What a chat is handed: the recipe and the capsule as it stands. `keepSpec`: an editor's, whose answer keeps the settings.
    text(spec: S, document: D, keepSpec: boolean): string;
    // What the host's own model is told and asked (POST revise/assist), today's date counted in the capsule's zone.
    ask(spec: S, document: D, keepSpec: boolean, instruction: string, now: number): { system: string; text: string };
    // A chat's answer against the plain capsule as it stands: the next one, or what is wrong (`tooLong`: the answer is over the limit).
    revise(c: Kept<S, D>, text: string, by: { author: string; at: string; now: number; keepSpec: boolean }): Revised<S, D> | { ok: false; tooLong?: true; reason?: string; messages?: string[] };
    // The plain capsule one step back. Refused when there is none, it no longer passes, or an editor's would change the settings.
    undo(c: Kept<S, D>, keepSpec: boolean): Revised<S, D>;
    // A sealed capsule a member's browser revised (`undo`: went back), checked by its plain parts and by the ciphertext that
    // must stay as it was. A new post is the seat's, at `now`.
    resealed(c: Kept<S, D>, input: unknown, how: { undo: boolean; keepSpec: boolean }, by: { seat: string; now: number }): { spec: S; document: D };
    // What is kept to go back to when `next` replaces the document.
    step(spec: S, document: D, next: D): unknown;
  };
  // The sealed form (docs/ephemeral-trip-capsule.md「5.4 平文の旅行を移す」「5.5 旅行の鍵を替える」): what moving a plain capsule to it and replacing
  // its key check of the kind's own records. A kind without it is never sealed.
  sealed?: {
    // The step back a move brings, as the browser sealed it.
    previous: ZodType;
    // The same records before and after the key is replaced, each post by the same seat at the same time. Refused otherwise.
    rekeyed(before: D, after: D): void;
  };
};
