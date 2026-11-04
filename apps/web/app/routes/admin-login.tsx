// Admin sign-in: password, Google and Feishu when configured. The form posts
// straight to the API, which sets the session cookie and sends the browser on.
import { useLoaderData } from "react-router";
import type { Route } from "./+types/admin-login";
import { SITE } from "@aihot/industry/site";
import { apiGet } from "../lib/api.server";
import { Wordmark } from "../components/Logo";
import { buttonClass } from "../components/ui/Controls";

const ERRORS: Record<string, string> = {
  wrong: "密码不对，再试一次。",
  unset: "还没有设置管理员密码：在 .env 里设置 ADMIN_PASSWORD（至少 12 位），重启后再登录。",
  "too-many": "尝试次数太多，请 15 分钟后再试。",
  "google-unavailable": "Google 登录暂未启用，请使用其他登录方式。",
  "google-state": "登录已过期或已使用，请重新点击 Google 登录。",
  "google-cancelled": "已取消 Google 登录，可以重新选择账号。",
  "google-denied": "这个 Google 账号没有后台权限，请使用管理员账号。",
  "google-failed": "Google 登录未完成，请稍后重试或使用其他登录方式。",
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("return") ?? "/admin";
  const options = await apiGet<{ password: boolean; feishu: boolean; google: boolean }>("/api/auth/options", { signal: request.signal }).catch(() => ({ password: true, feishu: false, google: false }));
  return { returnTo: returnTo.startsWith("/admin") ? returnTo : "/admin", error: url.searchParams.get("error"), ...options };
}

export const meta: Route.MetaFunction = () => [{ title: `登录 · ${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];

export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });

export default function AdminLogin() {
  const { returnTo, error, password, feishu, google } = useLoaderData<typeof loader>();
  const message = error ? (ERRORS[error] ?? "登录未完成，请重新尝试。") : !password && !feishu && !google ? "后台登录尚未配置，请联系站点维护者。" : null;
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center justify-center gap-2">
          <Wordmark size={26} className="text-ink" />
          <span className="text-[15px] font-semibold text-ink-3">后台</span>
        </div>
        <div className="card mt-8 p-6">
          {message && <p role="alert" className="mb-4 text-[12.5px] leading-relaxed text-hot">{message}</p>}
          {google && (
            <a href={`/api/auth/google?${new URLSearchParams({ return: returnTo })}`} className={`${buttonClass("secondary", "lg")} w-full`}>
              <svg aria-hidden="true" width="18" height="18" viewBox="0 0 48 48"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.2H24v8h11a9.4 9.4 0 0 1-4.1 6.2v5.2h6.6c3.9-3.6 6.1-8.8 6.1-15.2Z"/><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.6-5.2c-1.8 1.2-4.1 1.9-6.9 1.9-5.3 0-9.8-3.6-11.4-8.4H5.8v5.4A20.4 20.4 0 0 0 24 44Z"/><path fill="#FBBC05" d="M12.6 27.4a12.2 12.2 0 0 1 0-7.8v-5.4H5.8a20.4 20.4 0 0 0 0 18.6l6.8-5.4Z"/><path fill="#EA4335" d="M24 11.2c3 0 5.7 1 7.8 3l5.8-5.8A19.6 19.6 0 0 0 24 3a20.4 20.4 0 0 0-18.2 11.2l6.8 5.4C14.2 14.8 18.7 11.2 24 11.2Z"/></svg>
              使用 Google 登录
            </a>
          )}
          {password && <form method="post" action="/api/auth/password" className={google ? "mt-6" : undefined}>
          <input type="hidden" name="return" value={returnTo} />
          <label htmlFor="password" className="block text-[13px] font-medium text-ink-2">
            管理员密码
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
            className="mt-2 h-10 w-full rounded-full border border-line-strong bg-surface px-4 text-[14px] text-ink outline-none transition-colors focus:border-accent"
          />
          <button type="submit" className={`${buttonClass("primary", "lg")} mt-5 w-full`}>
            登录
          </button>
          </form>}
          {feishu && (
            <a href={`/api/auth/feishu?${new URLSearchParams({ return: returnTo })}`} className={`${buttonClass("secondary", "lg")} mt-3 w-full`}>
              用飞书登录
            </a>
          )}
        </div>
        <p className="mt-6 text-center text-[12px] text-ink-4">
          <a href="/" className="hover:text-ink-2">
            回到 {SITE.name}
          </a>
        </p>
      </div>
    </div>
  );
}
