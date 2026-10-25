import { sql, type Db } from '../db.ts';
import { credential } from '../config.ts';
import { wechatBodyIssue } from './wechat.ts';

/** Keep diagnostic messages, never upstream HTML, authenticated URLs or nested request options. */
export function bodyFailureMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : 'WeChat body retrieval failed';
  for (const secret of [credential('collectors', 'WECHAT2RSS_RSS_TOKEN')]) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  return message.replace(/https?:\/\/[^\s<>"']+/g, '[URL]').slice(0, 1000);
}

/** The article row serializes failures against a concurrent feed recovery or audited repair. */
export async function updateWechatBodyIssue(articleId: string, failure?: { stage: string; message: string; at: Date }, db: Db = sql): Promise<boolean> {
  if ('begin' in db) return (db as typeof sql).begin(tx => updateWechatBodyIssue(articleId, failure, tx));
  const [a] = await db`SELECT body_status,body_text,body_html,content_discarded_at FROM articles WHERE id=${articleId} FOR UPDATE`;
  if (!a || a.content_discarded_at) return false;
  const usable = a.body_status === 'ok' && !wechatBodyIssue(a.body_text, a.body_html);
  if (usable) {
    const closed = await db`UPDATE wechat_body_issues SET resolved_at=now() WHERE article_id=${articleId} AND resolved_at IS NULL RETURNING article_id`;
    if (closed.length) await db`INSERT INTO audit_log(actor,action,subject,after)
      VALUES('wechat-collector','wechat.body_resolved',${'content:'+articleId},${db.json({bodyStatus:'ok'})})`;
  } else if (failure) {
    const [before] = await db`SELECT last_error,stage,resolved_at FROM wechat_body_issues WHERE article_id=${articleId}`;
    await db`INSERT INTO wechat_body_issues(article_id,last_attempt_at,failed_attempts,first_error,last_error,stage)
      VALUES(${articleId},${failure.at},1,${failure.message},${failure.message},${failure.stage})
      ON CONFLICT(article_id) DO UPDATE SET failed_attempts=wechat_body_issues.failed_attempts+1,
        last_attempt_at=greatest(wechat_body_issues.last_attempt_at,EXCLUDED.last_attempt_at),
        last_error=CASE WHEN wechat_body_issues.last_attempt_at IS NULL OR EXCLUDED.last_attempt_at>=wechat_body_issues.last_attempt_at THEN EXCLUDED.last_error ELSE wechat_body_issues.last_error END,
        stage=CASE WHEN wechat_body_issues.last_attempt_at IS NULL OR EXCLUDED.last_attempt_at>=wechat_body_issues.last_attempt_at THEN EXCLUDED.stage ELSE wechat_body_issues.stage END,
        resolved_at=NULL`;
    if (!before || before.resolved_at || before.last_error !== failure.message || before.stage !== failure.stage) {
      await db`INSERT INTO audit_log(actor,action,subject,after)
        VALUES('wechat-collector','wechat.body_failed',${'content:'+articleId},${db.json({stage:failure.stage,error:failure.message})})`;
    }
  }
  return usable;
}
