# NZ Property Valuator – Site Research

Manual research notes gathered via browser DevTools / Network tab inspection.
Fill in each TODO before implementing any fetching logic.

---

## OneRoof (oneroof.co.nz)

### Base URL

```
https://www.oneroof.co.nz
```

### Search URL Pattern

```
# Regional listing search (browse):
https://www.oneroof.co.nz/search/houses-for-sale/region_<region-name>-<region-id>_page_<n>

# Examples:
https://www.oneroof.co.nz/search/houses-for-sale/region_auckland-35_page_1
https://www.oneroof.co.nz/search/houses-for-sale/region_all-new-zealand-1_page_1

# Estimate / map search (used to look up a specific address):
https://www.oneroof.co.nz/estimate/map/region_all-new-zealand-1
# Address lookup is handled client-side via the search component; no query-string
# parameter is present in the initial URL — the address is submitted via JS state.
```

### Known API Endpoints

```
# Official OpenAPI docs (JS-rendered Swagger/ReDoc UI — open in browser):
https://docs.oneroof.co.nz/openapi/index.html

# ────────────────────────────────────────────────────────────────────
# PUBLIC REST API — base URL:  https://www.oneroof.co.nz/v2.6/
# All calls must include these request headers (reconstructed from bundle):
#
#   Authorization:          Public <base64("B41n73ivbk-w0W8OyEkm1-whmnE9w66e:ps4z1a4c5J-NpDc6ujX67-YNyBgX8D7o")>
#   Timestamp:              <epoch milliseconds>
#   Sign:                   <SHA-256 of (char_frequency_string + timestamp)>
#   Content-Type:           application/json
#   Client:                 web
#   CF-Access-Client-Id:    6235e853dd3c95509c3a8568ac1de08b.access
#   CF-Access-Client-Secret:7b1f7775f9c1158c683e21a3178eeafb164696c4da426c9b2e2917477f3457e0
#
# Sign algorithm (from module 6036 in layout chunk):
#   1. Iterate chars of the full request URL string
#   2. Keep only [a-zA-Z0-9]; track distinct chars in first-appearance order
#   3. Build string: for each distinct char → char + total_count
#   4. Append epoch_ms timestamp
#   5. SHA-256 hex-digest of that string
# ────────────────────────────────────────────────────────────────────

# 1. Address autocomplete — PRIMARY ENDPOINT for property lookup
GET /v2.6/address/search?isMix=1&key=<query>&typeId=-100
# typeId=-100 is the Nn.estimate constant (module 69806); use for the estimate flow.
# → {
#     properties: [
#       { id: 1363845, slug: "auckland/remuera/10-mahoe-avenue/qeHJ8",
#         pureLabel: "10 Mahoe Avenue, Remuera, Auckland - City",
#         lat: -36.869213, lng: 174.802073, level: "property" }
#     ],
#     schools: []
#   }
# Confirmed live: HTTP 200, public auth headers only (no login cookie needed).
# The slug is the path fragment to build the property page URL:
#   https://www.oneroof.co.nz/property/<slug>

# 2. No direct estimate REST endpoint found.
#    All valuation data is embedded in the Next.js RSC page HTML (see below).
#    Fetching /v2.6/properties/<id> and /v2.6/estimate/<id> return HTTP 404.

# Static assets / CDN:
https://assets.oneroof.co.nz/...   # JS/CSS bundles
https://s.oneroof.co.nz/...        # Images; static-api-v2 CDN cache
```

### Property Page URL Pattern

```
https://www.oneroof.co.nz/property/<region>/<suburb>/<address-slug>/<property-id>

# Examples (confirmed via live search results):
https://www.oneroof.co.nz/property/auckland/remuera/10-mahoe-avenue/qeHJ8
https://www.oneroof.co.nz/property/auckland/mount-eden/93-halesowen-avenue/jlvQp
https://www.oneroof.co.nz/property/auckland/westmere/80-warnock-street/RoHzS

# Segments:
#   <region>      — lowercase region slug, e.g. "auckland", "wellington"
#   <suburb>      — lowercase suburb slug, e.g. "remuera", "mount-eden"
#   <address-slug>— kebab-case street address, e.g. "10-mahoe-avenue"
#   <property-id> — short alphanumeric hash, e.g. "qeHJ8"
```

### Valuation Estimate CSS Selector

