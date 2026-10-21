import {
  canonicalElsewhere,
  countBy,
  fetchWithChain,
  hostOf,
  isHtml,
  isNoindex,
  mapLimit,
  normalize,
  parsePage,
  readSitemap,
  responseIssues,
  signalIssues,
  type Issue,
} from "./audit.js";
import { getRobots, isAllowed } from "./robots.js";

export interface CrawlOptions {
  maxPages: number;
  maxDepth: number;
  maxSeconds: number;
  concurrency: number;
  respectRobots: boolean;
  ignoreQueryStrings: boolean;
  /** Sitemap to compare against for orphans; defaults to the ones robots.txt declares, then /sitemap.xml. */
  sitemapUrl?: string;
}

interface Page {
  url: string;
  depth: number;
  status: number;
  finalUrl: string;
  redirectHops: number;
  html: boolean;
  blockedByRobots?: string;
  error?: string;
  indexable: boolean;
  noindex: boolean;
  canonical?: string;
  title?: string;
  description?: string;
  wordCount?: number;
  issues: Issue[];
}

/** Files we link-check by extension alone; downloading them would waste the crawl budget. */
const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|gz|rar|7z|mp3|mp4|webm|mov|avi|woff2?|ttf|eot|css|js|json|xml|txt|csv|docx?|xlsx?|pptx?)$/i;

/** List sections are capped so a large crawl still returns a readable summary. */
const LIST_CAP = 25;

