#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ADS_SCOPE, getAuthorizedClient, runAuthFlow } from "./auth.js";
import { AdsClient } from "./ads.js";
import { AdsenseClient } from "./adsense.js";
import { GscClient, type Dimension } from "./gsc.js";
import { GaClient } from "./ga.js";
import { auditPage, countBy, mapLimit, normalize, readSitemap, sample } from "./audit.js";
import { crawlSite } from "./crawl.js";
import { checkRobots } from "./robots.js";
import { BingClient } from "./bing.js";
import { optionalKey, requireKey } from "./config.js";
import { submitIndexNow } from "./indexnow.js";
import { runPagespeed } from "./pagespeed.js";
import {
  addDays,
  isoDate,
  AI_SOURCE_REGEX,
  aiAssistant,
  cannibalization,
  changePoints,
  comparePeriods,
  expectedCtr,
  formatRow,
  lowCtr,
  pathKey,
  previousRange,
  recentRange,
  strikingDistance,
  totals,
} from "./analysis.js";

const dimension = z.enum(["query", "page", "country", "device", "date", "searchAppearance"]);
const searchType = z.enum(["web", "image", "video", "news", "discover", "googleNews"]).default("web");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const siteUrl = z
  .string()
  .describe('Property exactly as listed by list_sites, e.g. "sc-domain:example.com" or "https://example.com/"');
const filter = z.object({
  dimension,
  operator: z.enum(["equals", "notEquals", "contains", "notContains", "includingRegex", "excludingRegex"]),
  expression: z.string(),
});
const dateRange = {
  startDate: date.optional().describe("Defaults to 28 days before endDate"),
  endDate: date.optional().describe("Defaults to the latest finalized day (~3 days ago)"),
};

function resolveRange(startDate?: string, endDate?: string, days = 28) {
  const fallback = recentRange(days);
  return { startDate: startDate ?? fallback.startDate, endDate: endDate ?? fallback.endDate };
}

let gsc: GscClient | undefined;
async function client(): Promise<GscClient> {
  gsc ??= new GscClient(await getAuthorizedClient());
  return gsc;
}

let ga: GaClient | undefined;
async function gaClient(): Promise<GaClient> {
  ga ??= new GaClient(await getAuthorizedClient());
  return ga;
}

const gaProperty = z.string().describe('GA4 property from ga_list_properties, e.g. "properties/123456789" or "123456789"');
const gaDate = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|today|yesterday|\d+daysAgo)$/, 'YYYY-MM-DD, "today", "yesterday" or "NdaysAgo"');

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

// Turns thrown errors into tool errors the model can read and recover from.
function handler<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return json(await fn(args));
    } catch (err) {
      return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  };
}

const server = new McpServer({ name: "seoclaude", version: "0.2.0" });
const readOnly = { readOnlyHint: true, openWorldHint: true };

server.registerTool(
  "list_sites",
  {
    title: "List Search Console properties",
    description: "Lists every Search Console property the signed-in Google account can access.",
    annotations: readOnly,
  },
  handler(async () => (await client()).listSites()),
);

server.registerTool(
  "search_analytics",
  {
    title: "Search performance",
    description:
      "Clicks, impressions, CTR (%) and average position, grouped by the chosen dimensions. Omit dimensions for site totals.",
    inputSchema: {
      siteUrl,
      ...dateRange,
      dimensions: z.array(dimension).default([]),
      filters: z.array(filter).optional(),
      type: searchType,
      rowLimit: z.number().int().min(1).max(25000).default(100),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, startDate, endDate, dimensions, filters, type, rowLimit }) => {
    const range = resolveRange(startDate, endDate);
    const rows = await (await client()).searchAnalyticsAll(siteUrl, { ...range, dimensions, filters, type }, rowLimit);
    return { ...range, rowCount: rows.length, rows: rows.map((r) => formatRow(r, dimensions)) };
  }),
);

server.registerTool(
  "compare_periods",
  {
    title: "Compare two periods",
    description:
      "Compares performance between two date ranges by a dimension and returns overall totals plus the biggest gainers and losers by clicks. " +
      "The previous range defaults to the equal-length period right before the current one.",
    inputSchema: {
      siteUrl,
      ...dateRange,
      previousStartDate: date.optional(),
      previousEndDate: date.optional(),
      dimension: dimension.default("query"),
      filters: z.array(filter).optional(),
      type: searchType,
      top: z.number().int().min(1).max(200).default(25),
    },
    annotations: readOnly,
  },
  handler(async (args) => {
    const current = resolveRange(args.startDate, args.endDate);
    const previous =
      args.previousStartDate && args.previousEndDate
        ? { startDate: args.previousStartDate, endDate: args.previousEndDate }
        : previousRange(current.startDate, current.endDate);
    const gsc = await client();
    const base = { dimensions: [args.dimension as Dimension], filters: args.filters, type: args.type };
    const [cur, prev] = await Promise.all([
      gsc.searchAnalyticsAll(args.siteUrl, { ...current, ...base }),
      gsc.searchAnalyticsAll(args.siteUrl, { ...previous, ...base }),
    ]);
    const changes = comparePeriods(cur, prev).sort((a, b) => a.clicksDelta - b.clicksDelta);
    return {
      current: { ...current, ...totals(cur) },
      previous: { ...previous, ...totals(prev) },
      note: "Totals are summed from dimension rows, so they can differ slightly from the Search Console UI. Negative positionDelta = improved.",
      topGainers: changes.filter((c) => c.clicksDelta > 0).reverse().slice(0, args.top),
      topLosers: changes.filter((c) => c.clicksDelta < 0).slice(0, args.top),
    };
  }),
);

