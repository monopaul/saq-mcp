# saq-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [SAQ.com](https://www.saq.com) (Société des alcools du Québec).

Search wines and spirits, track new arrivals, monitor restocks, and filter alerts by geographic area — all from Claude or any MCP-compatible client.

## Features

| Tool | Description |
|---|---|
| `search_products` | Full-text search with filters: category, country, region, grape, price, availability |
| `get_product` | Product details by SKU (country, region, grape, ABV, sugar, taste profile, rating, store count) |
| `get_new_arrivals` | Products sorted by arrival date, optionally filtered by category |
| `get_coming_soon` | Products with "Available shortly" or "Lottery soon" status |
| `check_store_availability` | Which stores currently carry a product |
| `watch_product` | Add a SKU to the restock watchlist |
| `unwatch_product` | Remove from watchlist |
| `watch_all` | Monitor the entire SAQ catalog (~35k products) for any restock |
| `unwatch_all` | Disable catalog-wide monitoring |
| `check_restocks` | Manually trigger a restock check for all watched products |
| `list_watched` | Show watchlist status and last snapshot |
| `set_location_filter` | Restrict restock alerts to stores within a radius of a city or coordinates |
| `clear_location_filter` | Remove geographic filter |

## How it works

SAQ's website runs on Adobe Commerce with the [Live Search](https://experienceleague.adobe.com/en/docs/commerce/live-search/overview) catalog service. On first run, a headless Chromium browser intercepts an outgoing request to `catalog-service.adobe.io` to extract the public API key, which is then cached locally. All subsequent calls go directly to the GraphQL endpoint — no browser overhead.

Restock detection compares each product's `store_availability_list` (a full list of store IDs returned inline by the search API) against a saved snapshot. A restock fires when new store IDs appear or availability status improves (e.g. *Sold out → In store*).

## Requirements

- Node.js 20+
- macOS (for the launchd agent; the MCP server itself is cross-platform)

## Installation

```bash
git clone https://github.com/MonoPaul/saq-mcp.git
cd saq-mcp
npm install
npx playwright install chromium   # one-time: downloads headless browser
npm run build
```

### Add to Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "saq": {
      "command": "node",
      "args": ["/path/to/saq-mcp/dist/index.js"]
    }
  }
}
```

### Schedule daily restock checks (macOS)

```bash
bash install.sh
```

This fills in the `com.saq-mcp.watcher.plist.template` with your local paths, writes it to `~/Library/LaunchAgents/`, and loads it with `launchctl`. The watcher runs daily at 05:30 and sends a macOS notification for any restock detected.

You can also run it manually at any time:

```bash
node dist/watcher.js --notify
```

## Geographic filtering

Restock alerts can be scoped to stores within a configurable radius:

```
# In Claude:
set_location_filter city="Montréal" radius_km=30
```

The city is geocoded using SAQ's own store directory (no external geocoding API). The filter applies to both individually watched products and the full catalog scan.

## Data stored locally

All runtime data lives in `~/.saq-mcp/`:

| File | Contents |
|---|---|
| `credentials.json` | Cached API key (extracted once from the SAQ website) |
| `watchlist.json` | Watched SKUs, store snapshots, location filter |
| `catalog-snapshot.json` | Full catalog snapshot for watch-all mode |
| `stores.json` | SAQ store directory with coordinates (refreshed weekly) |
| `restock.log` | Append-only log of every watcher run |

None of these files are committed to git.

## License

MIT
