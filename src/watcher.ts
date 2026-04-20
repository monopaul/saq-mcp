/**
 * SAQ Restock Watcher
 *
 * Runs in two modes:
 *   - Individual: checks only explicitly watched SKUs (full store-ID diff)
 *   - Catalog:    scans the full SAQ catalog daily, diffs store counts
 *
 * In both modes, a location filter (if set) restricts alerts to stores
 * within the configured radius.
 *
 * Usage:
 *   node dist/watcher.js               # one-shot check + exit
 *   node dist/watcher.js --notify      # same + macOS notifications
 *   node dist/watcher.js --loop 86400  # run on an interval (seconds)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as nodemailer from 'nodemailer';
import { extractCredentials } from './credentials.js';
import { SaqClient } from './saq-client.js';
import { loadCtConfig, enrichWithCellarTracker } from './cellartracker.js';
import { getStoreDirectory, getLocalStoreIds } from './stores.js';
import type { ProductCategory } from './types.js';
import {
  loadWatchlist,
  saveWatchlist,
  loadCatalogSnapshot,
  saveCatalogSnapshot,
  detectRestock,
  detectRestockFromCatalog,
  detectNewArrival,
  filterKey,
  type CatalogSnapshot,
  type RestockEvent,
} from './watchlist.js';

const LOG_PATH = path.join(os.homedir(), '.saq-mcp', 'restock.log');

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout.write(line + '\n');
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
}

function sendNotification(title: string, body: string): void {
  try {
    execSync(
      `osascript -e 'display notification "${body.replace(/['"]/g, ' ')}" with title "${title.replace(/['"]/g, ' ')}" sound name "Ping"'`,
      { stdio: 'ignore' },
    );
  } catch {}
}

// ── Email categorization ──────────────────────────────────────────────────────

type EmailCategory =
  | 'veryHighValue'
  | 'sparklingAndChampagne'
  | 'redWine'
  | 'whiteWine'
  | 'roseWine'
  | 'otherWine'
  | 'spirits'
  | 'beerAndCider'
  | 'misc';

const EMAIL_CATEGORIES: Array<{ key: EmailCategory; emoji: string; label: string }> = [
  { key: 'veryHighValue',         emoji: '💎', label: 'Very High Value (>$600)'      },
  { key: 'sparklingAndChampagne', emoji: '🥂', label: 'Sparkling Wine & Champagne'   },
  { key: 'redWine',               emoji: '🍷', label: 'Red Wine'                     },
  { key: 'whiteWine',             emoji: '🍾', label: 'White Wine'                   },
  { key: 'roseWine',              emoji: '🌹', label: 'Rosé Wine'                    },
  { key: 'otherWine',             emoji: '🍇', label: 'Other Wine'                   },
  { key: 'spirits',               emoji: '🥃', label: 'Spirits'                      },
  { key: 'beerAndCider',          emoji: '🍺', label: 'Beer & Cider'                 },
  { key: 'misc',                  emoji: '📦', label: 'Misc'                         },
];

/**
 * Assign an email category based on price (checked first) then the product URL.
 * SAQ URLs embed the category path, e.g. /en/products/wine/red-wine/... or
 * /en/products/champagne-and-sparkling-wine/champagne/...
 * Very High Value is mutually exclusive — products >$600 don't repeat in wine sections.
 */
function categorizeEvent(r: RestockEvent): EmailCategory {
  if (r.price > 600) return 'veryHighValue';
  const url = r.url.toLowerCase();
  if (url.includes('/champagne-and-sparkling-wine/') || url.includes('/wine/sparkling-wine/')) {
    return 'sparklingAndChampagne';
  }
  if (url.includes('/wine/red-wine/'))   return 'redWine';
  if (url.includes('/wine/white-wine/')) return 'whiteWine';
  if (url.includes('/wine/rose'))        return 'roseWine';
  if (
    url.includes('/wine/') ||
    url.includes('/dessert-wine/') ||
    url.includes('/port-and-fortified-wine/') ||
    url.includes('/sake/') ||
    url.includes('/aperitif/')
  ) return 'otherWine';
  if (url.includes('/spirit/')) return 'spirits';
  if (url.includes('/beer/') || url.includes('/cider/')) return 'beerAndCider';
  return 'misc';
}