server.registerTool(
  "find_opportunities",
  {
    title: "Find SEO opportunities",
    description:
      "Surfaces quick wins: page-one queries/pages with CTR far below the benchmark for their position (low_ctr), " +
      "queries ranking 8–20 that could reach the top of page one (striking_distance), and queries where several pages " +
      "compete for the same impressions (cannibalization).",
    inputSchema: {
      siteUrl,
      ...dateRange,
      kinds: z
        .array(z.enum(["low_ctr", "striking_distance", "cannibalization"]))
        .default(["low_ctr", "striking_distance", "cannibalization"]),
      lowCtrBy: z.enum(["query", "page"]).default("query"),
      minImpressions: z.number().int().min(1).default(100),
      top: z.number().int().min(1).max(200).default(25),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, startDate, endDate, kinds, lowCtrBy, minImpressions, top }) => {
    const range = resolveRange(startDate, endDate);
    const gsc = await client();
    const result: Record<string, unknown> = { ...range };

    const needQueries = kinds.includes("striking_distance") || (kinds.includes("low_ctr") && lowCtrBy === "query");
    const [queryRows, pageRows, queryPageRows] = await Promise.all([
      needQueries ? gsc.searchAnalyticsAll(siteUrl, { ...range, dimensions: ["query"] }) : [],
      kinds.includes("low_ctr") && lowCtrBy === "page" ? gsc.searchAnalyticsAll(siteUrl, { ...range, dimensions: ["page"] }) : [],
      kinds.includes("cannibalization") ? gsc.searchAnalyticsAll(siteUrl, { ...range, dimensions: ["query", "page"] }) : [],
    ]);

    if (kinds.includes("low_ctr")) {
      result.lowCtr = lowCtr(lowCtrBy === "query" ? queryRows : pageRows, minImpressions).slice(0, top);
    }
    if (kinds.includes("striking_distance")) {
      result.strikingDistance = strikingDistance(queryRows, minImpressions).slice(0, top);
    }
    if (kinds.includes("cannibalization")) {
      result.cannibalization = cannibalization(queryPageRows, minImpressions).slice(0, top);
    }
    return result;
  }),
);

server.registerTool(
  "inspect_url",
  {
    title: "Inspect URL",
    description: "Google's index status for a URL: coverage, canonical, last crawl, mobile usability and rich results.",
    inputSchema: {
      siteUrl,
      url: z.string().url().describe("Full URL inside the property"),
      languageCode: z.string().default("en-US"),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, url, languageCode }) => (await client()).inspectUrl(siteUrl, url, languageCode)),
);

server.registerTool(
  "list_sitemaps",
  {
    title: "List sitemaps",
    description: "Submitted sitemaps with their last download time, warnings, errors and submitted/indexed URL counts.",
    inputSchema: { siteUrl },
    annotations: readOnly,
  },
  handler(async ({ siteUrl }) => (await client()).listSitemaps(siteUrl)),
);

