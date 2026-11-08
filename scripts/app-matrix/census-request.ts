import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseArmRegistry, verifyMeasurementInput, type ArmDescriptor, type ArmRegistry, type MeasurementHost, sha256 } from "../engine-arm-registry.ts";
import { censusArms, censusChild, verifyCensusProvenance } from "./engine-arms.ts";

type CensusHost = "native" | "playground";
type CensusPlan = {
  readonly schemaVersion: 2;
  readonly kind: "experimental-app-census";
  readonly host: CensusHost;
  readonly armRegistry: ArmRegistry;
  readonly children: readonly unknown[];
  readonly sourceCatalog: readonly unknown[];
  readonly fixturesSha256: string;
};
export type CensusSelection = {
  readonly plan: CensusPlan;
  readonly registry: ArmRegistry;
  readonly arm: ArmDescriptor;
  readonly child: ReturnType<typeof censusChild>;
  readonly measurementHost: MeasurementHost;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("census plan must be an object");
  return value;
}

function host(value: unknown): CensusHost {
  if (value !== "native" && value !== "playground") throw new TypeError("census plan host is invalid");
  return value;
}

function labelOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const label = Reflect.get(value, "label");
  return typeof label === "string" ? label : undefined;
}

function planValue(value: unknown): CensusPlan {
  const entry = record(value);
  assert.equal(entry.schemaVersion, 2, "census plan requires an arm-aware schema");
  assert.equal(entry.kind, "experimental-app-census", "census plan kind is invalid");
  if (!Array.isArray(entry.children)) throw new TypeError("census plan is missing typed arm requests");
  assert.ok(Array.isArray(entry.sourceCatalog) && entry.sourceCatalog.length > 0, "census plan is missing its catalog");
  assert.ok(typeof entry.fixturesSha256 === "string" && entry.fixturesSha256 === sha256(JSON.stringify(entry.sourceCatalog)), "census catalog digest differs");
  const registry = parseArmRegistry(entry.armRegistry);
  return { schemaVersion: 2, kind: "experimental-app-census", host: host(entry.host), armRegistry: registry,
    children: entry.children, sourceCatalog: entry.sourceCatalog, fixturesSha256: entry.fixturesSha256 };
}

function typedArmRequest(selection: CensusSelection, candidate: unknown): void {
  const expected = selection.child;
  const request = record(candidate);
  assert.equal(request.label, expected.label, "typed census request label differs");
  assert.equal(request.engine, expected.engine, "typed census request engine differs");
  assert.equal(request.cacheIdentity, expected.cacheIdentity, "typed census request cache identity differs");
  assert.equal(request.tier, expected.tier, "typed census request tier differs");
  assert.equal(request.sourceCommit, expected.sourceCommit, "typed census request source differs");
  assert.equal(request.sourceTree, expected.sourceTree, "typed census request tree differs");
  assert.deepEqual(request.program, expected.program, "typed census request program differs");
  assert.deepEqual(request.servedGzip, expected.servedGzip, "typed census request served bytes differ");
  assert.deepEqual(request.producerAdmission, expected.producerAdmission, "typed census request admission differs");
  assert.deepEqual(request.environment, expected.environment, "typed census request environment differs");
}

export function selectCensusArm(value: unknown, label: string): CensusSelection {
  assert.ok(label.length > 0, "census arm label is required");
  const plan = planValue(value);
  const measurementHost: MeasurementHost = plan.host === "native" ? "native" : "chromium";
  const arm = censusArms(plan.armRegistry, measurementHost).find(candidate => candidate.label === label);
  if (!arm) throw new Error(`census arm ${label} is not registered for ${plan.host}`);
  const child = censusChild(arm, measurementHost, {});
  const labels = censusArms(plan.armRegistry, measurementHost).map(arm => arm.label);
  assert.deepEqual(plan.children.map(labelOf).sort(), labels.toSorted(), "census typed requests must cover every arm exactly once");
  const candidate = plan.children.find(request => labelOf(request) === label);
  if (!candidate) throw new Error(`census plan has no typed request for ${label}`);
  const selection = { plan, registry: plan.armRegistry, arm, child, measurementHost };
  typedArmRequest(selection, candidate);
  verifyCensusProvenance(censusProvenance(selection), selection.registry, selection.arm);
  return selection;
}

export function censusProvenance(selection: Pick<CensusSelection, "registry" | "arm">): Record<string, unknown> {
  return { sourceCommit: selection.registry.sourceCommit, sourceTree: selection.registry.sourceTree, armLabel: selection.arm.label,
    engineKind: selection.arm.engineKind, tier: selection.arm.tier, program: selection.arm.program,
    servedGzip: selection.arm.servedGzip, producerAdmission: selection.arm.producerAdmission,
    manifestSha256: selection.arm.producerAdmission.manifest.sha256, admissionSha256: selection.arm.producerAdmission.receipt.sha256,
    launcher_sha256: selection.registry.launcher.sha256 };
}

export async function loadCensusSelection(path: string, label: string): Promise<CensusSelection> {
  const selection = selectCensusArm(JSON.parse(await readFile(path, "utf8")), label);
  await verifyMeasurementInput(selection.registry);
  return selection;
}

export function verifyCensusCatalog(selection: CensusSelection, selected: readonly unknown[]): void {
  assert.equal(sha256(JSON.stringify(selected)), selection.plan.fixturesSha256, "executed census catalog differs from the registered fixtures");
}
