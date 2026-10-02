import { AsyncLocalStorage } from "node:async_hooks";

export const BACKFILL_PROVIDER = "self-hosted";
export const BACKFILL_PRESETS = {
  prefilter: "qwen3.8-flash", structure: "qwen3.8-flash", score: "glm-5.3-flash-selection",
  understand: "glm-5.3-flash", summarize: "deepseek-v4-flash-0731",
} as const;
export type BackfillRole = keyof typeof BACKFILL_PRESETS;
export interface BackfillBinding { model: string; route: string; actualModel: string }
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
