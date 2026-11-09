# seoclaude

An MCP server that gives Claude (Claude Code, Claude Desktop or any MCP client) your SEO data and the tools to act on it: Google Search Console, Google Analytics 4, Google Tag Manager, Bing Webmaster Tools, IndexNow, PageSpeed Insights, AdSense and Google Ads Keyword Planner, plus live technical SEO audits of your pages.

Ask in plain language — *"when did search traffic drop, and which pages lost it?"*, *"are my canonicals and hreflang set up right?"*, *"how much traffic comes from ChatGPT?"* — and Claude pulls the numbers live and works out the answer.

Nothing is stored: every question is answered from the APIs in real time. The only things kept on disk are your Google OAuth token and any API keys you add, in `~/.config/seoclaude/`.

## Tools

### Search Console

| Tool | What it does |
| --- | --- |
| `list_sites` | Every Search Console property you can access |
| `search_analytics` | Clicks, impressions, CTR and position by query, page, country, device, date or search appearance |
| `compare_periods` | Two date ranges side by side, with the biggest gainers and losers |
| `find_opportunities` | Quick wins: low CTR for the position, queries ranking 8–20 (striking distance), keyword cannibalization |
| `detect_drops` | Finds sudden shifts in the daily series (e.g. impressions −93% from one week to the next) and lists the pages and queries behind the largest one |
| `inspect_url` | Google's index status for a URL: coverage, user vs Google canonical, last crawl, rich results |
| `bulk_inspect` | URL Inspection over many URLs (a list, a sitemap sample or your top pages), summarized: coverage states, canonical mismatches, crawl dates |
| `list_sitemaps` | Submitted sitemaps with errors, warnings and submitted/indexed counts |
| `submit_sitemap` | Submits or resubmits a sitemap |

### Technical audits (no account needed)

| Tool | What it does |
| --- | --- |
| `audit_page` | Fetches a live page and checks redirect chain, status, noindex (meta and header), robots.txt blocking, canonical (missing, multiple, other host, redirecting target), hreflang (self-reference, host, return links), title/description, `lang`, h1 and heading order, thin content, image alt text, and JSON-LD (parse errors plus required/recommended properties for Google rich result types) |
| `audit_sitemap` | Checks every sitemap URL is on one host, then audits an evenly spaced sample of pages and groups the issues |
| `crawl_site` | Crawls the site by following internal links and audits every page: click depth, broken links, links to redirects or noindex/non-canonical/blocked pages, weakly linked pages, anchors, orphan sitemap URLs, duplicate titles and descriptions. With a Search Console property, lists pages that get clicks but have no internal links |
| `check_robots` | robots.txt with Google's matching rules: Googlebot/Bingbot access, blocked CSS/JS, which AI crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended…) are allowed and what blocking each costs, declared sitemaps, `llms.txt`; tests URLs for any user agent |
| `pagespeed` | PageSpeed Insights: category scores, Core Web Vitals field data (CrUX) for page and origin, lab metrics, top opportunities, failing SEO/accessibility audits |

### Google Analytics 4

| Tool | What it does |
| --- | --- |
| `ga_list_properties` | Every GA4 property you can access |
| `ga_report` | Any GA4 dimensions and metrics: channels, landing pages, conversions, revenue… |
| `ga_realtime` | Activity in the last 30 minutes |
| `page_performance` | Search Console and GA4 joined per page; flags low CTR, low engagement, and search clicks with no GA sessions (a tracking gap) |
| `ai_traffic` | Traffic from AI assistants (ChatGPT, Perplexity, Claude, Gemini, Copilot, DeepSeek, Grok and more), matched by source: totals, share, per-assistant breakdown, landing pages, daily trend |

### Google Tag Manager

| Tool | What it does |
| --- | --- |
| `gtm_list_containers` | Every Tag Manager container you can access, with its `GTM-XXXXXX` ID |
| `gtm_audit` | Audits the live version of a container: GA4 measurement IDs, duplicate Google tag/GA4 config (double-counted page views), dead Universal Analytics tags, analytics hard-coded in Custom HTML, paused tags, tags without a trigger, unused triggers and variables, consent checks. Checks every measurement ID against your GA4 data streams (unknown IDs, or IDs of the wrong property when you pass `property`). Read-only |

### Bing and IndexNow

| Tool | What it does |
| --- | --- |
| `bing_list_sites` | Your Bing Webmaster Tools sites |
| `bing_report` | Bing queries and pages, daily traffic, crawl stats and crawl issues |
| `bing_submit` | Submits a sitemap and/or URLs to Bing, returns the remaining quota |
| `indexnow_submit` | Sends URLs, or a whole sitemap, to IndexNow (Bing, Yandex, Seznam, Naver…), after checking the key file is live |

### AdSense and Google Ads

| Tool | What it does |
| --- | --- |
| `adsense_list_accounts` | AdSense accounts and their sites |
| `adsense_report` | Any AdSense dimensions and metrics: earnings, RPM, page views, by page, country, ad unit… |
| `page_revenue` | AdSense earnings joined with Search Console per page; flags high-RPM pages ranking 8–20 or with low CTR |
| `ads_list_accounts` | Google Ads accounts you can access |
| `ads_keyword_ideas` | Keyword Planner ideas from seed keywords or a URL: monthly searches, 12-month trend, competition, bid range |
| `ads_keyword_volume` | Search volume, trend, competition and bids for an exact keyword list |
| `ads_query` | Read-only GAQL queries (paid vs organic, search terms, campaigns…) |

