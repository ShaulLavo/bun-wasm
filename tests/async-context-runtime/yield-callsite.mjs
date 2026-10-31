export async function* rejectedValue(value, note) {
  try { yield value; } catch (error) { note(error); }
}
