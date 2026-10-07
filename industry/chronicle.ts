// 大事记的初始选材门槛沿用上游，尚未用本站标注样本校准。
// 身份合并由 publication 层负责；这里不猜测模型名或改写事件标题。
export interface ChronicleKind {
  label: string;
  above?: true;
  launch?: true;
  company?: { min: number; perMonth: number };
  other?: { min: number };
}

export const CHRONICLE_KINDS: Record<string, ChronicleKind> = {
  model: { label: "模型", above: true, launch: true, company: { min: 70, perMonth: 3 }, other: { min: 75 } },
  product: { label: "产品", launch: true, company: { min: 75, perMonth: 2 }, other: { min: 75 } },
  research: { label: "研究", other: { min: 75 } },
  company: { label: "公司", company: { min: 85, perMonth: 1 } },
  industry: { label: "行业", other: { min: 85 } },
};

export const CHRONICLE_FORMS: Record<string, { kinds: string[]; perMonth?: number }> = {
  "model-releases": { kinds: ["model"], perMonth: 8 },
  "product-updates": { kinds: ["product"] },
  papers: { kinds: ["research"] },
  benchmarks: { kinds: ["research", "product"] },
  industry: { kinds: ["industry"] },
  policy: { kinds: ["industry"] },
};

export function chronicleKind(item: {
  title: string; category: string | null; tags: string[]; action: string | null; itemType: string | null;
}, group: "company" | "field" | "genre"): string | null {
  if (["tutorial_explainer", "opinion_analysis", "roundup", "digest"].includes(item.itemType ?? "")) return null;
  const kind = item.category === "ai-products" ? "product"
    : item.category === "ai-models" || item.tags.includes("模型发布") ? "model"
    : item.category === "paper" ? "research"
    : item.category === "industry" ? (group === "company" ? "company" : "industry") : null;
  if (kind !== "model" && kind !== "product") return kind;
  if (/^(?:(?:opinion|analysis|commentary|prediction|tutorial|preview)\b|介绍|讲解|分享|评测|测评|回顾|复盘|预告)/i.test(item.action ?? "")) return null;
  // 只判断主句：后面的免费使用说明或另一个工具的预告不否决已发生的发布。
  const main = item.title.split(/[，,。；;]|并(?:预告|宣布)/)[0]!;
  if (/即将|预告|将于|下周|传闻|coming soon|一揽子|汇总|合集|盘点/i.test(main)
    || /^(?:教程|指南|实测|体验|复盘|如何|评测|跑分|排行榜|榜单|Show HN|Ask HN)/i.test(main)) return null;
  return kind;
}