The AdSense and Google Ads tools are new and have not yet been tested against live accounts. Reports are welcome.

## Setup

You need Node.js 20 or newer and a Google Cloud OAuth client of your own (free, about five minutes). Only the Google services you enable are used; everything else is optional.

### 1. Create a Google OAuth client

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project (or pick one).
2. Under **APIs & Services → Library**, enable the APIs you want:
   - **Google Search Console API**
   - **Google Analytics Data API** and **Google Analytics Admin API**
   - **Tag Manager API** (optional)
   - **PageSpeed Insights API**
   - **AdSense Management API** (optional)
   - **Google Ads API** (optional)
3. **OAuth consent screen**: user type *External*; add your own Google account under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Application type: Desktop app**.
5. Download the JSON and save it as `~/.config/seoclaude/credentials.json`
   (or set `GSC_CLIENT_ID` and `GSC_CLIENT_SECRET`).

> While the app is in *Testing*, Google expires the refresh token every 7 days and you will need to sign in again. To avoid that, set the consent screen to *In production*; for personal use no verification is needed, you just click through a warning.

### 2. Sign in

```sh
npx seoclaude auth
```

A browser window opens; approve access with the Google account that owns your properties. It asks for read-only access to GA4, Tag Manager and AdSense, the `openid` scope PageSpeed Insights uses for quota, and full Search Console access. Google has no narrower scope that allows submitting sitemaps; seoclaude only writes to Search Console when you call `submit_sitemap`.

### 3. Connect it to Claude

**Claude Code**

```sh
claude mcp add seoclaude -- npx -y seoclaude
```

**Claude Desktop**: add this to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "seoclaude": {
      "command": "npx",
      "args": ["-y", "seoclaude"]
    }
  }
}
```

### 4. Optional: other services

Keys for non-Google services, and Google Ads settings, are read from environment variables or from `~/.config/seoclaude/config.json`:

```json
{
  "bingApiKey": "",
  "indexNowKey": "",
  "pagespeedApiKey": "",
  "googleAdsDeveloperToken": "",
  "googleAdsLoginCustomerId": "",
  "googleAdsCustomerId": "",
  "googleAdsApiVersion": ""
}
```

| Setting | Env var | Where to get it |
| --- | --- | --- |
| `bingApiKey` | `BING_API_KEY` | [Bing Webmaster Tools](https://www.bing.com/webmasters) → Settings → API access → API key |
| `indexNowKey` | `INDEXNOW_KEY` | Make one up (8–128 characters of `a-z A-Z 0-9 -`) and publish it on your site at `/<key>.txt`, containing only the key |
| `pagespeedApiKey` | `PAGESPEED_API_KEY` | Not needed: without it, PageSpeed calls use your Google sign-in. Set one only if you prefer a key |
| `googleAdsDeveloperToken` | `GOOGLE_ADS_DEVELOPER_TOKEN` | See below |
| `googleAdsLoginCustomerId` | `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Your manager account ID, e.g. `123-456-7890` |
| `googleAdsCustomerId` | `GOOGLE_ADS_CUSTOMER_ID` | The ad account tools use by default (`ads_list_accounts` lists them) |
| `googleAdsApiVersion` | `GOOGLE_ADS_API_VERSION` | Defaults to `v26`; set a newer one when Google sunsets it |

Restart the MCP server after changing these.

#### Google Ads

The `ads_*` tools need a **developer token** on top of OAuth:

1. Open or create a [Google Ads manager account](https://ads.google.com/home/tools/manager-accounts/) (free).
2. In the manager account, go to **Admin → API Center** and request a developer token. Higher access levels are needed for real data; apply from the same page if your token is limited to test accounts.
3. Put the token (and your manager account ID) in `config.json`.
4. Sign in again with Google Ads access: `npx seoclaude auth --ads`. Ads access is only requested when you ask for it, because Google's consent screen words it as managing your campaigns.

## Example questions

- "Which sites do I have?"
- "Top 20 queries on example.com in the last 28 days?"
- "When did search traffic drop, and which pages lost it?"
- "Find quick SEO wins."
- "Audit example.com's sitemap for technical SEO problems."
- "Summarize the index status of my 50 most-shown pages."
- "Is https://example.com/blog/x indexed? What canonical did Google pick?"
- "How much traffic do ChatGPT and other AI assistants send?"
- "Which pages show up in Google but don't get clicked, or get clicked and abandoned?"
- "Mobile Core Web Vitals for the home page?"
- "Resubmit the sitemap and send all its URLs to IndexNow."
- "Monthly search volume for these keywords in Turkey?"

## Notes

- Search Console data is finalized with a ~3 day delay; by default the last 28 finalized days are used. CTR is returned as a percentage.
- URL Inspection allows 2,000 inspections per property per day and 600 per minute; `bulk_inspect` counts against it.
- Search Console has no API for the **Request indexing** button.
- Google does not take part in IndexNow; for Google, sitemaps and Search Console are the route.
- `audit_page` and `audit_sitemap` fetch pages with a plain HTTP client and don't run JavaScript, so they see the server-rendered HTML.

## Development

```sh
git clone https://github.com/muhammeddilaver/seoclaude.git
cd seoclaude
npm install
npm run build
node dist/index.js auth
claude mcp add seoclaude -- node "$PWD/dist/index.js"
```

## License

MIT
