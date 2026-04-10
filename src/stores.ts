import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const STORES_PATH = path.join(os.homedir(), '.saq-mcp', 'stores.json');
const STORE_LIST_URL = 'https://www.saq.com/en/store/locator/ajaxlist/';
const STORE_LIST_HEADERS = {
  Accept: 'application/json',
  Referer: 'https://www.saq.com/en/store-locator',
  'X-Requested-With': 'XMLHttpRequest',
};

export interface SaqStore {
  id: string;          // "23096" — matches store_availability_list
  name: string;
  address: string;
  city: string;
  postcode: string;
  lat: number;
  lng: number;
  temporarily_closed: boolean;
}

interface StoreCache {
  fetchedAt: string;
  stores: SaqStore[];
}

// ── Fetch & cache ─────────────────────────────────────────────────────────────

export async function getStoreDirectory(forceRefresh = false): Promise<SaqStore[]> {
  if (!forceRefresh) {
    const cached = loadCached();
    if (cached) return cached;
  }

  process.stderr.write('[saq-mcp] Fetching SAQ store directory...\n');
  const stores = await fetchAllStores();
  saveCache(stores);
  process.stderr.write(`[saq-mcp] Cached ${stores.length} stores\n`);
  return stores;
}

async function fetchAllStores(): Promise<SaqStore[]> {
  const all: SaqStore[] = [];
  let loaded = 0;

  // We know there are ~402 stores; fetch in parallel batches of 10 concurrent requests
  // First: probe total count
  const probe = await fetch(`${STORE_LIST_URL}?loaded=0`, { headers: STORE_LIST_HEADERS });
  const probeData = (await probe.json()) as { list: RawStore[]; total: number };
  const total = probeData.total ?? 500;
  mapAndPush(probeData.list, all);
  loaded = probeData.list.length;

  // Fetch remaining pages in batches of 10 concurrent requests
  const CONCURRENCY = 10;
  const PAGE_SIZE = 10;
  while (loaded < total) {
    const offsets: number[] = [];
    for (let i = 0; i < CONCURRENCY && loaded + i * PAGE_SIZE < total; i++) {
      offsets.push(loaded + i * PAGE_SIZE);
    }
    const pages = await Promise.all(
      offsets.map((offset) =>
        fetch(`${STORE_LIST_URL}?loaded=${offset}`, { headers: STORE_LIST_HEADERS })
          .then((r) => r.json() as Promise<{ list: RawStore[] }>)
          .then((d) => d.list ?? []),
      ),
    );
    for (const page of pages) mapAndPush(page, all);
    loaded += offsets.length * PAGE_SIZE;
    if (pages.every((p) => p.length === 0)) break;
  }

  return all;
}

interface RawStore {
  identifier: string;
  name: string;
  address1?: string;
  city: string;
  postcode: string;
  latitude: string;
  longitude: string;
  temporarily_closed: boolean;
}

function mapAndPush(raw: RawStore[], out: SaqStore[]): void {
  for (const s of raw) {
    const lat = parseFloat(s.latitude);
    const lng = parseFloat(s.longitude);
    if (!s.identifier || isNaN(lat) || isNaN(lng)) continue;
    out.push({
      id: s.identifier,
      name: s.name,
      address: s.address1 ?? '',
      city: s.city,
      postcode: s.postcode,
      lat,
      lng,
      temporarily_closed: s.temporarily_closed,
    });
  }
}

function loadCached(): SaqStore[] | null {
  try {
    if (!fs.existsSync(STORES_PATH)) return null;
    const cache = JSON.parse(fs.readFileSync(STORES_PATH, 'utf-8')) as StoreCache;
    // Refresh weekly
    const age = Date.now() - new Date(cache.fetchedAt).getTime();
    if (age > 7 * 24 * 60 * 60 * 1000) return null;
    return cache.stores;
  } catch {
    return null;
  }
}

function saveCache(stores: SaqStore[]): void {
  const dir = path.dirname(STORES_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cache: StoreCache = { fetchedAt: new Date().toISOString(), stores };
  fs.writeFileSync(STORES_PATH, JSON.stringify(cache));
}

// ── Geography ─────────────────────────────────────────────────────────────────

/** Haversine distance in km between two lat/lng points */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Returns the Set of store IDs within radiusKm of (lat, lng) */
export function getLocalStoreIds(
  stores: SaqStore[],
  lat: number,
  lng: number,
  radiusKm: number,
): Set<string> {
  const result = new Set<string>();
  for (const s of stores) {
    if (!s.temporarily_closed && haversineKm(lat, lng, s.lat, s.lng) <= radiusKm) {
      result.add(s.id);
    }
  }
  return result;
}

/** Returns stores matching a city name (case-insensitive substring) */
export function findStoresByCity(stores: SaqStore[], city: string): SaqStore[] {
  const q = city.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  return stores.filter((s) => {
    const c = s.city.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
    return c.includes(q);
  });
}

/** Computes the centroid lat/lng of a list of stores */
export function centroid(stores: SaqStore[]): { lat: number; lng: number } {
  const lat = stores.reduce((s, x) => s + x.lat, 0) / stores.length;
  const lng = stores.reduce((s, x) => s + x.lng, 0) / stores.length;
  return { lat, lng };
}
