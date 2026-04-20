/**
 * CellarTracker community data lookup for SAQ alert enrichment.
 *
 * Uses the xlquery.asp CSV export endpoint (same as the CT MCP) which is not
 * WAF-blocked, unlike api.asp. Downloads the user's Availability and List
 * tables once per run, parses them, and fuzzy-matches alert wines by name +
 * vintage to pull CT community scores and average prices.
 *
 * Credentials are stored in ~/.saq-mcp/cellartracker.json.
 * The parsed index is cached in memory for the process lifetime (one watcher run).
 *
 * Usage:
 *   const config = loadCtConfig();
 *   if (config) await enrichWithCellarTracker(events, config, log);
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_DIR        = path.join(os.homedir(), '.saq-mcp');
const CT_CONFIG_PATH  = path.join(DATA_DIR, 'cellartracker.json');
const FX_CACHE_PATH   = path.join(DATA_DIR, 'fx-cache.json');
const FX_CACHE_TTL_MS = 20 * 60 * 60 * 1000; // 20 hours
const FX_API          = 'https://api.frankfurter.app/latest?from=USD&to=CAD';
const CT_BASE         = 'https://www.cellartracker.com/xlquery.asp';

export interface CtConfig {
  username: string;
  password: string;
}

export interface CtWineInfo {
  ctScore?: number;      // CT community average (0–100)
  ctScoreCount?: number; // number of CT community ratings
  ctPrice?: number;      // CT community average price in USD
  ctUrl?: string;        // https://www.cellartracker.com/wine.asp?iWine=…
}

// ── Config I/O ────────────────────────────────────────────────────────────────

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

/**
 * Test credentials against xlquery.asp (not WAF-blocked).
 * Returns 'valid' | 'invalid' | 'unreachable'.
 * CT returns HTML (not CSV) when credentials are wrong, even with HTTP 200.
 */
