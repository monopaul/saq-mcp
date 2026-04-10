import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SaqCredentials } from './types.js';

const CREDENTIALS_PATH = path.join(os.homedir(), '.saq-mcp', 'credentials.json');
const CATALOG_HOST = 'catalog-service.adobe.io';

const KNOWN_ENV_ID = '2ce24571-9db9-4786-84a9-5f129257ccbb';
const KNOWN_STORE_CODE = 'main_website_store';
const KNOWN_STORE_VIEW = 'en';
const KNOWN_WEBSITE_CODE = 'base';

export function loadCachedCredentials(): SaqCredentials | null {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
      const creds = JSON.parse(raw) as SaqCredentials;
      if (creds.apiKey && creds.environmentId) return creds;
    }
  } catch {}
  return null;
}

function saveCredentials(creds: SaqCredentials): void {
  const dir = path.dirname(CREDENTIALS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2));
}

export async function extractCredentials(): Promise<SaqCredentials> {
  const cached = loadCachedCredentials();
  if (cached) return cached;

  process.stderr.write('[saq-mcp] Extracting API credentials from saq.com (one-time setup)...\n');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let apiKey: string | null = null;

  page.on('request', (request) => {
    const url = request.url();
    if (url.includes(CATALOG_HOST)) {
      const headers = request.headers();
      const key = headers['x-api-key'] || headers['X-Api-Key'];
      if (key && !apiKey) {
        apiKey = key;
        process.stderr.write(`[saq-mcp] Found API key\n`);
      }
    }
  });

  try {
    await page.goto('https://www.saq.com/en/products/wine', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Trigger live search to force an API call
    await page.fill('input[type="search"], input[name="q"], #search', 'bordeaux').catch(() => {});
    await page.waitForTimeout(3000);

    if (!apiKey) {
      // Try scrolling to trigger more product loads
      await page.evaluate(() => window.scrollTo(0, 500));
      await page.waitForTimeout(3000);
    }
  } finally {
    await browser.close();
  }

  if (!apiKey) {
    throw new Error(
      'Could not extract SAQ API key. The site may have changed its auth mechanism.',
    );
  }

  const creds: SaqCredentials = {
    apiKey,
    environmentId: KNOWN_ENV_ID,
    storeCode: KNOWN_STORE_CODE,
    storeViewCode: KNOWN_STORE_VIEW,
    websiteCode: KNOWN_WEBSITE_CODE,
  };

  saveCredentials(creds);
  process.stderr.write('[saq-mcp] Credentials saved to cache.\n');
  return creds;
}