server.registerTool(
  "submit_sitemap",
  {
    title: "Submit sitemap",
    description:
      "Submits or resubmits a sitemap to Search Console so Google re-reads it (e.g. after fixing canonical or URL problems). " +
      "Note: there is no API for the 'Request indexing' button.",
    inputSchema: {
      siteUrl,
      sitemapUrl: z.string().url().describe("Full sitemap URL, e.g. https://www.example.com/sitemap.xml"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  handler(async ({ siteUrl, sitemapUrl }) => {
    const gsc = await client();
    await gsc.submitSitemap(siteUrl, sitemapUrl);
    const sitemaps = (await gsc.listSitemaps(siteUrl)) as { path?: string }[];
    return { submitted: sitemapUrl, status: sitemaps.find((s) => s.path === sitemapUrl) ?? "submitted; status not listed yet" };
  }),
);

server.registerTool(
  "audit_page",
  {
    title: "Audit page",
    description:
      "Fetches a live URL and checks technical SEO signals: redirect chain, status, noindex (meta and X-Robots-Tag), " +
      "canonical (missing, multiple, other host, redirecting target), hreflang (self-reference, host, return links), " +
      "title/description length, html lang, robots.txt blocking, h1 and heading order, thin content, image alt text, " +
      "and JSON-LD (parse errors plus required/recommended properties for Google rich result types). Returns the parsed " +
      "signals plus a list of issues.",
    inputSchema: {
      url: z.string().url(),
      checkCanonicalTarget: z.boolean().default(true).describe("Fetch the canonical URL when it differs from the page"),
      checkHreflang: z.boolean().default(true).describe("Fetch up to 10 hreflang alternates and verify they link back"),
    },
    annotations: readOnly,
  },
  handler(async ({ url, checkCanonicalTarget, checkHreflang }) => auditPage(url, { checkCanonicalTarget, checkHreflang })),
);

server.registerTool(
  "audit_sitemap",
  {
    title: "Audit sitemap",
    description:
      "Reads a sitemap (or sitemap index), checks that every URL is on one host, then audits an evenly spaced sample of " +
      "pages with audit_page and summarizes issues by type. Catches sitewide problems such as canonicals pointing to a " +
      "redirecting host or sitemap URLs that redirect.",
    inputSchema: {
      sitemapUrl: z.string().url(),
      sampleSize: z.number().int().min(1).max(200).default(25),
      checkHreflang: z.boolean().default(false).describe("Also verify hreflang return links (slower)"),
    },
    annotations: readOnly,
  },
  handler(async ({ sitemapUrl, sampleSize, checkHreflang }) => {
    const { urls, sitemaps, skippedSitemaps } = await readSitemap(sitemapUrl);
    const picked = sample(urls, sampleSize);
    const audits = await mapLimit(picked, 5, async (url) => {
      try {
        return await auditPage(url, { checkCanonicalTarget: true, checkHreflang });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { url, issues: [{ severity: "error" as const, code: "fetch_failed", message }] };
      }
    });
    const issues = audits.flatMap((a) => a.issues.map((i) => ({ ...i, url: a.url })));
    return {
      sitemaps,
      skippedSitemaps,
      totalUrls: urls.length,
      uniqueUrls: new Set(urls).size,
      hosts: countBy(urls, (u) => {
        try {
          return new URL(u).host;
        } catch {
          return "(invalid)";
        }
      }),
      sampled: picked.length,
      pagesWithErrors: audits.filter((a) => a.issues.some((i) => i.severity === "error")).length,
      issueCounts: countBy(issues, (i) => `${i.severity}:${i.code}`),
      // One example per issue code, so the summary stays short on large samples.
      examples: [...new Map(issues.map((i) => [i.code, i] as const).reverse()).values()],
      pages: audits.map((a) => ({ url: a.url, issues: a.issues.map((i) => i.code) })),
    };
  }),
);

server.registerTool(
  "check_robots",
  {
    title: "Check robots.txt",
    description:
      "Reads a site's robots.txt with Google's matching rules (longest match wins, Allow wins ties, * and $ wildcards). " +
      "Reports whether Googlebot and Bingbot can reach the homepage and CSS/JS paths, which AI crawlers are allowed " +
      "(GPTBot, OAI-SearchBot, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, CCBot and more, each with " +
      "what blocking it costs: training vs search citations), whether declared sitemaps answer 200, and whether " +
      "/llms.txt exists. Optionally tests specific URLs for a given user agent.",
    inputSchema: {
      url: z.string().url().describe("Any URL on the site; robots.txt is read from its origin"),
      testUrls: z.array(z.string().url()).max(100).optional().describe("URLs to test against the rules"),
      userAgent: z.string().default("Googlebot").describe("Product token used for testUrls"),
    },
    annotations: readOnly,
  },
  handler(async ({ url, testUrls, userAgent }) => checkRobots(url, testUrls, userAgent)),
);

server.registerTool(
  "crawl_site",
  {
    title: "Crawl site",
    description:
      "Crawls a site from a start URL by following internal links (breadth-first, same host, robots.txt respected as " +
      "Googlebot) and runs audit_page's checks on every page. Reports click depth, broken internal links, links to " +
      "redirects, noindex, non-canonical or robots-blocked pages, weakly linked pages, most-linked pages with anchors, " +
      "orphan sitemap URLs (in the sitemap but never linked), sitemap URLs that aren't indexable, duplicate titles and " +
      "descriptions, and issue counts with examples. With siteUrl it also lists Search Console pages that get clicks " +
      "but no internal links. Only links present in the HTML are seen (not ones added by client-side JavaScript).",
    inputSchema: {
      url: z.string().url().describe("Start URL, usually the homepage"),
      maxPages: z.number().int().min(1).max(5000).default(300),
      maxDepth: z.number().int().min(0).max(50).default(10),
      maxSeconds: z.number().int().min(10).max(900).default(180).describe("Stops and reports what it has when exceeded"),
      concurrency: z.number().int().min(1).max(10).default(5),
      respectRobots: z.boolean().default(true),
      ignoreQueryStrings: z.boolean().default(false).describe("Treat ?a=1 and ?a=2 as one URL (for faceted sites)"),
      sitemapUrl: z.string().url().optional().describe("Sitemap for the orphan check; defaults to robots.txt's, then /sitemap.xml"),
      siteUrl: siteUrl.optional().describe("Search Console property; adds pages with clicks but no internal links"),
      ...dateRange,
    },
    annotations: readOnly,
  },
  handler(async ({ url, maxPages, maxDepth, maxSeconds, concurrency, respectRobots, ignoreQueryStrings, sitemapUrl, siteUrl, startDate, endDate }) => {
    const { discovered, ...report } = await crawlSite(url, {
      maxPages,
      maxDepth,
      maxSeconds,
      concurrency,
      respectRobots,
      ignoreQueryStrings,
      sitemapUrl,
    });
    if (!siteUrl) return report;

    const rows = await (await client()).searchAnalyticsAll(siteUrl, { ...resolveRange(startDate, endDate, 90), dimensions: ["page"] }, 5000);
    const linked = new Set(discovered.map(normalize));
    const unlinked = rows
      .filter((r) => r.clicks > 0 && new URL(r.keys![0]).host === report.host && !linked.has(normalize(r.keys![0])))
      .sort((a, b) => b.clicks - a.clicks);
    return {
      ...report,
      searchConsole: {
        pagesWithClicks: rows.filter((r) => r.clicks > 0).length,
        // With an incomplete crawl, some of these are just beyond the limit rather than truly unlinked.
        unlinkedWithClicks: {
          count: unlinked.length,
          items: unlinked.slice(0, 25).map((r) => ({ url: r.keys![0], clicks: r.clicks, impressions: r.impressions })),
        },
      },
    };
  }),
);

server.registerTool(
  "bulk_inspect",
  {
    title: "Bulk URL inspection",
    description:
      "Runs URL Inspection on many URLs and summarizes Google's index status: coverage states, verdicts, user vs Google " +
      "canonical mismatches and last crawl dates. URLs come from an explicit list, a sitemap (evenly sampled) or the " +
      "pages with the most impressions. Quota: 2,000 inspections per property per day, 600 per minute.",
    inputSchema: {
      siteUrl,
      source: z.enum(["urls", "sitemap", "top_pages"]).default("top_pages"),
      urls: z.array(z.string().url()).optional().describe('Required when source is "urls"'),
      sitemapUrl: z.string().url().optional().describe('Required when source is "sitemap"'),
      ...dateRange,
      limit: z.number().int().min(1).max(500).default(50),
      languageCode: z.string().default("en-US"),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, source, urls, sitemapUrl, startDate, endDate, limit, languageCode }) => {
    const gsc = await client();
    let targets: string[];
    if (source === "urls") {
      if (!urls?.length) throw new Error('source "urls" needs a urls list');
      targets = urls.slice(0, limit);
    } else if (source === "sitemap") {
      if (!sitemapUrl) throw new Error('source "sitemap" needs sitemapUrl');
      targets = sample([...new Set((await readSitemap(sitemapUrl)).urls)], limit);
    } else {
      const range = resolveRange(startDate, endDate, 90);
      const rows = await gsc.searchAnalyticsAll(siteUrl, { ...range, dimensions: ["page"] }, limit);
      targets = rows.sort((a, b) => b.impressions - a.impressions).map((r) => r.keys![0]);
    }

    type Status = {
      verdict?: string;
      coverageState?: string;
      indexingState?: string;
      robotsTxtState?: string;
      pageFetchState?: string;
      lastCrawlTime?: string;
      userCanonical?: string;
      googleCanonical?: string;
    };
    const results = await mapLimit(targets, 5, async (url) => {
      try {
        const r = (await gsc.inspectUrl(siteUrl, url, languageCode)) as { indexStatusResult?: Status };
        const s = r.indexStatusResult ?? {};
        return {
          url,
          verdict: s.verdict,
          coverageState: s.coverageState,
          lastCrawlTime: s.lastCrawlTime,
          userCanonical: s.userCanonical,
          googleCanonical: s.googleCanonical,
          canonicalMismatch: !!s.userCanonical && !!s.googleCanonical && s.userCanonical !== s.googleCanonical,
          blocked: s.robotsTxtState === "DISALLOWED" || (s.indexingState ?? "").startsWith("BLOCKED"),
        };
      } catch (err) {
        return { url, error: err instanceof Error ? err.message : String(err) };
      }
    });

    const ok = results.filter((r): r is Exclude<typeof r, { error: string }> => !("error" in r));
    const crawled = ok.map((r) => r.lastCrawlTime).filter((t): t is string => !!t).sort();
    return {
      inspected: results.length,
      failed: results.length - ok.length,
      verdicts: countBy(ok, (r) => r.verdict),
      coverageStates: countBy(ok, (r) => r.coverageState),
      canonicalMismatches: ok.filter((r) => r.canonicalMismatch).length,
      blocked: ok.filter((r) => r.blocked).length,
      oldestCrawl: crawled[0],
      newestCrawl: crawled.at(-1),
      neverCrawled: ok.filter((r) => !r.lastCrawlTime).length,
      results,
    };
  }),
);

server.registerTool(
  "ga_list_properties",
  {
    title: "List Google Analytics properties",
    description: "Lists every GA4 property (with its account) the signed-in Google account can access.",
    annotations: readOnly,
  },
  handler(async () => (await gaClient()).listProperties()),
);

server.registerTool(
  "ga_report",
  {
    title: "Google Analytics report",
    description:
      "Runs a GA4 report with any GA4 Data API dimensions and metrics (e.g. dimensions: date, landingPage, pagePath, " +
      "sessionDefaultChannelGroup, sessionSourceMedium, country, deviceCategory, eventName; metrics: sessions, " +
      "activeUsers, newUsers, screenPageViews, engagementRate, averageSessionDuration, bounceRate, conversions, " +
      "keyEvents, totalRevenue). Returns rows plus metric totals.",
    inputSchema: {
      property: gaProperty,
      startDate: gaDate.default("28daysAgo"),
      endDate: gaDate.default("yesterday"),
      dimensions: z.array(z.string()).max(9).default([]),
      metrics: z.array(z.string()).min(1).max(10).default(["sessions", "activeUsers", "engagementRate"]),
      filters: z
        .array(
          z.object({
            dimension: z.string(),
            matchType: z.enum(["EXACT", "BEGINS_WITH", "ENDS_WITH", "CONTAINS", "FULL_REGEXP", "PARTIAL_REGEXP"]),
            value: z.string(),
            exclude: z.boolean().default(false),
          }),
        )
        .optional()
        .describe("Dimension filters, combined with AND"),
      orderBy: z
        .object({ name: z.string().describe("A metric or dimension in this report"), desc: z.boolean().default(true) })
        .optional()
        .describe("Defaults to the first metric, descending"),
      limit: z.number().int().min(1).max(10000).default(100),
    },
    annotations: readOnly,
  },
  handler(async ({ property, startDate, endDate, dimensions, metrics, filters, orderBy, limit }) => {
    const report = await (await gaClient()).runReport(property, {
      startDate,
      endDate,
      dimensions,
      metrics,
      filters,
      orderBy: orderBy ?? { name: metrics[0], desc: true },
      limit,
    });
    return { startDate, endDate, ...report };
  }),
);

server.registerTool(
  "ga_realtime",
  {
    title: "Google Analytics realtime",
    description:
      "Activity in the last 30 minutes (e.g. dimensions: unifiedScreenName, country, deviceCategory, eventName; " +
      "metrics: activeUsers, screenPageViews, eventCount).",
    inputSchema: {
      property: gaProperty,
      dimensions: z.array(z.string()).max(9).default([]),
      metrics: z.array(z.string()).min(1).max(10).default(["activeUsers"]),
      limit: z.number().int().min(1).max(10000).default(50),
    },
    annotations: readOnly,
  },
  handler(async ({ property, dimensions, metrics, limit }) =>
    (await gaClient()).runRealtimeReport(property, dimensions, metrics, limit),
  ),
);

server.registerTool(
  "detect_drops",
  {
    title: "Detect traffic drops and rises",
    description:
      "Scans the daily Search Console series for sudden level shifts (e.g. impressions falling 90% from one week to the " +
      "next), then for the largest shift lists the pages and queries that moved most across it. Use it first when " +
      "traffic looks wrong, to find when it changed and what changed.",
    inputSchema: {
      siteUrl,
      startDate: date.optional().describe("Defaults to 90 days before endDate"),
      endDate: dateRange.endDate,
      metric: z.enum(["clicks", "impressions"]).default("impressions"),
      window: z.number().int().min(3).max(28).default(7).describe("Days compared on each side of a candidate shift"),
      minChangePct: z.number().min(5).max(100).default(30),
      type: searchType,
      top: z.number().int().min(1).max(100).default(15),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, startDate, endDate, metric, window, minChangePct, type, top }) => {
    const range = resolveRange(startDate, endDate, 90);
    const gsc = await client();
    const daily = await gsc.searchAnalyticsAll(siteUrl, { ...range, dimensions: ["date"], type });
    const series = daily.map((r) => ({ date: r.keys![0], value: r[metric] }));
    const points = changePoints(series, range.startDate, range.endDate, window, minChangePct);
    if (!points.length) return { ...range, metric, changePoints: [], note: "No shift above the threshold." };

    // Drivers of the largest shift (drops first, since that is what this tool is for): the window
    // before it vs the window from it on.
    const drops = points.filter((p) => p.direction === "drop");
    const biggest = (drops.length ? drops : points).reduce((a, b) =>
      Math.abs(b.dailyAfter - b.dailyBefore) > Math.abs(a.dailyAfter - a.dailyBefore) ? b : a,
    );
    const before = { startDate: addDays(biggest.date, -window), endDate: addDays(biggest.date, -1) };
    const after = { startDate: biggest.date, endDate: addDays(biggest.date, window - 1) };
    const deltaKey = metric === "clicks" ? "clicksDelta" : "impressionsDelta";
    const drivers = async (dim: Dimension) => {
      const [a, b] = await Promise.all([
        gsc.searchAnalyticsAll(siteUrl, { ...after, dimensions: [dim], type }),
        gsc.searchAnalyticsAll(siteUrl, { ...before, dimensions: [dim], type }),
      ]);
      const changes = comparePeriods(a, b).sort((x, y) => x[deltaKey] - y[deltaKey]);
      return (biggest.direction === "drop" ? changes : changes.reverse()).slice(0, top);
    };
    const [pages, queries] = await Promise.all([drivers("page"), drivers("query")]);
    return {
      ...range,
      metric,
      changePoints: points,
      largest: { ...biggest, compared: { before, after }, pages, queries },
      note: "Query rows omit anonymized queries, so they often add up to far less than the page rows.",
    };
  }),
);

server.registerTool(
  "page_performance",
  {
    title: "Page performance (Search Console + GA4)",
    description:
      "Joins Search Console (impressions, clicks, CTR, position) with GA4 (sessions, engagement, duration, key events) " +
      "per page path, and flags pages with low CTR for their position, low engagement, or search clicks but no GA " +
      "sessions (often a tracking gap).",
    inputSchema: {
      siteUrl,
      property: gaProperty,
      ...dateRange,
      organicOnly: z.boolean().default(true).describe("Count only GA4 sessions from Organic Search"),
      minImpressions: z.number().int().min(1).default(20),
      top: z.number().int().min(1).max(1000).default(50),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, property, startDate, endDate, organicOnly, minImpressions, top }) => {
    const range = resolveRange(startDate, endDate);
    const [gscRows, gaReport] = await Promise.all([
      (await client()).searchAnalyticsAll(siteUrl, { ...range, dimensions: ["page"] }),
      (await gaClient()).runReport(property, {
        ...range,
        dimensions: ["landingPage"],
        metrics: ["sessions", "engagementRate", "averageSessionDuration", "keyEvents"],
        filters: organicOnly
          ? [{ dimension: "sessionDefaultChannelGroup", matchType: "EXACT", value: "Organic Search" }]
          : undefined,
        limit: 10000,
      }),
    ]);

    const ga = new Map<string, { sessions: number; engaged: number; duration: number; keyEvents: number }>();
    for (const r of gaReport.rows) {
      const key = pathKey(String(r.landingPage));
      const acc = ga.get(key) ?? { sessions: 0, engaged: 0, duration: 0, keyEvents: 0 };
      const sessions = Number(r.sessions);
      acc.sessions += sessions;
      acc.engaged += Number(r.engagementRate) * sessions;
      acc.duration += Number(r.averageSessionDuration) * sessions;
      acc.keyEvents += Number(r.keyEvents);
      ga.set(key, acc);
    }

    const pages = gscRows
      .filter((r) => r.impressions >= minImpressions)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, top)
      .map((r) => {
        const g = ga.get(pathKey(r.keys![0]));
        const engagementRate = g?.sessions ? g.engaged / g.sessions : null;
        const flags: string[] = [];
        if (r.position <= 10 && r.ctr < expectedCtr(r.position) * 0.5) flags.push("low_ctr");
        if (g && g.sessions >= 5 && engagementRate! < 0.4) flags.push("low_engagement");
        if (r.clicks >= 5 && !g?.sessions) flags.push("clicks_without_sessions");
        return {
          ...formatRow(r, ["page"]),
          expectedCtr: Math.round(expectedCtr(r.position) * 10000) / 100,
          sessions: g?.sessions ?? 0,
          engagementRate: engagementRate === null ? null : Math.round(engagementRate * 100),
          avgSessionSeconds: g?.sessions ? Math.round(g.duration / g.sessions) : null,
          keyEvents: g?.keyEvents ?? 0,
          flags,
        };
      });
    return {
      ...range,
      gaSessions: organicOnly ? "Organic Search only" : "all channels",
      flagged: countBy(pages.flatMap((p) => p.flags), (f) => f),
      note: "Pages are joined by path, so on a domain property two hosts with the same path share GA numbers. engagementRate is %.",
      pages,
    };
  }),
);

