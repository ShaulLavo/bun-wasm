export interface SourceEdit {
  path: string;
  search: string;
  replacement: string;
}

export type FeatureProbe =
  | { kind: "route"; id: string; path: string; selector: string; text: string }
  | { kind: "action"; id: string; path: string; button: string; selector: string; text: string }
  | { kind: "response"; id: string; path: string; status: number; text?: string; header?: { name: string; value: string } };

export type ProductCheck =
  | { kind: "page"; selector: string; text: string; hmr?: SourceEdit; probes?: readonly FeatureProbe[] }
  | { kind: "http"; text: string; probes?: readonly FeatureProbe[] }
  | { kind: "files"; paths: readonly string[]; text: string }
  | { kind: "stdout"; text: string }
  | { kind: "diagnostics"; exit: number; texts: readonly string[] };

export interface ProductCommand {
  name: string;
  args: readonly string[];
  check: ProductCheck;
  after?: string;
}

export interface ProductApp {
  id: string;
  family: string;
  dependencies: Record<string, string>;
  files: Record<string, string>;
  commands: readonly ProductCommand[];
  features?: readonly string[];
}

export const productMarker = "bun-wasm product matrix";
