// The kinds of capsule this host publishes, by `spec.kind` (src/kit.ts). A capsule of a kind not here is refused.
import type { DomainKit } from "./kit";
import { tripKit } from "./trip-kit";

export const kits: Record<string, DomainKit> = { trip: tripKit };
// The kind a request that names none means: what the top page makes, and what an older screen asks for.
export const DEFAULT_KIND = "trip";
export const kitOf = (spec: unknown, registry: Record<string, DomainKit> = kits): DomainKit | undefined => {
  const kind = spec && typeof spec === "object" ? (spec as { kind?: unknown }).kind : undefined;
  return typeof kind === "string" && Object.hasOwn(registry, kind) ? registry[kind] : undefined;
};