export async function validateCtCredentials(
  username: string,
  password: string,
): Promise<'valid' | 'invalid' | 'unreachable'> {
  try {
    const params = new URLSearchParams({
      User: username, Password: password, Format: 'csv', Table: 'List', Location: '1',
    });
    const res = await fetch(`${CT_BASE}?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return 'unreachable';
    const text = await res.text();
    // CT returns HTML page when credentials are wrong
    if (text.trimStart().startsWith('<')) return 'invalid';
    return 'valid';
  } catch {
    return 'unreachable';
  }
}

// ── USD → CAD exchange rate ───────────────────────────────────────────────────

interface FxCache { rate: number; date: string; fetchedAt: number }

export async function getUsdCadRate(): Promise<number | null> {
  try {
    if (fs.existsSync(FX_CACHE_PATH)) {
      const cached = JSON.parse(fs.readFileSync(FX_CACHE_PATH, 'utf-8')) as FxCache;
      if (Date.now() - cached.fetchedAt < FX_CACHE_TTL_MS) return cached.rate;
    }
  } catch {}
  try {
    const res = await fetch(FX_API, { signal: AbortSignal.timeout(8_000) });
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

// ── CSV parsing ───────────────────────────────────────────────────────────────

/** Parse a CT CSV export into an array of header→value objects. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  // Simple CSV parser — handles double-quoted fields with embedded commas/quotes
  function splitLine(line: string): string[] {
    const fields: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (c === ',' && !inQuote) {
        fields.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields;
  }

  const headers = splitLine(lines[0]);
  return lines.slice(1).map((line) => {
    const vals = splitLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

// ── Name matching ─────────────────────────────────────────────────────────────

function normalizeName(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(château|chateau|domaine|clos|maison|domaines)\b/gi, '')
    .replace(/['']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

function similarity(a: string, b: string): number {
  const wa = new Set(normalizeName(a).split(/\s+/).filter((w) => w.length > 2));
  const wb = new Set(normalizeName(b).split(/\s+/).filter((w) => w.length > 2));
  if (!wa.size || !wb.size) return 0;
  const intersection = [...wa].filter((w) => wb.has(w)).length;
  return intersection / (wa.size + wb.size - intersection);
}

// ── CT index (built once per process run) ─────────────────────────────────────

interface CtIndexEntry {
  iWine: string;
  name: string;
  vintage: string;
  ctScore?: number;
  ctScoreCount?: number;
  ctPrice?: number;  // community avg price (USD)
}

let ctIndex: CtIndexEntry[] | null = null;

async function buildCtIndex(config: CtConfig, log: (msg: string) => void): Promise<CtIndexEntry[]> {
  if (ctIndex) return ctIndex;

  log('  [CT] Downloading cellar data from CellarTracker...');

  // Fetch Availability (has CScore, CNotes) and List (has CTValue) in parallel
  const [availText, listText] = await Promise.all([
    fetchTable(config, { Table: 'Availability' }),
    fetchTable(config, { Table: 'List', Location: '1' }),
  ]);

  const availRows = parseCsv(availText);
  const listRows  = parseCsv(listText);

  // Build a map from iWine → CTValue (community avg price in USD)
  const priceByIWine = new Map<string, number>();
  for (const row of listRows) {
    const iWine = row['iWine'];
    const val   = parseFloat(row['CTValue'] ?? '');
    if (iWine && !isNaN(val) && val > 0) priceByIWine.set(iWine, val);
  }

  ctIndex = availRows
    .map((row): CtIndexEntry => {
      const iWine        = row['iWine'] ?? '';
      const ctScore      = parseFloat(row['CScore'] ?? '') || undefined;
      const ctScoreCount = parseInt(row['CNotes'] ?? '', 10) || undefined;
      const ctPrice      = priceByIWine.get(iWine);
      return {
        iWine,
        name:    row['Wine'] ?? '',
        vintage: row['Vintage'] ?? '',
        ctScore,
        ctScoreCount,
        ctPrice,
      };
    })
    .filter((e) => e.name);

  log(`  [CT] Index built: ${ctIndex.length} wines from your CellarTracker cellar`);
  return ctIndex;
}

async function fetchTable(config: CtConfig, extra: Record<string, string>): Promise<string> {
  const params = new URLSearchParams({
    User: config.username, Password: config.password, Format: 'csv', ...extra,
  });
  const res = await fetch(`${CT_BASE}?${params}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`CT xlquery HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  // CT exports use windows-1252 encoding
  try {
    return new TextDecoder('windows-1252').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

// ── Public enrichment API ─────────────────────────────────────────────────────

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
 * Downloads the user's full cellar data once (cached for the process lifetime).
 */
export async function enrichWithCellarTracker(
  events: EnrichableEvent[],
  config: CtConfig,
  log: (msg: string) => void,
): Promise<void> {
  if (!events.length) return;

  let index: CtIndexEntry[];
  try {
    index = await buildCtIndex(config, log);
  } catch (err) {
    log(`  [CT] Failed to build index: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (!index.length) {
    log('  [CT] No wines in CellarTracker cellar — skipping enrichment');
    return;
  }

  let found = 0;
  for (const event of events) {
    // Score each cellar entry by name similarity + vintage bonus
    let bestScore = 0;
    let bestEntry: CtIndexEntry | null = null;

    for (const entry of index) {
      const nameSim = similarity(event.name, entry.name);
      const vintageBonus = event.vintage && entry.vintage === event.vintage ? 0.15 : 0;
      const score = nameSim + vintageBonus;
      if (score > bestScore) { bestScore = score; bestEntry = entry; }
    }

    if (bestEntry && bestScore >= 0.25) {
      if (bestEntry.ctScore)      event.ctScore      = bestEntry.ctScore;
      if (bestEntry.ctScoreCount) event.ctScoreCount = bestEntry.ctScoreCount;
      if (bestEntry.ctPrice)      event.ctPrice      = bestEntry.ctPrice;
      if (bestEntry.iWine)        event.ctUrl        = `https://www.cellartracker.com/wine.asp?iWine=${bestEntry.iWine}`;
      if (bestEntry.ctScore) found++;
    }
  }

  log(`  [CT] Matched ${found}/${events.length} products to your CellarTracker cellar`);
}
