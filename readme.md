# SolarSiteIQ

Multi-factor solar farm siting demo — map UI with ranked parcels and per-site factor breakdown.

## Run locally

`fetch()` requires HTTP. Do not open `index.html` via `file://`.

```bash
npx serve .
```

Open the URL printed in the terminal (usually http://localhost:3000).

## Live endpoint vs mock fallback

Site data is loaded by `loadSites()` in `app.js`.

At the top of `app.js`:

```js
const LIVE_ENDPOINT_URL = "";
```

- **Empty (default):** loads `data/mockSites.json` silently. Console: `SolarSiteIQ data source: mock (LIVE_ENDPOINT_URL empty)`
- **Set to Flash URL:** tries the live endpoint first (3 second timeout). On success, console: `SolarSiteIQ data source: live endpoint`
- **Live fails** (timeout, network error, bad JSON, invalid shape): falls back to mock with no UI error. Console: `SolarSiteIQ live fetch failed...` then `SolarSiteIQ data source: mock fallback`

The live response must match the mock JSON shape (`county`, `center`, `sites[]` with `id`, `lat`, `lng`, `score`, `rank`, `factors`, `verdict`, etc.). The rest of the app does not care which source was used.

### Point at the real Flash endpoint

1. Open `app.js`
2. Set `LIVE_ENDPOINT_URL` to Person 2's endpoint, e.g. `"https://your-runpod-flash-url/score"`
3. Save and refresh — no other code changes needed

## Demo fallback — do not delete

**Keep `data/mockSites.json` in the repo permanently.** It is the demo safety net if the live Flash endpoint is down, slow, or misconfigured during the presentation. The UI must always work with this file alone.
