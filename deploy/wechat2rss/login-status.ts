// Only the health probe's required fields cross SSH; tokens and upstream errors never do.
const summary = process.argv.includes("--summary");
try {
  const token = process.env.RSS_TOKEN;
  if (!token) throw new Error("missing token");
  const url = new URL("/login/list", process.env.WECHAT2RSS_BASE_URL || "http://127.0.0.1:18480");
  url.searchParams.set("k", token);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error("HTTP error");
  const body = await response.json();
  if (body.err) {
    if (summary) { console.error("Wechat2RSS 健康 API 报错，登录状态未核实；请检查服务。"); process.exitCode = 1; }
    else console.log(JSON.stringify({ err: "Wechat2RSS 健康 API 报错" }));
  } else {
  if (!Array.isArray(body.data)) throw new Error("API error");
  const data = body.data.map((a: { available?: boolean; needCheck?: boolean; waitTime?: number }, i: number) => ({
    name: `微信账号 ${i + 1}`, available: a.available === true, needCheck: a.needCheck === true,
    waitTime: typeof a.waitTime === "number" ? a.waitTime : null,
  }));
  if (summary) {
    const healthy = data.length > 0 && data.every((a: { available: boolean; needCheck: boolean }) => a.available && !a.needCheck);
    console.log(`Wechat2RSS 登录：${data.length} 个账号，${healthy ? "可用且未风控" : "需处理登录或风控"}；AIHOT 采集/发布状态另查来源运行记录。`);
    process.exitCode = healthy ? 0 : 1;
  } else console.log(JSON.stringify({ data }));
  }
} catch {
  if (summary) console.error("Wechat2RSS 健康未核实：检查容器、私有配置与登录。未验证 AIHOT 采集/发布。");
  else console.log(JSON.stringify({ err: "Wechat2RSS 健康接口未能完成检查" }));
  process.exitCode = 1;
}
