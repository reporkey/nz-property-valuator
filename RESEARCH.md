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

## homes.co.nz

### Base URL

```
https://homes.co.nz
https://gateway.homes.co.nz   (API gateway — requires Origin/Referer spoofing)
```

### Known API Endpoints

```
# Address search — returns unit-level records only
GET https://gateway.homes.co.nz/address/search?Address=<query>
Headers: Origin: https://homes.co.nz, Referer: https://homes.co.nz/

# Property card (estimate + metadata) — only works with unit UUIDs
GET https://gateway.homes.co.nz/properties?property_ids=<uuid>
# → { cards: [ { id, url, property_details: { display_estimated_lower_value_short,
#              display_estimated_upper_value_short, display_address, unit_identifier,
#              street_number, street, suburb, city, ... } } ] }
# NOTE: building UUIDs return cards: [] — only unit UUIDs work.

# Estimate history — building-level estimate (authenticated / unavailable for apartments)
GET https://gateway.homes.co.nz/estimate/history/?month_limit=36
# Returns 503 for apartment buildings; may work for stand-alone houses (untested)

# Tracking — reveals the property UUID for the current page (building or unit)
POST https://gateway.homes.co.nz/track/<uuid>
```

### Property Page URL Pattern

```
# Unit page:
https://homes.co.nz/address/<city>/<suburb>/<unit>-<street-slug>/<shortId>
# Example: https://homes.co.nz/address/auckland/eden-terrace/4f-20-charlotte-street/Zo85p

# Building page (apartment block):
https://homes.co.nz/address/<city>/<suburb>/<street-slug>/<shortId>
# Example: https://homes.co.nz/address/auckland/eden-terrace/20-charlotte-street/M8qRVe
# The shortId is mandatory — the URL without it returns 200 (bare CSR shell, no __NEXT_DATA__)
# but no redirect to the full URL at the HTTP level.
```

### Apartment Building Research (20 Charlotte Street, Eden Terrace)

```
# ── Estimate availability ───────────────────────────────────────────────────
# CONFIRMED: homes.co.nz does NOT provide building-level estimates for apartments.
#
# gateway address search → returns ONLY unit records (all Type 4 with UnitIdentifier set).
#   Returns 14 units for "20 Charlotte Street, Eden Terrace" — no building record,
#   regardless of query length, comma format, or limit param.
#
# Building page /M8qRVe:
#   - estimate/history/?month_limit=36 → 503 (no estimate model for the building)
#   - /properties?property_ids=<building-uuid> → cards: [] (building UUIDs not valid here)
#   - HomesEstimate tab on page is empty
#
# Unit page /Zo85p (unit 4F):
#   - /properties?property_ids=dcd2980a-eadd-468b-a5da-a45dc0d293e8 → ✅ returns card
#   - display_estimated_lower_value_short: "390K"
#   - display_estimated_upper_value_short: "440K"
#   - display_address: "4F/20 Charlotte Street, Eden Terrace, Auckland"
#
# Unit card fields: id, item_id, property_id (all same UUID), url (unit URL with shortId),
#   property_details.unit_identifier, street_number, street, suburb, city,
#
# ── Building URL discoverability ────────────────────────────────────────────
# CONFIRMED: the building page URL is NOT discoverable via the public API from address alone.
#
# /property?url=<slug> endpoint:
#   - Resolves a full slug+shortId to a property card.
#   - /property?url=/auckland/eden-terrace/20-charlotte-street/M8qRVe → ✅ card (id: 4381544f)
#   - /property?url=/auckland/eden-terrace/20-charlotte-street (no shortId) → 404
#   - /property?url=/auckland/eden-terrace/20-charlotte-street/<unit-shortId> → "Property not found"
#     (shortIds are per-property, not per-slug — cannot reuse unit shortId for building)
#
# address/search result fields: Type, Score, Title, Lat, Long, DeliveryPointID (always 0),
#   UnitIdentifier, StreetNumber, StreetAlpha, City, Suburb, Street, StreetName, StreetType,
#   SuburbID, CityID, PropertyID (UUID) — NO url/shortId field.
#
# Unit property_details fields: no parent_url, building_url, parent_id, or building_id.
#
# INDIRECT PATH (gets you to building slug but not shortId):
#   1. address/search → unit UUID
#   2. /properties?property_ids=<uuid> → card.url (e.g. "/auckland/eden-terrace/4f-20.../Zo85p")
#   3. Strip unit prefix from slug → building slug "/auckland/eden-terrace/20-charlotte-street"
#   4. DEAD END: no API returns the building shortId; /property?url=<slug> needs it.
#
# CONCLUSION: building shortId is an opaque DB identifier with no derivation path from
#   address data. "No estimate found" for bare apartment queries is the correct behaviour.
#   display_estimated_{lower,upper,}_value_short, capital_value, display_capital_value_short
#
# CONCLUSION: For bare apartment-building address queries (no unit number),
#   homes.co.nz has no estimate to return. Strict Rule 2 (reject unit candidates when
#   query has no unit) is the correct behaviour — returning "No estimate found" is honest.
#   No building-level lookup path exists via the public API.
```

### Anti-Scraping Measures

- **CORS**: All gateway requests must include `Origin: https://homes.co.nz` and `Referer: https://homes.co.nz/` headers; otherwise CORS error.
- **No authentication required** for address search or `/properties` card endpoint.
- **CSR pages**: homes.co.nz property pages are client-side rendered — no `__NEXT_DATA__` and no SSR payload in the initial HTML.
- **Building page URL**: requires `shortId` (e.g. `M8qRVe`) — cannot be derived from address alone via any known public API endpoint.

