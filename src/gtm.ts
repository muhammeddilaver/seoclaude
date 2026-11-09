import type { OAuth2Client } from "google-auth-library";

const BASE = "https://tagmanager.googleapis.com/tagmanager/v2";

interface Param {
  key?: string;
  value?: string;
  list?: Param[];
  map?: Param[];
}

interface Tag {
  tagId: string;
  name: string;
  type: string;
  paused?: boolean;
  firingTriggerId?: string[];
  blockingTriggerId?: string[];
  setupTag?: { tagName?: string }[];
  teardownTag?: { tagName?: string }[];
  parameter?: Param[];
  consentSettings?: { consentStatus?: string };
}

interface Trigger {
  triggerId: string;
  name: string;
  type: string;
}

interface Variable {
  variableId: string;
  name: string;
  type: string;
  parameter?: Param[];
}

interface ContainerVersion {
  containerVersionId?: string;
  name?: string;
  fingerprint?: string;
  container?: { name?: string; publicId?: string; domainName?: string[]; usageContext?: string[]; path?: string };
  tag?: Tag[];
  trigger?: Trigger[];
  variable?: Variable[];
}

interface ContainerInfo {
  path: string;
  name: string;
  publicId: string;
  usageContext?: string[];
  domainName?: string[];
}

export type Severity = "high" | "medium" | "low" | "info";
export interface Issue {
  severity: Severity;
  check: string;
  detail: string;
  items?: string[];
}

const paramValue = (params: Param[] | undefined, key: string) => params?.find((p) => p.key === key)?.value;

// Tag types that load GA4: the Google tag ("googtag") and the older GA4 configuration tag ("gaawc").
const GA4_CONFIG_TYPES = new Set(["googtag", "gaawc"]);

const HARDCODED_ANALYTICS: [RegExp, string][] = [
  [/\bUA-\d{4,}-\d+/, "Universal Analytics ID"],
  [/\bG-[A-Z0-9]{6,}\b/, "GA4 measurement ID"],
  [/googletagmanager\.com\/gtag\/js/, "gtag.js loader"],
  [/google-analytics\.com\/(analytics|ga)\.js/, "analytics.js/ga.js loader"],
];

export class GtmClient {
  constructor(private auth: OAuth2Client) {}

