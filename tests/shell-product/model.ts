export interface Fixture {
  id: string;
  files: Record<string, string>;
  dependencies: Record<string, string>;
  selector: string;
  text: string;
  tool: string;
  buildOutputs: readonly string[];
  scripts: { dev: string; build: string };
}
