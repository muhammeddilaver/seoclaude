import type { OAuth2Client } from "google-auth-library";

const WEBMASTERS = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE = "https://searchconsole.googleapis.com/v1";

export type Dimension = "query" | "page" | "country" | "device" | "date" | "searchAppearance";
export type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";

export interface DimensionFilter {
  dimension: Dimension;
  operator: "equals" | "notEquals" | "contains" | "notContains" | "includingRegex" | "excludingRegex";
  expression: string;
}

export interface AnalyticsQuery {
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  type?: SearchType;
  filters?: DimensionFilter[];
  rowLimit?: number;
  startRow?: number;
}

export interface AnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export class GscClient {
  constructor(private auth: OAuth2Client) {}

  private async call<T>(url: string, method: "GET" | "POST" | "PUT" = "GET", data?: unknown): Promise<T> {
    try {
      const res = await this.auth.request<T>({ url, method, data });
      return res.data;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? err?.message ?? String(err);
      if (/insufficient (authentication )?(scopes|permission)/i.test(message)) {
        throw new Error("Search Console write access was not granted. Run `npx seoclaude auth` again to add it.");
      }
      throw new Error(`Search Console API error: ${message}`);
    }
  }

  async listSites() {
    const data = await this.call<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${WEBMASTERS}/sites`);
    return data.siteEntry ?? [];
  }

  async searchAnalytics(siteUrl: string, q: AnalyticsQuery): Promise<AnalyticsRow[]> {
    const body = {
      startDate: q.startDate,
      endDate: q.endDate,
      dimensions: q.dimensions,
      type: q.type ?? "web",
      dimensionFilterGroups: q.filters?.length ? [{ groupType: "and", filters: q.filters }] : undefined,
      rowLimit: q.rowLimit ?? 1000,
      startRow: q.startRow ?? 0,
      dataState: "final",
    };
    const data = await this.call<{ rows?: AnalyticsRow[] }>(
      `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      "POST",
      body,
    );
    return data.rows ?? [];
  }

  /** Pages through results up to `maxRows` (API caps a single request at 25k rows). */
  async searchAnalyticsAll(siteUrl: string, q: AnalyticsQuery, maxRows = 25000): Promise<AnalyticsRow[]> {
    const pageSize = Math.min(maxRows, 25000);
    const rows: AnalyticsRow[] = [];
    for (let startRow = 0; rows.length < maxRows; startRow += pageSize) {
      const page = await this.searchAnalytics(siteUrl, { ...q, rowLimit: pageSize, startRow });
      rows.push(...page);
      if (page.length < pageSize) break;
    }
    return rows.slice(0, maxRows);
  }

  async listSitemaps(siteUrl: string) {
    const data = await this.call<{ sitemap?: unknown[] }>(`${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
    return data.sitemap ?? [];
  }

  async inspectUrl(siteUrl: string, inspectionUrl: string, languageCode = "en-US") {
    const data = await this.call<{ inspectionResult: unknown }>(`${SEARCHCONSOLE}/urlInspection/index:inspect`, "POST", {
      siteUrl,
      inspectionUrl,
      languageCode,
    });
    return data.inspectionResult;
  }

  /** Submits (or resubmits) a sitemap. Needs the full webmasters scope, not webmasters.readonly. */
  async submitSitemap(siteUrl: string, feedpath: string) {
    await this.call(
      `${WEBMASTERS}/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(feedpath)}`,
      "PUT",
    );
  }
}
