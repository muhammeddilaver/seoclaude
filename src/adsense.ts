import type { OAuth2Client } from "google-auth-library";

const BASE = "https://adsense.googleapis.com/v2";

interface ReportResponse {
  headers?: { name: string; type: string; currencyCode?: string }[];
  rows?: { cells: { value?: string }[] }[];
  totals?: { cells: { value?: string }[] };
  totalMatchedRows?: string;
  startDate?: { year: number; month: number; day: number };
  endDate?: { year: number; month: number; day: number };
  warnings?: string[];
}

export interface AdsenseReportQuery {
  startDate: string;
  endDate: string;
  dimensions: string[];
  metrics: string[];
  /** AdSense filter expressions, e.g. "DOMAIN_NAME==example.com"; combined with AND. */
  filters?: string[];
  orderBy?: { name: string; desc: boolean };
  limit: number;
  currencyCode?: string;
}

const dateParts = (prefix: string, date: string) => {
  const [year, month, day] = date.split("-");
  return [
    [`${prefix}.year`, year],
    [`${prefix}.month`, String(Number(month))],
    [`${prefix}.day`, String(Number(day))],
  ];
};

export class AdsenseClient {
  constructor(private auth: OAuth2Client) {}

  private async call<T>(url: string): Promise<T> {
    try {
      return (await this.auth.request<T>({ url })).data;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? err?.message ?? String(err);
      if (/insufficient authentication scopes/i.test(message)) {
        throw new Error("AdSense access was not granted. Run `npx seoclaude auth` again to add it.");
      }
      if (/has not been used|is disabled/i.test(message)) {
        throw new Error(`Enable the AdSense Management API in your Google Cloud project. (${message})`);
      }
      throw new Error(`AdSense API error: ${message}`);
    }
  }

  async listAccounts() {
    const data = await this.call<{ accounts?: { name: string; displayName: string; state?: string; timeZone?: { id: string } }[] }>(
      `${BASE}/accounts`,
    );
    return Promise.all(
      (data.accounts ?? []).map(async (a) => {
        const sites = await this.call<{ sites?: { domain: string; state: string; autoAdsEnabled?: boolean }[] }>(
          `${BASE}/${a.name}/sites`,
        );
        return {
          account: a.name,
          displayName: a.displayName,
          state: a.state,
          timeZone: a.timeZone?.id,
          sites: (sites.sites ?? []).map((s) => ({ domain: s.domain, state: s.state, autoAdsEnabled: s.autoAdsEnabled })),
        };
      }),
    );
  }

  /** The account to use when none is given: errors if there are several, so the choice is never silent. */
  async defaultAccount(): Promise<string> {
    const data = await this.call<{ accounts?: { name: string }[] }>(`${BASE}/accounts`);
    const accounts = data.accounts ?? [];
    if (accounts.length === 1) return accounts[0].name;
    if (!accounts.length) throw new Error("This Google account has no AdSense account.");
    throw new Error(`Several AdSense accounts; pass one of: ${accounts.map((a) => a.name).join(", ")}`);
  }

  async report(account: string, q: AdsenseReportQuery) {
    const params = new URLSearchParams([["dateRange", "CUSTOM"], ...dateParts("startDate", q.startDate), ...dateParts("endDate", q.endDate)]);
    for (const d of q.dimensions) params.append("dimensions", d);
    for (const m of q.metrics) params.append("metrics", m);
    for (const f of q.filters ?? []) params.append("filters", f);
    if (q.orderBy) params.append("orderBy", `${q.orderBy.desc ? "-" : "+"}${q.orderBy.name}`);
    if (q.currencyCode) params.set("currencyCode", q.currencyCode);
    params.set("limit", String(q.limit));

    const res = await this.call<ReportResponse>(`${BASE}/${account}/reports:generate?${params}`);
    const headers = res.headers ?? [];
    // Dimension cells stay strings; metric cells (tally, ratio, currency…) become numbers.
    const toObject = (cells: { value?: string }[]) =>
      Object.fromEntries(
        headers.map((h, i) => [h.name, h.type === "DIMENSION" ? (cells[i]?.value ?? "") : Number(cells[i]?.value ?? 0)]),
      );
    return {
      currency: headers.find((h) => h.currencyCode)?.currencyCode,
      totalMatchedRows: Number(res.totalMatchedRows ?? 0),
      totals: res.totals ? Object.fromEntries(Object.entries(toObject(res.totals.cells)).filter(([, v]) => typeof v === "number")) : undefined,
      rows: (res.rows ?? []).map((r) => toObject(r.cells)),
      warnings: res.warnings,
    };
  }
}
