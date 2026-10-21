import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OAuth2Client, type Credentials } from "google-auth-library";

export const CONFIG_DIR = process.env.SEOCLAUDE_HOME ?? join(homedir(), ".config", "seoclaude");
const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials.json");
const TOKEN_PATH = join(CONFIG_DIR, "token.json");
const SCOPES = [
  // Full webmasters scope (not .readonly) so submit_sitemap can work.
  "https://www.googleapis.com/auth/webmasters",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/adsense.readonly",
  // PageSpeed Insights accepts OAuth with just openid; calls then use this project's quota, no API key needed.
  "openid",
];
// Asked for only on request (`auth --ads`): the consent screen words it as managing ad campaigns.
export const ADS_SCOPE = "https://www.googleapis.com/auth/adwords";

interface ClientSecrets {
  clientId: string;
  clientSecret: string;
}

// Client ID/secret come from env vars, or from the "Desktop app" JSON downloaded from Google Cloud Console.
async function loadClientSecrets(): Promise<ClientSecrets> {
  if (process.env.GSC_CLIENT_ID && process.env.GSC_CLIENT_SECRET) {
    return { clientId: process.env.GSC_CLIENT_ID, clientSecret: process.env.GSC_CLIENT_SECRET };
  }
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_PATH, "utf8");
  } catch {
    throw new Error(
      `OAuth client not configured. Set GSC_CLIENT_ID and GSC_CLIENT_SECRET, or save the Desktop app JSON to ${CREDENTIALS_PATH}.`,
    );
  }
  const json = JSON.parse(raw);
  const section = json.installed ?? json.web ?? json;
  if (!section.client_id || !section.client_secret) {
    throw new Error(`${CREDENTIALS_PATH} does not contain client_id/client_secret.`);
  }
  return { clientId: section.client_id, clientSecret: section.client_secret };
}

async function saveToken(token: Credentials): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await writeFile(TOKEN_PATH, JSON.stringify(token, null, 2), { mode: 0o600 });
}

async function loadToken(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(TOKEN_PATH, "utf8"));
  } catch {
    return null;
  }
}

/** Returns an authorized client, refreshing and persisting tokens as needed. */
export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const { clientId, clientSecret } = await loadClientSecrets();
  const token = await loadToken();
  if (!token?.refresh_token) {
    throw new Error("Not signed in to Google. Run `npx seoclaude auth` first.");
  }
  const client = new OAuth2Client({ clientId, clientSecret });
  client.setCredentials(token);
  client.on("tokens", (fresh) => {
    // Google only returns refresh_token on first consent, so keep the stored one.
    saveToken({ ...token, ...fresh, refresh_token: fresh.refresh_token ?? token.refresh_token }).catch(() => {});
  });
  return client;
}

/** Interactive loopback OAuth flow; opens a local port and waits for Google's redirect. */
export async function runAuthFlow(extraScopes: string[] = []): Promise<void> {
  const { clientId, clientSecret } = await loadClientSecrets();

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not open a local port.");
  const redirectUri = `http://127.0.0.1:${address.port}`;

  const client = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const authUrl = client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [...SCOPES, ...extraScopes] });

  console.log("Open this URL in your browser to sign in:\n\n" + authUrl + "\n");
  const { exec } = await import("node:child_process");
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${authUrl}"`);

  const code = await new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (!code && !error) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(error ? `<p>Sign-in failed: ${error}</p>` : "<p>seoclaude is connected. You can close this tab.</p>");
      server.close();
      if (error) reject(new Error(`Google sign-in failed: ${error}`));
      else resolve(code!);
    });
  });

  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error("Google did not return a refresh token. Remove seoclaude from your Google account permissions and retry.");
  }
  await saveToken(tokens);
  console.log(`Signed in. Token saved to ${TOKEN_PATH}`);
}
