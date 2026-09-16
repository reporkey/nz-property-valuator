# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project does

Chrome Extension (Manifest V3) that enriches TradeMe property listings with valuation estimates from three NZ property data sources: **OneRoof**, **homes.co.nz**, and **RealEstate.co.nz**.

All extension files live in the repo root. Load it unpacked from `chrome://extensions` (enable Developer mode, then Load unpacked → select the repo root folder). Navigate to a `https://www.trademe.co.nz/a/property/residential/sale/.../listing/...` listing to test. Rental, commercial and error pages must not activate the panel.

**No build step.** Plain browser JavaScript — no bundler or transpilation. `npm ci && npm test` runs development-only Node/jsdom regressions. After editing any file, go to `chrome://extensions` and click the reload icon (↺) for the extension, then refresh the TradeMe page. Service worker changes take effect on reload; content script changes take effect on page refresh; popup changes take effect immediately on next open.

## Architecture

```
content.js  ←→ (chrome.runtime messages) ←→  background.js
    ↓                                               ↓
Shadow DOM panel                           3 fetchers + cache
(panel.css)                                (in-memory, 30-min TTL)
```

**content.js** — uses site adapters for sale-only eligibility and address extraction. A 300 ms lifecycle check handles SPA navigation, delayed DOM updates, error rendering and panel removal. Only confirmed sale listings with a valid address activate the panel. The collapsible Shadow DOM panel is embedded after the adapter’s listing anchor. Wait for document load completion and reject insertion while the anchor’s ancestors or insertion area carry pending Angular `ngh` hydration markers; premature insertion caused TradeMe NG0500 crashes. The panel uses normal document flow, never a fixed overlay. Requests carry a unique `requestId`; streamed and final results are ignored after navigation, errors or superseding requests.

**background.js** — service worker. On `FETCH_VALUATIONS`: reads per-source toggles from `chrome.storage.sync`, runs all enabled fetchers with `Promise.allSettled()`, streams each result to the tab via `VALUATION_UPDATE` as it settles (so cards update incrementally), then sends the full final response and caches by `fullAddress`. On `CLEAR_CACHE`: wipes the in-memory `Map`. Fetch helpers: `fetchWithTimeout` (AbortController, 10 s default), `fetchWithBackoff` (exponential backoff on HTTP 429, up to 3 retries, ±400 ms jitter).

**popup.html / popup.js** — reads/writes `chrome.storage.sync` for per-source enabled toggles; reads `chrome.storage.local` for `fetchStatus` (last estimate + timestamp per source); sends `CLEAR_CACHE` message.

**panel.css** — loaded inside the Shadow DOM via `chrome.runtime.getURL('panel.css')`.

## Message protocol

| Type | Direction | Payload |
|------|-----------|---------|
| `FETCH_VALUATIONS` | content → background | `{ requestId, address: { streetAddress, suburb, city, fullAddress } }` |
| `VALUATION_UPDATE` | background → content (tab) | `{ requestId, result }` — sent once per source as it resolves |
| `CLEAR_CACHE` | popup → background | — |

Response to `FETCH_VALUATIONS`: `{ ok: true, results: [...], fromCache: bool }`

## Fetcher return shape

Each fetcher returns (never throws):
```js
{ source, estimate, url, error }
// estimate: formatted string e.g. "$1.43M" or "$920K – $1.04M", or null
// error: string describing the failure, or null on success
// disabled: true (only when source is toggled off — omit estimate/url/error)
```

## Per-source fetch flows

**OneRoof** (2-step + SHA-256 auth):
1. `GET /v2.6/address/search?isMix=1&key=<addr>&typeId=-100` — signed with `Authorization: Public <base64(key)>` + `Timestamp` + `Sign` (SHA-256 of char-frequency string of the URL + timestamp). Public credentials are embedded in OneRoof's own JS bundle.
2. `GET oneroof.co.nz/property/<slug>` — parse `self.__next_f.push([1,"..."])` RSC blocks for the `"avm":{...}` object.

**homes.co.nz** (2-step, requires spoofed headers):
1. `GET gateway.homes.co.nz/address/search?Address=<addr>` — must include `Origin: https://homes.co.nz` and `Referer: https://homes.co.nz/`.
2. `GET gateway.homes.co.nz/properties?property_ids=<uuid>` → `cards[0].property_details.display_estimated_{lower,upper}_value_short`.

**RealEstate.co.nz** (3-step, requires `Origin: https://www.realestate.co.nz`):
1. `GET platform.realestate.co.nz/search/v1/listings/smart?q=<addr>&filter[category][0]=res_sale` → `listing-id`.
2. `GET platform.realestate.co.nz/search/v1/listings/<id>` → `data.attributes['property-short-id']`.
3. `GET platform.realestate.co.nz/search/v1/properties/<short-id>` → `attributes['estimated-value'].{value-low, value-high, confidence-rating}`.

All fetchers use a **query cascade** (fullAddress → street+suburb → street only) with a street-name word guard to reject cross-suburb false positives.

## Coding conventions

- All console logs prefixed with `[NZ-Valuator]`
- `fmtAmount(n)` formats raw integers: `≥1M → "$X.XXM"`, `<1M → "$XXXK"`
- Never let one failed source break another — each fetcher is fully independent

## Storage

- `chrome.storage.sync` — `{ sources: { OneRoof: { enabled: bool }, ... } }`
- `chrome.storage.local` — `{ fetchStatus: { [source]: { ok, estimate, error, ts } } }`

## Common pitfalls

- **TradeMe DOM timing**: Angular renders asynchronously — always poll, never read DOM once at `document_idle`.
- **Suburb vs district**: TradeMe JSON-LD `addressLocality` = district (e.g. "Waitakere City"), not suburb. Always override from the URL slug.
- **OneRoof city in query**: Including the TradeMe region string (e.g. "Canterbury") in the OneRoof search query causes it to match unrelated streets. The cascade intentionally drops the city on later attempts.
- **Service worker lifecycle**: The service worker may be terminated between page loads, so the in-memory cache may be empty on revival — this is expected behaviour.
- **RESEARCH.md**: Contains confirmed live API endpoints, auth credentials (OneRoof's are public), response shapes, and anti-scraping notes for the supported sources. Consult it before changing any fetcher.
