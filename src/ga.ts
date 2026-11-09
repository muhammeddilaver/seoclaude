import type { OAuth2Client } from "google-auth-library";

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";

export type MatchType = "EXACT" | "BEGINS_WITH" | "ENDS_WITH" | "CONTAINS" | "FULL_REGEXP" | "PARTIAL_REGEXP";

export interface GaFilter {
  dimension: string;
  matchType: MatchType;
  value: string;
  exclude?: boolean;
}

export interface GaReportQuery {
  startDate: string;
  endDate: string;
  dimensions: string[];
  metrics: string[];
  filters?: GaFilter[];
  orderBy?: { name: string; desc: boolean };
  limit: number;
}

interface ReportResponse {
  dimensionHeaders?: { name: string }[];
  metricHeaders?: { name: string; type: string }[];
  rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[];
  totals?: { metricValues?: { value: string }[] }[];
  rowCount?: number;
}

/** Accepts "123456" or "properties/123456". */
function propertyPath(property: string): string {
  return property.startsWith("properties/") ? property : `properties/${property}`;
}

function dimensionFilter(filters?: GaFilter[]) {
  if (!filters?.length) return undefined;
  const expressions = filters.map((f) => {
    const expr = { filter: { fieldName: f.dimension, stringFilter: { matchType: f.matchType, value: f.value } } };
    return f.exclude ? { notExpression: expr } : expr;
  });
  return { andGroup: { expressions } };
}

// Flattens GA's header/value arrays into plain objects; metric values become numbers.
function toRows(res: ReportResponse) {
  const dims = res.dimensionHeaders?.map((h) => h.name) ?? [];
  const metrics = res.metricHeaders?.map((h) => h.name) ?? [];
  const rows = (res.rows ?? []).map((row) => {
    const out: Record<string, string | number> = {};
    dims.forEach((d, i) => (out[d] = row.dimensionValues?.[i]?.value ?? ""));
    metrics.forEach((m, i) => (out[m] = Number(row.metricValues?.[i]?.value ?? 0)));
    return out;
  });
  const totalValues = res.totals?.[0]?.metricValues;
  const totals = totalValues
    ? Object.fromEntries(metrics.map((m, i) => [m, Number(totalValues[i]?.value ?? 0)]))
    : undefined;
  return { rowCount: res.rowCount ?? rows.length, totals, rows };
}

export class GaClient {
  constructor(private auth: OAuth2Client) {}

  private async call<T>(url: string, method: "GET" | "POST" = "GET", data?: unknown): Promise<T> {
    try {
      const res = await this.auth.request<T>({ url, method, data });
      return res.data;
    } catch (err: any) {
      const message = err?.response?.data?.error?.message ?? err?.message ?? String(err);
      if (/insufficient authentication scopes/i.test(message)) {
        throw new Error("Google Analytics access was not granted. Run `npx seoclaude auth` again to add it.");
      }
      throw new Error(`Google Analytics API error: ${message}`);
    }
  }

  async listProperties() {
    type Summary = {
      account: string;
      displayName: string;
      propertySummaries?: { property: string; displayName: string; propertyType?: string }[];
    };
    const accounts: Summary[] = [];
    let pageToken: string | undefined;
    do {
      const url = `${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const data = await this.call<{ accountSummaries?: Summary[]; nextPageToken?: string }>(url);
      accounts.push(...(data.accountSummaries ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);

    return accounts.flatMap((a) =>
      (a.propertySummaries ?? []).map((p) => ({
        property: p.property,
        propertyName: p.displayName,
        account: a.displayName,
        propertyType: p.propertyType,
      })),
    );
  }

  /** Web data streams (measurement IDs) of one property, or of every property the account can access. */
  async listMeasurementIds(property?: string) {
    type Stream = { displayName?: string; webStreamData?: { measurementId?: string; defaultUri?: string } };
    const props = property
      ? [{ property: propertyPath(property), propertyName: undefined as string | undefined }]
      : await this.listProperties();
    const perProperty = await Promise.all(
      props.map(async (p) => {
        const streams: Stream[] = [];
        let pageToken: string | undefined;
        do {
          const url = `${ADMIN}/${p.property}/dataStreams?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
          const data = await this.call<{ dataStreams?: Stream[]; nextPageToken?: string }>(url);
          streams.push(...(data.dataStreams ?? []));
          pageToken = data.nextPageToken;
        } while (pageToken);
        return streams.flatMap((s) =>
          s.webStreamData?.measurementId
            ? [{ measurementId: s.webStreamData.measurementId, property: p.property, propertyName: p.propertyName, stream: s.displayName, uri: s.webStreamData.defaultUri }]
            : [],
        );
      }),
    );
    return perProperty.flat();
  }

  async runReport(property: string, q: GaReportQuery) {
    const body = {
      dateRanges: [{ startDate: q.startDate, endDate: q.endDate }],
      dimensions: q.dimensions.map((name) => ({ name })),
      metrics: q.metrics.map((name) => ({ name })),
      dimensionFilter: dimensionFilter(q.filters),
      orderBys: q.orderBy
        ? [
            q.metrics.includes(q.orderBy.name)
              ? { metric: { metricName: q.orderBy.name }, desc: q.orderBy.desc }
              : { dimension: { dimensionName: q.orderBy.name }, desc: q.orderBy.desc },
          ]
        : undefined,
      limit: q.limit,
      metricAggregations: ["TOTAL"],
    };
    const res = await this.call<ReportResponse>(`${DATA}/${propertyPath(property)}:runReport`, "POST", body);
    return toRows(res);
  }

  async runRealtimeReport(property: string, dimensions: string[], metrics: string[], limit: number) {
    const body = {
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit,
      metricAggregations: ["TOTAL"],
    };
    const res = await this.call<ReportResponse>(`${DATA}/${propertyPath(property)}:runRealtimeReport`, "POST", body);
    return toRows(res);
  }
}
