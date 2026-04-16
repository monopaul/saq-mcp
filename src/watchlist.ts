import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DATA_DIR = path.join(os.homedir(), '.saq-mcp');
const WATCHLIST_PATH = path.join(DATA_DIR, 'watchlist.json');
const CATALOG_SNAPSHOT_PATH = path.join(DATA_DIR, 'catalog-snapshot.json');

// ── Individual product watching ───────────────────────────────────────────────

export interface WatchedProduct {
  sku: string;
  name: string;
  price: number;
  url: string;
  addedAt: string;
  storeSnapshot: string[];       // full store ID list at last check
  availabilitySnapshot: string;
  lastChecked: string | null;
  lastRestockAt: string | null;
  lastRestockDelta: number | null;
}

export interface LocationFilter {
  lat: number;
  lng: number;
  radiusKm: number;
  label: string;           // human-readable, e.g. "Montréal (30 km)"
  storeCount: number;      // how many stores fall within the radius
}

export interface Watchlist {
  updatedAt: string;
  watchAll: boolean;             // if true, scan full catalog daily
  locationFilter?: LocationFilter;
  products: Record<string, WatchedProduct>;
}

export function loadWatchlist(): Watchlist {
  try {
    if (fs.existsSync(WATCHLIST_PATH)) {
      const raw = JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf-8')) as Watchlist;
      if (raw.watchAll === undefined) raw.watchAll = false;
    return raw;
    }
  } catch {}
  return { updatedAt: new Date().toISOString(), watchAll: false, products: {} };
}

export function saveWatchlist(wl: Watchlist): void {
  ensureDataDir();
  wl.updatedAt = new Date().toISOString();
  fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(wl, null, 2));
}

// ── Catalog-wide snapshot (for watch-all mode) ────────────────────────────────

/** Lightweight per-product entry stored in the catalog snapshot */
export interface CatalogEntry {
  name: string;
  price: number;
  url: string;
  storeCount: number;           // total stores across Quebec
  localStoreCount?: number;     // stores within location filter radius
  availability: string;
}

export interface CatalogSnapshot {
  scannedAt: string;
  productCount: number;
  /** Serialised location filter key at scan time — if it changes, local counts are stale */
  filterKey?: string;
  entries: Record<string, CatalogEntry>; // keyed by SKU
}

export function filterKey(filter: LocationFilter | undefined): string | undefined {
  if (!filter) return undefined;
  return `${filter.lat.toFixed(4)},${filter.lng.toFixed(4)},${filter.radiusKm}`;
}

export function loadCatalogSnapshot(): CatalogSnapshot | null {
  try {
    if (fs.existsSync(CATALOG_SNAPSHOT_PATH)) {
      return JSON.parse(fs.readFileSync(CATALOG_SNAPSHOT_PATH, 'utf-8')) as CatalogSnapshot;
    }
  } catch {}
  return null;
}

export function saveCatalogSnapshot(snapshot: CatalogSnapshot): void {
  ensureDataDir();
  fs.writeFileSync(CATALOG_SNAPSHOT_PATH, JSON.stringify(snapshot));
}

// ── Restock detection ─────────────────────────────────────────────────────────

export interface RestockEvent {
  sku: string;
  name: string;
  price: number;
  url: string;
  previousStoreCount: number;
  currentStoreCount: number;
  /** Only populated for individually watched products (full ID list available) */
  newStoreIds: string[];
  availabilityChanged: boolean;
  previousAvailability: string;
  currentAvailability: string;
  detectedAt: string;
  /** True when the product wasn't in the previous snapshot — it's a brand-new listing. */
  isNewArrival?: true;
}

/** Diff for an individually watched product (has full store ID list).
 *  Only fires when a product becomes newly available (0 → ≥1 stores),
 *  not when it merely gains more stores where it was already stocked. */
