/**
 * CellarTracker community data lookup for SAQ alert enrichment.
 *
 * Credentials are stored in ~/.saq-mcp/cellartracker.json (username + password).
 * Results are cached for 7 days in ~/.saq-mcp/ct-cache.json.
 *
 * Usage:
 *   const config = loadCtConfig();
 *   if (config) await enrichWithCellarTracker(events, config, log);
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_DIR         = path.join(os.homedir(), '.saq-mcp');
const CT_CONFIG_PATH   = path.join(DATA_DIR, 'cellartracker.json');
const CT_CACHE_PATH    = path.join(DATA_DIR, 'ct-cache.json');
const FX_CACHE_PATH    = path.join(DATA_DIR, 'fx-cache.json');
const CT_CACHE_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const FX_CACHE_TTL_MS  = 20 * 60 * 60 * 1000;     // 20 hours (rate refreshes once per trading day)
const CT_API           = 'https://www.cellartracker.com/api.asp';
const FX_API           = 'https://api.frankfurter.app/latest?from=USD&to=CAD';
const CT_REQUEST_DELAY = 300; // ms between API calls — be polite

export interface CtConfig {
  username: string;
  password: string;
}

export interface CtWineInfo {
  ctScore?: number;      // CellarTracker community average (0–100)
  ctScoreCount?: number; // number of CT community ratings
  ctPrice?: number;      // community average price in USD
  ctUrl?: string;        // https://www.cellartracker.com/wine.asp?iWine=…
}

type CtCache = Record<string, { info: CtWineInfo; cachedAt: number }>;

// ── Config & cache I/O ───────────────────────────────────────────────────────

export function loadCtConfig(): CtConfig | null {
  try {
    if (fs.existsSync(CT_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CT_CONFIG_PATH, 'utf-8')) as CtConfig;
      if (raw.username && raw.password) return raw;
    }
  } catch {}
  return null;
}

export function saveCtConfig(config: CtConfig): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CT_CONFIG_PATH, JSON.stringify(config, null, 2));
}

/** Test credentials against the CT API. Returns true if valid. */
export async function validateCtCredentials(username: string, password: string): Promise<boolean> {
  try {
    const params = new URLSearchParams({ q: 'GetWines', u: username, p: password, format: 'json', rows: '1' });
    const res = await fetch(`${CT_API}?${params}`, {
      headers: { 'User-Agent': 'saq-mcp/1.0' },
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function loadCache(): CtCache {
  try {
    if (fs.existsSync(CT_CACHE_PATH)) {
      return JSON.parse(fs.readFileSync(CT_CACHE_PATH, 'utf-8')) as CtCache;
    }
  } catch {}
  return {};
}

function saveCache(cache: CtCache): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CT_CACHE_PATH, JSON.stringify(cache));
}

function cacheKey(name: string, vintage?: string): string {
  return `${name.toLowerCase()}::${vintage ?? ''}`;
}

// ── Name matching ─────────────────────────────────────────────────────────────

/** Strip diacritics, common prefixes, punctuation — produce a normalized search term. */
function normalizeName(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // remove accents
    .replace(/\b(château|chateau|domaine|clos|maison|domaines)\b/gi, '')
    .replace(/['']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** Word-overlap Jaccard similarity (0–1). */
function similarity(a: string, b: string): number {
  const wa = new Set(normalizeName(a).toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wb = new Set(normalizeName(b).toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  return intersection / (wa.size + wb.size - intersection);
}

// ── CellarTracker API ────────────────────────────────────────────────────────

/**
 * CT API response shape for q=GetWines.
 * CT returns JSON as an array of wine objects; field names vary by version.
 */
interface CtApiWine {
  iWine?: string | number;
  Wine?: string;
  WineName?: string;
  Vintage?: string | number;
  // Community score — CT uses "CT" for their own community average
  CT?: string | number;
  community_score?: string | number;
  CommunityScore?: string | number;
  // Number of community tasting notes
  CNotes?: string | number;
  community_notes?: string | number;
  // Average community price (what members paid, USD)
  Valuation?: string | number;
  AvgPrice?: string | number;
  avg_price?: string | number;
}

async function fetchCtInfo(config: CtConfig, name: string, vintage?: string): Promise<CtWineInfo | null> {
  const searchTerm = normalizeName(name) + (vintage ? ` ${vintage}` : '');

  const params = new URLSearchParams({
    q: 'GetWines',
    u: config.username,
    p: config.password,
    format: 'json',
    wine: searchTerm,
    rows: '8',
  });
  if (vintage) params.set('vintage', vintage);

  let wines: CtApiWine[];
  try {
    const res = await fetch(`${CT_API}?${params}`, {
      headers: { 'User-Agent': 'saq-mcp/1.0' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const json = JSON.parse(text) as CtApiWine[] | { wines?: CtApiWine[]; data?: CtApiWine[] };
    wines = Array.isArray(json) ? json : (json.wines ?? json.data ?? []);
  } catch {
    return null;
  }

  if (!wines.length) return null;

  // Pick the best match by wine-name similarity + vintage match bonus
  const candidates = wines.map((w) => {
    const ctName = String(w.Wine ?? w.WineName ?? '');
    const ctVintage = String(w.Vintage ?? '');
    const nameSim = similarity(name, ctName);
    const vintageBonuus = vintage && ctVintage === vintage ? 0.15 : 0;
    return { w, score: nameSim + vintageBonuus };
  });

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.25) return null; // no reasonable match

  const w = best.w;
  const iWine = Number(w.iWine) || undefined;

  const ctScore = Number(w.CT ?? w.community_score ?? w.CommunityScore ?? 0) || undefined;
  const ctScoreCount = Number(w.CNotes ?? w.community_notes ?? 0) || undefined;
  const ctPrice = Number(w.AvgPrice ?? w.avg_price ?? w.Valuation ?? 0) || undefined;

  return {
    ctScore,
    ctScoreCount,
    ctPrice,
    ctUrl: iWine ? `https://www.cellartracker.com/wine.asp?iWine=${iWine}` : undefined,
  };
}

// ── USD → CAD exchange rate ───────────────────────────────────────────────────

interface FxCache {
  rate: number;    // USD → CAD multiplier
  date: string;    // rate date from the API (YYYY-MM-DD, i.e. previous trading day)
  fetchedAt: number;
}

/**
 * Fetch the most recent USD → CAD exchange rate from frankfurter.app (ECB data,
 * free, no auth). Result is cached for 20 hours so repeat runs within the day
 * make no network request. Returns null on any error.
 */
export async function getUsdCadRate(): Promise<number | null> {
  // Try cache first
  try {
    if (fs.existsSync(FX_CACHE_PATH)) {
      const cached = JSON.parse(fs.readFileSync(FX_CACHE_PATH, 'utf-8')) as FxCache;
      if (Date.now() - cached.fetchedAt < FX_CACHE_TTL_MS) return cached.rate;
    }
  } catch {}

  try {
    const res = await fetch(FX_API, {
      headers: { 'User-Agent': 'saq-mcp/1.0' },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = await res.json() as { rates?: { CAD?: number }; date?: string };
    const rate = json.rates?.CAD;
    if (!rate) return null;
    const cache: FxCache = { rate, date: json.date ?? '', fetchedAt: Date.now() };
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FX_CACHE_PATH, JSON.stringify(cache));
    return rate;
  } catch {
    return null;
  }
}

// ── Public enrichment API ────────────────────────────────────────────────────

export type EnrichableEvent = {
  name: string;
  vintage?: string;
  ctScore?: number;
  ctScoreCount?: number;
  ctPrice?: number;
  ctUrl?: string;
};

/**
 * Look up CellarTracker community score + price for each event.
 * Mutates events in place; skips gracefully on any error.
 * Only called for products that triggered alerts (usually < 20 per run).
 */
export async function enrichWithCellarTracker(
  events: EnrichableEvent[],
  config: CtConfig,
  log: (msg: string) => void,
): Promise<void> {
  if (!events.length) return;

  const cache = loadCache();
  let cacheUpdated = false;
  let found = 0;

  log(`  [CT] Looking up ${events.length} product(s) on CellarTracker...`);

  for (const event of events) {
    const key = cacheKey(event.name, event.vintage);
    const cached = cache[key];

    // Use cache if fresh
    if (cached && Date.now() - cached.cachedAt < CT_CACHE_TTL_MS) {
      Object.assign(event, cached.info);
      if (cached.info.ctScore) found++;
      continue;
    }

    try {
      const info = await fetchCtInfo(config, event.name, event.vintage);
      const entry: CtWineInfo = info ?? {};
      Object.assign(event, entry);
      cache[key] = { info: entry, cachedAt: Date.now() };
      cacheUpdated = true;
      if (info?.ctScore) found++;
      // Polite delay between API calls
      await new Promise<void>((r) => setTimeout(r, CT_REQUEST_DELAY));
    } catch {
      // Non-fatal — just skip CT enrichment for this wine
    }
  }

  if (cacheUpdated) saveCache(cache);
  log(`  [CT] Found community data for ${found}/${events.length} products`);
}
