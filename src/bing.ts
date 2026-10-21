const BASE = "https://ssl.bing.com/webmaster/api.svc/json";

/** Bing returns dates as "/Date(1316156400000-0700)/". */
function parseDate(value: unknown): string | unknown {
  if (typeof value !== "string") return value;
  const m = value.match(/^\/Date\((-?\d+)([+-]\d{4})?\)\/$/);
  return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : value;
}

/** Converts Bing's dates and drops the WCF "__type" tag it puts on every object. */
function convertDates<T>(value: T): T {
  if (Array.isArray(value)) return value.map(convertDates) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "__type")
        .map(([k, v]) => [k, typeof v === "string" ? parseDate(v) : convertDates(v)]),
    ) as T;
  }
  return value;
}

interface StatsRow {
  Query: string;
  Date: string;
  Clicks: number;
  Impressions: number;
  AvgClickPosition: number;
  AvgImpressionPosition: number;
}

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

export class BingClient {
  constructor(private apiKey: string) {}

  private async call<T>(method: string, params: Record<string, string> = {}, body?: unknown): Promise<T> {
    const qs = new URLSearchParams({ ...params, apikey: this.apiKey });
    const res = await fetch(`${BASE}/${method}?${qs}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json; charset=utf-8" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Bing Webmaster API error (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok || data?.ErrorCode !== undefined) {
      throw new Error(`Bing Webmaster API error (${res.status}): ${data?.Message ?? text.slice(0, 200)}`);
    }
    return convertDates(data.d as T);
  }

  /** Verification codes are left out: they are not useful here and are better not echoed around. */
  async listSites() {
    const sites = await this.call<{ Url: string; IsVerified: boolean }[]>("GetUserSites");
    return sites.map((s) => ({ siteUrl: s.Url, isVerified: s.IsVerified }));
  }

  /** Query or page stats, summed per key over the date range (Bing returns weekly buckets). */
  async stats(siteUrl: string, by: "query" | "page", startDate?: string, endDate?: string) {
    const rows = await this.call<StatsRow[]>(by === "query" ? "GetQueryStats" : "GetPageStats", { siteUrl });
    const inRange = rows.filter((r) => (!startDate || r.Date >= startDate) && (!endDate || r.Date <= endDate));
    const byKey = new Map<string, { clicks: number; impressions: number; weightedPosition: number }>();
    for (const r of inRange) {
      const acc = byKey.get(r.Query) ?? { clicks: 0, impressions: 0, weightedPosition: 0 };
      acc.clicks += r.Clicks;
      acc.impressions += r.Impressions;
      acc.weightedPosition += r.AvgImpressionPosition * r.Impressions;
      byKey.set(r.Query, acc);
    }
    return [...byKey]
      .map(([key, a]) => ({
        [by]: key,
        clicks: a.clicks,
        impressions: a.impressions,
        ctr: a.impressions ? round((a.clicks / a.impressions) * 100, 2) : 0,
        position: a.impressions ? round(a.weightedPosition / a.impressions) : null,
      }))
      .sort((a, b) => b.impressions - a.impressions);
  }

  /** Daily clicks and impressions for the whole site. */
  async traffic(siteUrl: string, startDate?: string, endDate?: string) {
    const rows = await this.call<{ Date: string; Clicks: number; Impressions: number }[]>("GetRankAndTrafficStats", { siteUrl });
    return rows
      .filter((r) => (!startDate || r.Date >= startDate) && (!endDate || r.Date <= endDate))
      .sort((a, b) => a.Date.localeCompare(b.Date));
  }

  /** Daily crawl counts, crawl errors and pages in index. */
  async crawl(siteUrl: string, startDate?: string, endDate?: string) {
    const rows = await this.call<{ Date: string }[]>("GetCrawlStats", { siteUrl });
    return rows
      .filter((r) => (!startDate || r.Date >= startDate) && (!endDate || r.Date <= endDate))
      .sort((a, b) => a.Date.localeCompare(b.Date));
  }

  crawlIssues(siteUrl: string) {
    return this.call<unknown[]>("GetCrawlIssues", { siteUrl });
  }

  submitSitemap(siteUrl: string, feedUrl: string) {
    return this.call<null>("SubmitFeed", {}, { siteUrl, feedUrl });
  }

  submitUrls(siteUrl: string, urlList: string[]) {
    return this.call<null>("SubmitUrlBatch", {}, { siteUrl, urlList });
  }

  urlQuota(siteUrl: string) {
    return this.call<{ DailyQuota: number; MonthlyQuota: number }>("GetUrlSubmissionQuota", { siteUrl });
  }
}