export function detectRestock(
  watched: WatchedProduct,
  currentStoreIds: string[],
  currentAvailability: string,
): RestockEvent | null {
  const prev = new Set(watched.storeSnapshot);
  const newStoreIds = currentStoreIds.filter((id) => !prev.has(id));
  const isPositiveAvailChange = isAvailabilityImprovement(
    watched.availabilitySnapshot,
    currentAvailability,
  );

  // Only alert when going from no local stores → at least one local store
  const isFirstAvailability = watched.storeSnapshot.length === 0 && currentStoreIds.length > 0;
  if (!isFirstAvailability && !isPositiveAvailChange) return null;

  return {
    sku: watched.sku,
    name: watched.name,
    price: watched.price,
    url: watched.url,
    previousStoreCount: watched.storeSnapshot.length,
    currentStoreCount: currentStoreIds.length,
    newStoreIds,
    availabilityChanged: currentAvailability !== watched.availabilitySnapshot,
    previousAvailability: watched.availabilitySnapshot,
    currentAvailability,
    detectedAt: new Date().toISOString(),
  };
}

/** Diff for a catalog-scan entry (only has store count, not full ID list).
 *  When a location filter was active at both scan times, uses localStoreCount.
 *
 *  Fires only when the product was genuinely unavailable before — meaning:
 *  - rank 0 availability (sold out / unavailable everywhere, NOT online) AND
 *  - 0 stores in the relevant scope
 *  AND is now actually available (rank > 0).
 *
 *  This prevents false alerts for:
 *  - Products "available online" that gain local stores (still available, just more so)
 *  - Products the API marks "Unavailable" but happens to carry store IDs */
export function detectRestockFromCatalog(
  sku: string,
  prev: CatalogEntry,
  current: CatalogEntry,
  geoFiltered: boolean,
): RestockEvent | null {
  // Choose which count to compare based on whether we're in geo-filtered mode
  const prevCount = geoFiltered ? (prev.localStoreCount ?? prev.storeCount) : prev.storeCount;
  const currCount = geoFiltered ? (current.localStoreCount ?? current.storeCount) : current.storeCount;
  const isPositiveAvailChange = isAvailabilityImprovement(prev.availability, current.availability);

  // Product must have been genuinely unavailable (rank 0 = sold out / truly unavailable, not online)
  // AND had no stores in scope, AND must now be actually available (rank > 0)
  const wasGenuinelyUnavailable = prevCount === 0 && availabilityRank(prev.availability) === 0;
  const isNowAvailable = currCount > 0 && availabilityRank(current.availability) > 0;
  const isFirstAvailability = wasGenuinelyUnavailable && isNowAvailable;

  if (!isFirstAvailability && !isPositiveAvailChange) return null;

  return {
    sku,
    name: current.name,
    price: current.price,
    url: current.url,
    previousStoreCount: prevCount,
    currentStoreCount: currCount,
    newStoreIds: [],
    availabilityChanged: current.availability !== prev.availability,
    previousAvailability: prev.availability,
    currentAvailability: current.availability,
    detectedAt: new Date().toISOString(),
  };
}

/** Detect a brand-new product (no previous snapshot entry) that is already in-store or online.
 *  In geo-filtered mode, requires at least one local store — unless it's online-only. */
export function detectNewArrival(
  sku: string,
  current: CatalogEntry,
  geoFiltered: boolean,
): RestockEvent | null {
  const isAvailable =
    current.availability.includes('In store') || current.availability.includes('Online');
  if (!isAvailable) return null;

  const currCount = geoFiltered
    ? (current.localStoreCount ?? current.storeCount)
    : current.storeCount;

  // Geo-filtered: skip if not online and no local stores
  if (geoFiltered && currCount === 0 && !current.availability.includes('Online')) return null;

  return {
    sku,
    name: current.name,
    price: current.price,
    url: current.url,
    previousStoreCount: 0,
    currentStoreCount: currCount,
    newStoreIds: [],
    availabilityChanged: true,
    previousAvailability: '',
    currentAvailability: current.availability,
    isNewArrival: true,
    detectedAt: new Date().toISOString(),
  };
}

/** Availability rank: 3 = in store / online, 2 = coming soon, 1 = lottery, 0 = unavailable/sold out */
export function availabilityRank(a: string): number {
  if (a.includes('Online') || a.includes('In store')) return 3;
  if (a.includes('shortly') || a.includes('Available')) return 2;
  if (a.includes('lottery') || a.includes('Lottery')) return 1;
  return 0;
}

export function isAvailabilityImprovement(prev: string, curr: string): boolean {
  return availabilityRank(curr) > availabilityRank(prev);
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
