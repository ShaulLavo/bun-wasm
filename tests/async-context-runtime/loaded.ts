export type Note = (phase: string, expected?: string) => void;

export async function loadedFromFile(note: Note, timer: (phase: string) => Promise<void>): Promise<void> {
  note("file.before-await");
  await Promise.resolve();
  note("file.after-await");
  await timer("file.after-timer");
  const rejection = new Error("file rejection");
  try {
    await Promise.reject(rejection);
    throw new Error("file expected rejection fulfilled");
  } catch (caught) {
    if (caught !== rejection) throw caught;
    note("file.catch");
  } finally {
    note("file.finally");
  }
}
