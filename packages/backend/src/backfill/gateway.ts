import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { BACKFILL_PRESETS, BACKFILL_PROVIDER, bindingRoutes, type BackfillBindings, type BackfillRole } from "./context.ts";

const route = z.object({ route: z.string().min(1), actualModel: z.string().min(1), provider: z.string().min(1), credentialProfile: z.string().min(1) }).strict();
const binding = z.union([
  z.object({ model: z.string().min(1), route: z.string().min(1), actualModel: z.string().startsWith("self_hosted/") }).strict(),
  z.object({ model: z.string().min(1), routes: z.array(route).min(1).max(16) }).strict(),
]);
export const bindingsSchema = z.object({ prefilter: binding, structure: binding, score: binding, understand: binding, summarize: binding }).strict()
  .refine((v) => JSON.stringify(v.prefilter) === JSON.stringify(v.structure), "Prefilter and structure share the Qwen preset and must use the same binding")
  .refine((v) => JSON.stringify(v.understand) === JSON.stringify(v.summarize), "Understand and summarize share the DeepSeek preset and must use the same binding")
  .superRefine((models, ctx) => {
    for (const [role, b] of Object.entries(models)) {
      const candidates = bindingRoutes(b);
      if (["score", "understand", "summarize"].includes(role)) {
        const r = candidates[0];
        if (b.model !== "deepseek-v4.1-flash" || candidates.length !== 1 ||
            r?.route !== "company_tencent_vod/deepseek-v4.1-flash/stream" ||
            r.actualModel !== "openai/deepseek-v4.1-flash" || r.provider !== "tencent-vod" ||
            r.credentialProfile !== "company_tencent_vod") {
          ctx.addIssue({ code: "custom", message: `Backfill ${role} requires DeepSeek V4.1 Flash on company_tencent_vod only` });
        }
        continue;
      }
      if (b.model.startsWith("deepseek")) ctx.addIssue({ code: "custom", message: "DeepSeek is not authorized for backfill prefilter or structure" });
      if (new Set(candidates.map((r) => r.route)).size !== candidates.length) ctx.addIssue({ code: "custom", message: `Duplicate backfill route in ${role}` });
      for (const r of candidates) {
        const self = r.provider === BACKFILL_PROVIDER && r.actualModel.startsWith("self_hosted/");
        if (!self) ctx.addIssue({ code: "custom", message: `Unauthorized backfill provider for ${role}` });
      }
    }
  });

export function verifyDiscovery(view: any, model: string, models: BackfillBindings, project: string, baseUrl: string): string {
  bindingsSchema.parse(models);
  const revision = view.loaded_registry_revision ?? view.registry?.loaded_revision;
  const fileRevision = view.file_registry_revision ?? view.registry?.file_revision;
  const scopes = z.union([z.enum(["personal", "company"]), z.array(z.enum(["personal", "company"])).min(1)
    .refine((v) => new Set(v).size === v.length)]).safeParse(view.project?.billing_scope);
  const billingScopes = scopes.success ? (Array.isArray(scopes.data) ? scopes.data : [scopes.data]) : [];
  if (view.projection_version !== 2 || view.view_scope !== "logical_model" || view.requested_logical_model !== model ||
      view.status !== "ready" || view.project?.id !== project || !billingScopes.includes("personal") ||
      JSON.stringify(view.project_allowed_logical_model_ids) !== JSON.stringify([model]) ||
      !revision || revision !== fileRevision ||
      (!view.loaded_registry_revision && view.endpoint !== `${baseUrl}/v1/chat/completions`)) throw new Error(`Gateway discovery is not ready for personal backfill model ${model}`);
  for (const b of Object.values(models).filter((b) => b.model === model)) {
    let eligible = false;
    for (const candidate of bindingRoutes(b)) {
      const found = view.routes?.find((r: any) => r.id === candidate.route && r.actual_model === candidate.actualModel && r.provider_id === candidate.provider &&
        (!candidate.credentialProfile || r.credential_profile_id === candidate.credentialProfile));
      if (!found || found.project_allowed === false || found.policy_allowed === false ||
          (candidate.provider === "tencent-vod" && !billingScopes.includes("company")) ||
          (candidate.provider !== BACKFILL_PROVIDER && found.funding_source !==
            (candidate.provider === "tencent-vod" ? "company_paid" : "personal_subscription"))) throw new Error(`Backfill route identity or funding changed: ${candidate.route}`);
      eligible ||= found.effectively_eligible === true;
    }
    if (!eligible) throw new Error(`No eligible authorized backfill route for ${model}`);
  }
  return revision;
}

export async function checkGatewayRevision(baseUrl: string, revision: string): Promise<void> {
  const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(15000) });
  const view = await res.json() as any;
  if (!res.ok || view.status !== "ok" || view.file_registry_revision !== revision || view.loaded_registry_revision !== revision) throw new Error("Gateway configuration changed or is not ready; run preflight again");
}

/** Discovery is read-only. No model check, deployment or cloud fallback is performed here. */
export async function preflightBackfill(input: unknown): Promise<{ models: BackfillBindings; check: () => Promise<void> }> {
  if (!input) throw new Error("尚未绑定回填模型，请先配置五个角色的授权路由");
  const models = bindingsSchema.parse(input);
  const project = process.env.LLM_GATEWAY_PROJECT;
  const endpoint = process.env.LLM_GATEWAY_URL;
  if (!endpoint || !project) throw new Error("Personal LLM_GATEWAY_URL and LLM_GATEWAY_PROJECT are required");
  const u = new URL(endpoint);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error("Invalid Gateway URL");
  const baseUrl = u.toString().replace(/\/+$/, "").replace(/\/v1$/, "");
  const revisions = new Set<string>();
  for (const model of new Set((Object.keys(BACKFILL_PRESETS) as BackfillRole[]).map((r) => models[r].model))) {
    let view: unknown;
    if (process.env.LLM_GATEWAY_CLI) {
      const { stdout } = await promisify(execFile)(process.env.LLM_GATEWAY_CLI,
        ["--format", "json", "discover", "--project", project, "--logical-model", model], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      view = JSON.parse(stdout);
    } else {
      const response = await fetch(`${baseUrl}/v1/discovery?model=${encodeURIComponent(model)}`, { headers: { "X-LLM-Project": project }, signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Gateway discovery HTTP ${response.status}`);
      view = await response.json();
    }
    revisions.add(verifyDiscovery(view, model, models, project, baseUrl));
  }
  if (revisions.size !== 1) throw new Error("Gateway changed during preflight");
  const check = () => checkGatewayRevision(baseUrl, [...revisions][0]!);
  await check();
  const verified: BackfillBindings = Object.fromEntries(Object.entries(models).map(([role, b]) => [role, { ...b, registryRevision: [...revisions][0]! }])) as BackfillBindings;
  return { models: verified, check };
}
