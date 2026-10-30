export type Encoding = "br" | "gzip" | "identity";

export function acceptedEncodings(value: string | null): Encoding[] | undefined {
  if (!value?.trim()) return ["identity"];
  const weights = new Map<string, number>();
  for (const member of value.split(",")) {
    if (!member.trim()) continue;
    const match = /^([!#$%&'*+.^_`|~0-9a-z-]+)(?:[ \t]*;[ \t]*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/i.exec(member.trim());
    const token = match?.[1]?.toLowerCase();
    if (!token) return;
    const coding = token === "x-gzip" ? "gzip" : token;
    const weight = Number(match?.[2] ?? 1);
    weights.set(coding, Math.min(weights.get(coding) ?? 1, weight));
  }
  const preference: Encoding[] = ["br", "gzip", "identity"];
  const quality = (encoding: Encoding) => weights.get(encoding) ?? (encoding === "identity" ? 0 : weights.get("*") ?? 0);
  const accepted = preference.filter(encoding => quality(encoding) > 0);
  accepted.sort((first, second) => quality(second) - quality(first));
  // Unweighted identity is the fallback, unless identity or the wildcard refuses it.
  if (!weights.has("identity") && weights.get("*") !== 0) accepted.push("identity");
  return accepted;
}

