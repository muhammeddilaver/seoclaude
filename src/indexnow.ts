const ENDPOINT = "https://api.indexnow.org/indexnow";
const BATCH = 10_000; // IndexNow accepts at most 10,000 URLs per request

const STATUS: Record<number, string> = {
  200: "OK: URLs received",
  202: "Accepted: key validation pending",
  400: "Bad request: invalid format",
  403: "Forbidden: key not valid (key file missing or content does not match)",
  422: "Unprocessable: URLs do not belong to the host, or key does not match the schema",
  429: "Too many requests: slow down",
};

/**
 * Submits URLs to IndexNow (Bing, Yandex, Seznam, Naver and others share submissions).
 * Google does not take part in IndexNow.
 */
export async function submitIndexNow(urls: string[], key: string, keyLocation?: string) {
  if (!urls.length) throw new Error("No URLs to submit.");
  const hosts = new Set(urls.map((u) => new URL(u).host));
  if (hosts.size > 1) throw new Error(`All URLs must share one host; got ${[...hosts].join(", ")}.`);
  const [host] = hosts;
  const origin = new URL(urls[0]).origin;
  const location = keyLocation ?? `${origin}/${key}.txt`;

  // The engines fetch the key file to verify ownership; check it first so a bad setup fails clearly.
  const keyFile = await fetch(location, { signal: AbortSignal.timeout(15_000) }).catch((err) => {
    throw new Error(`Could not fetch key file ${location}: ${err instanceof Error ? err.message : err}`);
  });
  if (keyFile.status !== 200 || (await keyFile.text()).trim() !== key) {
    throw new Error(`${location} must answer 200 with exactly the key as its body (got status ${keyFile.status}).`);
  }

  const batches = [];
  for (let i = 0; i < urls.length; i += BATCH) {
    const urlList = urls.slice(i, i + BATCH);
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ host, key, keyLocation: location, urlList }),
      signal: AbortSignal.timeout(60_000),
    });
    batches.push({ urls: urlList.length, status: res.status, meaning: STATUS[res.status] ?? (await res.text()).slice(0, 200) });
  }
  return { host, keyLocation: location, submitted: urls.length, batches };
}
