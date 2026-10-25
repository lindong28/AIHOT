// A known response and an unknown bill can coexist. Never derive billing from this classification.
import { type Db } from "../db.ts";
import { contentPolicyRejected, safeGatewayFailure } from "./gateway-error.ts";

export type ReceiptOutcome = "unknown" | "content_policy_rejected" | "invalid_request";

export function receiptOutcome(details: unknown, error: string | null, response?: unknown): ReceiptOutcome {
  const raw = response as { error?: { code?: string }; output?: unknown; choices?: Array<{ finish_reason?: string; message?: { refusal?: unknown } }> } | null;
  const body = (raw?.error?.code === "parse_error" ? raw.output : raw) as typeof raw;
  const choice = body?.choices?.[0];
  if (contentPolicyRejected(details, error) || choice?.finish_reason === "content_filter" || choice?.message?.refusal) return "content_policy_rejected";
  const safe = safeGatewayFailure(details);
  if (safe?.category === "invalid_request" && [400, 422].includes(safe.httpStatus ?? 0)) return "invalid_request";
  return "unknown";
}

/** Caller holds the parent receipt lock and supplies its current attempt. */
export async function recordReceiptOutcome(db: Db, id: number, attempt: number, outcome: ReceiptOutcome) {
  if (outcome === "unknown") return;
  const changed = await db`INSERT INTO receipt_reviews (receipt_id,attempt,outcome,disposition,note,actor,evidence)
    VALUES (${id},${attempt},${outcome},${outcome === "content_policy_rejected" ? "stopped" : "open"},
      ${outcome === "content_policy_rejected" ? "模型明确拒绝，停止同一请求；计费仍待核对" : "HTTP 明确拒绝请求；具体原因需核查，计费仍待核对"},
      'receipt.classify',${db.json({ source: "receipt_attempt", attempt })})
    ON CONFLICT (receipt_id,attempt) DO UPDATE SET outcome=excluded.outcome,
      disposition=CASE WHEN receipt_reviews.disposition='open' THEN excluded.disposition ELSE receipt_reviews.disposition END,
      updated_at=now() WHERE receipt_reviews.outcome<>excluded.outcome RETURNING outcome,disposition`;
  if (changed.length) await db`INSERT INTO audit_log (actor,action,subject,reason,after)
    VALUES ('receipt.classify','receipt.classify',${`receipt:${id}`},'按当前 attempt 的安全响应证据分类；计费不变',
      ${db.json({ attempt, ...changed[0] })})`;
}
