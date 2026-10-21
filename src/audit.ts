import { gunzipSync } from "node:zlib";
import { getRobots, isAllowed } from "./robots.js";
import { validateJsonLd, type SchemaFinding } from "./schema.js";

const USER_AGENT = "Mozilla/5.0 (compatible; seoclaude/0.2)";
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
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
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

export interface PageLink {
  href: string;
  text: string;
  nofollow: boolean;
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
  structuredData: { types: string[]; errors: number; findings: SchemaFinding[] };
  h1: string[];
  /** Heading levels in document order, e.g. [1, 2, 3, 2]. */
  headings: number[];
  /** Words of visible text outside nav, header, footer and aside. */
  wordCount: number;
  images: { total: number; missingAlt: number };
  links: PageLink[];
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** Removes elements whose text isn't page content. Not nesting-aware, which is fine for these tags. */
function contentHtml(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, " ");
}

const countWords = (text: string) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function extractLinks(html: string, baseUrl: string): PageLink[] {
  const base = attributes(html.match(/<base\b[^>]*>/i)?.[0] ?? "").href;
  let resolveBase = baseUrl;
  try {
    if (base) resolveBase = new URL(base, baseUrl).href;
  } catch {}
  const links: PageLink[] = [];
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(m[1]);
    const raw = attrs.href?.trim();
    if (!raw || /^(#|mailto:|tel:|javascript:|data:)/i.test(raw)) continue;
    let href: string;
    try {
      const u = new URL(raw, resolveBase);
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = "";
      href = u.href;
    } catch {
      continue;
    }
    // An image link's anchor text is its alt.
    const text = stripTags(m[2]) || tags(m[2], "img").map((i) => i.alt ?? "").join(" ").trim();
    links.push({ href, text, nofollow: (attrs.rel ?? "").toLowerCase().split(/\s+/).includes("nofollow") });
  }
  return links;
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
  const roots: unknown[] = [];
  let errors = 0;
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const collect = (node: any): void => {
        if (Array.isArray(node)) return node.forEach(collect);
        if (!node || typeof node !== "object") return;
        if (node["@type"]) types.push(...[node["@type"]].flat());
        if (node["@graph"]) collect(node["@graph"]);
      };
      const parsed = JSON.parse(m[1]);
      roots.push(parsed);
      collect(parsed);
    } catch {
      errors++;
    }
  }

  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const content = contentHtml(html);
  const images = tags(content, "img");
  const headings = [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
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
    structuredData: { types: [...new Set(types)], errors, findings: validateJsonLd(roots) },
    h1: headings.filter((h) => h[1] === "1").map((h) => stripTags(h[2])),
    headings: headings.map((h) => Number(h[1])),
    wordCount: countWords(stripTags(content)),
    images: { total: images.length, missingAlt: images.filter((i) => !("alt" in i)).length },
    links: extractLinks(html, baseUrl),
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
export const normalize = (u: string) => {
  try {
    const url = new URL(u);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return u;
  }
};
export const hostOf = (u: string) => {
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

type AddIssue = (severity: Severity, code: string, message: string) => void;

export const isHtml = (res: FetchResult) => (res.headers.get("content-type") ?? "").includes("html");

/** Checks on the response itself: redirects, final status and content type. */
export function responseIssues(url: string, res: FetchResult, add: AddIssue) {
  const redirects = res.chain.slice(0, -1);
  if (redirects.length > 1) add("warning", "redirect_chain", `${redirects.length} redirects before the final URL`);
  else if (redirects.length === 1) add("warning", "redirected", `${url} redirects (${redirects[0].status}) to ${res.finalUrl}`);
  if (res.status !== 200) add("error", "status", `Final URL answers ${res.status}`);
  if (!isHtml(res)) add("error", "not_html", `Content-Type is "${res.headers.get("content-type") ?? ""}"`);
}

export const isNoindex = (page: PageSignals) =>
  /noindex|none/.test([page.robotsMeta, page.xRobotsTag].filter(Boolean).join(", ").toLowerCase());

/** True when the page names another URL as canonical, so it isn't the version Google should index. */
export const canonicalElsewhere = (page: PageSignals, finalUrl: string) =>
  !!page.canonical && normalize(page.canonical) !== normalize(finalUrl);

/** Below this many words of body text a page is flagged as thin. */
export const THIN_WORDS = 200;

/** Checks on the parsed page that need no further requests; shared by audit_page and crawl_site. */
export function signalIssues(page: PageSignals, finalUrl: string, add: AddIssue) {
  const robots = [page.robotsMeta, page.xRobotsTag].filter(Boolean).join(", ").toLowerCase();
  if (isNoindex(page)) add("error", "noindex", `Page is noindex (${robots})`);

  if (!page.canonical) add("warning", "canonical_missing", "No rel=canonical");
  else {
    if (page.canonicalCount > 1) add("error", "canonical_multiple", `${page.canonicalCount} rel=canonical tags`);
    if (hostOf(page.canonical) !== hostOf(finalUrl)) {
      add("error", "canonical_host_mismatch", `Canonical host ${hostOf(page.canonical)} differs from served host ${hostOf(finalUrl)}`);
    } else if (canonicalElsewhere(page, finalUrl)) {
      add("warning", "canonical_elsewhere", `Canonical points to another URL: ${page.canonical}`);
    }
  }

  if (page.hreflang.length) {
    const self = normalize(page.canonical ?? finalUrl);
    if (!page.hreflang.some((h) => normalize(h.href) === self)) {
      add("warning", "hreflang_no_self", "hreflang set does not include the page itself");
    }
    const offHost = page.hreflang.filter((h) => hostOf(h.href) !== hostOf(finalUrl));
    if (offHost.length) add("error", "hreflang_host_mismatch", `${offHost.length} hreflang URLs on another host (${hostOf(offHost[0].href)})`);
  }

  if (!page.title) add("error", "title_missing", "No <title>");
  else if (page.title.length > 60) add("warning", "title_long", `Title is ${page.title.length} chars (may be truncated past ~60)`);
  if (!page.description) add("warning", "description_missing", "No meta description");
  else if (page.description.length > 160) add("warning", "description_long", `Description is ${page.description.length} chars`);
  if (!page.htmlLang) add("warning", "lang_missing", "<html> has no lang attribute");

  if (!page.h1.length) add("warning", "h1_missing", "No <h1>");
  else if (page.h1.length > 1) add("warning", "h1_multiple", `${page.h1.length} <h1> tags`);
  const skip = page.headings.findIndex((level, i) => i > 0 && level > page.headings[i - 1] + 1);
  if (skip > 0) add("warning", "heading_skip", `Heading level jumps from h${page.headings[skip - 1]} to h${page.headings[skip]}`);
  if (page.wordCount < THIN_WORDS) add("warning", "thin_content", `${page.wordCount} words of body text`);
  if (page.images.missingAlt) add("warning", "img_alt_missing", `${page.images.missingAlt} of ${page.images.total} images have no alt attribute`);

  if (page.structuredData.errors) add("error", "jsonld_invalid", `${page.structuredData.errors} JSON-LD block(s) fail to parse`);
  for (const f of page.structuredData.findings) {
    if (f.missingRequired.length) add("error", "schema_required_missing", `${f.type} is missing ${f.missingRequired.join(", ")}`);
    else add("warning", "schema_recommended_missing", `${f.type} lacks recommended ${f.missingRecommended.join(", ")}`);
  }
}

export async function auditPage(url: string, opts: AuditOptions = {}) {
  const issues: Issue[] = [];
  const add: AddIssue = (severity, code, message) => issues.push({ severity, code, message });

  // Fetched alongside the page: a robots.txt block hides the page's own noindex and canonical from Google.
  const [res, robots] = await Promise.all([fetchWithChain(url), getRobots(url).catch(() => undefined)]);
  const robotsVerdict = robots ? isAllowed(robots, res.finalUrl) : undefined;
  if (robotsVerdict && !robotsVerdict.allowed) {
    add("error", "robots_blocked", `robots.txt blocks Googlebot (${robotsVerdict.rule ?? robotsVerdict.matchedAgent})`);
  }

  responseIssues(url, res, add);
  if (!isHtml(res)) return { url, finalUrl: res.finalUrl, status: res.status, chain: res.chain, issues };

  const page = parsePage(res.body, res.finalUrl, res.headers);
  signalIssues(page, res.finalUrl, add);

  let canonicalTarget: { status: number; finalUrl: string } | undefined;
  if (opts.checkCanonicalTarget && page.canonical && canonicalElsewhere(page, res.finalUrl)) {
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
  if (opts.checkHreflang && page.hreflang.length) {
    const self = normalize(page.canonical ?? res.finalUrl);
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

  // Links are summarized here; crawl_site is the tool that follows them.
  const { links, ...signals } = page;
  const internal = links.filter((l) => hostOf(l.href) === hostOf(res.finalUrl));
  return {
    url,
    finalUrl: res.finalUrl,
    status: res.status,
    chain: res.chain,
    robotsTxt: robotsVerdict,
    ...signals,
    links: { internal: new Set(internal.map((l) => l.href)).size, external: links.length - internal.length, nofollow: links.filter((l) => l.nofollow).length },
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