```
# ⚠️  No CSS selector needed — parse RSC data from the page HTML directly.
#
# Valuation data (OneRoof estimate + low/high range + council RV) is embedded
# inside Next.js RSC serialised state, not in a stable DOM element.
# All data arrives inline with the initial HTML before any JS runs:
#
#   self.__next_f.push([1, "...large JSON blob..."])
#
# Confirmed approach (no headless browser required):
#   1. Autocomplete:  GET /v2.6/address/search?isMix=1&key=<addr>&typeId=-100
#      → extract properties[0].slug  (e.g. "auckland/remuera/10-mahoe-avenue/qeHJ8")
#   2. Property page: GET https://www.oneroof.co.nz/property/<slug>
#      (plain fetch, no special headers, HTTP 200 confirmed with curl)
#   3. Parse page HTML: extract all __next_f.push([1,"..."]) blocks, concatenate
#      the JSON strings, search for the "avm":{...} object.
#
# Confirmed AVM object shape (property qeHJ8, live 2025-02):
#   "avm": {
#     "avm":            "$1,425,000",   // display string incl. $
#     "high":           "$1,570,000",
#     "low":            "$1,285,000",
#     "rv":             "$1,500,000",   // council Rating Valuation
#     "rvTime":         1714478400,     // RV date as Unix epoch
#     "confidence":     4.5,            // 0–5 numeric score
#     "confidenceScore":"High",         // "Low"|"Medium"|"High"
#     "showAvm":        true
#   }
#
# The "$" prefix and commas are display artefacts — strip them for arithmetic.
# The avm field appears in RSC block 38 of 54 for property pages.
#
# Observed display format on property pages (e.g. qeHJ8):
#   OneRoof estimate:  $1.43M  (labelled "High Accuracy")
#   Low:               $1.29M
#   High:              $1.57M
#   Rating valuation:  $1.5M   (Auckland City Council, 2024)
```

### Anti-Scraping Measures

- **Next.js RSC streaming**: Data is not returned by a simple REST endpoint; it is
embedded inline as serialised React state. A plain `fetch()` of the page HTML
will include the data, but parsing it is non-trivial.
- **A/B testing**: Abtasty tracker present — page content may vary between sessions.
- **Analytics**: Google Tag Manager (GTM-58D24DV) — behavioural tracking in place.
- **No Cloudflare challenge** detected on basic property page fetches (as of research date).
- **No login required** for viewing estimate data on public property pages.
- **CDN assets** on separate origins (`assets.oneroof.co.nz`, `s.oneroof.co.nz`) —
CORS policy irrelevant; only the main HTML page and `/v2.6/` endpoints are fetched.
- **Server-side `fetch()` confirmed working**: a plain `curl` with no browser headers
returns HTTP 200 with the full RSC payload including AVM data (tested 2025-02, property
qeHJ8). No bot challenge observed.

### Notes

> - AVM (Automated Valuation Model) is provided by **Valocity** — mentioned in the
> "Valocity Disclaimers" section of `/property-valuations`.
> - The estimate gauge shows a confidence band (low / mid / high) plus the local
> council Rating Valuation (RV) for comparison.
> - Official API docs exist at `docs.oneroof.co.nz/openapi/index.html` but require
> JavaScript to render — check whether an unauthenticated API key is available.
> - Property IDs are short base-62 hashes (e.g. `qeHJ8`); the address slug and
> region/suburb are human-readable but the ID is the canonical identifier.

---

## PropertyValue (propertyvalue.co.nz)

### Base URL

```
https://www.propertyvalue.co.nz
```

### Search URL Pattern

```
# Hierarchical browse (region → district → suburb):
https://www.propertyvalue.co.nz/<region>
https://www.propertyvalue.co.nz/<region>/<district>/<suburb-id>

# Examples:
https://www.propertyvalue.co.nz/auckland
https://www.propertyvalue.co.nz/wellington
https://www.propertyvalue.co.nz/canterbury/christchurch-city/60

# Address autocomplete API (confirmed working, no auth required):
GET /api/public/clapi/suggestions?q=<address>&suggestionTypes=address&limit=5

# Example:
GET https://www.propertyvalue.co.nz/api/public/clapi/suggestions?q=14+Sefton+Street&suggestionTypes=address&limit=5
# Response 200: { "suggestions": [ { "propertyId": 7120741, "address": "...", ... } ] }
# Response 404: { "errors": [{ "msg": "No data found for your search." }] } when no match
```

### Known API Endpoints

