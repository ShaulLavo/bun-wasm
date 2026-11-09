type FixtureButton = { kind: string; index: number; parentIndex: number; label: string; ref: string; identifier?: string; selected?: boolean };
export function tabOverview(labels: string[], count = labels.length) {
  const nodes: FixtureButton[] = labels.flatMap((label, index) => [
    { kind: "button", index: index * 2, parentIndex: 90, label, ref: `e${index * 2 + 1}`, identifier: "TabOverviewItemView?IsPinned=false" },
    { kind: "button", index: index * 2 + 1, parentIndex: index * 2, label: "Close", ref: `e${index * 2 + 2}` },
  ]);
  nodes.push({ kind: "button", index: 90, parentIndex: 99, label: `${count} Tabs, Tab Group`, ref: "e99", selected: true });
  return { appBundleId: "com.apple.mobilesafari", truncated: false, nodes };
}

export function tabBatch(snapshot: unknown, commands = ["press", "snapshot"]) {
  return JSON.stringify({ success: true, data: { total: commands.length, executed: commands.length, results: commands.map((command, index) => ({ step: index + 1, command, ok: true, data: command === "snapshot" ? snapshot : {} })) } });
}
