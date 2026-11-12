export function load({ url }: { url: URL }) {
  return { value: url.searchParams.get('value') ?? 'initial' };
}
