# Calendar Display

A Cloudflare Worker that fetches a `.ics` calendar file from Nextcloud via WebDAV and renders it as a styled HTML calendar page for fire station display screens. The calendar file is exported from Outlook automatically when Outlook opens and synced to Nextcloud via the Nextcloud desktop app — no technical knowledge is required to keep the calendar current.

The `wide` and `full` layouts also fetch live NWS weather data and display it alongside the calendar: daily high/low temperatures and conditions in every column header, an hourly forecast strip in the today panel, and active/upcoming weather alert banners and badges.

## System Documentation
Full system documentation is maintained at: https://github.com/wehnerb/ffd-display-system-documentation

## Live URLs

| Environment | URL |
|-------------|-----|
| Production  | `https://calendar-display.bwehner.workers.dev/` |
| Staging     | `https://calendar-display-staging.bwehner.workers.dev/` |

## URL Parameters

| Parameter | Default | Options | Description |
|-----------|---------|---------|-------------|
| `layout`  | `wide`  | `full`, `wide`, `split`, `tri` | Column width matching display hardware. The "FFD Calendar" title label is only shown in the `full` layout — other layouts have a built-in title bar provided by the display system. NWS weather features are only shown in `wide` and `full` layouts. |

### Example URLs

```
# Wide layout (default) — includes NWS weather
https://calendar-display.bwehner.workers.dev/

# Full-screen display with FFD Calendar title label — includes NWS weather
https://calendar-display.bwehner.workers.dev/?layout=full

# Two-column strip layout — no weather
https://calendar-display.bwehner.workers.dev/?layout=split

# Three-column strip layout — no weather
https://calendar-display.bwehner.workers.dev/?layout=tri
```

### Layout Dimensions

| Layout  | Width (px) | Height (px) | Use Case |
|---------|------------|-------------|----------|
| `full`  | 1920       | 1075        | Full-screen display with FFD Calendar title |
| `wide`  | 1735       | 720         | Single-column display (default) |
| `split` | 852        | 720         | Two-column display |
| `tri`   | 558        | 720         | Three-column display |

-----

## How It Works

1. The Worker checks the Workers Cache API for a previously rendered page matching the requested layout. If a valid cached response exists, it is returned immediately.
1. On a cache miss, the Worker fetches data. For `split` and `tri` layouts, only the ICS file is fetched. For `wide` and `full` layouts, the ICS file and all three NWS endpoints are fetched in parallel using `Promise.all` to minimize total latency.
1. The raw ICS text is fetched server-side from Nextcloud via WebDAV. The display browser never contacts Nextcloud directly.
1. The ICS file is parsed into structured event objects. Windows timezone names emitted by Exchange (e.g. `"Central Standard Time"`) are automatically mapped to IANA timezone identifiers.
1. Filter rules are applied to remove unwanted events before rendering.
1. A self-contained HTML page is returned and stored in the Workers Cache API for `CACHE_SECONDS` seconds.
1. The `meta http-equiv="refresh"` interval is set to `CACHE_SECONDS`, so the display reloads approximately in sync with the cache expiry.

If any NWS fetch fails, the calendar renders without weather data rather than showing an error page.

-----

## Layout Designs

Two visual designs are used depending on the layout parameter:

**Split view (`wide` / `full`)** — A CSS grid layout with all column headers in row 1 and all column bodies in row 2. Row 1 automatically sizes to the tallest header across all columns so all headers are always the same height regardless of content. The left column (today) shows a narrow hourly weather strip on the left side of the body and stacked events (time above title) on the right. The remaining columns show the next N-1 days with daily weather in their headers. Active NWS alerts appear as colored banners above all columns.

**Strip view (`split` / `tri`)** — A compact chronological list grouped by day, designed for narrower display columns. No weather data is shown. All-day banners appear above timed events for each day.

-----

## NWS Weather Features (wide / full layouts only)

