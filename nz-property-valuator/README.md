# NZ Property Valuator

A Chrome Extension (Manifest V3) that overlays property valuation data directly onto NZ real estate listing pages.

## Purpose

When browsing a property listing on TradeMe, the extension injects a panel showing valuation estimates sourced from third-party NZ property data providers (homes.co.nz, propertyvalue.co.nz, OneRoof, etc.), giving buyers quick context without leaving the page.

## Supported sites

| Site | Role |
|------|------|
| trademe.co.nz | Primary listing surface (content script injected here) |
| homes.co.nz | Valuation data source |
| propertyvalue.co.nz | Valuation data source |
| oneroof.co.nz | Valuation / market data source |

## Project structure

```
nz-property-valuator/
├── manifest.json      # Extension manifest (MV3)
├── content.js         # Content script — scrapes listing & renders panel
├── background.js      # Service worker — fetches valuation data, manages state
├── panel.css          # Styles for the injected valuation panel
├── popup.html         # Browser-action popup UI
├── popup.js           # Popup logic
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

## Loading in Chrome (development)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. Navigate to any `https://www.trademe.co.nz/a/*` property listing

## Status

Skeleton only — no logic implemented yet.
