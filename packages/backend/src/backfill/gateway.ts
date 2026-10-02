import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { BACKFILL_PRESETS, BACKFILL_PROVIDER, type BackfillBindings, type BackfillRole } from "./context.ts";

const binding = z.object({ model: z.string().min(1), route: z.string().min(1), actualModel: z.string().startsWith("self_hosted/") }).strict();
export const bindingsSchema = z.object({ prefilter: binding, structure: binding, score: binding, understand: binding, summarize: binding }).strict()
  .refine((v) => JSON.stringify(v.prefilter) === JSON.stringify(v.structure), "Prefilter and structure share the Qwen preset and must use the same binding");

export function verifyDiscovery(view: any, model: string, models: BackfillBindings, project: string, baseUrl: string): string {
  if (view.projection_version !== 2 || view.view_scope !== "logical_model" || view.requested_logical_model !== model ||
      view.status !== "ready" || view.project?.id !== project || view.project?.billing_scope !== "personal" ||
      JSON.stringify(view.project_allowed_logical_model_ids) !== JSON.stringify([model]) ||
      !view.registry?.loaded_revision || view.registry.loaded_revision !== view.registry.file_revision ||
      view.endpoint !== `${baseUrl}/v1/chat/completions`) throw new Error(`Gateway discovery is not ready for personal backfill model ${model}`);
  for (const b of Object.values(models).filter((b) => b.model === model)) {
    if (!view.routes?.some((r: any) => r.id === b.route && r.logical_model === model && r.actual_model === b.actualModel && r.provider_id === BACKFILL_PROVIDER &&
        r.effectively_eligible === true && r.project_allowed === true && r.policy_allowed === true)) throw new Error(`Self-hosted route is not eligible: ${b.route}`);
  }
  return view.registry.loaded_revision;
}

export async function checkGatewayRevision(baseUrl: string, revision: string): Promise<void> {
  const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(15000) });
  const view = await res.json() as any;
  if (!res.ok || view.status !== "ok" || view.file_registry_revision !== revision || view.loaded_registry_revision !== revision) throw new Error("Gateway configuration changed or is not ready; run preflight again");
}

/** Discovery is read-only. No model check, deployment or cloud fallback is performed here. */
export async function preflightBackfill(input: unknown): Promise<{ models: BackfillBindings; check: () => Promise<void> }> {
  if (!input) throw new Error("尚未绑定回填模型，请在部署完成后配置五个角色的自部署路由");
  const models = bindingsSchema.parse(input);
  const project = process.env.LLM_GATEWAY_PROJECT;
  const endpoint = process.env.LLM_GATEWAY_URL;
  if (!endpoint || !project) throw new Error("Personal LLM_GATEWAY_URL and LLM_GATEWAY_PROJECT are required");
  const u = new URL(endpoint);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Invalid Gateway URL");
  const baseUrl = u.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
  const revisions = new Set<string>();
  for (const model of new Set((Object.keys(BACKFILL_PRESETS) as BackfillRole[]).map((r) => models[r].model))) {
    const { stdout } = await promisify(execFile)(process.env.LLM_GATEWAY_CLI || "llm-gateway",
      ["--format", "json", "discover", "--project", project, "--logical-model", model], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    revisions.add(verifyDiscovery(JSON.parse(stdout), model, models, project, baseUrl));
  }
  if (revisions.size !== 1) throw new Error("Gateway changed during preflight");
  const check = () => checkGatewayRevision(baseUrl, [...revisions][0]!);
  await check();
  return { models, check };
}
