// The kinds of capsule this host publishes, by `spec.kind` (src/kit.ts). A capsule of a kind not here is refused.
import type { DomainKit } from "./kit";
import { tripKit } from "./trip-kit";
import { boardKit } from "./board-kit";
import { extract } from "./paste";

export const kits: Record<string, DomainKit> = { trip: tripKit, board: boardKit };
// The kind a request that names none means: what the top page makes, and what an older screen asks for.
export const DEFAULT_KIND = "trip";
export const kitOf = (spec: unknown, registry: Record<string, DomainKit> = kits): DomainKit | undefined => {
  const kind = spec && typeof spec === "object" ? (spec as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && Object.hasOwn(registry, kind) ? registry[kind] : undefined;
};
// A pasted answer (POST /v1/check) judged by the kit of the kind it names; one that names none, or a kind not registered, by
// `fallback` (the top page's kind), whose sentences say what is wrong.
export function judgePasted(text: string, now: number, registry: Record<string, DomainKit>, fallback: DomainKit) {
  const taken = extract(text);
  return ((taken.ok && kitOf((taken.value as { spec?: unknown } | null)?.spec, registry)) || fallback).judge(text, now);
}
