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
//   - Wine is the only category that exceeds the limit: 27k+ products total.
//     It is split into four chunks that each stay under the limit:
//       1. Available wines (online/in-store/lottery/coming soon): ~8k
//       2. Sold-out French wines:                                 ~9.3k
//       3. Sold-out non-French wines (all other countries):       ~4.4k
//       4. Unavailable wines:                                     ~5.9k
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

const API_LIMIT = 9_900;
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

  // Chunk 1: available wines (online/in-store/lottery/coming soon) — ~8k
  Object.assign(entries, await scanChunk(client, localStoreIds, {
    category: 'wine', includeUnavailable: false,
  }));

  // Chunk 2: sold-out French wines — ~9.3k (France alone is the largest single-country bucket)
  Object.assign(entries, await scanChunk(client, localStoreIds, {
    category: 'wine', availability: ['soldOut'], includeUnavailable: true, country: 'France',
  }));

  // Chunk 3: sold-out non-French wines — ~4.4k
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

  log(`  Total from API: ${Object.keys(newEntries).length} unique products`);

  // ── Carry-forward guard ──────────────────────────────────────────────────────
  // The SAQ API returns inconsistent product counts between runs — some products
  // are silently omitted on certain days (total_pages drifts). If we blindly replace
  // the snapshot with whatever the API returned today, those missing products
  // disappear from our baseline and reappear as "new arrivals" the next day.
  // Fix: carry forward any product the scan missed, preserving its last-known state.
  // This is safe because the detection logic requires prev availability rank > 0 to fire,
  // so carried-forward products won't produce false alerts unless they genuinely restock.
  // (Filter changes are excluded: local counts would be stale under a new filter.)
  if (prevSnapshot && !isFirstRun && !filterChanged) {
    let carriedForward = 0;
    for (const [sku, prevEntry] of Object.entries(prevSnapshot.entries)) {
      if (!newEntries[sku]) {
        newEntries[sku] = prevEntry;
        carriedForward++;
      }
    }
    if (carriedForward > 0) {
      log(`  Carried forward ${carriedForward} products not seen this scan (API jitter guard)`);
    }
  }

  log(`  Total in snapshot: ${Object.keys(newEntries).length} unique products`);

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
    const rows = emailItems.sort((a, b) => b.price - a.price).map((r) =>
      `<tr><td><a href="${r.url}">${r.name}</a></td><td>$${r.price.toFixed(2)}</td>` +
      `<td>${r.currentStoreCount} store${r.currentStoreCount !== 1 ? 's' : ''}${geoLabel}</td>` +
      `<td>${r.currentAvailability}</td></tr>`,
    ).join('');
    await sendEmail(
      `SAQ: ${emailItems.length} product${emailItems.length !== 1 ? 's' : ''} now available`,
      `<h2>📦 ${emailItems.length} product${emailItems.length !== 1 ? 's' : ''} now available at SAQ</h2>` +
      `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif">` +
      `<thead><tr><th>Product</th><th>Price</th><th>Stores</th><th>Availability</th></tr></thead>` +
      `<tbody>${rows}</tbody></table>`,
    );
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
