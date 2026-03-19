# Calendar Display

A Cloudflare Worker that fetches a `.ics` calendar file from Google Drive and renders it as a styled HTML calendar page for fire station display screens. The calendar file is exported from Outlook and uploaded to a shared Google Drive folder — no technical knowledge is required to update the calendar.

## Live URLs

| Environment | URL |
|-------------|-----|
| Production  | `https://calendar-display.bwehner.workers.dev/` |
| Staging     | `https://calendar-display-staging.bwehner.workers.dev/` |

## URL Parameters

| Parameter | Default | Options | Description |
|-----------|---------|---------|-------------|
| `layout`  | `wide`  | `full`, `wide`, `split`, `tri` | Column width matching display hardware. The "Station Calendar" title label is only shown in the `full` layout — other layouts have a built-in title bar provided by the display system. |

### Example URLs

```
# Wide layout (default)
https://calendar-display.bwehner.workers.dev/

# Full-screen display with title label
https://calendar-display.bwehner.workers.dev/?layout=full

# Two-column split layout
https://calendar-display.bwehner.workers.dev/?layout=split

# Three-column layout
https://calendar-display.bwehner.workers.dev/?layout=tri
```

### Layout Dimensions

| Layout  | Width (px) | Height (px) | Use Case |
|---------|------------|-------------|----------|
| `full`  | 1920       | 1080        | Full-screen display |
| `wide`  | 1735       | 720         | Single-column display (default) |
| `split` | 852        | 720         | Two-column display |
| `tri`   | 558        | 720         | Three-column display |

-----

## How It Works

1. The Worker authenticates with Google using the shared service account (same account as `slide-timing-proxy` and `daily-message-display`), generating a short-lived OAuth2 access token.
1. The Worker searches the configured Google Drive folder for a file named exactly `FFD Calendar Calendar.ics`.
1. The raw ICS text is fetched from Google Drive server-side. The display browser never contacts Google directly.
1. The ICS file is parsed into structured event objects. Windows timezone names emitted by Exchange (e.g. `"Central Standard Time"`) are automatically mapped to IANA timezone identifiers.
1. Filter rules are applied to remove unwanted events before rendering.
1. A self-contained HTML page is returned. The `meta http-equiv="refresh"` interval is set to `CACHE_SECONDS` (default: 15 minutes).

-----

## Layout Designs

Two visual designs are used depending on the layout parameter:

**Split view (`wide` / `full`)** — A prominent left panel shows today's events with large time labels and full event details. The remaining days are shown as equal-width columns in a right panel. All-day events appear as colored banners at the top of each panel.

**Strip view (`split` / `tri`)** — A compact chronological list grouped by day, designed for narrower display columns. All-day banners appear above timed events for each day.

-----

## All-Day Events

All-day events are displayed as colored banners at the top of each day. Specific event titles can be assigned custom colors using the `ALLDAY_COLORS` configuration constant. Events not listed in `ALLDAY_COLORS` use the default blue banner style.

Current custom colors:

| Event    | Background | Style |
|----------|------------|-------|
| A Shift  | Dark green | Green text and border |
| B Shift  | Off-white  | Dark text, grey border |
| C Shift  | Dark red   | Red text and border |

-----

## Managing the Calendar

### Updating the Calendar

1. In Outlook 2016, open the calendar, go to **File → Save Calendar**.
1. Set the date range to the desired period and save the file.
1. Rename the file to exactly `FFD Calendar Calendar.ics`.
1. Open the **FFD Calendar** folder in Google Drive.
1. Delete the existing `FFD Calendar Calendar.ics` file.
1. Upload the new file into the same folder.

The Worker will pick up the new file automatically on its next refresh cycle (within 15 minutes).

### ICS File Requirements

- The file must be named exactly `FFD Calendar Calendar.ics` — the Worker searches for this exact filename.
- The file must be placed in the root of the **FFD Calendar** Google Drive folder — subfolders are not searched.
- The folder must remain shared with the service account email address.

-----

## Event Filtering

Events can be excluded from the display using two filter arrays in `src/index.js`:

**`FILTER_EXACT`** — The event title must match the filter string exactly (case-insensitive). Use this for titles that could appear as substrings of legitimate event names. For example, `'A Shift'` will not filter `'A Shift Overtime'`.

**`FILTER_CONTAINS`** — The event title must contain the filter string anywhere (case-insensitive). Use this for broad categories where any event containing the phrase should be hidden.

To temporarily disable a filter without removing it, add `//` to the beginning of its line.

-----

## Configuration

The top of `src/index.js` contains all values that may need to be changed. No other section should require editing for routine operation.

| Constant | Default | Description |
|----------|---------|-------------|
| `DAYS_TO_SHOW` | `5` | Number of days to display starting from today. `wide`/`full`: today panel + next N-1 columns. `split`/`tri`: total days in the strip. |
| `CACHE_SECONDS` | `900` | Page auto-refresh interval in seconds. 900 = 15 minutes. |
| `CALENDAR_FILENAME` | `'FFD Calendar Calendar.ics'` | Exact filename of the ICS file in the Drive folder. Must match the uploaded file name exactly. |
| `DEFAULT_LAYOUT` | `'wide'` | Layout used when no `?layout=` parameter is provided. |
| `ERROR_RETRY_SECONDS` | `60` | How long the error page waits before auto-retrying. |
| `FILTER_EXACT` | See code | Event titles that must match exactly to be excluded. |
| `FILTER_CONTAINS` | See code | Substrings that cause an event to be excluded if found anywhere in the title. |
| `ALLDAY_COLORS` | See code | Custom banner colors for specific all-day events, keyed by title (case-insensitive). |

-----

## Secrets

All credentials are stored as Cloudflare Worker secrets and GitHub Actions secrets. They are never present in source code.

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers edit permissions. |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID. |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email — shared with `slide-timing-proxy` and `daily-message-display`. |
| `GOOGLE_PRIVATE_KEY` | RSA private key from Google Cloud JSON key file — shared with `slide-timing-proxy` and `daily-message-display`. |
| `GOOGLE_DRIVE_FOLDER_ID` | ID of the Google Drive folder containing the ICS file. Found in the folder URL after `/folders/`. |

The Google Drive folder must be shared with the service account email address with at least **Viewer** access.

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
- All calendar content (event titles, locations) is HTML-escaped before injection into pages to prevent XSS.
- `X-Frame-Options` is intentionally **not** set — this Worker is loaded as a full-screen iframe by the display system. Adding `SAMEORIGIN` would cause immediate white screens on every station display.
- The ICS file is fetched server-side from Google Drive. The display browser never contacts Google directly.
- `Cache-Control: no-store` is set on all HTML responses to prevent browser caching.
- The Google Drive folder ID is stored as a Worker secret, not in source code.
