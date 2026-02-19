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

# No plain XHR endpoints detected via static HTML inspection.
# The site uses Next.js React Server Components (RSC): all property and valuation
# data is streamed as serialised JSON inside <script> tags of the form:
#   self.__next_f.push([...])
# There are NO separate REST/GraphQL XHR calls to intercept for the estimate value;
# the data arrives inline with the page HTML.

# Static assets / CDN:
https://assets.oneroof.co.nz/...
https://s.oneroof.co.nz/...

# TODO: Open the estimate page in DevTools (Network → Fetch/XHR) while typing an
# address to capture any autocomplete or property-lookup calls.
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
# ⚠️  No stable CSS selector found.
#
# Valuation data (OneRoof estimate + low/high range + council RV) is embedded
# inside Next.js RSC serialised state, not in a plain DOM element:
#
#   self.__next_f.push([...large JSON blob...])
#
# Approach: parse the page HTML, extract the __next_f script blocks, JSON-parse
# the payload, and walk the React component tree to find the estimate node.
#
# Observed display format on property pages (e.g. qeHJ8):
#   OneRoof estimate:  $1.43M  (labelled "High Accuracy")
#   Low:               $1.29M
#   High:              $1.57M
#   Rating valuation:  $1.5M   (Auckland City Council, 2024)
#
# TODO: Confirm with DevTools whether a simpler selector exists after hydration,
# e.g. something like [class*="estimate"] or [class*="valuation"].
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
CORS policy on these is TODO; the main page HTML should be accessible without CORS issues.
- TODO: Test whether a server-side `fetch()` (no browser headers) returns the full
RSC payload or a stripped/bot-blocked response.

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