  private async call<T>(path: string): Promise<T> {
    try {
      return (await this.auth.request<T>({ url: `${BASE}/${path}` })).data;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 404) throw Object.assign(new Error("not found"), { notFound: true });
      const message = err?.response?.data?.error?.message ?? err?.message ?? String(err);
      if (/insufficient authentication scopes/i.test(message)) {
        throw new Error("Google Tag Manager access was not granted. Run `npx seoclaude auth` again to add it.");
      }
      if (/has not been used in project|is disabled/i.test(message)) {
        throw new Error("Enable the Tag Manager API for your Google Cloud project (APIs & Services → Library), then retry.");
      }
      throw new Error(`Google Tag Manager API error: ${message}`);
    }
  }

  private async paged<T>(path: string, key: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const data = await this.call<Record<string, any>>(`${path}${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`);
      out.push(...((data[key] as T[] | undefined) ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async listContainers(): Promise<(ContainerInfo & { account: string })[]> {
    const accounts = await this.paged<{ path: string; name: string }>("accounts", "account");
    const perAccount = await Promise.all(
      accounts.map(async (a) => {
        const containers = await this.paged<ContainerInfo>(`${a.path}/containers`, "container");
        return containers.map((c) => ({
          account: a.name,
          path: c.path,
          name: c.name,
          publicId: c.publicId,
          usageContext: c.usageContext,
          domainName: c.domainName,
        }));
      }),
    );
    return perAccount.flat();
  }

  /** Accepts "GTM-XXXXXX" or "accounts/123/containers/456". */
  private async resolvePath(container: string): Promise<string> {
    if (/^accounts\/\d+\/containers\/\d+$/.test(container)) return container;
    const wanted = container.trim().toUpperCase();
    const match = (await this.listContainers()).find((c) => c.publicId.toUpperCase() === wanted);
    if (!match) throw new Error(`No container ${container} among the ones this Google account can access. Try gtm_list_containers.`);
    return match.path;
  }

  async auditContainer(container: string) {
    const path = await this.resolvePath(container);
    let version: ContainerVersion;
    try {
      version = await this.call<ContainerVersion>(`${path}/versions:live`);
    } catch (err: any) {
      if (!err?.notFound) throw err;
      return {
        container: path,
        published: false,
        issues: [
          {
            severity: "high",
            check: "no-published-version",
            detail: "This container has never been published, so none of its tags run on the site.",
          } satisfies Issue,
        ],
      };
    }
    return { container: path, published: true, ...analyze(version) };
  }
}

export interface Stream {
  measurementId: string;
  property: string;
  propertyName?: string;
  stream?: string;
  uri?: string;
}

/** Compares the measurement IDs a container sends data to with the GA4 data streams the account owns. */
export function crossCheck(
  audit: { measurementIds?: Record<string, string[]>; htmlMeasurementIds?: Record<string, string[]>; issues: Issue[] },
  streams: Stream[],
  expectedProperty?: string,
) {
  const known = new Map(streams.map((s) => [s.measurementId, s]));
  const used = new Map<string, string[]>();
  for (const src of [audit.measurementIds, audit.htmlMeasurementIds]) {
    for (const [id, tags] of Object.entries(src ?? {})) {
      if (/^G-/.test(id)) used.set(id, [...(used.get(id) ?? []), ...tags]);
    }
  }
  const unknown = [...used].filter(([id]) => !known.has(id));
  if (unknown.length) {
    audit.issues.unshift({
      severity: "high",
      check: "measurement-id-not-in-ga",
      detail: "Tags send data to measurement IDs that belong to none of the GA4 properties this Google account can access (a typo, a leftover from another site, or a property you have no access to).",
      items: unknown.map(([id, tags]) => `${id}: ${[...new Set(tags)].join(", ")}`),
    });
  }
  if (expectedProperty) {
    const expected = expectedProperty.startsWith("properties/") ? expectedProperty : `properties/${expectedProperty}`;
    const foreign = [...used].filter(([id]) => known.has(id) && known.get(id)!.property !== expected);
    if (foreign.length) {
      audit.issues.unshift({
        severity: "high",
        check: "measurement-id-other-property",
        detail: `These measurement IDs belong to a GA4 property other than ${expected}.`,
        items: foreign.map(([id, tags]) => `${id} (${known.get(id)!.property} ${known.get(id)!.propertyName ?? ""}): ${[...new Set(tags)].join(", ")}`.replace(" )", ")")),
      });
    }
    if (![...used.keys()].some((id) => known.get(id)?.property === expected)) {
      audit.issues.unshift({
        severity: "high",
        check: "property-not-tracked",
        detail: `No tag in this container sends data to ${expected}, so it receives nothing from here.`,
      });
    }
  }
  return {
    checkedAgainst: expectedProperty ?? "all accessible GA4 properties",
    matched: [...used].filter(([id]) => known.has(id)).map(([id]) => ({ id, property: known.get(id)!.property, stream: known.get(id)!.stream, uri: known.get(id)!.uri })),
  };
}

function analyze(v: ContainerVersion) {
  const tags = v.tag ?? [];
  const triggers = v.trigger ?? [];
  const variables = v.variable ?? [];
  const issues: Issue[] = [];
  const names = (list: { name: string }[]) => list.map((x) => x.name);

  // Resolves "{{GA4 ID}}" to the constant variable's value when it is one.
  const constants = new Map(variables.filter((x) => x.type === "c").map((x) => [x.name, paramValue(x.parameter, "value")]));
  const resolve = (raw?: string) => {
    const ref = raw?.match(/^\{\{(.+)\}\}$/)?.[1];
    return ref ? (constants.get(ref) ?? raw) : raw;
  };

  // GA4 / Google tag measurement IDs, and duplicate configuration of the same ID.
  const byId = new Map<string, string[]>();
  for (const t of tags.filter((t) => GA4_CONFIG_TYPES.has(t.type))) {
    const id = resolve(paramValue(t.parameter, "measurementId") ?? paramValue(t.parameter, "tagId"));
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), t.paused ? `${t.name} (paused)` : t.name]);
  }
  const duplicates = [...byId].filter(([, ts]) => ts.filter((n) => !n.endsWith("(paused)")).length > 1);
  if (duplicates.length) {
    issues.push({
      severity: "high",
      check: "duplicate-config-tag",
      detail: "The same Google tag / GA4 configuration is set up more than once, which usually double-counts page views.",
      items: duplicates.map(([id, ts]) => `${id}: ${ts.join(", ")}`),
    });
  }
  if (!byId.size) {
    issues.push({
      severity: "info",
      check: "no-ga4-config",
      detail: "No Google tag / GA4 configuration tag found. GA4 may be installed outside GTM, or not at all.",
    });
  }

  const ua = tags.filter((t) => t.type === "ua");
  if (ua.length) {
    issues.push({
      severity: "medium",
      check: "universal-analytics-tag",
      detail: "Universal Analytics stopped processing data in July 2023; these tags collect nothing.",
      items: names(ua),
    });
  }

  // Analytics code pasted into Custom HTML tags next to the proper tags.
  const htmlIds = new Map<string, string[]>();
  const hardcoded = tags.flatMap((t) => {
    if (t.type !== "html") return [];
    const html = paramValue(t.parameter, "html") ?? "";
    for (const id of html.match(/\bG-[A-Z0-9]{6,}\b/g) ?? []) htmlIds.set(id, [...(htmlIds.get(id) ?? []), t.name]);
    const found = HARDCODED_ANALYTICS.filter(([re]) => re.test(html)).map(([, label]) => label);
    return found.length ? [`${t.name}: ${found.join(", ")}`] : [];
  });
  if (hardcoded.length) {
    issues.push({
      severity: "medium",
      check: "hardcoded-analytics",
      detail: "Custom HTML tags contain analytics IDs or loaders; they can double-count next to the Google tag.",
      items: hardcoded,
    });
  }

  const paused = tags.filter((t) => t.paused);
  if (paused.length) {
    issues.push({ severity: "low", check: "paused-tags", detail: "Paused tags never fire.", items: names(paused) });
  }

  // Tags that never fire: no firing trigger and not used as a setup/teardown tag of another tag.
  const sequenced = new Set(tags.flatMap((t) => [...(t.setupTag ?? []), ...(t.teardownTag ?? [])]).map((s) => s.tagName));
  const neverFire = tags.filter((t) => !t.paused && !t.firingTriggerId?.length && !sequenced.has(t.name));
  if (neverFire.length) {
    issues.push({
      severity: "medium",
      check: "tags-without-trigger",
      detail: "Active tags with no firing trigger never run.",
      items: names(neverFire),
    });
  }

  // Triggers no tag uses (as firing or blocking trigger, or inside a trigger group).
  const usedTriggers = new Set(tags.flatMap((t) => [...(t.firingTriggerId ?? []), ...(t.blockingTriggerId ?? [])]));
  const groups = JSON.stringify(triggers.filter((t) => t.type === "triggerGroup"));
  const unusedTriggers = triggers.filter((t) => !usedTriggers.has(t.triggerId) && !groups.includes(`"${t.triggerId}"`));
  if (unusedTriggers.length) {
    issues.push({ severity: "low", check: "unused-triggers", detail: "Triggers no tag uses.", items: names(unusedTriggers) });
  }

  const blob = JSON.stringify([tags, triggers, variables]);
  const unusedVariables = variables.filter((x) => !blob.includes(`{{${x.name}}}`));
  if (unusedVariables.length) {
    issues.push({ severity: "low", check: "unused-variables", detail: "User-defined variables nothing references.", items: names(unusedVariables) });
  }

  // Consent Mode: informational, since whether it is needed depends on the audience.
  const consent = { needed: 0, notNeeded: 0, notSet: 0 };
  for (const t of tags) {
    const s = t.consentSettings?.consentStatus;
    if (s === "needed") consent.needed++;
    else if (s === "notNeeded") consent.notNeeded++;
    else consent.notSet++;
  }
  if (tags.length && consent.needed === 0) {
    issues.push({
      severity: "info",
      check: "no-tag-consent-checks",
      detail: "No tag has additional consent checks. If you serve EEA/UK visitors, verify consent is handled via Consent Mode or a CMP.",
    });
  }

  const order: Severity[] = ["high", "medium", "low", "info"];
  issues.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  return {
    name: v.container?.name,
    publicId: v.container?.publicId,
    usageContext: v.container?.usageContext,
    domains: v.container?.domainName,
    liveVersion: { id: v.containerVersionId, name: v.name },
    counts: { tags: tags.length, triggers: triggers.length, variables: variables.length, paused: paused.length },
    tagTypes: Object.fromEntries(
      [...tags.reduce((m, t) => m.set(t.type, (m.get(t.type) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]),
    ),
    measurementIds: Object.fromEntries(byId),
    htmlMeasurementIds: Object.fromEntries(htmlIds),
    consent,
    note: "Audits the live (published) version; unpublished workspace changes are not included.",
    issues,
  };
}