server.registerTool(
  "ai_traffic",
  {
    title: "AI assistant traffic",
    description:
      "GA4 sessions referred by AI assistants (ChatGPT, Perplexity, Claude, Gemini, Copilot, DeepSeek, Grok, Meta AI and " +
      "others), matched by session source rather than GA4's channel grouping, which misses some of them. Returns totals, " +
      "share of all sessions, a per-assistant breakdown, top landing pages and a daily trend.",
    inputSchema: {
      property: gaProperty,
      startDate: gaDate.default("28daysAgo"),
      endDate: gaDate.default("yesterday"),
      top: z.number().int().min(1).max(500).default(25),
    },
    annotations: readOnly,
  },
  handler(async ({ property, startDate, endDate, top }) => {
    const ga = await gaClient();
    const filters = [{ dimension: "sessionSource", matchType: "PARTIAL_REGEXP" as const, value: AI_SOURCE_REGEX }];
    const metrics = ["sessions", "activeUsers", "engagementRate", "averageSessionDuration", "keyEvents"];
    const base = { startDate, endDate, filters };
    const [all, bySource, byPage, byDate] = await Promise.all([
      ga.runReport(property, { startDate, endDate, dimensions: [], metrics: ["sessions"], limit: 1 }),
      ga.runReport(property, { ...base, dimensions: ["sessionSource"], metrics, limit: 1000 }),
      ga.runReport(property, { ...base, dimensions: ["sessionSource", "landingPage"], metrics: ["sessions", "engagementRate"], limit: top * 4 }),
      ga.runReport(property, { ...base, dimensions: ["date"], metrics: ["sessions"], orderBy: { name: "date", desc: false }, limit: 1000 }),
    ]);

    const assistants = new Map<string, { sessions: number; activeUsers: number; engaged: number; keyEvents: number; sources: string[] }>();
    for (const r of bySource.rows) {
      const name = aiAssistant(String(r.sessionSource)) ?? String(r.sessionSource);
      const acc = assistants.get(name) ?? { sessions: 0, activeUsers: 0, engaged: 0, keyEvents: 0, sources: [] };
      acc.sessions += Number(r.sessions);
      acc.activeUsers += Number(r.activeUsers);
      acc.engaged += Number(r.engagementRate) * Number(r.sessions);
      acc.keyEvents += Number(r.keyEvents);
      acc.sources.push(String(r.sessionSource));
      assistants.set(name, acc);
    }
    const aiSessions = bySource.totals?.sessions ?? 0;
    const allSessions = all.totals?.sessions ?? 0;
    return {
      startDate,
      endDate,
      aiSessions,
      shareOfAllSessions: allSessions ? Math.round((aiSessions / allSessions) * 1000) / 10 : 0,
      assistants: [...assistants]
        .map(([name, a]) => ({
          assistant: name,
          sessions: a.sessions,
          activeUsers: a.activeUsers,
          engagementRate: a.sessions ? Math.round((a.engaged / a.sessions) * 100) : 0,
          keyEvents: a.keyEvents,
          sources: a.sources,
        }))
        .sort((a, b) => b.sessions - a.sessions),
      landingPages: byPage.rows.slice(0, top).map((r) => ({
        assistant: aiAssistant(String(r.sessionSource)) ?? r.sessionSource,
        landingPage: r.landingPage,
        sessions: r.sessions,
        engagementRate: Math.round(Number(r.engagementRate) * 100),
      })),
      daily: byDate.rows.map((r) => ({ date: r.date, sessions: r.sessions })),
      note: "Assistants that send no referrer (many app clients) show up as Direct and cannot be counted. engagementRate is %.",
    };
  }),
);

