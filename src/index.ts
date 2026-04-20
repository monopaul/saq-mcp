import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'path';

// Resolve the project root regardless of where the process is invoked from
const PROJECT_ROOT = path.resolve(__dirname, '..');
const WATCHER_BIN = path.join(PROJECT_ROOT, 'dist', 'watcher.js');
const INSTALL_SCRIPT = path.join(PROJECT_ROOT, 'install.sh');
import { extractCredentials } from './credentials.js';
import { SaqClient } from './saq-client.js';
import { loadCtConfig, saveCtConfig, validateCtCredentials } from './cellartracker.js';
import {
  loadWatchlist,
  saveWatchlist,
  loadCatalogSnapshot,
  detectRestock,
  filterKey,
  type WatchedProduct,
  type LocationFilter,
} from './watchlist.js';
import { getStoreDirectory, getLocalStoreIds, findStoresByCity, centroid, haversineKm } from './stores.js';
import type { AvailabilityFilter, ProductCategory, SortField, SortDir } from './types.js';

let client: SaqClient | null = null;

async function getClient(): Promise<SaqClient> {
  if (!client) {
    const creds = await extractCredentials();
    client = new SaqClient(creds);
  }
  return client;
}

const server = new McpServer({
  name: 'saq-mcp',
  version: '1.0.0',
});