// Accent colour per category — used for section header background and card left border
const CATEGORY_ACCENT: Record<EmailCategory, string> = {
  veryHighValue:         '#9A7D0A',  // dark gold
  sparklingAndChampagne: '#6C3483',  // grape purple
  redWine:               '#7B1B1B',  // deep burgundy
  whiteWine:             '#7D6608',  // amber-gold
  roseWine:              '#B03A6A',  // raspberry
  otherWine:             '#5D4037',  // earthy brown
  spirits:               '#37474F',  // slate
  beerAndCider:          '#9A6B00',  // amber
  misc:                  '#546E7A',  // blue-grey
};

/** Render a coloured availability pill. */
function availBadge(avail: string): string {
  let bg: string; let fg: string; let text: string;
  if (avail.includes('Online') && avail.includes('In store')) {
    bg = '#E8F5E9'; fg = '#1B5E20'; text = 'Online &amp; In store';
  } else if (avail.includes('In store')) {
    bg = '#E8F5E9'; fg = '#1B5E20'; text = 'In store';
  } else if (avail.includes('Online')) {
    bg = '#E3F2FD'; fg = '#0D47A1'; text = 'Online';
  } else if (avail.includes('shortly')) {
    bg = '#FFF3E0'; fg = '#E65100'; text = 'Coming soon';
  } else if (avail.includes('lottery') || avail.includes('Lottery')) {
    bg = '#EDE7F6'; fg = '#4A148C'; text = 'Lottery';
  } else {
    bg = '#F5F5F5'; fg = '#757575'; text = avail.split(',')[0];
  }
  return `<span style="display:inline-block;background:${bg};color:${fg};font-size:10px;font-weight:700;` +
         `padding:3px 8px;border-radius:4px;letter-spacing:0.3px;white-space:nowrap">${text}</span>`;
}

/** Render CellarTracker community score as a badge. Returns '' if no score. */
function ctScoreHtml(score: number | undefined, count: number | undefined, ctUrl: string | undefined): string {
  if (!score) return '';
  // CT scores are 0–100; colour by tier
  const color = score >= 93 ? '#7B1B1B' : score >= 88 ? '#9A6B00' : '#555';
  const cnt   = count ? ` · ${count.toLocaleString()} notes` : '';
  const inner = `<span style="font-weight:800;font-size:13px;color:${color}">CT ${score}</span>` +
                `<span style="font-size:11px;color:#888">/100${cnt}</span>`;
  return ctUrl
    ? `<a href="${ctUrl}" style="text-decoration:none">${inner}</a>`
    : inner;
}

/** Render CellarTracker average community price. Returns '' if unavailable. */
function ctPriceHtml(price: number | undefined): string {
  if (!price) return '';
  return `<span style="font-size:11px;color:#888">CT avg <strong style="color:#555">$${price.toFixed(0)} USD</strong></span>`;
}