server.registerTool(
  "pagespeed",
  {
    title: "PageSpeed Insights",
    description:
      "Runs PageSpeed Insights (Lighthouse) for a URL: category scores, Core Web Vitals field data from CrUX for the page " +
      "and origin (real users, when there is enough traffic), lab metrics, the biggest performance opportunities and " +
      "failing SEO/accessibility/best-practice audits. Takes 10–40 seconds.",
    inputSchema: {
      url: z.string().url(),
      strategy: z.enum(["mobile", "desktop"]).default("mobile"),
      categories: z
        .array(z.enum(["performance", "seo", "accessibility", "best-practices"]))
        .default(["performance", "seo", "accessibility", "best-practices"]),
    },
    annotations: readOnly,
  },
  handler(async ({ url, strategy, categories }) => {
    const key = await optionalKey("pagespeedApiKey");
    return runPagespeed(url, strategy, categories, key ? { key } : { client: await getAuthorizedClient() });
  }),
);

server.registerTool(
  "indexnow_submit",
  {
    title: "Submit URLs to IndexNow",
    description:
      "Notifies IndexNow engines (Bing, Yandex, Seznam, Naver…) of new or changed URLs, from a list or a whole sitemap. " +
      "Google does not use IndexNow. Needs a key (INDEXNOW_KEY or indexNowKey in config.json) served as a text file on " +
      "the site, by default at /<key>.txt; the file is checked before anything is sent.",
    inputSchema: {
      urls: z.array(z.string().url()).max(50000).optional(),
      sitemapUrl: z.string().url().optional().describe("Submit every URL in this sitemap instead of a list"),
      key: z.string().optional().describe("Overrides the configured key"),
      keyLocation: z.string().url().optional().describe("Key file URL when it is not at /<key>.txt"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  handler(async ({ urls, sitemapUrl, key, keyLocation }) => {
    const list = urls?.length ? urls : sitemapUrl ? [...new Set((await readSitemap(sitemapUrl, 100)).urls)] : [];
    if (!list.length) throw new Error("Give urls or a sitemapUrl.");
    return submitIndexNow(list, key ?? (await requireKey("indexNowKey")), keyLocation);
  }),
);

let bing: BingClient | undefined;
async function bingClient(): Promise<BingClient> {
  bing ??= new BingClient(await requireKey("bingApiKey"));
  return bing;
}

const bingSite = z.string().describe('Site exactly as listed by bing_list_sites, e.g. "https://www.example.com/"');

server.registerTool(
  "bing_list_sites",
  {
    title: "List Bing Webmaster sites",
    description: "Lists the sites in Bing Webmaster Tools for the configured API key (BING_API_KEY).",
    annotations: readOnly,
  },
  handler(async () => (await bingClient()).listSites()),
);

server.registerTool(
  "bing_report",
  {
    title: "Bing Webmaster report",
    description:
      "Bing search and crawl data: top queries or pages (clicks, impressions, CTR %, position summed over the range), " +
      "daily site traffic, daily crawl stats (pages crawled, crawl errors, pages in index) or the current crawl issues. " +
      "Bing's index also feeds several AI search products, so this complements Search Console.",
    inputSchema: {
      siteUrl: bingSite,
      report: z.enum(["queries", "pages", "traffic", "crawl", "crawl_issues"]),
      startDate: date.optional(),
      endDate: date.optional(),
      top: z.number().int().min(1).max(1000).default(50),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, report, startDate, endDate, top }) => {
    const b = await bingClient();
    switch (report) {
      case "queries":
        return (await b.stats(siteUrl, "query", startDate, endDate)).slice(0, top);
      case "pages":
        return (await b.stats(siteUrl, "page", startDate, endDate)).slice(0, top);
      case "traffic":
        return b.traffic(siteUrl, startDate, endDate);
      case "crawl":
        return b.crawl(siteUrl, startDate, endDate);
      case "crawl_issues":
        return (await b.crawlIssues(siteUrl)).slice(0, top);
    }
  }),
);

server.registerTool(
  "bing_submit",
  {
    title: "Submit to Bing",
    description:
      "Submits a sitemap and/or a batch of URLs to Bing Webmaster Tools, and returns the remaining daily URL quota.",
    inputSchema: {
      siteUrl: bingSite,
      sitemapUrl: z.string().url().optional(),
      urls: z.array(z.string().url()).max(500).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  handler(async ({ siteUrl, sitemapUrl, urls }) => {
    if (!sitemapUrl && !urls?.length) throw new Error("Give a sitemapUrl, urls, or both.");
    const b = await bingClient();
    if (sitemapUrl) await b.submitSitemap(siteUrl, sitemapUrl);
    if (urls?.length) await b.submitUrls(siteUrl, urls);
    return { sitemapSubmitted: sitemapUrl ?? null, urlsSubmitted: urls?.length ?? 0, quota: await b.urlQuota(siteUrl) };
  }),
);

let adsense: AdsenseClient | undefined;
async function adsenseClient(): Promise<AdsenseClient> {
  adsense ??= new AdsenseClient(await getAuthorizedClient());
  return adsense;
}

/** AdSense data is not lagged like Search Console's: default to the 28 days ending yesterday. */
function adsenseRange(startDate?: string, endDate?: string) {
  const end = endDate ?? addDays(isoDate(new Date()), -1);
  return { startDate: startDate ?? addDays(end, -27), endDate: end };
}

const adsenseAccount = z.string().optional().describe('e.g. "accounts/pub-1234567890123456"; defaults to the only account');

server.registerTool(
  "adsense_list_accounts",
  {
    title: "List AdSense accounts",
    description: "AdSense accounts the signed-in Google account can access, with their sites and approval state.",
    annotations: readOnly,
  },
  handler(async () => (await adsenseClient()).listAccounts()),
);

server.registerTool(
  "adsense_report",
  {
    title: "AdSense report",
    description:
      "AdSense report with any dimensions and metrics (e.g. dimensions: DATE, MONTH, DOMAIN_NAME, PAGE_URL, COUNTRY_NAME, " +
      "PLATFORM_TYPE_NAME, AD_UNIT_NAME, AD_FORMAT_NAME; metrics: ESTIMATED_EARNINGS, PAGE_VIEWS, PAGE_VIEWS_RPM, " +
      "IMPRESSIONS, IMPRESSIONS_RPM, CLICKS, COST_PER_CLICK, PAGE_VIEWS_CTR, AD_REQUESTS_COVERAGE, ACTIVE_VIEW_VIEWABILITY).",
    inputSchema: {
      account: adsenseAccount,
      startDate: date.optional().describe("Defaults to 28 days before endDate"),
      endDate: date.optional().describe("Defaults to yesterday"),
      dimensions: z.array(z.string()).default(["DATE"]),
      metrics: z.array(z.string()).min(1).default(["ESTIMATED_EARNINGS", "PAGE_VIEWS", "PAGE_VIEWS_RPM", "IMPRESSIONS", "CLICKS"]),
      filters: z.array(z.string()).optional().describe('e.g. ["DOMAIN_NAME==example.com"]; combined with AND'),
      orderBy: z.object({ name: z.string(), desc: z.boolean().default(true) }).optional(),
      limit: z.number().int().min(1).max(100000).default(100),
      currencyCode: z.string().length(3).optional(),
    },
    annotations: readOnly,
  },
  handler(async ({ account, startDate, endDate, dimensions, metrics, filters, orderBy, limit, currencyCode }) => {
    const a = await adsenseClient();
    const range = adsenseRange(startDate, endDate);
    const report = await a.report(account ?? (await a.defaultAccount()), {
      ...range,
      dimensions,
      metrics,
      filters,
      orderBy: orderBy ?? (dimensions.includes("DATE") ? { name: "DATE", desc: false } : { name: metrics[0], desc: true }),
      limit,
      currencyCode,
    });
    return { ...range, ...report };
  }),
);

server.registerTool(
  "page_revenue",
  {
    title: "Page revenue (AdSense + Search Console)",
    description:
      "Joins AdSense earnings per page with Search Console performance for the same URLs, and flags revenue " +
      "opportunities: pages with above-median page RPM that rank 8–20 (moving up pays off most) or have low CTR for their " +
      "position. Earnings cover all traffic to the page, not only search.",
    inputSchema: {
      siteUrl,
      account: adsenseAccount,
      ...dateRange,
      minPageViews: z.number().int().min(1).default(20).describe("Ignore pages with fewer AdSense page views when computing RPM"),
      top: z.number().int().min(1).max(1000).default(50),
    },
    annotations: readOnly,
  },
  handler(async ({ siteUrl, account, startDate, endDate, minPageViews, top }) => {
    const range = resolveRange(startDate, endDate);
    const a = await adsenseClient();
    const [ads, gscRows] = await Promise.all([
      a.report(account ?? (await a.defaultAccount()), {
        ...range,
        dimensions: ["PAGE_URL"],
        metrics: ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "PAGE_VIEWS_RPM"],
        orderBy: { name: "ESTIMATED_EARNINGS", desc: true },
        limit: 10000,
      }),
      (await client()).searchAnalyticsAll(siteUrl, { ...range, dimensions: ["page"] }),
    ]);

    // URLs compared by host + path, so http/https, trailing slashes and query strings don't split a page.
    const urlKey = (u: string) => {
      try {
        return new URL(u).host.toLowerCase() + pathKey(u);
      } catch {
        return pathKey(u);
      }
    };
    const gsc = new Map(gscRows.map((r) => [urlKey(r.keys![0]), r]));
    const rows = ads.rows
      .map((r) => {
        const g = gsc.get(urlKey(String(r.PAGE_URL)));
        return {
          page: String(r.PAGE_URL),
          earnings: Number(r.ESTIMATED_EARNINGS),
          pageViews: Number(r.PAGE_VIEWS),
          pageRpm: Number(r.PAGE_VIEWS_RPM),
          clicks: g?.clicks ?? 0,
          impressions: g?.impressions ?? 0,
          position: g ? Math.round(g.position * 10) / 10 : null,
          ctr: g ? Math.round(g.ctr * 10000) / 100 : null,
          flags: [] as string[],
        };
      })
      .filter((r) => r.earnings > 0 || r.impressions > 0);

    const rpms = rows.filter((r) => r.pageViews >= minPageViews).map((r) => r.pageRpm).sort((x, y) => x - y);
    const medianRpm = rpms.length ? rpms[Math.floor(rpms.length / 2)] : 0;
    for (const r of rows) {
      if (r.pageViews < minPageViews || r.pageRpm < medianRpm || r.position === null) continue;
      if (r.position >= 8 && r.position <= 20) r.flags.push("high_rpm_striking_distance");
      if (r.position <= 10 && r.ctr !== null && r.ctr / 100 < expectedCtr(r.position) * 0.5) r.flags.push("high_rpm_low_ctr");
    }
    return {
      ...range,
      currency: ads.currency,
      totalEarnings: ads.totals?.ESTIMATED_EARNINGS,
      medianPageRpm: medianRpm,
      pagesWithEarnings: ads.rows.length,
      pagesMatchedInSearchConsole: rows.filter((r) => r.position !== null).length,
      flagged: countBy(rows.flatMap((r) => r.flags), (f) => f),
      pages: rows.slice(0, top),
    };
  }),
);

let ads: AdsClient | undefined;
async function adsClient(): Promise<AdsClient> {
  if (!ads) {
    const developerToken = await requireKey("googleAdsDeveloperToken");
    ads = new AdsClient(await getAuthorizedClient(), {
      developerToken,
      loginCustomerId: await optionalKey("googleAdsLoginCustomerId"),
      customerId: await optionalKey("googleAdsCustomerId"),
      apiVersion: await optionalKey("googleAdsApiVersion"),
    });
  }
  return ads;
}

const adsCustomer = z.string().optional().describe("Google Ads customer ID (123-456-7890); defaults to googleAdsCustomerId");
const plannerTarget = {
  language: z.string().default("en").describe('Language code, e.g. "en", "tr", "id"'),
  countries: z.array(z.string().length(2)).default([]).describe('ISO country codes, e.g. ["TR"]; empty means worldwide'),
};

server.registerTool(
  "ads_list_accounts",
  {
    title: "List Google Ads accounts",
    description: "Google Ads accounts the signed-in user can access: ID, name, currency, whether it is a manager or test account.",
    annotations: readOnly,
  },
  handler(async () => (await adsClient()).listAccounts()),
);

server.registerTool(
  "ads_keyword_ideas",
  {
    title: "Keyword ideas (Keyword Planner)",
    description:
      "Google Ads Keyword Planner ideas from seed keywords and/or a page URL: average monthly searches, 12-month trend, " +
      "competition and top-of-page bid range. Shows demand for topics a site does not rank for yet, which Search Console " +
      "cannot. Requires a developer token with Basic access for real volumes.",
    inputSchema: {
      customerId: adsCustomer,
      keywords: z.array(z.string()).max(20).optional(),
      url: z.string().url().optional().describe("Seed ideas from this page (or site)"),
      ...plannerTarget,
      limit: z.number().int().min(1).max(5000).default(100),
    },
    annotations: readOnly,
  },
  handler(async ({ customerId, keywords, url, language, countries, limit }) => {
    if (!keywords?.length && !url) throw new Error("Give keywords, a url, or both.");
    const a = await adsClient();
    const ideas = await a.keywordIdeas(a.customerId(customerId), { keywords, url, language, countries, limit });
    return { language, countries: countries.length ? countries : "worldwide", ideas };
  }),
);

server.registerTool(
  "ads_keyword_volume",
  {
    title: "Keyword search volume",
    description:
      "Average monthly searches, 12-month trend, competition and bid range for an exact list of keywords " +
      "(e.g. the queries a page already ranks for in Search Console).",
    inputSchema: {
      customerId: adsCustomer,
      keywords: z.array(z.string()).min(1).max(10000),
      ...plannerTarget,
    },
    annotations: readOnly,
  },
  handler(async ({ customerId, keywords, language, countries }) => {
    const a = await adsClient();
    return { language, countries: countries.length ? countries : "worldwide", keywords: await a.keywordVolume(a.customerId(customerId), { keywords, language, countries }) };
  }),
);

server.registerTool(
  "ads_query",
  {
    title: "Google Ads query (GAQL)",
    description:
      "Runs a read-only Google Ads Query Language query. Examples: paid vs organic for the same query (needs Ads linked to " +
      "Search Console) — SELECT paid_organic_search_term_view.search_term, metrics.organic_clicks, metrics.organic_impressions, " +
      "metrics.clicks, metrics.impressions FROM paid_organic_search_term_view WHERE segments.date DURING LAST_30_DAYS; " +
      "search terms that triggered ads — SELECT search_term_view.search_term, metrics.clicks, metrics.cost_micros, " +
      "metrics.conversions FROM search_term_view WHERE segments.date DURING LAST_30_DAYS ORDER BY metrics.clicks DESC; " +
      "campaigns — SELECT campaign.name, campaign.status, metrics.clicks, metrics.cost_micros FROM campaign WHERE " +
      "segments.date DURING LAST_30_DAYS. cost_micros / 1,000,000 = account currency.",
    inputSchema: {
      customerId: adsCustomer,
      query: z.string().describe("GAQL SELECT statement"),
      limit: z.number().int().min(1).max(10000).default(500),
    },
    annotations: readOnly,
  },
  handler(async ({ customerId, query, limit }) => {
    // GAQL has no write statements, but keep this tool strictly to SELECT.
    if (!/^\s*select\b/i.test(query)) throw new Error("Only SELECT queries are allowed.");
    const a = await adsClient();
    const rows = await a.search(a.customerId(customerId), query, limit);
    return { rowCount: rows.length, rows };
  }),
);

const command = process.argv[2];
if (command === "auth") {
  // Google Ads access is opt-in: requested with --ads, or when a developer token is already configured.
  const wantsAds = process.argv.includes("--ads") || !!(await optionalKey("googleAdsDeveloperToken"));
  runAuthFlow(wantsAds ? [ADS_SCOPE] : []).then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
} else {
  await server.connect(new StdioServerTransport());
}
