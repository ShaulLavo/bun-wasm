import type { Fixture } from "./model";
export interface ProductApi {
  setup(): Promise<void>;
  open(fixture: Fixture, registry: string): Promise<void>;
  command(text: string, milliseconds?: number): Promise<{ code: number | null; output: string }>;
  start(command: string, port: number, milliseconds: number): Promise<string>;
  interrupt(): Promise<{ code: number; output: string }>;
  close(): Promise<void>;
  readFile(path: string): Promise<string | null>;
  diagnostics(): { tailAvailable: boolean; transcripts: { app: string; text: string }[]; pending: unknown };
  cleanup(): Promise<{ workers: number; listeners: number }>;
}