/** Render one product card as a table row. */
function renderCard(r: RestockEvent, accent: string, geoLabel: string): string {
  // ── Tag pill ────────────────────────────────────────────────────────────────
  const tagBg   = r.isNewArrival ? '#4A235A' : '#1A5C38';
  const tagText = r.isNewArrival ? 'NEW ARRIVAL' : 'NOW AVAILABLE';
  const tag = `<span style="background:${tagBg};color:#fff;font-size:9px;font-weight:800;` +
              `padding:2px 7px;border-radius:3px;letter-spacing:0.8px">${tagText}</span>`;

  // ── Name + vintage ──────────────────────────────────────────────────────────
  const nameYear = r.vintage ? `${r.name} <span style="color:#888;font-weight:400">${r.vintage}</span>` : r.name;
  const nameHtml = `<a href="${r.url}" style="color:#7B1B1B;text-decoration:none;font-size:14px;font-weight:700">${nameYear}</a>`;

  // ── Metadata line 1: producer · region · country ───────────────────────────
  const meta1Parts = [r.producer, r.region, r.country].filter(Boolean);
  const meta1 = meta1Parts.length
    ? `<div style="color:#7A6A6A;font-size:12px;margin-top:3px">${meta1Parts.join(' &nbsp;·&nbsp; ')}</div>`
    : '';

  // ── Metadata line 2: grape · format ────────────────────────────────────────
  const meta2Parts: string[] = [];
  if (r.grape)  meta2Parts.push(r.grape);
  if (r.format) meta2Parts.push(r.format);
  const meta2 = meta2Parts.length
    ? `<div style="color:#999;font-size:11px;margin-top:2px">${meta2Parts.join(' &nbsp;·&nbsp; ')}</div>`
    : '';

  // ── CellarTracker score + community price ───────────────────────────────────
  const ctScore = ctScoreHtml(r.ctScore, r.ctScoreCount, r.ctUrl);
  const ctPrice = ctPriceHtml(r.ctPrice);
  const ctLine  = [ctScore, ctPrice].filter(Boolean).join(' &nbsp;&nbsp; ');
  const ctHtml  = ctLine
    ? `<div style="margin-top:4px">${ctLine}</div>`
    : '';

  // ── Price ───────────────────────────────────────────────────────────────────
  const price = `<div style="font-size:22px;font-weight:800;color:#7B1B1B;line-height:1.1">$${r.price.toFixed(2)}</div>`;

  // ── Store count ─────────────────────────────────────────────────────────────
  const storeStr = r.currentStoreCount > 0
    ? `${r.currentStoreCount} store${r.currentStoreCount !== 1 ? 's' : ''}${geoLabel}`
    : 'Online only';
  const stores = `<div style="font-size:11px;color:#888;margin-top:4px">${storeStr}</div>`;

  // ── Link ────────────────────────────────────────────────────────────────────
  const link = `<a href="${r.url}" style="font-size:11px;color:#7B1B1B;text-decoration:none">→ View on SAQ.com</a>`;

  return `<tr>
  <td style="border-left:4px solid ${accent};background:#fff;padding:12px 16px 8px;border-bottom:1px solid #F0E8E8">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="vertical-align:top;padding-right:12px">
          <div style="margin-bottom:5px">${tag}</div>
          <div style="margin-bottom:2px">${nameHtml}</div>
          ${meta1}${meta2}${ctHtml}
          <div style="margin-top:7px">${link}</div>
        </td>
        <td width="130" style="vertical-align:top;text-align:right;white-space:nowrap">
          ${price}${stores}
          <div style="margin-top:6px">${availBadge(r.currentAvailability)}</div>
        </td>
      </tr>
    </table>
  </td>
</tr>`;
}

