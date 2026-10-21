import { fetchWithChain, mapLimit } from "./audit.js";

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelay?: number;
}

export interface RobotsTxt {
  url: string;
  /** HTTP status of the final robots.txt response, or 0 when it could not be fetched. */
  status: number;
  redirects: number;
  /** 4xx: Google crawls everything. 5xx/unreachable: Google treats the whole site as disallowed. */
  mode: "rules" | "allow_all" | "disallow_all";
  groups: RobotsGroup[];
  sitemaps: string[];
  bytes: number;
  error?: string;
}

/** Google stops reading robots.txt after 500 KiB. */
const MAX_BYTES = 500 * 1024;

export function parseRobots(body: string): Pick<RobotsTxt, "groups" | "sitemaps"> {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | undefined;
  // A user-agent line after rules starts a new group; consecutive user-agent lines share one.
  let lastWasAgent = false;
  for (const raw of body.slice(0, MAX_BYTES).split(/\r?\n|\r/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(value);
    else if (!current) continue;
    else if (key === "allow" || key === "disallow") {
      // An empty Disallow allows everything, so it adds no rule.
      if (value) current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "crawl-delay" && !Number.isNaN(Number(value))) current.crawlDelay = Number(value);
  }
  return { groups, sitemaps };
}

/** robots.txt is cached per origin for the life of the process; audits and crawls hit it repeatedly. */
const cache = new Map<string, Promise<RobotsTxt>>();

export function getRobots(siteUrl: string): Promise<RobotsTxt> {
  const origin = new URL(siteUrl).origin;
  let hit = cache.get(origin);
  if (!hit) {
    hit = loadRobots(origin);
    cache.set(origin, hit);
  }
  return hit;
}

async function loadRobots(origin: string): Promise<RobotsTxt> {
  const url = `${origin}/robots.txt`;
  try {
    const res = await fetchWithChain(url);
    const base = { url, status: res.status, redirects: res.chain.length - 1, bytes: Buffer.byteLength(res.body) };
    if (res.status >= 500 || res.status === 429) return { ...base, mode: "disallow_all", groups: [], sitemaps: [] };
    if (res.status >= 400) return { ...base, mode: "allow_all", groups: [], sitemaps: [] };
    return { ...base, mode: "rules", ...parseRobots(res.body) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { url, status: 0, redirects: 0, bytes: 0, mode: "disallow_all", groups: [], sitemaps: [], error };
  }
}

/**
 * Picks the rules a crawler obeys, as Google does: every group naming the agent's token (merged), else the
 * Googlebot group for Googlebot-* crawlers, else the * group.
 */
export function rulesFor(robots: RobotsTxt, agent: string): { rules: RobotsRule[]; matchedAgent: string } {
  const token = agent.toLowerCase();
  const pick = (name: string) => robots.groups.filter((g) => g.agents.includes(name));
  for (const name of [token, ...(token.startsWith("googlebot-") ? ["googlebot"] : []), "*"]) {
    const groups = pick(name);
    if (groups.length) return { rules: groups.flatMap((g) => g.rules), matchedAgent: name };
  }
  return { rules: [], matchedAgent: "(none)" };
}

function patternToRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Percent-encoding differences shouldn't change a match (e.g. Arabic slugs, written raw or encoded). */
function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export interface RobotsVerdict {
  allowed: boolean;
  matchedAgent: string;
  rule?: string;
}

/** The longest matching pattern wins; on a tie, Allow wins. */
export function isAllowed(robots: RobotsTxt, url: string, agent = "Googlebot"): RobotsVerdict {
  if (robots.mode !== "rules") return { allowed: robots.mode === "allow_all", matchedAgent: "(n/a)", rule: robots.mode };
  const u = new URL(url);
  const path = decodePath(u.pathname + u.search);
  if (path === "/robots.txt") return { allowed: true, matchedAgent: "(n/a)" };
  const { rules, matchedAgent } = rulesFor(robots, agent);
  let best: RobotsRule | undefined;
  for (const rule of rules) {
    if (!patternToRegex(decodePath(rule.pattern)).test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return {
    allowed: best?.allow ?? true,
    matchedAgent,
    rule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.pattern}` : undefined,
  };
}

/** Product tokens that robots.txt can address, with what blocking each one costs. */
export const AI_CRAWLERS = [
  { agent: "GPTBot", owner: "OpenAI", purpose: "training" },
  { agent: "OAI-SearchBot", owner: "OpenAI", purpose: "search (ChatGPT search results)" },
  { agent: "ChatGPT-User", owner: "OpenAI", purpose: "user-triggered fetch" },
  { agent: "ClaudeBot", owner: "Anthropic", purpose: "training" },
  { agent: "Claude-SearchBot", owner: "Anthropic", purpose: "search (Claude answers)" },
  { agent: "Claude-User", owner: "Anthropic", purpose: "user-triggered fetch" },
  { agent: "PerplexityBot", owner: "Perplexity", purpose: "search (Perplexity answers)" },
  { agent: "Perplexity-User", owner: "Perplexity", purpose: "user-triggered fetch" },
  { agent: "Google-Extended", owner: "Google", purpose: "Gemini training and grounding (not Search or AI Overviews)" },
  { agent: "Applebot-Extended", owner: "Apple", purpose: "Apple Intelligence training" },
  { agent: "Meta-ExternalAgent", owner: "Meta", purpose: "training" },
  { agent: "Amazonbot", owner: "Amazon", purpose: "Alexa answers and training" },
  { agent: "CCBot", owner: "Common Crawl", purpose: "open dataset used by many models" },
  { agent: "Bytespider", owner: "ByteDance", purpose: "training" },
  { agent: "DuckAssistBot", owner: "DuckDuckGo", purpose: "search (DuckAssist answers)" },
] as const;

const SEARCH_CRAWLERS = ["Googlebot", "Googlebot-Image", "Bingbot"];

/** Paths that usually hold the CSS/JS Google needs to render a page. */
const RENDER_PATHS = ["/_next/static/", "/static/", "/assets/", "/wp-content/", "/wp-includes/", "/css/", "/js/"];

export async function checkRobots(siteUrl: string, testUrls: string[] = [], agent = "Googlebot") {
  const robots = await getRobots(siteUrl);
  const origin = new URL(siteUrl).origin;
  const home = `${origin}/`;
  const issues: { severity: "error" | "warning"; code: string; message: string }[] = [];
  const add = (severity: "error" | "warning", code: string, message: string) => issues.push({ severity, code, message });

  if (robots.status === 0) add("error", "robots_unreachable", `robots.txt could not be fetched (${robots.error}); Google stops crawling`);
  else if (robots.mode === "disallow_all") add("error", "robots_5xx", `robots.txt answers ${robots.status}; Google treats the site as disallowed`);
  else if (robots.mode === "allow_all") add("warning", "robots_missing", `robots.txt answers ${robots.status}; everything is crawlable and no sitemap is declared`);
  if (robots.redirects > 0) add("warning", "robots_redirects", `robots.txt redirects ${robots.redirects} time(s)`);
  if (robots.bytes > MAX_BYTES) add("warning", "robots_too_large", `robots.txt is ${robots.bytes} bytes; Google ignores everything after 500 KiB`);

  const search = SEARCH_CRAWLERS.map((bot) => ({ bot, home: isAllowed(robots, home, bot) }));
  for (const s of search) {
    if (!s.home.allowed) add("error", "search_bot_blocked", `${s.bot} is blocked from the homepage (${s.home.rule})`);
  }
  for (const p of RENDER_PATHS) {
    const v = isAllowed(robots, `${origin}${p}x.js`);
    if (!v.allowed) add("warning", "render_resources_blocked", `Googlebot is blocked from ${p} (${v.rule}); pages may not render`);
  }

  const ai = AI_CRAWLERS.map((c) => {
    const v = isAllowed(robots, home, c.agent);
    return { ...c, homepageAllowed: v.allowed, matchedGroup: v.matchedAgent, rule: v.rule };
  });
  const blockedSearch = ai.filter((c) => !c.homepageAllowed && c.purpose.startsWith("search"));
  if (blockedSearch.length) {
    add("warning", "ai_search_blocked", `Blocked AI search crawlers (site won't be cited there): ${blockedSearch.map((c) => c.agent).join(", ")}`);
  }

  const sitemaps = await mapLimit(robots.sitemaps, 5, async (url) => {
    try {
      const res = await fetchWithChain(url);
      if (res.status !== 200) add("error", "sitemap_status", `Sitemap ${url} answers ${res.status}`);
      else if (res.chain.length > 1) add("warning", "sitemap_redirects", `Sitemap ${url} redirects to ${res.finalUrl}`);
      return { url, status: res.status, redirects: res.chain.length - 1 };
    } catch (err) {
      add("error", "sitemap_unreachable", `Sitemap ${url}: ${err instanceof Error ? err.message : err}`);
      return { url, status: 0 };
    }
  });
  if (robots.mode === "rules" && !robots.sitemaps.length) add("warning", "no_sitemap_declared", "robots.txt declares no Sitemap");

  let llmsTxt: { url: string; status: number; bytes?: number };
  try {
    const res = await fetchWithChain(`${origin}/llms.txt`);
    const isText = !(res.headers.get("content-type") ?? "").includes("html");
    llmsTxt = { url: res.finalUrl, status: res.status, bytes: res.status === 200 && isText ? Buffer.byteLength(res.body) : undefined };
  } catch {
    llmsTxt = { url: `${origin}/llms.txt`, status: 0 };
  }

  return {
    robotsTxt: {
      url: robots.url,
      status: robots.status,
      mode: robots.mode,
      bytes: robots.bytes,
      groups: robots.groups.map((g) => ({ agents: g.agents, rules: g.rules.length, crawlDelay: g.crawlDelay })),
    },
    searchCrawlers: search.map((s) => ({ bot: s.bot, homepageAllowed: s.home.allowed, matchedGroup: s.home.matchedAgent, rule: s.home.rule })),
    aiCrawlers: ai,
    sitemaps,
    llmsTxt,
    tests: testUrls.map((url) => ({ url, agent, ...isAllowed(robots, url, agent) })),
    issues,
  };
}
