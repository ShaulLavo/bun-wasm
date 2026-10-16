/** Opaque filesystem-owned identity. Open handles remain valid across rename and unlink. */
export type FileHandle = number;
export interface FileStat {
  kind: "file" | "directory";
  ino: number;
  size: number;
  mtime: number;
}
export interface DirectoryEntry {
  name: string;
  ino: number;
  kind: FileStat["kind"];
}
export interface ResolvedPath {
  parent: FileHandle | undefined;
  name: string;
  node: FileHandle | undefined;
  trailingSlash: boolean;
  terminalDot: boolean;
}
/** Synchronous preview1 boundary; a worker-backed client can implement the same operations.
 * Errors are positive WASI errno values. No tree nodes or file buffers cross this interface.
 */
export interface FileSystem {
  preopen(path: string): FileHandle;
  /** One retain/release pair per open description; duplicates share that lifetime. */
  retain(handle: FileHandle): void;
  release(handle: FileHandle): void;
  resolve(directory: FileHandle, path: string): ResolvedPath | number;
  stat(handle: FileHandle): FileStat;
  read(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number;
  write(handle: FileHandle, chunks: readonly Uint8Array[], offset: number): number;
  resize(handle: FileHandle, size: number, truncate: boolean): void;
  setMtime(handle: FileHandle, mtime: number): void;
  readdir(handle: FileHandle): DirectoryEntry[];
  create(path: ResolvedPath, kind: "file" | "directory"): FileHandle | { error: number };
  link(from: ResolvedPath, to: ResolvedPath): number;
  removePath(path: ResolvedPath, directory: boolean): number;
  rename(from: ResolvedPath, to: ResolvedPath): number;
}