```
# ✅ Full public REST API confirmed — no authentication required.
# All public endpoints are under:
#   https://www.propertyvalue.co.nz/api/public/clapi/
# (confirmed by reverse-engineering /main.d8e1ef19.js)

# 1. Address autocomplete
GET /api/public/clapi/suggestions?q=<query>&suggestionTypes=address&limit=5
# → { suggestions: [...] }

# 2. Property details — PRIMARY ENDPOINT (includes estimate, no auth needed)
GET /api/public/clapi/properties/<property-id>
# → {
#     propertyId:       7120741,
#     estimatedRange:   { lowerBand: 2200000, upperBand: 2400000, confidence: "MEDIUM" },
#     ratingValuation:  { capitalValue: "2370000", landValue: "1530000",
#                         improvementValue: "840000", valuationDate: "2024-09-01",
#                         valuationRef: "16851/36800", legalDescriptions: [...] },
#     core:             { beds, baths, carSpaces, landArea, ... },
#     location:         { locallyFormattedAddress, latitude, longitude, ... },
#     isForSale:        true,
#     propertyTimeline: [...],  // listing and sale history
#     sales:            { lastSale: {} }
#   }
# Confirmed live: HTTP 200, no auth, no session cookie required.

# 3. Resolve property page URL from integer ID
GET /api/public/clapi/properties/propertyUrl?propertyId=<id>
# → plain string path, e.g.:
#   "/wellington/wellington-city/wadestown-6012/14-sefton-street-...-7120741"
# Confirmed live: HTTP 200, no auth.

# 4. Property search (by location / address text)
GET /api/public/clapi/property/search
# Params: locationType, locationId, propertyAddress, recordsPerPage, pageNumber,
#         streetName, suburbName, councilArea, requestLocation
# (authenticated variant: /api/private/clapi/property/search)

# 5. Comparables
GET /api/public/clapi/comparables/<property-id>

# 6. Property trends
GET /api/public/clapi/property/trends/house-values
GET /api/public/clapi/property/trends/sales-prices
```

### Property Page URL Pattern

```
https://www.propertyvalue.co.nz/<region>/<district>/<suburb-postcode>/<address-slug>-<property-id>

# Examples (confirmed via live site):
https://www.propertyvalue.co.nz/wellington/wellington-city/wadestown-6012/14-sefton-street-wadestown-wellington-6012-7120741
https://www.propertyvalue.co.nz/wellington/upper-hutt-city/ebdentown-5018/5-victoria-street-ebdentown-upper-hutt-5018-8769929
https://www.propertyvalue.co.nz/otago/queenstown-lakes-district/jacks-point-9371/15-inder-street-jacks-point-9371-62817321

# Segments:
#   <region>          — lowercase region slug, e.g. "auckland", "wellington", "otago"
#   <district>        — lowercase district slug, e.g. "wellington-city", "queenstown-lakes-district"
#   <suburb-postcode> — suburb slug + postcode, e.g. "wadestown-6012"
#   <address-slug>    — full address as kebab-case, e.g. "14-sefton-street-wadestown-wellington-6012"
#   <property-id>     — plain integer from CoreLogic, e.g. "7120741"
```

### Valuation Estimate CSS Selector

```
# ✅ No CSS selector needed — use the REST API directly.
#
# Preferred approach (API):
#   1. Autocomplete: GET /api/public/clapi/suggestions?q=<address>&suggestionTypes=address&limit=5
#      → extract propertyId integer from suggestions[0].propertyId
#   2. Estimate:     GET /api/public/clapi/properties/<propertyId>
#      → read response.estimatedRange and response.ratingValuation
#
# Confirmed data shape (property 7120741, live):
#   estimatedRange: {
#     lowerBand:  2200000,   // integer, NZD
#     upperBand:  2400000,   // integer, NZD
#     confidence: "MEDIUM"   // "LOW" | "MEDIUM" | "HIGH"
#   }
#   ratingValuation: {
#     capitalValue:     "2370000",  // string, NZD
#     landValue:        "1530000",
#     improvementValue: "840000",
#     valuationDate:    "2024-09-01",
#     valuationRef:     "16851/36800"
#   }
#
# Fallback approach (HTML parsing):
#   Fetch property page URL → extract window.REDUX_DATA JSON blob (brace-match)
#   → parse data.PropertyDetails.estimatedRange (same shape as above)
#   Only needed if the API starts requiring auth.
```

### Anti-Scraping Measures

- **Imperva Incapsula WAF**: `/_Incapsula_Resource?SWJIYLWA=...` script injected on
  every page HTML. The `/api/public/clapi/*` endpoints returned HTTP 200 without
  browser cookies during research — Incapsula appears to protect the HTML UI layer,
  not the JSON API layer.
- **No Cloudflare** challenge detected on API or page fetches.
- **No login required** for `/api/public/clapi/*` endpoints (confirmed live).
- **CORS**: API responses include `X-CDN: Imperva` header; CORS policy on the JSON
  API endpoints needs testing from a Chrome extension `fetch()` context.
- **Analytics**: Google Tag Manager ×2 (GTM-WS5J7MD, GTM-W2GFLV8).
- **Convert.com A/B testing**: `cdn-4.convertexperiments.com` — affects UI only,
  not the API response structure.

### Notes

> - AVM data powered by **CoreLogic / Cotality** (`cotality.com/nz`) — same data
>   provider used by NZ banks and councils.
> - Property IDs are plain **integers** (CoreLogic IDs), e.g. `7120741`. Not hashes.
> - `robots.txt` has no Disallow rules — all paths permitted for crawlers.
> - The `/api/public/clapi/properties/<id>` endpoint returns the same data as
>   `window.REDUX_DATA.PropertyDetails` in the SSR HTML — both approaches are valid.