export async function crawlSite(startUrl: string, opts: CrawlOptions) {
  const started = Date.now();
  const outOfTime = () => Date.now() - started > opts.maxSeconds * 1000;

  // Resolve the start URL first, so http→https or apex→www doesn't make every link look external.
  const first = await fetchWithChain(startUrl);
  const host = hostOf(first.finalUrl);
  const robots = await getRobots(first.finalUrl);

  const key = (u: string) => {
    const url = new URL(u);
    url.hash = "";
    if (opts.ignoreQueryStrings) url.search = "";
    return url.href;
  };
  const internal = (u: string) => hostOf(u) === host;

  const pages = new Map<string, Page>();
  /** target → source pages linking to it */
  const inlinks = new Map<string, Set<string>>();
  const anchors = new Map<string, Map<string, number>>();
  const nofollowInternal = new Set<string>();
  const external = new Set<string>();
  const discovered = new Set<string>([key(first.finalUrl)]);
  let skippedFiles = 0;
  let stoppedBy: "complete" | "maxPages" | "maxDepth" | "maxSeconds" = "complete";

  const visit = async (url: string, depth: number): Promise<string[]> => {
    const page: Page = { url, depth, status: 0, finalUrl: url, redirectHops: 0, html: false, indexable: false, noindex: false, issues: [] };
    pages.set(url, page);
    const add = (severity: Issue["severity"], code: string, message: string) => page.issues.push({ severity, code, message });

    if (opts.respectRobots) {
      const v = isAllowed(robots, url);
      if (!v.allowed) {
        page.blockedByRobots = v.rule ?? v.matchedAgent;
        return [];
      }
    }
    let res;
    try {
      // The start URL's own redirects are reported once as startRedirects, not as an issue of the homepage.
      res = url === key(first.finalUrl) ? { ...first, chain: first.chain.slice(-1) } : await fetchWithChain(url);
    } catch (err) {
      page.error = err instanceof Error ? err.message : String(err);
      add("error", "fetch_failed", page.error);
      return [];
    }
    page.status = res.status;
    page.finalUrl = res.finalUrl;
    page.redirectHops = res.chain.length - 1;
    page.html = isHtml(res);
    responseIssues(url, res, add);
    if (!page.html || res.status !== 200) return [];

    // An internal redirect target is crawled as a page of its own on the next level.
    if (page.redirectHops) {
      const finalKey = key(res.finalUrl);
      if (!internal(res.finalUrl) || discovered.has(finalKey)) return [];
      discovered.add(finalKey);
      return [finalKey];
    }

    const signals = parsePage(res.body, res.finalUrl, res.headers);
    signalIssues(signals, res.finalUrl, add);
    page.noindex = isNoindex(signals);
    page.canonical = signals.canonical;
    page.indexable = !page.noindex && !canonicalElsewhere(signals, res.finalUrl) && !page.redirectHops;
    page.title = signals.title;
    page.description = signals.description;
    page.wordCount = signals.wordCount;

    const next: string[] = [];
    const seenHere = new Set<string>();
    for (const link of signals.links) {
      if (!internal(link.href)) {
        external.add(link.href);
        continue;
      }
      const target = key(link.href);
      if (link.nofollow) nofollowInternal.add(target);
      if (!seenHere.has(target)) {
        seenHere.add(target);
        if (!inlinks.has(target)) inlinks.set(target, new Set());
        inlinks.get(target)!.add(url);
      }
      if (link.text) {
        const a = anchors.get(target) ?? new Map<string, number>();
        a.set(link.text, (a.get(link.text) ?? 0) + 1);
        anchors.set(target, a);
      }
      if (discovered.has(target)) continue;
      discovered.add(target);
      if (SKIP_EXT.test(new URL(target).pathname)) skippedFiles++;
      else next.push(target);
    }
    return next;
  };

  // Breadth-first, one level at a time, so each page's depth is its shortest click path from the start.
  let frontier = [key(first.finalUrl)];
  let unvisited: string[] = [];
  for (let depth = 0; frontier.length; depth++) {
    if (depth > opts.maxDepth) {
      stoppedBy = "maxDepth";
      unvisited = frontier;
      break;
    }
    const room = opts.maxPages - pages.size;
    const batch = frontier.slice(0, Math.max(0, room));
    if (batch.length < frontier.length) {
      stoppedBy = "maxPages";
      unvisited = frontier.slice(batch.length);
    }
    const found = await mapLimit(batch, opts.concurrency, async (url) => {
      if (outOfTime()) {
        unvisited.push(url);
        return [];
      }
      return visit(url, depth);
    });
    if (outOfTime()) stoppedBy = "maxSeconds";
    if (stoppedBy !== "complete") {
      unvisited.push(...found.flat());
      break;
    }
    frontier = found.flat();
  }

  const all = [...pages.values()];
  const crawledHtml = all.filter((p) => p.html && p.status === 200 && !p.redirectHops);
  const inlinkCount = (u: string) => inlinks.get(u)?.size ?? 0;
  const sources = (u: string) => [...(inlinks.get(u) ?? [])].slice(0, 3);
  const topAnchors = (u: string) =>
    [...(anchors.get(u) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t);
  const linked = (p: Page) => inlinkCount(p.url) > 0;
  const capped = <T>(items: T[]) => ({ count: items.length, items: items.slice(0, LIST_CAP) });

  // Sitemap URLs never reached through links are orphan candidates.
  const sitemapCandidates = opts.sitemapUrl ? [opts.sitemapUrl] : robots.sitemaps.length ? robots.sitemaps : [`https://${host}/sitemap.xml`];
  const sitemap: { urls: string[]; sources: string[]; error?: string } = { urls: [], sources: [] };
  for (const sm of sitemapCandidates) {
    try {
      const r = await readSitemap(sm);
      sitemap.urls.push(...r.urls);
      sitemap.sources.push(sm);
    } catch (err) {
      sitemap.error = err instanceof Error ? err.message : String(err);
    }
  }
  const sitemapKeys = [...new Set(sitemap.urls.filter((u) => internal(u)).map(key))];
  const discoveredNorm = new Set([...discovered].map(normalize));
  const orphans = sitemapKeys.filter((u) => !discoveredNorm.has(normalize(u)));
  const sitemapNotIndexable = sitemapKeys
    .map((u) => pages.get(u))
    .filter((p): p is Page => !!p && !p.indexable)
    .map((p) => ({ url: p.url, status: p.status, redirectsTo: p.redirectHops ? p.finalUrl : undefined, noindex: p.noindex || undefined, canonical: p.canonical }));

  const duplicates = (field: "title" | "description") => {
    const groups = new Map<string, string[]>();
    for (const p of crawledHtml.filter((p) => p.indexable && p[field])) {
      const v = p[field]!.trim().toLowerCase();
      groups.set(v, [...(groups.get(v) ?? []), p.url]);
    }
    const dupes = [...groups.values()]
      .filter((urls) => urls.length > 1)
      .sort((a, b) => b.length - a.length)
      .map((urls) => ({ [field]: pages.get(urls[0])![field], pages: urls.length, examples: urls.slice(0, 5) }));
    return capped(dupes);
  };

  const issues = all.flatMap((p) => p.issues.map((i) => ({ ...i, url: p.url })));
  const examples: Record<string, string[]> = {};
  for (const i of issues) {
    const list = (examples[`${i.severity}:${i.code}`] ??= []);
    if (list.length < 5) list.push(i.url);
  }

  const brokenTargets = all.filter((p) => linked(p) && (p.status >= 400 || p.error));
  const redirectTargets = all.filter((p) => linked(p) && p.redirectHops > 0);
  const nonIndexableTargets = all.filter((p) => linked(p) && p.html && p.status === 200 && !p.redirectHops && !p.indexable);
  const blocked = all.filter((p) => p.blockedByRobots);
  const indexable = crawledHtml.filter((p) => p.indexable);

  return {
    start: first.finalUrl,
    startRedirects: first.chain.length - 1,
    host,
    crawlComplete: stoppedBy === "complete",
    stoppedBy,
    seconds: Math.round((Date.now() - started) / 1000),
    pagesFetched: all.length - blocked.length,
    urlsDiscovered: discovered.size,
    notCrawled: unvisited.length,
    skippedFiles,
    externalLinks: external.size,
    statusCounts: countBy(all.filter((p) => !p.blockedByRobots), (p) => (p.error ? "error" : String(p.status))),
    depth: {
      distribution: countBy(crawledHtml, (p) => String(p.depth)),
      deepPages: capped(
        indexable.filter((p) => p.depth > 3).sort((a, b) => b.depth - a.depth).map((p) => ({ url: p.url, depth: p.depth })),
      ),
    },
    links: {
      broken: capped(
        brokenTargets
          .sort((a, b) => inlinkCount(b.url) - inlinkCount(a.url))
          .map((p) => ({ url: p.url, status: p.status || p.error, linkingPages: inlinkCount(p.url), from: sources(p.url) })),
      ),
      toRedirects: capped(
        redirectTargets
          .sort((a, b) => inlinkCount(b.url) - inlinkCount(a.url))
          .map((p) => ({ url: p.url, redirectsTo: p.finalUrl, hops: p.redirectHops, linkingPages: inlinkCount(p.url), from: sources(p.url) })),
      ),
      toNonIndexable: capped(
        nonIndexableTargets
          .sort((a, b) => inlinkCount(b.url) - inlinkCount(a.url))
          .map((p) => ({ url: p.url, noindex: p.noindex || undefined, canonical: p.canonical, linkingPages: inlinkCount(p.url) })),
      ),
      toRobotsBlocked: capped(blocked.map((p) => ({ url: p.url, rule: p.blockedByRobots, linkingPages: inlinkCount(p.url) }))),
      nofollowInternal: nofollowInternal.size,
      // The start page has no inlinks by definition; it isn't weakly linked.
      weaklyLinked: capped(
        indexable
          .filter((p) => p.depth > 0 && inlinkCount(p.url) === 1)
          .map((p) => ({ url: p.url, depth: p.depth, from: sources(p.url)[0] })),
      ),
      mostLinked: [...indexable]
        .sort((a, b) => inlinkCount(b.url) - inlinkCount(a.url))
        .slice(0, 10)
        .map((p) => ({ url: p.url, linkingPages: inlinkCount(p.url), anchors: topAnchors(p.url) })),
    },
    sitemap: {
      sources: sitemap.sources,
      error: sitemap.sources.length ? undefined : sitemap.error,
      urls: sitemapKeys.length,
      orphans: capped(orphans),
      orphansNote:
        stoppedBy === "complete"
          ? undefined
          : `Crawl stopped by ${stoppedBy} with ${unvisited.length} URLs not fetched; orphans may be linked from those pages. Raise the limit to confirm.`,
      notIndexable: capped(sitemapNotIndexable),
    },
    content: {
      duplicateTitles: duplicates("title"),
      duplicateDescriptions: duplicates("description"),
      averageWords: crawledHtml.length
        ? Math.round(crawledHtml.reduce((sum, p) => sum + (p.wordCount ?? 0), 0) / crawledHtml.length)
        : 0,
    },
    issueCounts: countBy(issues, (i) => `${i.severity}:${i.code}`),
    issueExamples: examples,
    /** Exposed for callers that join the crawl with other data (e.g. Search Console pages). */
    discovered: [...discovered],
  };
}
