import { AsyncLocalStorage } from "node:async_hooks";

export const BACKFILL_PROVIDER = "self-hosted";
export const BACKFILL_PRESETS = {
  prefilter: "qwen3.8-flash", structure: "qwen3.8-flash", score: "deepseek-v4.1-flash-selection",
  understand: "deepseek-v4.1-flash-low", summarize: "deepseek-v4.1-flash",
} as const;
export type BackfillRole = keyof typeof BACKFILL_PRESETS;
export interface BackfillRoute { route: string; actualModel: string; provider: string; credentialProfile?: string }
export interface BackfillBinding {
  model: string;
  // Old single-route manifests remain readable; new batches can restrict automatic fallback.
  route?: string;
  actualModel?: string;
  routes?: BackfillRoute[];
  registryRevision?: string;
}
export function bindingRoutes(binding: BackfillBinding): BackfillRoute[] {
  return binding.routes ?? [{ route: binding.route!, actualModel: binding.actualModel!, provider: BACKFILL_PROVIDER }];
}
export type BackfillBindings = Record<BackfillRole, BackfillBinding>;
export interface BackfillContext {
  runId: string;
  models: BackfillBindings;
  beforeCall: (purpose: string, model: string) => Promise<void>;
}
export const backfillContext = new AsyncLocalStorage<BackfillContext>();
export class BackfillPaused extends Error {}

export function backfillBinding(preset: string): BackfillBinding | null {
  const context = backfillContext.getStore();
  if (!context) return null;
  const role = (Object.keys(BACKFILL_PRESETS) as BackfillRole[]).find((r) => BACKFILL_PRESETS[r] === preset);
  if (!role) throw new Error(`Model ${preset} is outside the backfill pipeline`);
  return context.models[role];
}