function buildEmailHtml(items: RestockEvent[], geoLabel: string): string {
  const total = items.length;
  const date  = new Date().toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Group by category, preserving EMAIL_CATEGORIES order
  const grouped = new Map<EmailCategory, RestockEvent[]>(
    EMAIL_CATEGORIES.map(({ key }) => [key, []]),
  );
  for (const item of items) grouped.get(categorizeEvent(item))!.push(item);

  // Summary pills for the header bar
  const pillHtml = EMAIL_CATEGORIES
    .filter(({ key }) => (grouped.get(key)?.length ?? 0) > 0)
    .map(({ key, emoji, label }) => {
      const acc = CATEGORY_ACCENT[key];
      const shortLabel = label.replace(/\s*\(.*?\)/, '');
      return `<span style="display:inline-block;background:${acc};color:#fff;` +
             `font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;` +
             `margin:3px 4px 3px 0;white-space:nowrap">` +
             `${emoji} ${shortLabel} (${grouped.get(key)!.length})</span>`;
    }).join('');

  // One section per non-empty category
  const sectionsHtml = EMAIL_CATEGORIES
    .filter(({ key }) => (grouped.get(key)?.length ?? 0) > 0)
    .map(({ key, emoji, label }) => {
      const acc   = CATEGORY_ACCENT[key];
      const group = grouped.get(key)!.sort((a, b) => b.price - a.price);
      const cards = group.map((r) => renderCard(r, acc, geoLabel)).join('\n');

      return `
<!-- ${label} -->
<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:24px;border-radius:6px;overflow:hidden;border:1px solid #E8D5D5">
  <tr>
    <td style="background:${acc};padding:9px 16px;color:#fff;font-size:14px;font-weight:700">
      ${emoji}&nbsp; ${label} <span style="opacity:0.75;font-weight:400">(${group.length})</span>
    </td>
  </tr>
  <tr><td style="padding:0">
    <table width="100%" cellpadding="0" cellspacing="0">${cards}</table>
  </td></tr>
</table>`;
    }).join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:16px;background:#F8F0F0">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:0 auto">

  <!-- Header -->
  <tr><td style="background:#7B1B1B;border-radius:8px 8px 0 0;padding:20px 24px">
    <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-0.5px">🍷 SAQ Alert</div>
    <div style="color:rgba(255,255,255,0.8);font-size:13px;margin-top:4px">
      ${total} product${total !== 1 ? 's' : ''} now available &nbsp;·&nbsp; ${date}
    </div>
  </td></tr>

  <!-- Category summary bar -->
  <tr><td style="background:#F5ECEA;border:1px solid #E8D5D5;border-top:none;padding:10px 16px">
    ${pillHtml}
  </td></tr>

  <!-- Sections -->
  <tr><td style="padding:4px 0 24px">${sectionsHtml}</td></tr>

  <!-- Footer -->
  <tr><td style="text-align:center;padding:8px;color:#bbb;font-size:11px;font-family:sans-serif">
    SAQ MCP &nbsp;·&nbsp; watch-all mode
  </td></tr>

</table>
</body></html>`;
}

// ── Email notifications ───────────────────────────────────────────────────────

interface EmailConfig {
  to: string;
  from: string;
  smtp: { host: string; port: number; user: string; pass: string };
}

const EMAIL_CONFIG_PATH = path.join(os.homedir(), '.saq-mcp', 'email.json');

function loadEmailConfig(): EmailConfig | null {
  try {
    if (fs.existsSync(EMAIL_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(EMAIL_CONFIG_PATH, 'utf-8')) as EmailConfig;
    }
  } catch {}
  return null;
}

async function sendEmail(subject: string, html: string): Promise<void> {
  const cfg = loadEmailConfig();
  if (!cfg) return;
  try {
    const transporter = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.port === 465,
      auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
    });
    await transporter.sendMail({ from: cfg.from, to: cfg.to, subject, html });
    log(`  [email] Sent: ${subject}`);
  } catch (err) {
    log(`  [email] Failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function printRestock(r: RestockEvent, geoLabel?: string): void {
  const scope = geoLabel ? ` [within ${geoLabel}]` : '';
  const tag = r.isNewArrival ? '[NEW ARRIVAL]' : '[NOW AVAILABLE]';
  const storeInfo = r.isNewArrival
    ? `${r.currentStoreCount} store${r.currentStoreCount !== 1 ? 's' : ''}${scope} · ${r.currentAvailability}`
    : r.newStoreIds.length > 0
      ? `${r.previousStoreCount} → ${r.currentStoreCount} local stores (+${r.newStoreIds.length} new)${scope}`
      : `${r.previousStoreCount} → ${r.currentStoreCount} stores${scope}`;
  process.stdout.write(
    [
      `  ${tag} ${r.name} (${r.sku})`,
      `    $${r.price.toFixed(2)} · ${storeInfo}`,
      ...(r.isNewArrival ? [] : [`    ${r.previousAvailability} → ${r.currentAvailability}`]),
      `    ${r.url}`,
    ].join('\n') + '\n',
  );
}

// ── Individual SKU check ──────────────────────────────────────────────────────

async function checkIndividual(
  client: SaqClient,
  notify: boolean,
  localStoreIds: Set<string> | null,
): Promise<RestockEvent[]> {
  const wl = loadWatchlist();
  const skus = Object.keys(wl.products);
  if (skus.length === 0) return [];

  const geoLabel = wl.locationFilter?.label;
  log(`Checking ${skus.length} individually watched product(s)${geoLabel ? ` (geo: ${geoLabel})` : ''}...`);
  const restocks: RestockEvent[] = [];

  for (const sku of skus) {
    const watched = wl.products[sku];
    try {
      const product = await client.getProductBySku(sku);
      if (!product) { log(`  [${sku}] not found — skipping`); continue; }

      const allStoreIds = product.storeIds ?? [];
      // Apply geo filter: only consider stores within radius
      const currentStoreIds = localStoreIds
        ? allStoreIds.filter((id) => localStoreIds.has(id))
        : allStoreIds;

      const currentAvailability = product.availability ?? '';
      const event = detectRestock(watched, currentStoreIds, currentAvailability);

      wl.products[sku] = {
        ...watched,
        name: product.name,
        price: product.price,
        storeSnapshot: currentStoreIds,  // snapshot uses filtered store list
        availabilitySnapshot: currentAvailability,
        lastChecked: new Date().toISOString(),
        lastRestockAt: event ? new Date().toISOString() : watched.lastRestockAt,
        lastRestockDelta: event ? event.newStoreIds.length : watched.lastRestockDelta,
      };

      if (event) {
        // Enrich with product details (available for individually watched products)
        event.vintage    = product.vintage;
        event.producer   = product.producer;
        event.region     = product.region;
        event.country    = product.country;
        event.grape      = product.grape;
        event.format     = product.format;
        event.rating     = product.rating;
        event.ratingCount = product.ratingCount;
        restocks.push(event);
        log(`  [NOW AVAILABLE] ${product.name} — ${event.currentStoreCount} store(s)${geoLabel ? ` near ${geoLabel}` : ''}`);
        if (notify) {
          const storeStr = localStoreIds
            ? `${event.currentStoreCount} store(s) within ${geoLabel}`
            : `${event.currentStoreCount} store(s) across Québec`;
          sendNotification(`SAQ Now Available: ${event.name}`, `${storeStr} · $${event.price.toFixed(2)}`);
        }
      } else {
        log(`  [OK] ${product.name} — ${currentStoreIds.length} stores${localStoreIds ? ' locally' : ''}`);
      }
    } catch (err) {
      log(`  [ERROR] ${sku}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  saveWatchlist(wl);
  return restocks;
}

// ── Full catalog scan ─────────────────────────────────────────────────────────

// SAQ API hard-caps pagination at 10 000 products per filtered query.
// Strategy:
//   - Most categories are small enough to scan directly (includeUnavailable: true).
//   - Wine is the only category that exceeds the limit: ~14k unique products.
//     It is split into four chunks that each stay under the limit:
//       1. Purchasable / coming-soon wines:                       ~8k total_count (~5.8k unique)
//       2. Sold-out French wines:                                 ~4.2k total_count (~3k unique)
//       3. Sold-out non-French wines (all other countries):       ~1.7k total_count (~1.2k unique)
//       4. Unavailable wines:                                     ~5.9k total_count (~4.3k unique)
//
// Note: total_count is inflated (~25–30%) because the Magento search index returns the same
// SKU on multiple pages. The entries Map deduplicates these naturally.
const ALL_CATEGORIES: ProductCategory[] = [
  'wine', 'spirits', 'beer', 'champagne-and-sparkling-wine',
  'cider', 'sake', 'aperitif', 'port-and-fortified-wine',
  'dessert-wine',
  // Note: 'non-alcoholic' is NOT a real SAQ categoryPath — the website shows a filtered
  // view by low ABV across categories. Those products are already captured under beer/wine/etc.
];

// All wine-producing countries found in SAQ's catalog (except France which gets its own chunk).
// Discovered by scanning the first 9 984 wine soldOut products to extract unique pays_origine values.
const WINE_COUNTRIES_NON_FRANCE: string[] = [
  'Argentina', 'Armenia', 'Australia', 'Austria', 'Brazil', 'Bulgaria',
  'Canada', 'Chile', 'China', 'Germany', 'Greece', 'Hungary', 'Israel',
  'Italy', 'Lebanon', 'Mexico', 'Moldova, Republic of', 'Morocco',
  'New Zealand', 'Peru', 'Portugal', 'Romania', 'Slovakia', 'South Africa',
  'Spain', 'Switzerland', 'Tunisia', 'United States', 'Uruguay',
];

const PAGE_SIZE = 48;

async function scanChunk(
  client: SaqClient,
  localStoreIds: Set<string> | null,
  options: Parameters<SaqClient['searchProducts']>[0],
): Promise<CatalogSnapshot['entries']> {
  const entries: CatalogSnapshot['entries'] = {};
  let page = 1;
  let totalPages = 1;

  do {
    const result = await client.searchProducts({ ...options, pageSize: PAGE_SIZE, page });
    if (page === 1) totalPages = result.total_pages;

    for (const p of result.products) {
      const allStoreIds = p.storeIds ?? [];
      entries[p.sku] = {
        name: p.name,
        price: p.price,
        url: p.url,
        storeCount: allStoreIds.length,
        localStoreCount: localStoreIds
          ? allStoreIds.filter((id) => localStoreIds.has(id)).length
          : undefined,
        availability: p.availability ?? '',
        // Product details for richer email notifications
        vintage: p.vintage,
        producer: p.producer,
        region: p.region,
        country: p.country,
        grape: p.grape,
        format: p.format,
        rating: p.rating,
        ratingCount: p.ratingCount,
      };
    }
    page++;
  } while (page <= totalPages);

  return entries;
}

async function scanWine(
  client: SaqClient,
  localStoreIds: Set<string> | null,
): Promise<CatalogSnapshot['entries']> {
  const entries: CatalogSnapshot['entries'] = {};

  // Chunk 1: purchasable or coming-soon wines — ~8k
  // Explicit availability list to include 'Available shortly' (comingSoon), which is
  // missed by the generic includeUnavailable: false filter.
  Object.assign(entries, await scanChunk(client, localStoreIds, {
    category: 'wine',
    availability: ['online', 'inStore', 'lotteryCurrently', 'lotterySoon', 'comingSoon'],
    includeUnavailable: true,
  }));

  // Chunk 2: sold-out French wines — ~4.2k (France is the largest single-country bucket)
  Object.assign(entries, await scanChunk(client, localStoreIds, {
    category: 'wine', availability: ['soldOut'], includeUnavailable: true, country: 'France',
  }));

  // Chunk 3: sold-out non-French wines — ~1.7k
  Object.assign(entries, await scanChunk(client, localStoreIds, {
    category: 'wine', availability: ['soldOut'], includeUnavailable: true,
    countries: WINE_COUNTRIES_NON_FRANCE,
  }));

  // Chunk 4: unavailable wines — ~5.9k
  Object.assign(entries, await scanChunk(client, localStoreIds, {
    category: 'wine', availability: ['unavailable'], includeUnavailable: true,
  }));

  return entries;
}

async function scanCatalog(
  client: SaqClient,
  notify: boolean,
  localStoreIds: Set<string> | null,
  currentFilterKey: string | undefined,
): Promise<RestockEvent[]> {
  const prevSnapshot = loadCatalogSnapshot();
  const isFirstRun = prevSnapshot === null;
  // If the filter changed, local counts are stale — treat as first run for local data
  const filterChanged = !isFirstRun && currentFilterKey !== prevSnapshot.filterKey;

  if (isFirstRun) {
    log('Catalog scan: building baseline (no diffs on first run)...');
  } else if (filterChanged) {
    log('Catalog scan: location filter changed — rebuilding local counts (no diffs this run)...');
  } else {
    log(`Catalog scan: checking full SAQ catalog${localStoreIds ? ` (geo-filtered)` : ''}...`);
  }

  const newEntries: CatalogSnapshot['entries'] = {};

  for (const category of ALL_CATEGORIES) {
    if (category === 'wine') {
      const entries = await scanWine(client, localStoreIds);
      Object.assign(newEntries, entries);
      log(`  [wine] ${Object.keys(entries).length} products (4 chunks)`);
      continue;
    }

    // All other categories are small enough to scan in one shot
    const entries = await scanChunk(client, localStoreIds, {
      category, includeUnavailable: true,
    });
    const count = Object.keys(entries).length;
    if (count > 0) {
      Object.assign(newEntries, entries);
      log(`  [${category}] ${count} products`);
    } else {
      log(`  [${category}] WARNING: 0 products returned — API may have failed for this category`);
    }
  }

  // Note: the SAQ API's total_count is inflated because the same SKU can appear on multiple
  // pages (Magento search index artifact). The actual unique product count (~14k wines) is
  // ~70–75% of total_count. The Set-based deduplication in scanChunk already handles this
  // correctly — no carry-forward guard is needed.
  log(`  Total unique products from API: ${Object.keys(newEntries).length}`);

  const newSnapshot: CatalogSnapshot = {
    scannedAt: new Date().toISOString(),
    productCount: Object.keys(newEntries).length,
    filterKey: currentFilterKey,
    entries: newEntries,
  };
  saveCatalogSnapshot(newSnapshot);
  log(`  Saved snapshot: ${newSnapshot.productCount} products`);

  if (isFirstRun || filterChanged) {
    log('  Baseline saved. Restocks will be detected on the next daily run.');
    return [];
  }

  // Diff: restocks for known products + new arrival alerts for brand-new listings
  const geoFiltered = localStoreIds !== null;
  const restocks: RestockEvent[] = [];
  const newArrivals: RestockEvent[] = [];

  for (const [sku, current] of Object.entries(newEntries)) {
    const prev = prevSnapshot.entries[sku];
    if (!prev) {
      const event = detectNewArrival(sku, current, geoFiltered);
      if (event) newArrivals.push(event);
      continue;
    }
    const event = detectRestockFromCatalog(sku, prev, current, geoFiltered);
    if (event) restocks.push(event);
  }

  log(`  Diff complete: ${restocks.length} restock(s), ${newArrivals.length} new arrival(s)`);

  if (notify) {
    // New arrivals notification
    if (newArrivals.length === 1) {
      const r = newArrivals[0];
      sendNotification(
        `SAQ New Arrival: ${r.name}`,
        `${r.currentStoreCount} store${r.currentStoreCount !== 1 ? 's' : ''} · $${r.price.toFixed(2)}`,
      );
    } else if (newArrivals.length > 1) {
      sendNotification(
        `SAQ: ${newArrivals.length} new arrivals`,
        newArrivals.slice(0, 3).map((r) => r.name).join(', ') +
          (newArrivals.length > 3 ? ` +${newArrivals.length - 3} more` : ''),
      );
    }

    // Now-available notification (products that went from 0 stores → in stock)
    if (restocks.length === 1) {
      const r = restocks[0];
      sendNotification(
        `SAQ Now Available: ${r.name}`,
        `${r.currentStoreCount} store${r.currentStoreCount !== 1 ? 's' : ''} · $${r.price.toFixed(2)}`,
      );
    } else if (restocks.length > 1) {
      sendNotification(
        `SAQ: ${restocks.length} products now available`,
        restocks.slice(0, 3).map((r) => r.name).join(', ') +
          (restocks.length > 3 ? ` +${restocks.length - 3} more` : ''),
      );
    }
  }

  // Email notifications (sent whenever email.json is configured, regardless of --notify flag)
  const geoLabel = localStoreIds ? ` within ${currentFilterKey ? '100 km of Montréal' : 'your area'}` : '';

  const emailItems = [...restocks, ...newArrivals];
  if (emailItems.length > 0) {
    // Enrich with CellarTracker community score + price (only for alert products, not full catalog)
    const ctConfig = loadCtConfig();
    if (ctConfig) await enrichWithCellarTracker(emailItems, ctConfig, log);

    const subject = `SAQ: ${emailItems.length} product${emailItems.length !== 1 ? 's' : ''} now available`;
    await sendEmail(subject, buildEmailHtml(emailItems, geoLabel));
  }

  return [...newArrivals, ...restocks];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runCheck(notify: boolean): Promise<void> {
  const wl = loadWatchlist();
  const creds = await extractCredentials();
  const client = new SaqClient(creds);

  // Resolve geo filter once
  let localStoreIds: Set<string> | null = null;
  if (wl.locationFilter) {
    const { lat, lng, radiusKm, label } = wl.locationFilter;
    log(`Location filter active: ${label}`);
    const allStores = await getStoreDirectory();
    localStoreIds = getLocalStoreIds(allStores, lat, lng, radiusKm);
    log(`  ${localStoreIds.size} stores within radius`);
  }

  const currentFilterKey = filterKey(wl.locationFilter);
  const allRestocks: RestockEvent[] = [];

  if (Object.keys(wl.products).length > 0) {
    const events = await checkIndividual(client, notify, localStoreIds);
    allRestocks.push(...events);
  }

  if (wl.watchAll) {
    const events = await scanCatalog(client, notify, localStoreIds, currentFilterKey);
    allRestocks.push(...events);
  }

  if (!wl.watchAll && Object.keys(wl.products).length === 0) {
    log('Nothing to check. Use watch_product or watch_all to start monitoring.');
    return;
  }

  if (allRestocks.length > 0) {
    const arrivals = allRestocks.filter((r) => r.isNewArrival);
    const restocks = allRestocks.filter((r) => !r.isNewArrival);
    if (arrivals.length > 0) {
      process.stdout.write(`\n=== ${arrivals.length} NEW ARRIVAL(S) ===\n`);
      arrivals.forEach((r) => printRestock(r, wl.locationFilter?.label));
    }
    if (restocks.length > 0) {
      process.stdout.write(`\n=== ${restocks.length} NOW AVAILABLE ===\n`);
      restocks.forEach((r) => printRestock(r, wl.locationFilter?.label));
    }
  } else {
    log('No restocks or new arrivals detected.');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const notify = args.includes('--notify');
  const loopIdx = args.indexOf('--loop');
  const loopInterval = loopIdx !== -1 ? parseInt(args[loopIdx + 1] ?? '86400', 10) : null;

  if (loopInterval !== null) {
    log(`Watcher started (every ${loopInterval}s, notify=${notify})`);
    await runCheck(notify);
    setInterval(() => void runCheck(notify), loopInterval * 1000);
  } else {
    await runCheck(notify);
  }
}

main().catch((err) => {
  process.stderr.write(`[watcher] Fatal: ${err}\n`);
  process.exit(1);
});
