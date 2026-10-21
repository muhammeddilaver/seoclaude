/**
 * Property checks for the JSON-LD types Google uses for rich results, following its structured data docs.
 * `required` keeps the type out of rich results when missing; `recommended` only weakens it.
 * `anyOf` lists alternatives of which at least one is required.
 */
interface TypeSpec {
  required?: string[];
  anyOf?: string[][];
  recommended?: string[];
}

const ARTICLE: TypeSpec = { recommended: ["headline", "image", "datePublished", "dateModified", "author"] };

const SPECS: Record<string, TypeSpec> = {
  Article: ARTICLE,
  NewsArticle: ARTICLE,
  BlogPosting: ARTICLE,
  BreadcrumbList: { required: ["itemListElement"] },
  FAQPage: { required: ["mainEntity"] },
  Question: { required: ["name", "acceptedAnswer"] },
  Answer: { required: ["text"] },
  Product: { required: ["name"], anyOf: [["offers", "review", "aggregateRating"]], recommended: ["image", "description"] },
  Offer: { anyOf: [["price", "priceSpecification"]], recommended: ["priceCurrency", "availability"] },
  AggregateRating: { required: ["ratingValue"], anyOf: [["ratingCount", "reviewCount"]] },
  Review: { required: ["author", "reviewRating"] },
  Organization: { recommended: ["name", "url", "logo"] },
  WebSite: { required: ["name", "url"] },
  LocalBusiness: { required: ["name", "address"], recommended: ["telephone", "openingHoursSpecification", "geo"] },
  Event: { required: ["name", "startDate", "location"], recommended: ["endDate", "image", "description"] },
  Recipe: { required: ["name", "image"], recommended: ["author", "datePublished", "recipeIngredient", "recipeInstructions"] },
  VideoObject: { required: ["name", "thumbnailUrl", "uploadDate"], recommended: ["description", "duration", "contentUrl"] },
  JobPosting: { required: ["title", "description", "datePosted", "hiringOrganization", "jobLocation"] },
  Course: { required: ["name", "description"], recommended: ["provider"] },
  SoftwareApplication: { required: ["name"], anyOf: [["aggregateRating", "review"]], recommended: ["offers", "applicationCategory"] },
  Book: { required: ["name", "author"] },
  ProfilePage: { required: ["mainEntity"] },
  QAPage: { required: ["mainEntity"] },
};

export interface SchemaFinding {
  type: string;
  missingRequired: string[];
  missingRecommended: string[];
}

const present = (node: any, prop: string) => {
  const v = node[prop];
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
};

function checkNode(node: any, type: string): SchemaFinding | undefined {
  const spec = SPECS[type];
  if (!spec) return;
  const missingRequired = (spec.required ?? []).filter((p) => !present(node, p));
  for (const group of spec.anyOf ?? []) {
    if (!group.some((p) => present(node, p))) missingRequired.push(group.join(" | "));
  }
  if (type === "BreadcrumbList") missingRequired.push(...breadcrumbIssues(node));
  const missingRecommended = (spec.recommended ?? []).filter((p) => !present(node, p));
  if (!missingRequired.length && !missingRecommended.length) return;
  return { type, missingRequired, missingRecommended };
}

/** Each ListItem needs position and name; every item but the last needs `item` (its URL). */
function breadcrumbIssues(node: any): string[] {
  const items = [node.itemListElement ?? []].flat();
  const out = new Set<string>();
  items.forEach((li: any, i: number) => {
    if (!li || typeof li !== "object") return;
    if (!present(li, "position")) out.add("itemListElement[].position");
    // name may sit on the ListItem or on its nested item object.
    if (!present(li, "name") && !(li.item && typeof li.item === "object" && present(li.item, "name"))) {
      out.add("itemListElement[].name");
    }
    if (i < items.length - 1 && !present(li, "item")) out.add("itemListElement[].item");
  });
  return [...out];
}

/**
 * Child properties Google validates as part of the parent's rich result. Other nested objects (an Organization
 * as author, a Book as `about`) are references, not rich results of their own, so they aren't checked.
 */
const CHILDREN: Record<string, string[]> = {
  FAQPage: ["mainEntity"],
  QAPage: ["mainEntity"],
  Question: ["acceptedAnswer", "suggestedAnswer"],
  Product: ["offers", "aggregateRating", "review"],
  SoftwareApplication: ["offers", "aggregateRating", "review"],
  Recipe: ["aggregateRating", "review", "video"],
  Course: ["aggregateRating", "review"],
  Book: ["aggregateRating", "review"],
  LocalBusiness: ["aggregateRating", "review"],
};

const typesOf = (node: any): string[] =>
  [node?.["@type"] ?? []].flat().filter((t): t is string => typeof t === "string").map((t) => t.replace(/^https?:\/\/schema\.org\//, ""));

/** Checks the top-level entities of each JSON-LD block (including @graph members) and their rich result children. */
export function validateJsonLd(roots: unknown[]): SchemaFinding[] {
  const findings: SchemaFinding[] = [];
  const check = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(check);
    if (!node || typeof node !== "object") return;
    for (const type of typesOf(node)) {
      const f = checkNode(node, type);
      if (f) findings.push(f);
      for (const prop of CHILDREN[type] ?? []) check(node[prop]);
    }
  };
  const top = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(top);
    if (!node || typeof node !== "object") return;
    if (node["@graph"]) top(node["@graph"]);
    check(node);
  };
  roots.forEach(top);
  return findings;
}
