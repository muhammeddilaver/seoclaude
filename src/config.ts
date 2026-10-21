import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR } from "./auth.js";

const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface ApiKeys {
  bingApiKey?: string;
  indexNowKey?: string;
  pagespeedApiKey?: string;
  googleAdsDeveloperToken?: string;
  googleAdsLoginCustomerId?: string;
  googleAdsCustomerId?: string;
  googleAdsApiVersion?: string;
}

const ENV: Record<keyof ApiKeys, string> = {
  bingApiKey: "BING_API_KEY",
  indexNowKey: "INDEXNOW_KEY",
  pagespeedApiKey: "PAGESPEED_API_KEY",
  googleAdsDeveloperToken: "GOOGLE_ADS_DEVELOPER_TOKEN",
  googleAdsLoginCustomerId: "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
  googleAdsCustomerId: "GOOGLE_ADS_CUSTOMER_ID",
  googleAdsApiVersion: "GOOGLE_ADS_API_VERSION",
};

let cached: ApiKeys | undefined;

/** Keys for the non-Google services, from env vars first and then ~/.config/seoclaude/config.json. */
async function loadKeys(): Promise<ApiKeys> {
  if (cached) return cached;
  let file: ApiKeys = {};
  try {
    file = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
  } catch {
    // No config file is fine: every key is optional until a tool needs it.
  }
  const keys: ApiKeys = {};
  for (const [name, env] of Object.entries(ENV) as [keyof ApiKeys, string][]) {
    keys[name] = process.env[env] || file[name] || undefined;
  }
  return (cached = keys);
}

export async function optionalKey(name: keyof ApiKeys): Promise<string | undefined> {
  return (await loadKeys())[name];
}

export async function requireKey(name: keyof ApiKeys): Promise<string> {
  const key = await optionalKey(name);
  if (!key) throw new Error(`${ENV[name]} is not set. Set the env var or add "${name}" to ${CONFIG_PATH}.`);
  return key;
}