// ── search_products ───────────────────────────────────────────────────────────
server.tool(
  'search_products',
  'Search SAQ products by query, category, country, grape variety, price range, etc.',
  {
    query: z.string().optional().describe('Search term (wine name, producer, region, etc.)'),
    category: z
      .enum([
        'wine',
        'spirits',
        'beer',
        'champagne-and-sparkling-wine',
        'cider',
        'sake',
        'aperitif',
        'port-and-fortified-wine',
        'dessert-wine',
        'non-alcoholic',
      ])
      .optional()
      .describe('Product category'),
    availability: z
      .array(z.enum(['online', 'inStore', 'comingSoon', 'lotteryCurrently', 'lotterySoon', 'soldOut']))
      .optional()
      .describe('Filter by availability status'),
    country: z.string().optional().describe('Country of origin (e.g. "France", "Italy")'),
    region: z.string().optional().describe('Region (e.g. "Bordeaux", "Burgundy")'),
    grape: z.string().optional().describe('Grape variety (e.g. "Cabernet Sauvignon")'),
    min_price: z.number().optional().describe('Minimum price in CAD'),
    max_price: z.number().optional().describe('Maximum price in CAD'),
    sort_by: z
      .enum(['relevance', 'date_arrival', 'price', 'name'])
      .optional()
      .default('relevance')
      .describe('Sort field'),
    sort_dir: z.enum(['asc', 'desc']).optional().default('desc').describe('Sort direction'),
    page: z.number().int().min(1).optional().default(1),
    page_size: z.number().int().min(1).max(48).optional().default(20),
  },
  async (args) => {
    const saq = await getClient();
    const result = await saq.searchProducts({
      query: args.query,
      category: args.category as ProductCategory | undefined,
      availability: args.availability as AvailabilityFilter[] | undefined,
      country: args.country,
      region: args.region,
      grape: args.grape,
      minPrice: args.min_price,
      maxPrice: args.max_price,
      sortBy: args.sort_by as SortField,
      sortDir: args.sort_dir as SortDir,
      page: args.page,
      pageSize: args.page_size,
    });

    const lines = [
      `Found ${result.total_count} products (page ${result.current_page}/${result.total_pages})`,
      '',
      ...result.products.map((p) => {
        const attrs = [
          p.country,
          p.region,
          p.grape,
          p.abv ? `${p.abv}%` : null,
          p.format,
        ]
          .filter(Boolean)
          .join(' · ');
        return [
          `**${p.name}** — $${p.price.toFixed(2)}`,
          `  SKU: ${p.sku} | ${p.availability ?? 'unknown availability'}`,
          attrs ? `  ${attrs}` : null,
          `  ${p.url}`,
        ]
          .filter(Boolean)
          .join('\n');
      }),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

// ── get_new_arrivals ──────────────────────────────────────────────────────────
server.tool(
  'get_new_arrivals',
  'Get the latest new arrivals on SAQ.com, sorted by arrival date (most recent first)',
  {
    category: z
      .enum([
        'wine',
        'spirits',
        'beer',
        'champagne-and-sparkling-wine',
        'cider',
        'sake',
        'aperitif',
        'port-and-fortified-wine',
        'dessert-wine',
        'non-alcoholic',
      ])
      .optional()
      .describe('Filter new arrivals by category'),
    page: z.number().int().min(1).optional().default(1),
    page_size: z.number().int().min(1).max(48).optional().default(20),
  },
  async (args) => {
    const saq = await getClient();
    const result = await saq.getNewArrivals({
      category: args.category as ProductCategory | undefined,
      page: args.page,
      pageSize: args.page_size,
    });

    const lines = [
      `${result.total_count} new arrivals (page ${result.current_page}/${result.total_pages})`,
      '',
      ...result.products.map((p) => {
        const arrived = p.releaseDate ? ` · arrived ${p.releaseDate}` : '';
        return [
          `**${p.name}** — $${p.price.toFixed(2)}${arrived}`,
          `  SKU: ${p.sku} | ${p.country ?? ''}${p.region ? ` · ${p.region}` : ''}${p.grape ? ` · ${p.grape}` : ''}`,
          `  ${p.url}`,
        ]
          .join('\n');
      }),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

// ── get_coming_soon ───────────────────────────────────────────────────────────
server.tool(
  'get_coming_soon',
  'Get products that are coming soon (not yet available / pre-release), including upcoming lottery products',
  {
    category: z
      .enum([
        'wine',
        'spirits',
        'beer',
        'champagne-and-sparkling-wine',
        'cider',
        'sake',
        'aperitif',
        'port-and-fortified-wine',
        'dessert-wine',
        'non-alcoholic',
      ])
      .optional(),
    page: z.number().int().min(1).optional().default(1),
    page_size: z.number().int().min(1).max(48).optional().default(20),
  },
  async (args) => {
    const saq = await getClient();
    const result = await saq.getComingSoon({
      category: args.category as ProductCategory | undefined,
      page: args.page,
      pageSize: args.page_size,
    });

    const lines = [
      `${result.total_count} products coming soon (page ${result.current_page}/${result.total_pages})`,
      '',
      ...result.products.map((p) => {
        const releaseInfo = p.releaseDate ? ` · available ${p.releaseDate}` : '';
        const status = p.availability === 'lotterySoon' ? '🎟 Lottery' : '⏳ Coming soon';
        return [
          `**${p.name}** — $${p.price.toFixed(2)} [${status}${releaseInfo}]`,
          `  SKU: ${p.sku} | ${[p.country, p.region, p.grape].filter(Boolean).join(' · ')}`,
          `  ${p.url}`,
        ]
          .join('\n');
      }),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

// ── get_product ───────────────────────────────────────────────────────────────
server.tool(
  'get_product',
  'Get full details for a specific SAQ product by its SKU/code',
  {
    sku: z.string().describe('SAQ product code / SKU (e.g. "14366195" or "0014366195")'),
  },
  async (args) => {
    const saq = await getClient();
    const product = await saq.getProductBySku(args.sku);

    if (!product) {
      return {
        content: [{ type: 'text', text: `No product found for SKU: ${args.sku}` }],
      };
    }

    const onSale =
      product.regularPrice && product.regularPrice > product.price
        ? ` ~~$${product.regularPrice.toFixed(2)}~~`
        : '';
    const ratingStr =
      product.rating != null
        ? `${product.rating}/100 (${product.ratingCount} reviews)`
        : null;

    const details = [
      `# ${product.name}`,
      product.vintage ? `**Vintage**: ${product.vintage}` : null,
      `**Price**: $${product.price.toFixed(2)} ${product.currency}${onSale}`,
      `**SKU**: ${product.sku}`,
      `**Availability**: ${product.availability ?? 'unknown'}`,
      product.storeIds?.length ? `**In stock at**: ${product.storeIds.length} stores` : null,
      product.productType ? `**Type**: ${product.productType}` : null,
      product.country ? `**Country**: ${product.country}` : null,
      product.region ? `**Region**: ${product.region}` : null,
      product.appellation ? `**Appellation**: ${product.appellation}` : null,
      product.grape ? `**Grape**: ${product.grape}` : null,
      product.colour ? `**Colour**: ${product.colour}` : null,
      product.abv ? `**ABV**: ${parseFloat(product.abv).toFixed(1)}%` : null,
      product.format ? `**Format**: ${product.format}` : null,
      product.sugar ? `**Sugar**: ${product.sugar}` : null,
      product.tasteProfile ? `**Taste**: ${product.tasteProfile}` : null,
      product.producer ? `**Producer**: ${product.producer}` : null,
      ratingStr ? `**Rating**: ${ratingStr}` : null,
      product.releaseDate ? `**Available since**: ${product.releaseDate}` : null,
      `**URL**: ${product.url}`,
    ]
      .filter(Boolean)
      .join('\n');

    return {
      content: [{ type: 'text', text: details }],
    };
  },
);

// ── check_store_availability ──────────────────────────────────────────────────
server.tool(
  'check_store_availability',
  'Check which SAQ stores have a specific product in stock',
  {
    sku: z.string().describe('SAQ product code / SKU'),
  },
  async (args) => {
    const saq = await getClient();

    let stores;
    try {
      stores = await saq.checkStoreAvailability(args.sku);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Could not retrieve store inventory for SKU ${args.sku}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }

    if (!stores.length) {
      return {
        content: [{ type: 'text', text: `No stores currently have SKU ${args.sku} in stock.` }],
      };
    }

    const lines = [
      `SKU ${args.sku} is in stock at **${stores.length} SAQ stores**.`,
      `Store IDs: ${stores.map((s) => s.storeId).join(', ')}`,
      '',
      `Find a store near you: https://www.saq.com/en/store-locator`,
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

// ── set_location_filter / clear_location_filter ───────────────────────────────
server.tool(
  'set_location_filter',
  'Restrict restock alerts to SAQ stores within a radius of a city or coordinates. Applies to both individual SKU watching and watch-all catalog scans.',
  {
    city: z.string().optional().describe('City name (e.g. "Montréal", "Québec", "Laval"). Used to compute the center point.'),
    radius_km: z.number().min(1).max(500).optional().default(30).describe('Radius in km around the center point (default: 30)'),
    lat: z.number().optional().describe('Latitude of center — use instead of city for a precise location'),
    lng: z.number().optional().describe('Longitude of center — use instead of city for a precise location'),
  },
  async (args) => {
    if (!args.city && (args.lat === undefined || args.lng === undefined)) {
      return { content: [{ type: 'text', text: 'Provide either a city name or lat+lng coordinates.' }] };
    }

    const allStores = await getStoreDirectory();
    let lat: number, lng: number, label: string;

    if (args.city) {
      const cityStores = findStoresByCity(allStores, args.city);
      if (cityStores.length === 0) {
        // Fuzzy suggestion
        const cities = [...new Set(allStores.map((s) => s.city))].sort();
        const close = cities.filter((c) =>
          c.toLowerCase().includes(args.city!.toLowerCase().slice(0, 4)),
        );
        return {
          content: [
            {
              type: 'text',
              text: `No SAQ stores found in "${args.city}".${close.length ? `\n\nDid you mean: ${close.slice(0, 8).join(', ')}?` : ''}`,
            },
          ],
        };
      }
      const center = centroid(cityStores);
      lat = center.lat;
      lng = center.lng;
      label = `${args.city} (${args.radius_km} km)`;
    } else {
      lat = args.lat!;
      lng = args.lng!;
      label = `${lat.toFixed(4)}, ${lng.toFixed(4)} (${args.radius_km} km)`;
    }

    const radiusKm = args.radius_km ?? 30;
    const localIds = getLocalStoreIds(allStores, lat, lng, radiusKm);

    if (localIds.size === 0) {
      return {
        content: [{ type: 'text', text: `No SAQ stores found within ${radiusKm} km of ${label}. Try a larger radius.` }],
      };
    }

    // Sample nearest stores for confirmation
    const nearest = allStores
      .filter((s) => localIds.has(s.id))
      .map((s) => ({ ...s, dist: haversineKm(lat, lng, s.lat, s.lng) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);

    const filter: LocationFilter = { lat, lng, radiusKm, label, storeCount: localIds.size };
    const wl = loadWatchlist();
    const prevFilter = wl.locationFilter;
    wl.locationFilter = filter;
    saveWatchlist(wl);

    const filterChanged = prevFilter && filterKey(prevFilter) !== filterKey(filter);

    const lines = [
      `Location filter set: **${label}**`,
      `**${localIds.size} SAQ stores** are within ${radiusKm} km.`,
      '',
      'Nearest stores:',
      ...nearest.map((s) => `  - ${s.name}, ${s.city} (${s.dist.toFixed(1)} km)`),
      '',
      filterChanged
        ? 'Filter changed — the next watcher run will rebuild the local baseline before alerting.'
        : 'Ready. Run the watcher to start detecting local restocks.',
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'clear_location_filter',
  'Remove the geographic filter — restock alerts will cover all SAQ stores in Quebec',
  {},
  async () => {
    const wl = loadWatchlist();
    if (!wl.locationFilter) {
      return { content: [{ type: 'text', text: 'No location filter is set.' }] };
    }
    const prev = wl.locationFilter.label;
    delete wl.locationFilter;
    saveWatchlist(wl);
    return {
      content: [{ type: 'text', text: `Location filter cleared (was: ${prev}). Next watcher run will cover all Quebec stores.` }],
    };
  },
);

// ── watch_all / unwatch_all ───────────────────────────────────────────────────
server.tool(
  'watch_all',
  'Enable full-catalog restock monitoring. The daily watcher will scan every SAQ product and alert on any store count increase or availability improvement.',
  {},
  async () => {
    const wl = loadWatchlist();

    if (wl.watchAll) {
      const snapshot = loadCatalogSnapshot();
      const snapshotAge = snapshot
        ? `Last scan: ${new Date(snapshot.scannedAt).toLocaleString('en-CA')} (${snapshot.productCount} products)`
        : 'No baseline yet — run the watcher to build one.';
      return {
        content: [{ type: 'text', text: `Watch-all is already enabled.\n${snapshotAge}` }],
      };
    }

    wl.watchAll = true;
    saveWatchlist(wl);

    return {
      content: [
        {
          type: 'text',
          text: [
            'Watch-all enabled.',
            '',
            'The next watcher run will scan the full SAQ catalog (~12 000 products) and save a baseline.',
            'Restocks will be detected on the run after that.',
            '',
            'Run now:',
            `  node ${WATCHER_BIN} --notify`,
            '',
            'Or install the daily launchd agent:',
            `  bash ${INSTALL_SCRIPT}`,
          ].join('\n'),
        },
      ],
    };
  },
);

server.tool(
  'unwatch_all',
  'Disable full-catalog restock monitoring (catalog snapshot is kept on disk)',
  {},
  async () => {
    const wl = loadWatchlist();
    if (!wl.watchAll) {
      return { content: [{ type: 'text', text: 'Watch-all is not enabled.' }] };
    }
    wl.watchAll = false;
    saveWatchlist(wl);
    return { content: [{ type: 'text', text: 'Watch-all disabled. Individually watched products are unaffected.' }] };
  },
);

// ── watch_product ─────────────────────────────────────────────────────────────
server.tool(
  'watch_product',
  'Add a SAQ product to the restock watchlist. The watcher will alert when it becomes available at new stores.',
  {
    sku: z.string().describe('SAQ product code / SKU to watch'),
  },
  async (args) => {
    const saq = await getClient();
    const product = await saq.getProductBySku(args.sku);

    if (!product) {
      return {
        content: [{ type: 'text', text: `Product not found: ${args.sku}` }],
      };
    }

    const wl = loadWatchlist();

    if (wl.products[product.sku]) {
      return {
        content: [
          {
            type: 'text',
            text: `Already watching **${product.name}** (${product.sku}) — currently in ${wl.products[product.sku].storeSnapshot.length} stores.`,
          },
        ],
      };
    }

    const entry: WatchedProduct = {
      sku: product.sku,
      name: product.name,
      price: product.price,
      url: product.url,
      addedAt: new Date().toISOString(),
      storeSnapshot: product.storeIds ?? [],
      availabilitySnapshot: product.availability ?? '',
      lastChecked: new Date().toISOString(),
      lastRestockAt: null,
      lastRestockDelta: null,
    };

    wl.products[product.sku] = entry;
    saveWatchlist(wl);

    return {
      content: [
        {
          type: 'text',
          text: [
            `Now watching **${product.name}** (${product.sku})`,
            `Current snapshot: ${entry.storeSnapshot.length} stores · ${entry.availabilitySnapshot || 'unknown availability'}`,
            `Price: $${product.price.toFixed(2)}`,
            ``,
            `Run the watcher to detect restocks:`,
            `  node ${WATCHER_BIN} --notify`,
          ].join('\n'),
        },
      ],
    };
  },
);

// ── unwatch_product ───────────────────────────────────────────────────────────
server.tool(
  'unwatch_product',
  'Remove a product from the restock watchlist',
  {
    sku: z.string().describe('SAQ product code / SKU to stop watching'),
  },
  async (args) => {
    const wl = loadWatchlist();
    const entry = wl.products[args.sku];

    if (!entry) {
      return {
        content: [{ type: 'text', text: `SKU ${args.sku} is not in the watchlist.` }],
      };
    }

    delete wl.products[args.sku];
    saveWatchlist(wl);

    return {
      content: [{ type: 'text', text: `Removed **${entry.name}** (${args.sku}) from watchlist.` }],
    };
  },
);

// ── list_watched ──────────────────────────────────────────────────────────────
server.tool(
  'list_watched',
  'Show all products on the restock watchlist with their current snapshot status',
  {},
  async () => {
    const wl = loadWatchlist();
    const entries = Object.values(wl.products);
    const snapshot = loadCatalogSnapshot();

    const header: string[] = [];
    if (wl.watchAll) {
      const snapshotInfo = snapshot
        ? `baseline: ${snapshot.productCount} products, scanned ${new Date(snapshot.scannedAt).toLocaleString('en-CA')}`
        : 'no baseline yet — run watcher to build one';
      header.push(`**Watch-all: ON** (${snapshotInfo})`);
    } else {
      header.push('**Watch-all: OFF**');
    }

    if (entries.length === 0 && !wl.watchAll) {
      return {
        content: [
          {
            type: 'text',
            text: [
              ...header,
              '',
              'No individually watched products. Use `watch_product` or `watch_all`.',
            ].join('\n'),
          },
        ],
      };
    }

    const lines = [
      ...header,
      '',
      entries.length > 0 ? `**${entries.length} individually watched product(s)**` : '',
      '',
      ...entries.map((e) => {
        const checkedStr = e.lastChecked
          ? new Date(e.lastChecked).toLocaleString('en-CA')
          : 'never';
        const restockStr = e.lastRestockAt
          ? `last restock: ${new Date(e.lastRestockAt).toLocaleString('en-CA')} (+${e.lastRestockDelta} stores)`
          : 'no restock detected yet';
        return [
          `**${e.name}** (${e.sku}) — $${e.price.toFixed(2)}`,
          `  Stores: ${e.storeSnapshot.length} · ${e.availabilitySnapshot || 'unknown'}`,
          `  Checked: ${checkedStr} · ${restockStr}`,
          `  ${e.url}`,
        ].join('\n');
      }),
    ];

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

// ── check_restocks ────────────────────────────────────────────────────────────
server.tool(
  'check_restocks',
  'Check all watched products for restock events right now. Compares current SAQ availability against saved snapshots.',
  {
    notify: z
      .boolean()
      .optional()
      .default(false)
      .describe('Send a macOS notification for each restock detected'),
  },
  async (args) => {
    const wl = loadWatchlist();
    const skus = Object.keys(wl.products);

    if (skus.length === 0) {
      return {
        content: [{ type: 'text', text: 'Watchlist is empty. Nothing to check.' }],
      };
    }

    const saq = await getClient();
    const restocks = [];
    const noChange = [];
    const errors = [];

    for (const sku of skus) {
      const watched = wl.products[sku];
      try {
        const product = await saq.getProductBySku(sku);

        if (!product) {
          errors.push(`${sku}: not found in catalog`);
          continue;
        }

        const currentStoreIds = product.storeIds ?? [];
        const currentAvailability = product.availability ?? '';
        const event = detectRestock(watched, currentStoreIds, currentAvailability);

        // Update snapshot
        wl.products[sku] = {
          ...watched,
          name: product.name,
          price: product.price,
          storeSnapshot: currentStoreIds,
          availabilitySnapshot: currentAvailability,
          lastChecked: new Date().toISOString(),
          lastRestockAt: event ? new Date().toISOString() : watched.lastRestockAt,
          lastRestockDelta: event ? event.newStoreIds.length : watched.lastRestockDelta,
        };

        if (event) {
          restocks.push({ event, product });
          if (args.notify) {
            try {
              const { execSync } = await import('child_process');
              const title = `SAQ Restock: ${event.name}`;
              const body =
                event.newStoreIds.length > 0
                  ? `Now in ${event.currentStoreCount} stores (+${event.newStoreIds.length}) · $${event.price.toFixed(2)}`
                  : `${event.previousAvailability} → ${event.currentAvailability}`;
              execSync(
                `osascript -e 'display notification "${body.replace(/'/g, '"')}" with title "${title.replace(/'/g, '"')}" sound name "Ping"'`,
                { stdio: 'ignore' },
              );
            } catch {}
          }
        } else {
          noChange.push(`${product.name} (${sku}) — ${currentStoreIds.length} stores, no change`);
        }
      } catch (err) {
        errors.push(`${sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    saveWatchlist(wl);

    const lines: string[] = [];

    if (restocks.length > 0) {
      lines.push(`## 🔔 ${restocks.length} Restock(s) Detected\n`);
      restocks.forEach(({ event }) => {
        const storeDiff =
          event.newStoreIds.length > 0
            ? `${event.previousStoreCount} → ${event.currentStoreCount} stores (+${event.newStoreIds.length} new)`
            : `availability changed`;
        lines.push(
          [
            `**${event.name}** (${event.sku})`,
            `  Price: $${event.price.toFixed(2)}`,
            `  Stores: ${storeDiff}`,
            `  Status: ${event.currentAvailability}`,
            `  URL: ${event.url}`,
          ].join('\n'),
        );
      });
      lines.push('');
    }

    if (noChange.length > 0) {
      lines.push(`## No Change (${noChange.length})\n`);
      noChange.forEach((s) => lines.push(`- ${s}`));
      lines.push('');
    }

    if (errors.length > 0) {
      lines.push(`## Errors (${errors.length})\n`);
      errors.forEach((s) => lines.push(`- ${s}`));
    }

    if (restocks.length === 0 && noChange.length > 0) {
      lines.unshift(`Checked ${skus.length} product(s) — no restocks detected.\n`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  },
);

// ── setup_cellartracker ───────────────────────────────────────────────────────
server.tool(
  'setup_cellartracker',
  'Configure CellarTracker credentials so the daily email includes community scores and average prices. ' +
  'Credentials are saved to ~/.saq-mcp/cellartracker.json and used only by the watcher daemon.',
  {
    username: z.string().describe('Your CellarTracker username'),
    password: z.string().describe('Your CellarTracker password'),
  },
  async ({ username, password }) => {
    const valid = await validateCtCredentials(username, password);
    if (!valid) {
      return {
        content: [{
          type: 'text',
          text: '❌ Could not authenticate with CellarTracker. Please check your username and password.',
        }],
      };
    }
    saveCtConfig({ username, password });
    return {
      content: [{
        type: 'text',
        text: [
          '✅ CellarTracker credentials saved.',
          '',
          'The next daily email will include:',
          '  • Community score (CT 92/100)',
          '  • Number of community tasting notes',
          '  • Average community price (USD)',
          '  • Link to the CellarTracker wine page',
          '',
          'Scores are looked up at email-send time (only for products that triggered an alert, ' +
          'not the full catalog) and cached for 7 days.',
        ].join('\n'),
      }],
    };
  },
);

server.tool(
  'cellartracker_status',
  'Show whether CellarTracker enrichment is configured for the daily email.',
  {},
  async () => {
    const config = loadCtConfig();
    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'CellarTracker is not configured. Use `setup_cellartracker` to add your credentials.',
        }],
      };
    }
    return {
      content: [{
        type: 'text',
        text: `✅ CellarTracker configured for user: ${config.username}`,
      }],
    };
  },
);

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[saq-mcp] Server started\n');
}

main().catch((err) => {
  process.stderr.write(`[saq-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
