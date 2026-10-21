import type { AnalyticsRow, Dimension } from "./gsc.js";

// Search Console data is typically finalized with a ~3 day delay.
const DATA_LAG_DAYS = 3;

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** The most recent `days` days of finalized data. */
export function recentRange(days: number): { startDate: string; endDate: string } {
  const endDate = addDays(isoDate(new Date()), -DATA_LAG_DAYS);
  return { startDate: addDays(endDate, -(days - 1)), endDate };
}

/** The range of equal length immediately before the given one. */
export function previousRange(startDate: string, endDate: string): { startDate: string; endDate: string } {
  const length = Math.round((Date.parse(endDate) - Date.parse(startDate)) / 86_400_000) + 1;
  return { startDate: addDays(startDate, -length), endDate: addDays(startDate, -1) };
}

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits;

export function formatRow(row: AnalyticsRow, dimensions: Dimension[] = []) {
  const out: Record<string, string | number> = {};
  dimensions.forEach((dim, i) => (out[dim] = row.keys?.[i] ?? ""));
  out.clicks = row.clicks;
  out.impressions = row.impressions;
  out.ctr = round(row.ctr * 100);
  out.position = round(row.position, 1);
  return out;
}

export interface PeriodChange {
  key: string;
  clicks: number;
  clicksPrev: number;
  clicksDelta: number;
  impressions: number;
  impressionsPrev: number;
  impressionsDelta: number;
  position: number | null;
  positionPrev: number | null;
  positionDelta: number | null;
}

export function comparePeriods(current: AnalyticsRow[], previous: AnalyticsRow[]): PeriodChange[] {
  const keyOf = (r: AnalyticsRow) => (r.keys ?? []).join(" | ");
  const prev = new Map(previous.map((r) => [keyOf(r), r]));
  const cur = new Map(current.map((r) => [keyOf(r), r]));
  const keys = new Set([...cur.keys(), ...prev.keys()]);

  return [...keys].map((key) => {
    const c = cur.get(key);
    const p = prev.get(key);
    const position = c ? round(c.position, 1) : null;
    const positionPrev = p ? round(p.position, 1) : null;
    return {
      key,
      clicks: c?.clicks ?? 0,
      clicksPrev: p?.clicks ?? 0,
      clicksDelta: (c?.clicks ?? 0) - (p?.clicks ?? 0),
      impressions: c?.impressions ?? 0,
      impressionsPrev: p?.impressions ?? 0,
      impressionsDelta: (c?.impressions ?? 0) - (p?.impressions ?? 0),
      position,
      positionPrev,
      // Negative is an improvement (moved up the results page).
      positionDelta: position !== null && positionPrev !== null ? round(position - positionPrev, 1) : null,
    };
  });
}

export function totals(rows: AnalyticsRow[]) {
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  const weightedPosition = rows.reduce((s, r) => s + r.position * r.impressions, 0);
  return {
    clicks,
    impressions,
    ctr: impressions ? round((clicks / impressions) * 100) : 0,
    position: impressions ? round(weightedPosition / impressions, 1) : 0,
  };
}

// Rough organic CTR benchmark by position (desktop + mobile blend).
const EXPECTED_CTR = [0.28, 0.15, 0.1, 0.07, 0.05, 0.04, 0.03, 0.025, 0.02, 0.018];

export function expectedCtr(position: number): number {
  const i = Math.min(Math.max(Math.round(position), 1), EXPECTED_CTR.length) - 1;
  return EXPECTED_CTR[i];
}

/** Rows ranking on page one whose CTR is well below the benchmark for their position. */
export function lowCtr(rows: AnalyticsRow[], minImpressions: number) {
  return rows
    .filter((r) => r.impressions >= minImpressions && r.position <= 10 && r.ctr < expectedCtr(r.position) * 0.5)
    .map((r) => ({
      key: r.keys?.[0] ?? "",
      impressions: r.impressions,
      clicks: r.clicks,
      ctr: round(r.ctr * 100),
      expectedCtr: round(expectedCtr(r.position) * 100),
      position: round(r.position, 1),
      missedClicks: Math.round(r.impressions * expectedCtr(r.position) - r.clicks),
    }))
    .sort((a, b) => b.missedClicks - a.missedClicks);
}

/** Queries sitting just off page one (positions 8–20) with meaningful demand. */
export function strikingDistance(rows: AnalyticsRow[], minImpressions: number) {
  return rows
    .filter((r) => r.impressions >= minImpressions && r.position >= 8 && r.position <= 20)
    .map((r) => ({
      query: r.keys?.[0] ?? "",
      impressions: r.impressions,
      clicks: r.clicks,
      position: round(r.position, 1),
    }))
    .sort((a, b) => b.impressions - a.impressions);
}

