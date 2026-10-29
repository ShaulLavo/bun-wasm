export type Note = (phase: string, expected?: string) => void;

export async function loadedFromFile(note: Note, timer: (phase: string) => Promise<void>): Promise<void> {
  note("file.before-await");
  await Promise.resolve();
  note("file.after-await");
  await timer("file.after-timer");
  try {
    await Promise.reject(new Error("file rejection"));
  } catch {
    note("file.catch");
  } finally {
    note("file.finally");
  }
}