Weather data is fetched from the National Weather Service public API (`api.weather.gov`) on every cache miss. No API key is required. All fetches use the `NWS_USER_AGENT` value set in `wrangler.toml` as required by the NWS API terms.

### Daily Forecast — Column Headers
Every column header (today and each upcoming day) shows:
- **H / L temperatures** — high in orange, low in blue. If only one period is available (e.g. today's daytime period has passed), only that value is shown.
- **Condition** — a small color-coded dot followed by the NWS short forecast text (e.g. "Heavy Snow And Patchy Blowing Snow"). The dot color encodes the weather category at a glance.
- **Wind** — direction and speed range.

### Dot Color Reference

| Color | Conditions |
|-------|------------|
| Yellow `#f0c040` | Sunny, clear, mostly sunny, mostly clear |
| Soft yellow `#c8a830` | Partly cloudy, partly sunny |
| Amber `#f0a040` | Thunderstorm |
| Light blue `#a8d8f0` | Snow, blizzard |
| Blue-purple `#a0b0e0` | Wintry mix, sleet, freezing rain, freezing drizzle |
| Bright blue `#60b0f0` | Rain, showers, drizzle |
| Gray-blue `#b0c4d4` | Cloudy, overcast, fog, haze, mist, wind, default |

### Hourly Forecast — Today Panel Strip
A narrow strip on the left side of the today panel body shows remaining hours of today at `WEATHER_HOUR_INTERVAL`-hour intervals (default every 2 hours). Each slot shows the hour label ("NOW", "2 PM", etc.), temperature, and an inline SVG weather icon. The number of slots displayed is automatically capped so no slot is clipped by the panel boundary.

SVG weather icons are used instead of emoji to ensure correct rendering on display hardware that may not have an emoji font installed. Icons are geometric shapes — sun with rays, cloud shapes, rain lines, snow dots, a lightning bolt, fog lines, and wind curves — rendered in the same color palette as the dot indicators.

### Alert Banners — Active Alerts
When NWS has active weather alerts for Cass County (zone NDZ039), a full-width colored banner appears above the panel row for each alert, sorted by severity (Extreme → Severe → Moderate → Minor). Each banner shows the alert name and expiry time. The expiry time is taken from the `ends` field (actual weather event end) rather than the `expires` field (when NWS will issue the next product update), so the displayed time matches what other weather services show.

Banner colors:
- Red — Extreme / Severe (Warning)
- Orange — Moderate (Watch)
- Yellow — Minor (Advisory)

Active alert banners expire automatically. The next page cache refresh (up to 15 minutes after the alert ends) will omit any alert whose `expires` time has passed.

### Alert Badges — Future Alerts
Upcoming alerts that have not yet begun appear as colored severity pills in the affected day's column header. A multi-day alert appears in every overlapping day's header. All column headers always render the same number of badge rows (real badges + invisible placeholders) so header heights remain uniform.

-----

## All-Day Events

All-day events are displayed as colored banners at the top of each day. Specific event titles can be assigned custom colors using the `ALLDAY_COLORS` configuration constant. Events with a defined `ALLDAY_COLORS` entry always sort above other all-day events regardless of their order in the ICS file. Events not listed in `ALLDAY_COLORS` use the default blue banner style.

Current custom colors:

| Event    | Background | Style |
|----------|------------|-------|
| A Shift  | Dark green | Green text and border |
| B Shift  | Off-white  | Dark text, grey border |
| C Shift  | Dark red   | Red text and border |

-----

## Managing the Calendar

The calendar is updated automatically each time you log into the department computer. The process runs without any manual steps:

1. Outlook opens and a VBA macro runs automatically, exporting the next 30 days of the FFD Calendar public folder to `U:\Fire\BWehner\FFD Calendar Export\FFD Calendar Calendar.ics`.
1. The Nextcloud desktop app syncs the FFD Calendar Export folder to Nextcloud automatically.
1. The Worker fetches the updated file from Nextcloud on the next cache expiry (within 15 minutes).

### Manually Updating the Calendar

If the calendar needs to be updated outside of a normal login (e.g. after a significant change was made mid-day):

1. Open the VBA editor in Outlook (Developer tab → Visual Basic).
2. Click anywhere inside `Application_Startup` and press **F5** to run the macro manually.
3. The Nextcloud desktop app will sync the updated file automatically within a few seconds.

The Worker will pick up the new file within 15 minutes. To force an immediate cache refresh, increment `CACHE_VERSION` in `src/index.js` by 1, deploy to staging, test, and merge to main.

-----

## Event Filtering

Events can be excluded from the display using two filter arrays in `src/index.js`:

**`FILTER_EXACT`** — The event title must match the filter string exactly (case-insensitive). Use this for titles that could appear as substrings of legitimate event names. For example, `'A Shift'` will not filter `'A Shift Overtime'`.

**`FILTER_CONTAINS`** — The event title must contain the filter string anywhere (case-insensitive). Use this for broad categories where any event containing the phrase should be hidden.

To temporarily disable a filter without removing it, add `//` to the beginning of its line.

-----

## Configuration

The top of `src/index.js` contains all values that may need to be changed. No other section should require editing for routine operation.

### Calendar Settings

| Constant | Default | Description |
|----------|---------|-------------|
| `DAYS_TO_SHOW` | `6` | Number of days to display starting from today. `wide`/`full`: today panel + next N-1 columns. `split`/`tri`: total days in the strip. |
| `CACHE_SECONDS` | `900` | Page auto-refresh interval in seconds. 900 = 15 minutes. Also controls the Workers Cache API TTL. |
| `CACHE_VERSION` | *(current)* | Increment this integer to immediately invalidate all cached pages. Use after any configuration change that affects the rendered output. |
| `DEFAULT_LAYOUT` | `'wide'` | Layout used when no `?layout=` parameter is provided. |
| `ERROR_RETRY_SECONDS` | `60` | How long the error page waits before auto-retrying. |
| `FILTER_EXACT` | See code | Event titles that must match exactly to be excluded. |
| `FILTER_CONTAINS` | See code | Substrings that cause an event to be excluded if found anywhere in the title. |
| `ALLDAY_COLORS` | See code | Custom banner colors for specific all-day events, keyed by title (case-insensitive). |

### NWS Weather Settings

| Constant | Default | Description |
|----------|---------|-------------|
| `NWS_OFFICE` | `'FGF'` | NWS forecast office identifier for Fargo, ND. |
| `NWS_GRID_X` | `65` | NWS forecast grid X coordinate for Fargo. Verified via `api.weather.gov/points/46.8772,-96.7898`. |
| `NWS_GRID_Y` | `57` | NWS forecast grid Y coordinate for Fargo. |
| `NWS_ALERT_ZONE` | `'NDZ039'` | NWS public zone code for Cass County, ND — used for the alerts endpoint. |
| `WEATHER_HOUR_INTERVAL` | `2` | Hours between slots in the hourly strip. `2` = every other hour (NOW, 2 PM, 4 PM…). Increase to reduce crowding. |
| `WEATHER_STRIP_WIDTH` | `75` | Width in pixels of the hourly weather strip inside the today panel body. |
| `WEATHER_ICON_SIZE` | `18` | Size in pixels of SVG weather icons in the hourly strip. |
| `NWS_FORECAST_CACHE_SECONDS` | `3600` | Edge cache TTL for NWS daily and hourly forecasts. NWS updates these ~4 times per day and ~once per hour respectively. |
| `NWS_ALERTS_CACHE_SECONDS` | `900` | Edge cache TTL for NWS active alerts. Matches the page cache interval. |

`NWS_USER_AGENT` is set as a plain `[vars]` entry in `wrangler.toml` (not a secret — it appears in outbound request headers). It identifies the Worker to the NWS API as required by their terms of service.

-----

## Secrets

All credentials are stored as Cloudflare Worker secrets and GitHub Actions secrets. They are never present in source code.

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers edit permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID. |
| `NEXTCLOUD_URL` | Full WebDAV URL to the ICS file on Nextcloud. Format: `https://fileshare.fargond.gov/remote.php/dav/files/USERNAME/FFD%20Calendar%20Export/FFD%20Calendar%20Calendar.ics` |
| `NEXTCLOUD_USERNAME` | Nextcloud login username (shown when creating an app password — not the display name). |
| `NEXTCLOUD_PASSWORD` | Nextcloud app password. Generate at: Nextcloud → Settings → Security → Devices & sessions → Create new app password. Use an app password rather than the account password so it can be revoked independently. |

-----

## Automatic Calendar Export — Setup Reference

The calendar export system consists of two components. See `FFD Calendar Export Setup.txt` in `U:\Fire\BWehner\FFD Calendar Export\` for full setup instructions if this needs to be configured on a new computer.

| Component | Location | Purpose |
|-----------|----------|---------|
| Outlook VBA macro | Outlook VBA editor → ThisOutlookSession | Exports FFD Calendar to ICS on Outlook startup |
| Nextcloud desktop app | Installed on department computer | Syncs FFD Calendar Export folder to Nextcloud automatically |

-----

## Deployment

This repository uses two branches. All changes must go through staging before being merged to main.

| Branch    | Deploys To | Purpose |
|-----------|------------|---------|
| `staging` | `calendar-display-staging.bwehner.workers.dev` | Testing and validation |
| `main`    | `calendar-display.bwehner.workers.dev` | Live production environment |

GitHub Actions deploys automatically on every push to either branch via the `wrangler-action` workflow. Deployment takes approximately 30–45 seconds.

### Making a Change

1. Switch to the `staging` branch and edit `src/index.js`.
1. Commit — GitHub Actions will deploy to the staging Worker automatically.
1. Test the staging URL in a browser and on actual display hardware.
1. Create a Pull Request from `staging` → `main` and merge to deploy to production.

### Rolling Back

Use the Cloudflare dashboard **Deployments** tab for immediate stabilization, then use GitHub's Revert feature on the `main` branch to resync the repository.

-----

## Security Notes

- All credentials are stored as secrets — never in source code.
- Only `GET` requests are accepted. All other HTTP methods return `405`.
- URL parameters are sanitized before use.
- All calendar and weather content (event titles, locations, forecast text, alert names) is HTML-escaped before injection into pages to prevent XSS. SVG weather icon strings are generated entirely from safe hardcoded templates and are not escaped (they contain no user input).
- `X-Frame-Options` is intentionally **not** set — this Worker is loaded as a full-screen iframe by the display system. Adding `SAMEORIGIN` would cause immediate white screens on every station display.
- The ICS file is fetched server-side from Nextcloud. The display browser never contacts Nextcloud directly.
- A Nextcloud app password is used rather than the account password, so the credential can be revoked independently without affecting the Nextcloud account.
- `Cache-Control: no-store` is set on all HTML responses to prevent browser caching. The Workers Cache API handles server-side caching independently.
- NWS weather data is fetched from a public API requiring no credentials. The `NWS_USER_AGENT` value is non-sensitive and is stored as a plain `[vars]` entry in `wrangler.toml`.

-----

## Network Requirements

The display hardware must have outbound internet access on port 443 (HTTPS) to:
- `*.workers.dev` — Cloudflare Worker endpoints
- `api.weather.gov` — NWS weather data (fetched by the Worker on the server side, not by the display browser directly, but must be reachable from Cloudflare's network — no display-side access needed)

Note: `api.weather.gov` is contacted by the Cloudflare Worker on Cloudflare's network. The display screen itself does not need to reach it.
