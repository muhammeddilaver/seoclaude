import { gunzipSync } from "node:zlib";

const USER_AGENT = "Mozilla/5.0 (compatible; seoclaude/0.1)";
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;

export interface Hop {
  url: string;
  status: number;
}

export interface FetchResult {
  chain: Hop[];
  finalUrl: string;
  status: number;
  headers: Headers;
  body: string;
}

/** Follows redirects by hand so every hop (and a 301 vs 308) is visible. */
export async function fetchWithChain(url: string): Promise<FetchResult> {
  const chain: Hop[] = [];
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let res: Response;
    try {
      res = await fetch(current, {
        redirect: "manual",
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Could not fetch ${current}: ${err instanceof Error ? err.message : err}`);
    }
    chain.push({ url: current, status: res.status });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    const body = current.endsWith(".gz")
      ? gunzipSync(Buffer.from(await res.arrayBuffer())).toString("utf8")
      : await res.text();
    return { chain, finalUrl: current, status: res.status, headers: res.headers, body };
  }
  throw new Error(`More than ${MAX_REDIRECTS} redirects starting from ${url}`);
}

// --- HTML parsing (regex is enough for <head> tags; no DOM dependency) ---

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Attribute names are lowercased, since Next.js and others emit e.g. hrefLang. */
function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

const tags = (html: string, name: string) =>
  [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => attributes(m[0]));

export interface Hreflang {
  lang: string;
  href: string;
}

export interface PageSignals {
  title?: string;
  description?: string;
  htmlLang?: string;
  robotsMeta?: string;
  xRobotsTag?: string;
  canonical?: string;
  canonicalCount: number;
  hreflang: Hreflang[];
  structuredData: { types: string[]; errors: number };
}

export function parsePage(html: string, baseUrl: string, headers: Headers): PageSignals {
  const resolve = (href: string) => {
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  };
  const links = tags(html, "link");
  const metas = tags(html, "meta");
  const rel = (l: Record<string, string>) => (l.rel ?? "").toLowerCase().split(/\s+/);
  const canonicals = links.filter((l) => rel(l).includes("canonical") && l.href);
  const meta = (name: string) => metas.find((m) => (m.name ?? "").toLowerCase() === name)?.content;

  const types: string[] = [];
  let errors = 0;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const collect = (node: any): void => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (!node || typeof node !== "object") return;
        if (node["@type"]) types.push(...[node["@type"]].flat());
        if (node["@graph"]) collect(node["@graph"]);
      };
      collect(JSON.parse(m[1]));
    } catch {
      errors++;
    }
  }

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: title === undefined ? undefined : decodeEntities(title).trim(),
    description: meta("description"),
    htmlLang: attributes(html.match(/<html\b[^>]*>/i)?.[0] ?? "").lang,
    robotsMeta: meta("robots") ?? meta("googlebot"),
    xRobotsTag: headers.get("x-robots-tag") ?? undefined,
    canonical: canonicals[0] ? resolve(canonicals[0].href) : undefined,
    canonicalCount: canonicals.length,
    hreflang: links
      .filter((l) => rel(l).includes("alternate") && l.hreflang && l.href)
      .map((l) => ({ lang: l.hreflang, href: resolve(l.href) })),
    structuredData: { types: [...new Set(types)], errors },
  };
}

// --- Audit ---

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  code: string;
  message: string;
}

/** Trailing slashes and fragments don't make two URLs different for canonical purposes. */
const normalize = (u: string) => {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return u;
  }
};
const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
};

export interface AuditOptions {
  /** Fetch the canonical target and confirm it answers 200 without redirecting. */
  checkCanonicalTarget?: boolean;
  /** Fetch every hreflang alternate and confirm it links back (return tags). */
  checkHreflang?: boolean;
}

export async function auditPage(url: string, opts: AuditOptions = {}) {
  const res = await fetchWithChain(url);
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, message: string) => issues.push({ severity, code, message });

  const redirects = res.chain.slice(0, -1);
  if (redirects.length > 1) add("warning", "redirect_chain", `${redirects.length} redirects before the final URL`);
  else if (redirects.length === 1) add("warning", "redirected", `${url} redirects (${redirects[0].status}) to ${res.finalUrl}`);
  if (res.status !== 200) add("error", "status", `Final URL answers ${res.status}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    add("error", "not_html", `Content-Type is "${contentType}"`);
    return { url, finalUrl: res.finalUrl, status: res.status, chain: res.chain, issues };
  }

  const page = parsePage(res.body, res.finalUrl, res.headers);
  const robots = [page.robotsMeta, page.xRobotsTag].filter(Boolean).join(", ").toLowerCase();
  if (/noindex|none/.test(robots)) add("error", "noindex", `Page is noindex (${robots})`);

  if (!page.canonical) add("warning", "canonical_missing", "No rel=canonical");
  else {
    if (page.canonicalCount > 1) add("error", "canonical_multiple", `${page.canonicalCount} rel=canonical tags`);
    if (hostOf(page.canonical) !== hostOf(res.finalUrl)) {
      add("error", "canonical_host_mismatch", `Canonical host ${hostOf(page.canonical)} differs from served host ${hostOf(res.finalUrl)}`);
    } else if (normalize(page.canonical) !== normalize(res.finalUrl)) {
      add("warning", "canonical_elsewhere", `Canonical points to another URL: ${page.canonical}`);
    }
  }

  let canonicalTarget: { status: number; finalUrl: string } | undefined;
  if (opts.checkCanonicalTarget && page.canonical && normalize(page.canonical) !== normalize(res.finalUrl)) {
    try {
      const target = await fetchWithChain(page.canonical);
      canonicalTarget = { status: target.status, finalUrl: target.finalUrl };
      if (target.chain.length > 1) add("error", "canonical_redirects", `Canonical ${page.canonical} redirects to ${target.finalUrl}`);
      if (target.status !== 200) add("error", "canonical_status", `Canonical ${page.canonical} answers ${target.status}`);
    } catch (err) {
      add("error", "canonical_unreachable", err instanceof Error ? err.message : String(err));
    }
  }

  let hreflangReturn: { lang: string; href: string; linksBack: boolean | null; status?: number }[] | undefined;
  if (page.hreflang.length) {
    const self = normalize(page.canonical ?? res.finalUrl);
    if (!page.hreflang.some((h) => normalize(h.href) === self)) {
      add("warning", "hreflang_no_self", "hreflang set does not include the page itself");
    }
    const offHost = page.hreflang.filter((h) => hostOf(h.href) !== hostOf(res.finalUrl));
    if (offHost.length) add("error", "hreflang_host_mismatch", `${offHost.length} hreflang URLs on another host (${hostOf(offHost[0].href)})`);

    if (opts.checkHreflang) {
      const others = page.hreflang.filter((h) => normalize(h.href) !== self && h.lang !== "x-default").slice(0, 10);
      hreflangReturn = await Promise.all(
        others.map(async (h) => {
          try {
            const alt = await fetchWithChain(h.href);
            const back = parsePage(alt.body, alt.finalUrl, alt.headers).hreflang.some((x) => normalize(x.href) === self);
            if (alt.chain.length > 1) add("error", "hreflang_redirects", `hreflang ${h.lang} ${h.href} redirects to ${alt.finalUrl}`);
            if (!back) add("error", "hreflang_no_return", `hreflang ${h.lang} ${h.href} does not link back`);
            return { ...h, status: alt.status, linksBack: back };
          } catch {
            add("warning", "hreflang_unreachable", `Could not fetch hreflang ${h.lang} ${h.href}`);
            return { ...h, linksBack: null };
          }
        }),
      );
    }
  }

  if (!page.title) add("error", "title_missing", "No <title>");
  else if (page.title.length > 60) add("warning", "title_long", `Title is ${page.title.length} chars (may be truncated past ~60)`);
  if (!page.description) add("warning", "description_missing", "No meta description");
  else if (page.description.length > 160) add("warning", "description_long", `Description is ${page.description.length} chars`);
  if (!page.htmlLang) add("warning", "lang_missing", "<html> has no lang attribute");
  if (page.structuredData.errors) add("error", "jsonld_invalid", `${page.structuredData.errors} JSON-LD block(s) fail to parse`);

  return {
    url,
    finalUrl: res.finalUrl,
    status: res.status,
    chain: res.chain,
    ...page,
    canonicalTarget,
    hreflangReturn,
    issues,
  };
}

// --- Sitemaps ---

/** Reads a sitemap or sitemap index and returns page URLs, following up to `maxSitemaps` child sitemaps. */
export async function readSitemap(url: string, maxSitemaps = 20) {
  const urls: string[] = [];
  const sitemaps: { url: string; status: number; urls: number }[] = [];
  const queue = [url];
  while (queue.length && sitemaps.length < maxSitemaps) {
    const next = queue.shift()!;
    const res = await fetchWithChain(next);
    const locs = [...res.body.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
    if (/<sitemapindex\b/i.test(res.body)) {
      queue.push(...locs);
      sitemaps.push({ url: next, status: res.status, urls: 0 });
    } else {
      urls.push(...locs);
      sitemaps.push({ url: next, status: res.status, urls: locs.length });
    }
  }
  return { urls, sitemaps, skippedSitemaps: queue.length };
}

/** Evenly spaced sample, so a large sitemap is covered end to end rather than just its first entries. */
export function sample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function countBy<T>(items: T[], key: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item) ?? "(none)";
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}
