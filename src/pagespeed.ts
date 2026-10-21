import type { OAuth2Client } from "google-auth-library";

const ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

const CATEGORIES = ["performance", "seo", "accessibility", "best-practices"] as const;
export type Category = (typeof CATEGORIES)[number];

// Lab metrics worth reporting from Lighthouse, by audit id.
const LAB_METRICS = [
  "first-contentful-paint",
  "largest-contentful-paint",
  "total-blocking-time",
  "cumulative-layout-shift",
  "speed-index",
  "server-response-time",
];

interface FieldMetric {
  percentile: number;
  category: string;
}
interface LoadingExperience {
  id?: string;
  overall_category?: string;
  metrics?: Record<string, FieldMetric>;
}
interface Audit {
  id: string;
  title: string;
  score: number | null;
  scoreDisplayMode: string;
  displayValue?: string;
  details?: { type?: string; overallSavingsMs?: number; overallSavingsBytes?: number };
}
interface PsiResponse {
  loadingExperience?: LoadingExperience;
  originLoadingExperience?: LoadingExperience;
  lighthouseResult?: {
    finalUrl?: string;
    categories?: Record<string, { score: number | null; auditRefs: { id: string; weight: number }[] }>;
    audits?: Record<string, Audit>;
  };
  error?: { message: string };
}

/** CrUX field data (real Chrome users, 28-day window). Absent when the URL or origin has too little traffic. */
function field(exp?: LoadingExperience) {
  if (!exp?.metrics) return undefined;
  return {
    overall: exp.overall_category,
    metrics: Object.fromEntries(Object.entries(exp.metrics).map(([k, m]) => [k, { p75: m.percentile, category: m.category }])),
  };
}

/** Calls with the API key when one is configured, otherwise with the signed-in Google account. */
export async function runPagespeed(
  url: string,
  strategy: "mobile" | "desktop",
  categories: Category[],
  auth: { key: string } | { client: OAuth2Client },
) {
  const qs = new URLSearchParams({ url, strategy });
  for (const c of categories) qs.append("category", c);
  let data: PsiResponse;
  if ("key" in auth) {
    qs.set("key", auth.key);
    const res = await fetch(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(120_000) });
    data = (await res.json()) as PsiResponse;
    if (!res.ok || data.error) throw new Error(`PageSpeed Insights error (${res.status}): ${data.error?.message ?? "unknown"}`);
  } else {
    try {
      data = (await auth.client.request<PsiResponse>({ url: `${ENDPOINT}?${qs}`, timeout: 120_000 })).data;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? err?.message ?? String(err);
      if (/insufficient authentication scopes/i.test(message)) {
        throw new Error("PageSpeed access was not granted. Run `npx seoclaude auth` again, or set PAGESPEED_API_KEY.");
      }
      if (/has not been used|is disabled/i.test(message)) {
        throw new Error(`Enable the PageSpeed Insights API in your Google Cloud project, or set PAGESPEED_API_KEY. (${message})`);
      }
      throw new Error(`PageSpeed Insights error: ${message}`);
    }
  }

  const lh = data.lighthouseResult ?? {};
  const audits = lh.audits ?? {};
  const scores = Object.fromEntries(
    Object.entries(lh.categories ?? {}).map(([k, c]) => [k, c.score === null ? null : Math.round(c.score * 100)]),
  );

  const opportunities = Object.values(audits)
    .filter((a) => a.details?.type === "opportunity" && (a.details.overallSavingsMs ?? 0) > 0)
    .sort((a, b) => (b.details?.overallSavingsMs ?? 0) - (a.details?.overallSavingsMs ?? 0))
    .slice(0, 10)
    .map((a) => ({ id: a.id, title: a.title, savingsMs: Math.round(a.details!.overallSavingsMs!), displayValue: a.displayValue }));

  // Failing audits in the non-performance categories (SEO, accessibility, best practices).
  const failing = Object.fromEntries(
    Object.entries(lh.categories ?? {})
      .filter(([k]) => k !== "performance")
      .map(([k, c]) => [
        k,
        c.auditRefs
          // Zero-weight audits are informative and don't affect the score; listing them contradicts a 100.
          .filter((ref) => ref.weight > 0)
          .map((ref) => audits[ref.id])
          .filter((a) => a && a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "notApplicable" && a.scoreDisplayMode !== "manual")
          .map((a) => ({ id: a.id, title: a.title, displayValue: a.displayValue })),
      ]),
  );

  return {
    url,
    finalUrl: lh.finalUrl,
    strategy,
    scores,
    fieldData: {
      page: field(data.loadingExperience) ?? "No CrUX data for this URL (not enough traffic)",
      origin: field(data.originLoadingExperience) ?? "No CrUX data for this origin (not enough traffic)",
    },
    lab: Object.fromEntries(LAB_METRICS.filter((id) => audits[id]).map((id) => [id, audits[id].displayValue])),
    opportunities,
    failingAudits: failing,
  };
}