/** Queries where two or more pages each take a real share of impressions. Expects [query, page] rows. */
export function cannibalization(rows: AnalyticsRow[], minImpressions: number, minShare = 0.1) {
  const byQuery = new Map<string, AnalyticsRow[]>();
  for (const r of rows) {
    const query = r.keys?.[0] ?? "";
    byQuery.set(query, [...(byQuery.get(query) ?? []), r]);
  }

  const results = [];
  for (const [query, pages] of byQuery) {
    const total = pages.reduce((s, r) => s + r.impressions, 0);
    if (total < minImpressions) continue;
    const competing = pages.filter((r) => r.impressions / total >= minShare);
    if (competing.length < 2) continue;
    results.push({
      query,
      impressions: total,
      pages: competing
        .sort((a, b) => b.impressions - a.impressions)
        .map((r) => ({
          page: r.keys?.[1] ?? "",
          impressions: r.impressions,
          clicks: r.clicks,
          share: round((r.impressions / total) * 100, 1),
          position: round(r.position, 1),
        })),
    });
  }
  return results.sort((a, b) => b.impressions - a.impressions);
}

export interface ChangePoint {
  /** First day at the new level. */
  date: string;
  direction: "drop" | "rise";
  dailyBefore: number;
  dailyAfter: number;
  changePct: number;
}

/**
 * Finds days where the level of a daily series shifts: the mean of the `window` days from that
 * day on vs the `window` days before it. Missing days count as 0. Shifts smaller than
 * `minChangePct`, or where neither side averages `minDaily`, are treated as noise.
 */
export function changePoints(
  series: { date: string; value: number }[],
  startDate: string,
  endDate: string,
  window = 7,
  minChangePct = 30,
  minDaily = 5,
): ChangePoint[] {
  const byDate = new Map(series.map((p) => [p.date, p.value]));
  const dates: string[] = [];
  for (let d = startDate; d <= endDate; d = addDays(d, 1)) dates.push(d);
  const values = dates.map((d) => byDate.get(d) ?? 0);
  const mean = (from: number, to: number) => values.slice(from, to).reduce((s, v) => s + v, 0) / (to - from);

  const candidates = [];
  for (let i = window; i + window <= values.length; i++) {
    const before = mean(i - window, i);
    const after = mean(i, i + window);
    if (Math.max(before, after) < minDaily) continue;
    const changePct = before ? ((after - before) / before) * 100 : 100;
    if (Math.abs(changePct) < minChangePct) continue;
    // Absolute size of the step: unlike a ratio it peaks on the day the level changes, not a few
    // days later when the trailing window has emptied out.
    candidates.push({ i, before, after, changePct, score: Math.abs(after - before) });
  }

  // Keep the strongest shift in each neighbourhood rather than every day of the same slope.
  const picked: typeof candidates = [];
  for (const c of candidates.sort((a, b) => b.score - a.score)) {
    if (picked.every((p) => Math.abs(p.i - c.i) >= window)) picked.push(c);
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map((c) => ({
      date: dates[c.i],
      direction: c.after < c.before ? "drop" : "rise",
      dailyBefore: round(c.before, 1),
      dailyAfter: round(c.after, 1),
      changePct: round(c.changePct, 1),
    }));
}

// AI assistants by referral source. Patterns are RE2-compatible so the same list can filter GA4.
export const AI_SOURCES: [name: string, pattern: string][] = [
  ["ChatGPT", "chatgpt\\.com|openai\\.com"],
  ["Perplexity", "perplexity"],
  ["Claude", "claude\\.ai|anthropic\\.com"],
  ["Gemini", "gemini\\.google|bard\\.google"],
  ["Copilot", "copilot\\.microsoft|copilot\\.cloud\\.microsoft"],
  ["DeepSeek", "deepseek"],
  ["Grok", "grok\\.com"],
  ["Meta AI", "meta\\.ai"],
  ["Mistral", "chat\\.mistral\\.ai"],
  ["Qwen", "qwen|tongyi"],
  ["Kimi", "kimi\\.com|moonshot"],
  ["You.com", "(^|\\.)you\\.com$"],
  ["Phind", "phind\\.com"],
  ["Poe", "poe\\.com"],
];

export const AI_SOURCE_REGEX = AI_SOURCES.map(([, p]) => `(${p})`).join("|");

export function aiAssistant(source: string): string | undefined {
  return AI_SOURCES.find(([, p]) => new RegExp(p, "i").test(source))?.[0];
}

/** GA4 landingPage paths and GSC page URLs compared without host, trailing slash or URL encoding. */
export function pathKey(urlOrPath: string): string {
  let path = urlOrPath;
  try {
    path = new URL(urlOrPath, "https://x").pathname;
  } catch {
    // Keep the raw value.
  }
  try {
    path = decodeURI(path);
  } catch {
    // Malformed escapes: compare as-is.
  }
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}
