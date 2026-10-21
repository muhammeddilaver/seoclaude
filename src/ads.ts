import type { OAuth2Client } from "google-auth-library";

// Google Ads sunsets API versions roughly a year after release; override with googleAdsApiVersion when this one goes.
export const DEFAULT_ADS_API_VERSION = "v26";

export interface AdsSettings {
  developerToken: string;
  /** Manager (MCC) account the user signs in through, digits only. */
  loginCustomerId?: string;
  /** Account used when a tool is not given one. */
  customerId?: string;
  apiVersion?: string;
}

const digits = (id: string) => id.replace(/\D/g, "");
const fromMicros = (v?: string | number) => (v === undefined ? null : Math.round(Number(v) / 10_000) / 100);

export class AdsClient {
  private base: string;

  constructor(
    private auth: OAuth2Client,
    private settings: AdsSettings,
  ) {
    this.base = `https://googleads.googleapis.com/${settings.apiVersion ?? DEFAULT_ADS_API_VERSION}`;
  }

  private async call<T>(path: string, method: "GET" | "POST" = "GET", data?: unknown): Promise<T> {
    const headers: Record<string, string> = { "developer-token": this.settings.developerToken };
    if (this.settings.loginCustomerId) headers["login-customer-id"] = digits(this.settings.loginCustomerId);
    try {
      return (await this.auth.request<T>({ url: `${this.base}${path}`, method, data, headers })).data;
    } catch (err: any) {
      const status = err?.response?.status;
      const body = err?.response?.data;
      const error = Array.isArray(body) ? body[0]?.error : body?.error;
      // Ads puts the useful reason in details[].errors[].message; the top-level message is often generic.
      const detail = error?.details?.flatMap((d: any) => d.errors ?? []).map((e: any) => e.message).join("; ");
      const message = detail || error?.message || err?.message || String(err);
      if (/insufficient authentication scopes/i.test(message)) {
        throw new Error("Google Ads access was not granted. Run `npx seoclaude auth --ads`.");
      }
      if (status === 404 && !error) {
        throw new Error(`Google Ads API ${this.base.split("/").pop()} not found; it may be sunset. Set googleAdsApiVersion to a newer version.`);
      }
      throw new Error(`Google Ads API error: ${message}`);
    }
  }

  customerId(given?: string): string {
    const id = given ?? this.settings.customerId;
    if (!id) throw new Error("No Google Ads customer ID: pass customerId or set googleAdsCustomerId (see ads_list_accounts).");
    return digits(id);
  }

  /** GAQL query; pages through results up to `limit` rows. */
  async search<T = any>(customerId: string, query: string, limit = 10_000): Promise<T[]> {
    const rows: T[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.call<{ results?: T[]; nextPageToken?: string }>(`/customers/${digits(customerId)}/googleAds:search`, "POST", {
        query,
        pageToken,
      });
      rows.push(...(res.results ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken && rows.length < limit);
    return rows.slice(0, limit);
  }

  async listAccounts() {
    const { resourceNames = [] } = await this.call<{ resourceNames?: string[] }>("/customers:listAccessibleCustomers");
    return Promise.all(
      resourceNames.map(async (name) => {
        const id = name.split("/")[1];
        try {
          const [row] = await this.search(
            id,
            "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer",
          );
          return { customerId: id, ...row.customer };
        } catch (err) {
          // Accounts reachable only through a manager fail without the right login-customer-id.
          return { customerId: id, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }

  /** Resolves "tr" / "TR" style codes to the constants the keyword planner wants. */
  private async constants(customerId: string, language: string, countries: string[]) {
    const quote = (s: string) => `'${s.replace(/[^A-Za-z-]/g, "")}'`;
    const [lang] = await this.search(
      customerId,
      `SELECT language_constant.resource_name FROM language_constant WHERE language_constant.code = ${quote(language.toLowerCase())}`,
    );
    if (!lang) throw new Error(`Unknown language code "${language}".`);
    const geos = countries.length
      ? await this.search(
          customerId,
          `SELECT geo_target_constant.resource_name, geo_target_constant.country_code FROM geo_target_constant ` +
            `WHERE geo_target_constant.target_type = 'Country' AND geo_target_constant.country_code IN (${countries.map((c) => quote(c.toUpperCase())).join(", ")})`,
        )
      : [];
    if (geos.length < countries.length) throw new Error(`Unknown country code among ${countries.join(", ")}.`);
    return {
      language: lang.languageConstant.resourceName as string,
      geoTargetConstants: geos.map((g) => g.geoTargetConstant.resourceName as string),
    };
  }

  private static metrics(m: any = {}) {
    return {
      avgMonthlySearches: m.avgMonthlySearches === undefined ? null : Number(m.avgMonthlySearches),
      competition: m.competition ?? null,
      competitionIndex: m.competitionIndex === undefined ? null : Number(m.competitionIndex),
      lowTopOfPageBid: fromMicros(m.lowTopOfPageBidMicros),
      highTopOfPageBid: fromMicros(m.highTopOfPageBidMicros),
      monthly: (m.monthlySearchVolumes ?? []).map((v: any) => ({
        month: `${v.year}-${String(monthIndex(v.month)).padStart(2, "0")}`,
        searches: Number(v.monthlySearches ?? 0),
      })),
    };
  }

  /** Keyword Planner ideas from seed keywords and/or a URL. */
  async keywordIdeas(customerId: string, opts: { keywords?: string[]; url?: string; language: string; countries: string[]; limit: number }) {
    const { language, geoTargetConstants } = await this.constants(customerId, opts.language, opts.countries);
    const seed =
      opts.keywords?.length && opts.url
        ? { keywordAndUrlSeed: { keywords: opts.keywords, url: opts.url } }
        : opts.url
          ? { urlSeed: { url: opts.url } }
          : { keywordSeed: { keywords: opts.keywords } };
    const results: any[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.call<{ results?: any[]; nextPageToken?: string }>(`/customers/${customerId}:generateKeywordIdeas`, "POST", {
        language,
        geoTargetConstants,
        keywordPlanNetwork: "GOOGLE_SEARCH",
        includeAdultKeywords: false,
        pageSize: Math.min(opts.limit, 1000),
        pageToken,
        ...seed,
      });
      results.push(...(res.results ?? []));
      pageToken = res.nextPageToken;
    } while (pageToken && results.length < opts.limit);
    return results.slice(0, opts.limit).map((r) => ({ keyword: r.text, ...AdsClient.metrics(r.keywordIdeaMetrics) }));
  }

  /** Search volume and bids for exact keywords (no idea expansion). */
  async keywordVolume(customerId: string, opts: { keywords: string[]; language: string; countries: string[] }) {
    const { language, geoTargetConstants } = await this.constants(customerId, opts.language, opts.countries);
    const res = await this.call<{ results?: any[] }>(`/customers/${customerId}:generateKeywordHistoricalMetrics`, "POST", {
      keywords: opts.keywords,
      language,
      geoTargetConstants,
      keywordPlanNetwork: "GOOGLE_SEARCH",
    });
    return (res.results ?? []).map((r) => ({
      keyword: r.text,
      closeVariants: r.closeVariants,
      ...AdsClient.metrics(r.keywordMetrics),
    }));
  }
}

const MONTHS = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
const monthIndex = (m: string | number) => (typeof m === "number" ? m - 1 : MONTHS.indexOf(m)) + 1;
