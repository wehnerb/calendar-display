# Calendar Display

A Cloudflare Worker that fetches a `.ics` calendar file from Nextcloud via WebDAV and renders it as a styled HTML page for fire station display screens. Wide and full layouts also include live NWS weather data — daily forecasts, an hourly strip, and active/upcoming alert banners.

## 📄 System Documentation
Full documentation (architecture, setup, account transfer, IT reference): https://github.com/wehnerb/ffd-display-system-documentation

---

## Live URLs

| Environment | URL |
|---|---|
| Production | `https://calendar-display.bwehner.workers.dev/` |
| Staging | `https://calendar-display-staging.bwehner.workers.dev/` |

---

## Layout Parameter

| Parameter | Default | Options |
|---|---|---|
| `?layout=` | `wide` | `full`, `wide`, `split`, `tri` |

| Layout | Width | Height | Weather |
|---|---|---|---|
| `full` | 1920px | 1075px | ✅ |
| `wide` | 1735px | 720px | ✅ |
| `split` | 852px | 720px | ❌ |
| `tri` | 558px | 720px | ❌ |

---

## Configuration (`src/index.js`)

All routine configuration is at the top of `src/index.js`.

| Constant | Default | Description |
|---|---|---|
| `DAYS_TO_SHOW` | `6` | Days to display from today |
| `CACHE_SECONDS` | `900` | Cache and auto-refresh interval (seconds) |
| `CACHE_VERSION` | *(current)* | Increment to immediately invalidate all cached pages |
| `DEFAULT_LAYOUT` | `'wide'` | Layout when no `?layout=` parameter is provided |
| `FILTER_EXACT` | See code | Event titles excluded by exact match |
| `FILTER_CONTAINS` | See code | Event titles excluded by substring match |
| `ALLDAY_COLORS` | See code | Custom colors for all-day events (A/B/C Shift) |

---

## Secrets

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token — Workers edit permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `NEXTCLOUD_URL` | Full WebDAV URL to the ICS file |
| `NEXTCLOUD_USERNAME` | Nextcloud login username |
| `NEXTCLOUD_PASSWORD` | Nextcloud app password |

---

## Deployment

| Branch | Deploys To | Purpose |
|---|---|---|
| `staging` | `calendar-display-staging.bwehner.workers.dev` | Testing |
| `main` | `calendar-display.bwehner.workers.dev` | Production |

Push to either branch — GitHub Actions deploys automatically (~30–45 sec).  
**Always stage and test before merging to main.**  
To roll back: use the Cloudflare dashboard **Deployments** tab, then revert the commit on `main`.
