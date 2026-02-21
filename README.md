# NZ Property Valuator

A Chrome Extension (Manifest V3) that overlays property valuation data directly onto NZ real estate listing pages.

## Purpose

When browsing a property listing on TradeMe, OneRoof, or RealEstate.co.nz, the extension injects a panel showing valuation estimates sourced from third-party NZ property data providers (homes.co.nz, propertyvalue.co.nz, OneRoof, RealEstate.co.nz), giving buyers quick context without leaving the page.

## Supported sites

| Site | Role |
|------|------|
| trademe.co.nz | Listing surface (content script injected here) |
| oneroof.co.nz | Listing surface + valuation data source |
| realestate.co.nz | Listing surface + valuation data source |
| homes.co.nz | Valuation data source |
| propertyvalue.co.nz | Valuation data source |

## Project structure

```
nz-property-valuator/
├── manifest.json        # Extension manifest (MV3)
├── background.js        # Service worker — fetches valuation data, manages cache
├── content.js           # Content script — renders the valuation panel
├── addressMatcher.js    # Shared address parsing and matching utilities
├── panel.css            # Styles for the injected valuation panel (Shadow DOM)
├── popup.html           # Browser-action popup UI
├── popup.js             # Popup logic (toggles, status, cache clear)
├── sites/
│   ├── trademe.js       # TradeMe adapter (address extraction + panel anchor)
│   ├── oneroof.js       # OneRoof adapter
│   └── realestate.js    # RealEstate.co.nz adapter
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
4. Navigate to any property listing on TradeMe, OneRoof, or RealEstate.co.nz

## Status

Fully functional. All four valuation sources (OneRoof, homes.co.nz, PropertyValue, RealEstate.co.nz) are implemented and active across all three supported listing sites.

## Support

If this extension saves you time, [☕ buy me a coffee](https://buymeacoffee.com/YOUR_USERNAME) — it's appreciated but never expected.
