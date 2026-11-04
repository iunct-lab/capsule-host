// Before the Host is torn down, the operator counts the trips that are still live. `aws/capsules.ts check-decommission`
// prints these lines and stops while any is left. The lines carry counts, states and a date only: never an id or a title.
// The Host never sees a trip's Export (it happens in the owner's browser on the sealed plan), so the report can only say
// which trips are at a stage where one can be taken (reflection / frozen) and leaves asking the owners to the operator.
export type Listed = { id: string | null; kind: string; state: string | null; purgeAt: string };
export type DecommissionReport = { live: number; byState: Record<string, number>; latestPurgeAt: string | null; ok: boolean; lines: string[] };

export function decommissionReport(list: Listed[], now: number): DecommissionReport {
  // A purge date that does not parse counts as live: this check is there to stop, so it errs on the side of stopping.
  const live = list.filter(c => !(+new Date(c.purgeAt) < now));
  const byState: Record<string, number> = {};
  for (const c of live) byState[c.state ?? "unknown"] = (byState[c.state ?? "unknown"] ?? 0) + 1;
  const latestPurgeAt = live.filter(c => !Number.isNaN(+new Date(c.purgeAt))).reduce<string | null>((latest, c) => latest === null || +new Date(c.purgeAt) > +new Date(latest) ? c.purgeAt : latest, null);
  const ok = live.length === 0;
  const lines = [
    `有効な旅行: ${live.length} 件`,
    ...Object.entries(byState).sort(([a], [b]) => a.localeCompare(b)).map(([state, n]) => `  ${state}: ${n} 件`),
    ...(latestPurgeAt ? [`いちばん遅い削除予定: ${latestPurgeAt}`] : []),
    "Export は Host に記録されません。reflection / frozen の旅行は Export できる段階です。Export が済んだかは各旅行の所有者に確かめてください。",
  ];
  return { live: live.length, byState, latestPurgeAt, ok, lines };
}
