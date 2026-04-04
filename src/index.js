// =============================================================================
// calendar-display — Cloudflare Worker
// =============================================================================
// Fetches a .ics calendar file from Nextcloud via WebDAV and renders it as a
// styled HTML calendar page for fire station displays.
//
// Two layout designs based on the ?layout= URL parameter:
//   wide / full  → Split view: today's events in a left panel,
//                  next N-1 days as columns in a right panel.
//                  Includes NWS weather: daily forecast in all column headers
//                  (including today), hourly forecast strip in the today panel,
//                  and active/future NWS alert banners and per-day badges.
//   split / tri  → Strip view: compact chronological list grouped by day.
//                  No weather data (layout too narrow).
//
// All-day events are rendered as colored banners at the top of each day.
// Events defined in ALLDAY_COLORS always sort above other all-day events.
// Events can be filtered by exact title match or substring match.
//
// ICS timestamp handling:
//   - UTC timestamps (ending in Z) are converted to Central time
//   - Local timestamps with TZID parameter use the specified timezone
//   - Floating timestamps (no Z, no TZID) are treated as Central time
//   - All-day events (date-only DTSTART) are handled as full-day entries
//
// NWS weather data (wide/full layouts only):
//   - Daily forecast: high/low temp, condition emoji, wind per day column.
//     Today's panel header matches the day column header structure exactly.
//   - Hourly forecast: remaining hours of today shown in a narrow left strip
//     inside the today panel body, every WEATHER_HOUR_INTERVAL hours.
//     Strip slot count is capped so no slot is clipped by the panel boundary.
//   - Alerts: active alerts shown as full-width banners above the panel row.
//     Future alerts shown as small severity-colored badges in each affected
//     day's column header. Multi-day alerts appear on every overlapping day.
//     All column headers (including today's) render exactly maxBadgeCount
//     badge rows so all headers are always the same height. Badge rows are
//     omitted entirely when no visible day has a future alert.
//   - Active alert banners expire automatically: the next page cache refresh
//     (up to CACHE_SECONDS later) will omit any alert whose expires time
//     has passed. Expiry wording uses "until 6 PM" when the alert expires
//     today, or "until Thursday 6 PM" when it expires on a future day.
//   All NWS fetches fail gracefully — weather is omitted if unavailable.
//
// Caching strategy:
//   - Rendered HTML cached per layout in Workers Cache API for CACHE_SECONDS.
//   - NWS daily/hourly forecasts edge-cached for NWS_FORECAST_CACHE_SECONDS.
//   - NWS alerts edge-cached for NWS_ALERTS_CACHE_SECONDS.
//   - Increment CACHE_VERSION to immediately invalidate all cached pages.
//   - Cache-Control: no-store on HTML responses prevents browser caching.
//
// Calendar update workflow:
//   - Outlook VBA macro exports FFD Calendar to a local folder on startup.
//   - Nextcloud desktop app syncs that folder automatically.
//   - Worker fetches the ICS file from Nextcloud via WebDAV on each cache miss.
//   - No manual upload steps or scheduled tasks are required.
//
// Security:
//   - Nextcloud credentials stored as Cloudflare Worker secrets — never in code
//   - HTTP Basic auth used for WebDAV; app password rather than account password
//   - NWS_USER_AGENT stored as a plain wrangler.toml [vars] entry (not sensitive)
//   - URL parameters sanitized before use
//   - All calendar and weather content HTML-escaped before page injection
//   - No X-Frame-Options header — loaded as full-screen iframe by display system
//   - ICS file fetched server-side; display browser never contacts Nextcloud
// =============================================================================


// -----------------------------------------------------------------------------
// CONFIGURATION — edit values in this section only for routine operation.
// No other section should require changes.
// -----------------------------------------------------------------------------

// Number of days to display, starting from today.
// wide/full: today panel + (DAYS_TO_SHOW - 1) day columns in right panel.
// split/tri: total days listed in the upcoming strip.
const DAYS_TO_SHOW = 6;

// Page auto-refresh interval in seconds. 900 = 15 minutes.
// Also controls how long rendered HTML is cached in the Workers Cache API.
const CACHE_SECONDS = 900;

// Increment this integer to immediately invalidate all cached pages.
// Useful after configuration changes that affect the rendered output,
// such as updating ALLDAY_COLORS, FILTER_EXACT, or DAYS_TO_SHOW.
const CACHE_VERSION = 11;

// Default layout when no ?layout= parameter is provided.
// Options: 'full', 'wide', 'split', 'tri'
const DEFAULT_LAYOUT = 'wide';

// Layout pixel dimensions — must match all other station Workers exactly.
const LAYOUTS = {
  full:  { width: 1920, height: 1075 },
  wide:  { width: 1735, height: 720  },
  split: { width: 852,  height: 720  },
  tri:   { width: 558,  height: 720  },
};

// How long the error/retry page waits before reloading (seconds).
const ERROR_RETRY_SECONDS = 60;

// Event titles to exclude when they match EXACTLY (full string, case-insensitive).
// Use for titles that could appear as substrings in legitimate event names.
// Example: 'A Shift' will NOT filter 'A Shift Overtime' — add both if needed.
const FILTER_EXACT = [
  // 'A Shift', // Added "//" at the beginning of this line to remove this from a filter, but keep the syntax
  // 'B Shift', // Added "//" at the beginning of this line to remove this from a filter, but keep the syntax
  // 'C Shift', // Added "//" at the beginning of this line to remove this from a filter, but keep the syntax
];

// Event titles to exclude when the title CONTAINS this string anywhere (case-insensitive).
// Use for broad categories where any event containing this phrase should be hidden.
const FILTER_CONTAINS = [
  // Example: 'Cancelled',
];

// Custom colors for specific all-day event banners.
// Key: event title (case-insensitive exact match).
// Each entry overrides the default blue banner style.
// bg = background color, border = left accent bar, text = text color.
// Use hex values. Remove an entry to revert that event to the default style.
// Events listed here always sort above other all-day events in each day panel.
const ALLDAY_COLORS = {
  'A Shift': { bg: '#1a4d2e', border: '#2d8a50', text: '#a8f0be' },
  'B Shift': { bg: '#e8e8e8', border: '#808080', text: '#1a1a1a' },
  'C Shift': { bg: '#4d1a1a', border: '#c0392b', text: '#f0a8a8' },
};

// --- NWS Weather Configuration ---

// NWS forecast office and grid coordinates for Fargo, ND.
// Verified via: https://api.weather.gov/points/46.8772,-96.7898
// These values are static for Fargo and do not need to change between stations —
// the 2.5km NWS grid produces identical forecasts across Fargo's ~6-mile area.
const NWS_OFFICE   = 'FGF';
const NWS_GRID_X   = 65;
const NWS_GRID_Y   = 57;

// NWS public zone code for Cass County, ND — used for the alerts endpoint.
const NWS_ALERT_ZONE = 'NDZ039';

// How many hourly periods to skip between slots in the today panel strip.
// 2 = show every other hour (NOW, 2 PM, 4 PM, 6 PM...).
// Increase if the strip feels crowded; decrease for more granularity.
const WEATHER_HOUR_INTERVAL = 2;

// Width in pixels of the hourly weather strip inside the today panel body.
const WEATHER_STRIP_WIDTH = 75;

// Edge cache TTL (seconds) for NWS daily and hourly forecasts.
// NWS updates daily forecasts ~4 times per day and hourly forecasts ~once per hour.
// 3600 (1 hour) is appropriate — lower if forecast data appears stale.
const NWS_FORECAST_CACHE_SECONDS = 3600;

// Edge cache TTL (seconds) for NWS active alerts.
// Alerts are near-real-time. 900 (15 minutes) matches the page cache interval.
const NWS_ALERTS_CACHE_SECONDS = 900;


// =============================================================================
// MAIN WORKER ENTRY POINT
// =============================================================================

export default {
  async fetch(request, env) {

    // Reject non-GET requests with a generic error to reduce attack surface.
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Parse and validate the layout URL parameter before the try block so
    // the error page renderer always has a valid layout to work with.
    const url         = new URL(request.url);
    const layoutParam = sanitizeParam(url.searchParams.get('layout')) || DEFAULT_LAYOUT;
    const layoutKey   = (layoutParam in LAYOUTS) ? layoutParam : DEFAULT_LAYOUT;
    const layout      = LAYOUTS[layoutKey];

    // wide/full → split view with weather.  split/tri → upcoming strip, no weather.
    const useStrip = (layoutKey === 'split' || layoutKey === 'tri');

    // --- Workers Cache API ---
    // Each layout variant is cached separately using a versioned cache key.
    // CACHE_VERSION allows instant cache invalidation by incrementing the
    // constant above — no Cloudflare dashboard action required.
    const cache    = caches.default;
    const cacheKey = new Request(
      'https://calendar-display-cache.internal/v' + CACHE_VERSION +
      '/' + layoutKey,
      { method: 'GET' }
    );

    // Return the cached response immediately if one exists.
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    try {

      // Strip layouts only need the ICS file.
      // Split layouts fetch the ICS and all three NWS endpoints in parallel to
      // minimise total latency. Each NWS fetch catches its own errors and returns
      // null on failure so the calendar renders without weather rather than
      // returning an error page.
      let icsText;
      let dailyPeriods  = null;
      let hourlyPeriods = null;
      let alertFeatures = null;

      if (useStrip) {
        icsText = await fetchIcsFromNextcloud(
          env.NEXTCLOUD_URL,
          env.NEXTCLOUD_USERNAME,
          env.NEXTCLOUD_PASSWORD
        );
      } else {
        [icsText, dailyPeriods, hourlyPeriods, alertFeatures] = await Promise.all([
          fetchIcsFromNextcloud(
            env.NEXTCLOUD_URL,
            env.NEXTCLOUD_USERNAME,
            env.NEXTCLOUD_PASSWORD
          ),
          fetchNwsDaily(env.NWS_USER_AGENT),
          fetchNwsHourly(env.NWS_USER_AGENT),
          fetchNwsAlerts(env.NWS_USER_AGENT),
        ]);
      }

      if (!icsText) {
        return renderErrorPage(
          'Calendar data could not be loaded. Retrying shortly.',
          layout
        );
      }

      // Parse the ICS text into structured event objects.
      const allEvents = parseIcs(icsText);

      // Apply filter rules before rendering.
      const events = applyFilters(allEvents);

      // Build the ordered list of date strings to display in Central time.
      const todayStr     = getTodayString();
      const displayDates = getDisplayDates(todayStr, DAYS_TO_SHOW);

      // Render the appropriate layout design.
      const html = useStrip
        ? buildStripLayout(events, displayDates, layout, layoutKey)
        : buildSplitLayout(
            events, displayDates, layout, layoutKey,
            dailyPeriods, hourlyPeriods, alertFeatures
          );

      const response = new Response(html, {
        status: 200,
        headers: {
          'Content-Type':           'text/html; charset=utf-8',
          // no-store prevents the browser from caching the HTML page itself.
          // The meta-refresh interval controls how often the display reloads.
          'Cache-Control':          'no-store',
          // Prevent MIME-type sniffing attacks.
          'X-Content-Type-Options': 'nosniff',
          // NOTE: X-Frame-Options is intentionally NOT set here.
          // This Worker is loaded as a full-screen iframe by the display system.
          // Adding X-Frame-Options: SAMEORIGIN causes immediate white screens.
        },
      });

      // Store the rendered response in the Workers Cache API.
      // A separate cache-control header on the cloned response tells
      // Cloudflare's cache how long to keep it — this does not affect
      // the Cache-Control header returned to the display browser.
      const responseToCache = new Response(html, {
        status: 200,
        headers: {
          'Content-Type':           'text/html; charset=utf-8',
          'Cache-Control':          'public, max-age=' + CACHE_SECONDS,
          'X-Content-Type-Options': 'nosniff',
        },
      });
      await cache.put(cacheKey, responseToCache);

      return response;

    } catch (err) {
      // Log full detail server-side; return only a generic message to the
      // display browser to avoid leaking implementation details.
      console.error('Worker unhandled error:', err);
      return renderErrorPage('A system error occurred. Retrying shortly.', layout);
    }
  },
};


// =============================================================================
// DATE AND TIME HELPERS
// =============================================================================

// Returns today's date string (YYYY-MM-DD) in America/Chicago time.
// Uses Intl.DateTimeFormat for correct DST handling.
// The en-CA locale produces YYYY-MM-DD format natively.
function getTodayString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).format(new Date());
}

// Returns an array of `count` date strings (YYYY-MM-DD) starting from todayStr.
// Uses noon UTC as the base to avoid DST boundary issues when incrementing days.
function getDisplayDates(todayStr, count) {
  const dates = [];
  // Parse at noon UTC so incrementing by 1 day never crosses a DST boundary.
  const base = new Date(todayStr + 'T12:00:00Z');
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    dates.push(d.toISOString().substring(0, 10));
  }
  return dates;
}

// Formats a YYYY-MM-DD string as a short label, e.g. "Mon 3/18".
function formatDateShort(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday:  'short',
    month:    'numeric',
    day:      'numeric',
  }).format(d);
}

// Formats a JS Date as a 12-hour time string, e.g. "9:00 AM".
function formatTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(date);
}

// Returns the YYYY-MM-DD date string for a JS Date in Central time.
function toLocalDateStr(date) {
  if (!date) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
  }).format(date);
}

// Formats an NWS hourly period start time as a short hour label, e.g. "2 PM".
// NWS hourly periods always start on the hour so the minute is always :00.
function formatHourLabel(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour:     'numeric',
    hour12:   true,
  }).format(date);
}

// Formats a timestamp as a short, clean hour string for alert timing labels.
// Whole hours: "6 PM". Special cases: "noon", "midnight". With minutes: "6:30 PM".
function formatHourOnly(date) {
  if (!date) return '';
  const raw = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(date);
  // Remove ":00" from whole-hour times for cleaner display.
  const clean = raw.replace(':00', '');
  if (clean === '12 PM') return 'noon';
  if (clean === '12 AM') return 'midnight';
  return clean;
}


// =============================================================================
// NEXTCLOUD WEBDAV — fetch ICS file
// =============================================================================
// Fetches the ICS file from Nextcloud using HTTP Basic authentication over
// the WebDAV interface. No OAuth or token exchange is required — credentials
// are passed directly in the Authorization header.
//
// Required Worker secrets (set in Cloudflare dashboard and deploy.yml):
//   NEXTCLOUD_URL      — Full WebDAV URL to the ICS file, e.g.:
//                        https://fileshare.fargond.gov/remote.php/dav/files/
//                        USERNAME/FFD%20Calendar%20Export/FFD%20Calendar%20Calendar.ics
//   NEXTCLOUD_USERNAME — Nextcloud username (not display name)
//   NEXTCLOUD_PASSWORD — Nextcloud app password (not account password).
//                        Generate at: Nextcloud → Settings → Security →
//                        Devices & sessions → Create new app password.
//                        App passwords can be revoked without affecting the
//                        main Nextcloud account.

async function fetchIcsFromNextcloud(nextcloudUrl, username, password) {
  // Encode credentials as Base64 for the HTTP Basic Authorization header.
  // btoa() is available natively in Cloudflare Workers.
  const credentials = btoa(username + ':' + password);

  const res = await fetch(nextcloudUrl, {
    method:  'GET',
    headers: {
      'Authorization': 'Basic ' + credentials,
    },
    // cf.cacheTtl: 0 ensures Cloudflare's edge cache is bypassed so the
    // Worker always retrieves the current file from Nextcloud rather than
    // a stale cached copy. The Workers Cache API handles page-level caching.
    cf: { cacheTtl: 0 },
  });

  if (!res.ok) {
    // Log the status server-side without exposing credentials or the URL.
    console.error(
      'Nextcloud WebDAV fetch failed (' + res.status + '). ' +
      'Verify NEXTCLOUD_URL, NEXTCLOUD_USERNAME, and NEXTCLOUD_PASSWORD secrets.'
    );
    return null;
  }

  return await res.text();
}


// =============================================================================
// NWS WEATHER FETCHES
// =============================================================================
// All three functions share the same pattern:
//   - Set a User-Agent header (NWS requires this for all API requests).
//   - Use cf.cacheTtl to let Cloudflare's edge cache hold NWS responses,
//     reducing how often the Worker contacts api.weather.gov.
//   - Return null on any error so callers can degrade gracefully.
//
// NWS_USER_AGENT is set in wrangler.toml as a plain [vars] entry and accessed
// via env.NWS_USER_AGENT. It is not sensitive — it appears in outbound headers.

// Fetches the 7-day daily forecast for the configured Fargo grid point.
// Returns the periods array or null on failure.
// Edge-cached for NWS_FORECAST_CACHE_SECONDS (daily forecasts update ~4x/day).
async function fetchNwsDaily(userAgent) {
  const url = (
    'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y +
    '/forecast'
  );
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_FORECAST_CACHE_SECONDS },
    });
    if (!res.ok) {
      console.error('NWS daily forecast fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return (data.properties && data.properties.periods) ? data.properties.periods : null;
  } catch (e) {
    console.error('NWS daily forecast error:', e);
    return null;
  }
}

// Fetches the 7-day hourly forecast for the configured Fargo grid point.
// Returns the periods array or null on failure.
// Edge-cached for NWS_FORECAST_CACHE_SECONDS (hourly forecasts update ~once/hour).
async function fetchNwsHourly(userAgent) {
  const url = (
    'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y +
    '/forecast/hourly'
  );
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_FORECAST_CACHE_SECONDS },
    });
    if (!res.ok) {
      console.error('NWS hourly forecast fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return (data.properties && data.properties.periods) ? data.properties.periods : null;
  } catch (e) {
    console.error('NWS hourly forecast error:', e);
    return null;
  }
}

// Fetches active weather alerts for the configured Cass County zone (NDZ039).
// Returns the features array or null on failure.
// Edge-cached for NWS_ALERTS_CACHE_SECONDS (matches page cache interval).
async function fetchNwsAlerts(userAgent) {
  const url = 'https://api.weather.gov/alerts/active?zone=' + NWS_ALERT_ZONE;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: NWS_ALERTS_CACHE_SECONDS },
    });
    if (!res.ok) {
      console.error('NWS alerts fetch failed (' + res.status + ')');
      return null;
    }
    const data = await res.json();
    return (data.features && Array.isArray(data.features)) ? data.features : null;
  } catch (e) {
    console.error('NWS alerts error:', e);
    return null;
  }
}


// =============================================================================
// NWS DATA PROCESSING
// =============================================================================

// Builds a map of { 'YYYY-MM-DD': { high, low, shortForecast, wind } } from
// NWS daily forecast periods. Daytime periods supply the high temp and
// primary condition; nighttime periods supply the low. If only one period
// type is available for a date (e.g. daytime has already passed), only that
// value is set and callers omit the missing value from the display.
function buildDailyWeatherMap(periods) {
  const map = {};
  if (!periods) return map;

  for (const p of periods) {
    const startDate = new Date(p.startTime);
    const dateStr   = toLocalDateStr(startDate);

    if (!map[dateStr]) {
      map[dateStr] = { high: null, low: null, shortForecast: null, wind: null };
    }

    if (p.isDaytime) {
      map[dateStr].high          = p.temperature;
      map[dateStr].shortForecast = p.shortForecast;
      map[dateStr].wind          = (p.windDirection || '') + ' ' + (p.windSpeed || '');
    } else {
      map[dateStr].low = p.temperature;
      // Use nighttime condition/wind only if no daytime period exists for this date.
      if (!map[dateStr].shortForecast) {
        map[dateStr].shortForecast = p.shortForecast;
        map[dateStr].wind          = (p.windDirection || '') + ' ' + (p.windSpeed || '');
      }
    }
  }

  return map;
}

// Builds the list of hourly slots to render in the today panel's weather strip.
// Starts from the current hour (labeled "NOW") and takes every
// WEATHER_HOUR_INTERVAL-th period for the remainder of today only.
// maxSlots caps the list so no slot extends beyond the panel's visible area.
// Returns an array of { isNow, label, temp, emoji } objects, or [] if no data.
function buildHourlyStripSlots(hourlyPeriods, todayStr, now, maxSlots) {
  if (!hourlyPeriods) return [];

  // Floor to the start of the current UTC hour so the current period
  // (whose startTime equals that hour boundary) is included.
  const currentHourMs = now.getTime() - (now.getTime() % 3600000);

  // Collect today's periods that start at or after the current hour.
  const todayPeriods = hourlyPeriods.filter(function(p) {
    const pStart = new Date(p.startTime);
    return (
      toLocalDateStr(pStart) === todayStr &&
      pStart.getTime() >= currentHourMs
    );
  });

  if (todayPeriods.length === 0) return [];

  const slots = [];
  let nextIndex = 0;

  for (let i = 0; i < todayPeriods.length; i++) {
    if (slots.length >= maxSlots) break;
    if (i !== nextIndex) continue;
    const p = todayPeriods[i];
    slots.push({
      isNow: slots.length === 0,
      label: slots.length === 0 ? 'NOW' : formatHourLabel(new Date(p.startTime)),
      temp:  p.temperature,
      emoji: mapConditionToEmoji(p.shortForecast),
    });
    nextIndex += WEATHER_HOUR_INTERVAL;
  }

  return slots;
}

// Maps an NWS shortForecast string to a representative weather emoji.
// Checks are case-insensitive and ordered from most to least specific to
// prevent broad matches (e.g. "rain") from shadowing specific ones
// (e.g. "thunderstorm" or "freezing rain").
function mapConditionToEmoji(shortForecast) {
  if (!shortForecast) return '\uD83C\uDF21'; // default: 🌡
  const f = shortForecast.toLowerCase();

  if (f.includes('thunderstorm'))                      return '\u26C8\uFE0F'; // ⛈
  if (f.includes('blizzard'))                         return '\u2744\uFE0F'; // ❄️
  if (f.includes('freezing rain') ||
      f.includes('freezing drizzle') ||
      f.includes('wintry mix') ||
      f.includes('sleet'))                            return '\uD83C\uDF28'; // 🌨
  if (f.includes('snow'))                             return '\u2744\uFE0F'; // ❄️
  if (f.includes('rain') || f.includes('shower'))    return '\uD83C\uDF27'; // 🌧
  if (f.includes('drizzle'))                         return '\uD83C\uDF26'; // 🌦
  if (f.includes('fog') || f.includes('haze') ||
      f.includes('smoke') || f.includes('mist'))     return '\uD83C\uDF2B'; // 🌫
  if (f.includes('blustery') || f.includes('windy') ||
      f.includes('breezy'))                          return '\uD83D\uDCA8'; // 💨
  if (f.includes('mostly cloudy'))                   return '\uD83C\uDF25'; // 🌥
  if (f.includes('partly cloudy') ||
      f.includes('partly sunny'))                    return '\u26C5';       // ⛅
  if (f.includes('mostly sunny') ||
      f.includes('mostly clear'))                    return '\uD83C\uDF24'; // 🌤
  if (f.includes('sunny') || f.includes('clear'))   return '\u2600\uFE0F'; // ☀️
  if (f.includes('cloudy') || f.includes('overcast')) return '\u2601\uFE0F'; // ☁️
  return '\uD83C\uDF21'; // 🌡 default
}

// Returns the list of alert features that should appear as a future badge on
// the given date's column header.
//
// For today: only alerts not yet started (onset > now). Already-active alerts
//   are shown in the top banner and are not repeated as a badge.
// For future days: all non-expired alerts whose onset-to-expires window
//   overlaps that calendar day, regardless of whether they have started yet.
//
// Filters out test/cancelled alerts (status !== 'Actual' or messageType === 'Cancel').
function getBadgeAlertsForDate(alertFeatures, dateStr, todayStr, now) {
  if (!alertFeatures) return [];

  return alertFeatures.filter(function(f) {
    const p = f.properties;
    if (!p)                           return false;
    if (p.status !== 'Actual')        return false;
    if (p.messageType === 'Cancel')   return false;

    const onset   = p.onset   ? new Date(p.onset)   : null;
    const expires = p.expires ? new Date(p.expires) : null;
    if (!onset || !expires)           return false;
    if (expires <= now)               return false; // product already superseded

    // For date-range overlap and display, prefer p.ends (actual weather event end)
    // over p.expires (alert product expiry). NWS sets expires to when they will
    // issue the next update, which can be hours before the hazard actually ends.
    // p.ends may be null for some alert types, so fall back to expires.
    const eventEnd       = p.ends ? new Date(p.ends) : expires;
    const onsetDateStr   = toLocalDateStr(onset);
    const expireDateStr  = toLocalDateStr(eventEnd);

    // Alert must overlap this date.
    if (onsetDateStr > dateStr || expireDateStr < dateStr) return false;

    // For today: only show alerts that haven't started yet.
    if (dateStr === todayStr) return onset > now;

    // For future days: show all overlapping, non-expired alerts.
    return true;
  });
}

// Returns the list of currently active alert features (onset <= now < expires).
// These are displayed as full-width banners above the panel row.
function getActiveAlerts(alertFeatures, now) {
  if (!alertFeatures) return [];

  return alertFeatures.filter(function(f) {
    const p = f.properties;
    if (!p || p.status !== 'Actual' || p.messageType === 'Cancel') return false;
    const onset   = p.onset   ? new Date(p.onset)   : null;
    const expires = p.expires ? new Date(p.expires) : null;
    if (!onset || !expires) return false;
    return onset <= now && expires > now;
  });
}

// Sorts an alert array by descending severity so the most critical alert
// appears first when displaying multiple simultaneous alerts.
function sortAlertsBySeverity(alerts) {
  const order = { extreme: 0, severe: 1, moderate: 2, minor: 3 };
  return alerts.slice().sort(function(a, b) {
    const sa = order[(a.properties.severity || '').toLowerCase()];
    const sb = order[(b.properties.severity || '').toLowerCase()];
    return (sa !== undefined ? sa : 4) - (sb !== undefined ? sb : 4);
  });
}

// Returns the CSS class for an active alert banner (top of page).
function getAlertBannerClass(alertProperties) {
  const s = (alertProperties.severity || '').toLowerCase();
  if (s === 'extreme' || s === 'severe') return 'alert-warning';
  if (s === 'moderate')                  return 'alert-watch';
  return 'alert-advisory';
}

// Returns the CSS class for a future alert badge in a column header.
function getAlertBadgeClass(alertProperties) {
  const s = (alertProperties.severity || '').toLowerCase();
  if (s === 'extreme' || s === 'severe') return 'badge-warning';
  if (s === 'moderate')                  return 'badge-watch';
  return 'badge-advisory';
}

// Returns a short timing qualifier for a future alert badge on a specific date:
//   "begins 6 PM"  — alert starts on this date
//   "until noon"   — alert ends on this date (started on a prior date)
//   "all day"      — alert spans the entire date entirely
// Uses p.ends (actual weather event end) in preference to p.expires (product
// expiry) so the displayed time matches what other weather services show.
function formatAlertTiming(alertProperties, dateStr) {
  const onset    = alertProperties.onset ? new Date(alertProperties.onset) : null;
  // Prefer ends (actual hazard end time) over expires (product message expiry).
  const eventEnd = (alertProperties.ends || alertProperties.expires)
    ? new Date(alertProperties.ends || alertProperties.expires)
    : null;

  const onsetDateStr  = onset    ? toLocalDateStr(onset)    : null;
  const expireDateStr = eventEnd ? toLocalDateStr(eventEnd) : null;

  if (onsetDateStr === dateStr)  return 'begins ' + formatHourOnly(onset);
  if (expireDateStr === dateStr) return 'until '  + formatHourOnly(eventEnd);
  return 'all day';
}

// Formats the expiry time of an active alert for the top-of-page banner.
// If the alert expires today: "until 6 PM" (no day name — today is unambiguous).
// If the alert expires on a future day: "until Thursday 6 PM".
// This prevents confusion when an alert expires at, e.g., 1 PM on the same day.
function formatExpiresLabel(expiresStr, todayStr) {
  if (!expiresStr) return '';
  const d           = new Date(expiresStr);
  const expDateStr  = toLocalDateStr(d);
  const timeLabel   = formatHourOnly(d);

  if (expDateStr === todayStr) {
    // Expires today — show time only.
    return 'until ' + timeLabel;
  }

  // Expires on a future day — include the day name.
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday:  'long',
  }).format(d);
  return 'until ' + day + ' ' + timeLabel;
}


// =============================================================================
// ICS PARSER
// =============================================================================
// Parses a subset of the iCalendar format (RFC 5545) sufficient for display:
// DTSTART, DTEND, SUMMARY, LOCATION. All-day and timed events are detected.
//
// Four DTSTART/DTEND timestamp formats are handled:
//   1. UTC:             DTSTART:20260318T150000Z
//   2. TZID local:      DTSTART;TZID=America/Chicago:20260318T090000
//   3. All-day (date):  DTSTART;VALUE=DATE:20260318
//   4. Floating local:  DTSTART:20260318T090000  (no Z, no TZID — treated as Central)
//
// Exchange emits Windows timezone names in quotes (e.g. "Central Standard Time").
// These are stripped of quotes and mapped to IANA names via windowsToIana().
//
// Lines may be RFC 5545 "folded" (long lines wrapped with leading whitespace);
// unfolding is applied before parsing.

function parseIcs(icsText) {
  // Normalize line endings to \n, then unfold folded lines per RFC 5545 §3.1.
  const normalized = icsText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines      = unfoldLines(normalized.split('\n'));

  const events = [];
  let current  = null;

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    // Preserve original case for the params portion — TZID values like
    // "Central Standard Time" must not be uppercased before windowsToIana()
    // looks them up. Only the property name itself is uppercased.
    const rawNamePart = line.substring(0, colonIdx).trim();
    const value       = line.substring(colonIdx + 1).trim();

    const semiIdx    = rawNamePart.indexOf(';');
    const propName   = semiIdx === -1
      ? rawNamePart.toUpperCase()
      : rawNamePart.substring(0, semiIdx).toUpperCase();
    const propParams = semiIdx === -1 ? '' : rawNamePart.substring(semiIdx + 1);

    if (propName === 'BEGIN' && value === 'VEVENT') {
      current = {};
      continue;
    }

    if (propName === 'END' && value === 'VEVENT') {
      // Only add events that have at least a SUMMARY and a DTSTART.
      if (current && current.summary !== undefined && current.start) {
        events.push(current);
      }
      current = null;
      continue;
    }

    if (!current) continue;

    switch (propName) {
      case 'SUMMARY':
        current.summary = unescapeIcs(value);
        break;
      case 'LOCATION':
        current.location = unescapeIcs(value);
        break;
      case 'DTSTART': {
        const parsed = parseDatetimeProp(value, propParams);
        if (parsed) {
          current.start    = parsed.date;
          current.allDay   = parsed.allDay;
          current.startStr = parsed.dateStr;
        }
        break;
      }
      case 'DTEND': {
        const parsed = parseDatetimeProp(value, propParams);
        if (parsed) {
          current.end    = parsed.date;
          current.endStr = parsed.dateStr;
        }
        break;
      }
    }
  }

  return events;
}

// Unfolds RFC 5545 folded lines. A continuation line starts with a space or tab;
// that leading whitespace is stripped and the line is joined to the previous one.
function unfoldLines(lines) {
  const result = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && result.length > 0) {
      result[result.length - 1] += line.substring(1);
    } else {
      result.push(line);
    }
  }
  return result;
}

// Parses a DTSTART or DTEND property value and parameters into a structured object.
// Returns { date: Date, allDay: boolean, dateStr: 'YYYY-MM-DD' } or null.
function parseDatetimeProp(value, params) {

  // All-day: VALUE=DATE parameter or exactly 8 digits (no T component).
  if (params.includes('VALUE=DATE') || /^\d{8}$/.test(value)) {
    const yr  = parseInt(value.substring(0, 4), 10);
    const mo  = parseInt(value.substring(4, 6), 10) - 1;
    const dy  = parseInt(value.substring(6, 8), 10);
    // Use noon UTC so the date is unambiguous regardless of system timezone.
    const date    = new Date(Date.UTC(yr, mo, dy, 12, 0, 0));
    const dateStr = value.substring(0, 4) + '-' +
                    value.substring(4, 6) + '-' +
                    value.substring(6, 8);
    return { date, allDay: true, dateStr };
  }

  // UTC timestamp: ends with Z.
  if (value.endsWith('Z')) {
    const date = parseRawDateTime(value.slice(0, -1));
    if (!date) return null;
    // The date string for grouping is derived in Central time from the UTC instant.
    return { date, allDay: false, dateStr: toLocalDateStr(date) };
  }

  // Local time with TZID parameter.
  // Exchange emits Windows timezone names wrapped in quotes, e.g.:
  //   DTSTART;TZID="Central Standard Time":20260318T090000
  // Strip quotes and map Windows names to IANA names before parsing.
  const tzidMatch = params.match(/TZID=([^;]+)/i);
  if (tzidMatch) {
    const rawTzid  = tzidMatch[1].replace(/^"|"$/g, '').trim();
    const ianaZone = windowsToIana(rawTzid);
    const date     = parseLocalDateTimeInZone(value, ianaZone);
    if (!date) return null;
    return { date, allDay: false, dateStr: toLocalDateStr(date) };
  }

  // Floating local time (no Z, no TZID) — treat as America/Chicago.
  const date = parseLocalDateTimeInZone(value, 'America/Chicago');
  if (!date) return null;
  return { date, allDay: false, dateStr: toLocalDateStr(date) };
}

// Parses a bare ICS datetime string (YYYYMMDDTHHMMSS) as UTC.
// Returns a JS Date or null on failure.
function parseRawDateTime(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6], 10)
  ));
}

// Parses a bare ICS datetime string (YYYYMMDDTHHMMSS) as a wall-clock time
// in the given IANA timezone. Returns a JS Date representing the correct
// UTC instant, or null on failure.
//
// Strategy: interpret the value as a UTC date first, then measure the offset
// between what that UTC date displays in the target timezone and what was
// intended, and correct accordingly. This handles DST transitions correctly.
function parseLocalDateTimeInZone(value, tzid) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;

  try {
    const [, yr, mo, dy, hr, mn, sc] = m;

    // Treat the components as UTC to get an initial JS Date.
    const utcApprox = new Date(Date.UTC(
      parseInt(yr, 10), parseInt(mo, 10) - 1, parseInt(dy, 10),
      parseInt(hr, 10), parseInt(mn, 10),     parseInt(sc, 10)
    ));

    // Find what wall-clock time that UTC instant shows in the target timezone.
    const parts = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year:     'numeric', month:  '2-digit', day:    '2-digit',
      hour:     '2-digit', minute: '2-digit', second: '2-digit',
      hour12:   false,
    }).formatToParts(utcApprox)) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }

    // The displayed wall-clock time as a UTC-based millisecond value.
    const displayedMs = Date.UTC(
      parseInt(parts.year,   10),
      parseInt(parts.month,  10) - 1,
      parseInt(parts.day,    10),
      parseInt(parts.hour,   10) % 24, // hour12:false can return 24 for midnight
      parseInt(parts.minute, 10),
      parseInt(parts.second, 10)
    );

    // The intended wall-clock time as a UTC-based millisecond value.
    const intendedMs = Date.UTC(
      parseInt(yr, 10), parseInt(mo, 10) - 1, parseInt(dy, 10),
      parseInt(hr, 10), parseInt(mn, 10),     parseInt(sc, 10)
    );

    // Subtract the offset to get the correct UTC instant.
    return new Date(utcApprox.getTime() - (displayedMs - intendedMs));

  } catch (e) {
    console.error(
      'Datetime parse error for value "' + value +
      '" in timezone "' + tzid + '":', e
    );
    return null;
  }
}

// Unescapes ICS text values per RFC 5545:
// \n → newline, \\ → backslash, \; → semicolon, \, → comma.
function unescapeIcs(str) {
  return str
    .replace(/\\n/gi, '\n')
    .replace(/\\\\/g, '\\')
    .replace(/\\;/g,  ';')
    .replace(/\\,/g,  ',');
}

// Maps Windows timezone names (as used by Exchange/Outlook) to IANA timezone
// identifiers accepted by Intl.DateTimeFormat. Covers all US zones plus common
// international zones that may appear in department calendars.
// If the name is already a valid IANA zone (or unrecognized), it is returned
// unchanged — Intl.DateTimeFormat will throw and the event will be skipped
// with a console.error rather than silently producing a wrong time.
function windowsToIana(windowsTz) {
  const map = {
    // United States
    'Eastern Standard Time':     'America/New_York',
    'Eastern Summer Time':       'America/New_York',
    'Central Standard Time':     'America/Chicago',
    'Central Summer Time':       'America/Chicago',
    'Mountain Standard Time':    'America/Denver',
    'Mountain Summer Time':      'America/Denver',
    'US Mountain Standard Time': 'America/Phoenix',  // Arizona — no DST
    'Pacific Standard Time':     'America/Los_Angeles',
    'Pacific Summer Time':       'America/Los_Angeles',
    'Alaskan Standard Time':     'America/Anchorage',
    'Hawaiian Standard Time':    'Pacific/Honolulu',
    // UTC
    'UTC':                       'UTC',
    'Greenwich Standard Time':   'UTC',
    // Canada
    'Canada Central Standard Time': 'America/Regina',
    'Atlantic Standard Time':    'America/Halifax',
    'Newfoundland Standard Time': 'America/St_Johns',
    // Europe
    'GMT Standard Time':         'Europe/London',
    'Romance Standard Time':     'Europe/Paris',
    'Central Europe Standard Time': 'Europe/Budapest',
    'Central European Standard Time': 'Europe/Warsaw',
    'W. Europe Standard Time':   'Europe/Berlin',
    'E. Europe Standard Time':   'Europe/Nicosia',
    // Other common
    'AUS Eastern Standard Time': 'Australia/Sydney',
    'Tokyo Standard Time':       'Asia/Tokyo',
    'China Standard Time':       'Asia/Shanghai',
  };

  return map[windowsTz] || windowsTz;
}


// =============================================================================
// EVENT FILTERING AND SORTING
// =============================================================================

// Applies FILTER_EXACT and FILTER_CONTAINS rules to remove matching events.
// Both checks are case-insensitive. Returns the filtered event array.
function applyFilters(events) {
  return events.filter(event => {
    const title      = (event.summary || '').trim();
    const titleLower = title.toLowerCase();

    // Exact match: full title must equal the filter string.
    for (const exact of FILTER_EXACT) {
      if (titleLower === exact.toLowerCase()) return false;
    }

    // Substring match: title contains the filter string anywhere.
    for (const substr of FILTER_CONTAINS) {
      if (titleLower.includes(substr.toLowerCase())) return false;
    }

    return true;
  });
}

// Sorts an array of all-day events so that events with a defined ALLDAY_COLORS
// entry always appear above events without one. Within each group the original
// ICS order is preserved. This ensures shift banners (A/B/C Shift) always
// appear at the top of each day regardless of how Exchange exports the calendar.
function sortAllDayEvents(allDayEvents) {
  const colorKeys = Object.keys(ALLDAY_COLORS).map(function(k) {
    return k.toLowerCase();
  });
  return allDayEvents.slice().sort(function(a, b) {
    const aHasColor = colorKeys.includes((a.summary || '').trim().toLowerCase()) ? 0 : 1;
    const bHasColor = colorKeys.includes((b.summary || '').trim().toLowerCase()) ? 0 : 1;
    return aHasColor - bHasColor;
  });
}

// Returns an inline style string for an all-day event banner.
// If the event title matches an entry in ALLDAY_COLORS (case-insensitive),
// the custom colors are applied. Otherwise returns an empty string so the
// default .allday-banner CSS class styles take effect.
function getAllDayBannerStyle(summary) {
  const key = Object.keys(ALLDAY_COLORS).find(
    k => k.toLowerCase() === (summary || '').trim().toLowerCase()
  );
  if (!key) return '';
  const c = ALLDAY_COLORS[key];
  return (
    ' style="background:' + c.bg +
    ';border-left-color:'  + c.border +
    ';color:'              + c.text + ';"'
  );
}


// =============================================================================
// INPUT HELPERS
// =============================================================================

// Sanitizes a URL parameter value to prevent injection attacks.
// Allows only alphanumeric characters, hyphens, and underscores.
function sanitizeParam(value) {
  if (!value || typeof value !== 'string') return null;
  return value.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50);
}

// Escapes a string for safe insertion into HTML content to prevent XSS.
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}


// =============================================================================
// SHARED HTML WRAPPER
// =============================================================================

// Builds a complete HTML document with meta-refresh, viewport, and styles.
// String concatenation used throughout to prevent smart-quote corruption
// when editing in GitHub's browser editor.
function buildHtmlDoc(width, height, styles, body) {
  return (
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta http-equiv="refresh" content="' + CACHE_SECONDS + '">' +
    '<meta name="viewport" content="width=' + width + ', height=' + height + '">' +
    '<title>Station Calendar</title>' +
    // Noto Emoji provides emoji glyphs on display hardware that lacks a system
    // emoji font. Preconnect hints let the browser start DNS/TLS early.
    // The font is used as a fallback after Arial in all font-family stacks,
    // so it only activates for characters Arial cannot render (emoji).
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Emoji&display=swap">' +
    '<style>' + styles + '</style>' +
    '</head>' +
    '<body>' + body + '</body>' +
    '</html>'
  );
}


// =============================================================================
// SPLIT LAYOUT — wide / full
// =============================================================================
// Left panel: today's daily forecast in header + hourly weather strip on the
//   left side of the body + stacked events (time above title) on the right.
// Right panel: day columns with daily forecast in headers and stacked events.
// Alert banners: active NWS alerts shown above the panel row.
// Alert badges: future alerts shown as colored pills in each affected column
//   header. All headers (including today's) render exactly maxBadgeCount badge
//   rows so every header is the same height regardless of alert count.
//
// Today's header uses the same row structure and font sizes as the day column
// headers so both panels are always the same header height.

function buildSplitLayout(events, displayDates, layout, layoutKey, dailyPeriods, hourlyPeriods, alertFeatures) {
  const { width, height } = layout;
  const now      = new Date();
  const todayStr = displayDates[0];

  // Full layout shows an "FFD Calendar" title label; other layouts have their
  // own title bar from the display system.
  const showLabel = (layoutKey === 'full');

  // --- Sizing — all proportional to layout height so wide and full both look correct ---
  const pad         = Math.floor(height * 0.030);
  const labelHeight = showLabel ? Math.floor(height * 0.065) : 0;

  // Today panel width. Narrowed slightly when 5 day columns are shown.
  const rightDayCount = displayDates.length - 1;
  const leftRatio     = rightDayCount <= 4 ? 0.36 : 0.30;
  const leftWidth     = Math.floor(width * leftRatio);

  // ── Font sizes ──
  // Header fonts — identical values used in BOTH the today header and day column
  // headers. CSS grid row 1 sizes to the tallest header automatically so all
  // headers are always the same height without any JS height estimation.
  const colDateFont     = Math.floor(height * 0.035); // date line — matches main dayHeaderFont
  const colWxFont       = Math.floor(height * 0.025); // weather rows (H/L, condition, wind)
  const colWindFont     = Math.floor(colWxFont * 0.95); // wind information in all columns
  const badgeFont       = Math.floor(height * 0.03); // future weather alert badge text

  // Body fonts — today panel events.
  const evtTimeFont     = Math.floor(height * 0.030); // stacked event time label
  const evtTitleFont    = Math.floor(height * 0.033); // event title — matches main todayTitleFont
  const evtLocFont      = Math.floor(height * 0.025); // event location — matches main todayLocFont

  // Body fonts — day column events.
  const dayTimeFont     = Math.floor(height * 0.025); // time label
  const dayTitleFont    = Math.floor(height * 0.026); // event title

  // Hourly weather strip fonts.
  const wxTimeFont      = Math.floor(height * 0.020); // hour label ("NOW", "2 PM")
  const wxTempFont      = Math.floor(height * 0.024); // temperature
  const wxEmojiFont     = Math.floor(height * 0.024); // condition emoji

  // Shared.
  const bannerFont      = Math.floor(height * 0.025); // all-day shift banners
  const alertBannerFont = Math.floor(height * 0.033); // active weather alert banner text
  const noEventsFont    = Math.floor(height * 0.028); // "No events" — matches main
  const labelFont       = Math.floor(height * 0.040); // "FFD Calendar" title (full only)

  // hdrGap: gap between flex rows inside each header (date, H/L, condition, wind, badges).
  const hdrGap = Math.floor(pad * 0.16);

  // --- Process NWS data ---
  const dailyWeatherMap = buildDailyWeatherMap(dailyPeriods);
  const activeAlerts    = sortAlertsBySeverity(getActiveAlerts(alertFeatures, now));

  // Per-date future alert badge lists and the overall maximum count.
  // Every column header renders exactly maxBadgeCount badge-row elements
  // (real badges + invisible placeholders) so all headers have the same
  // number of badge rows. The CSS grid ensures all headers are the same
  // total height by stretching to match the tallest column.
  const badgesPerDate = {};
  for (const dateStr of displayDates) {
    const raw = getBadgeAlertsForDate(alertFeatures, dateStr, todayStr, now);
    badgesPerDate[dateStr] = sortAlertsBySeverity(raw);
  }
  const maxBadgeCount = displayDates.reduce(function(max, d) {
    return Math.max(max, badgesPerDate[d].length);
  }, 0);

  // Each badge element is a fixed 2-text-line height + vertical padding + 2px borders.
  // The +2 accounts for the 1px top + 1px bottom border on .future-alert-badge which are
  // subtracted from the content area by box-sizing:border-box.
  // This same value is the CSS height on .future-alert-badge so real badges and
  // placeholders are always the same height regardless of text content.
  const lh        = 1.4;
  const badgeRowH = Math.ceil(badgeFont * lh) * 2 + Math.floor(pad * 0.12) * 2 + 2;

  // --- Compute max hourly strip slots ---
  // The actual header height is determined by the CSS grid at browser render time
  // (it sizes to the tallest content across all columns), so the Worker cannot know
  // it precisely. We use a conservative worst-case estimate to ensure no hourly slot
  // is ever clipped by overflow. On calm-weather days the strip may show 1-2 fewer
  // slots than theoretically possible, but this is visually insignificant.
  //
  // Worst-case header height assumes:
  //   - condition wraps to 3 lines (longest possible NWS forecast text)
  //   - actual maxBadgeCount badge rows (we know this exactly)
  const hdrPad  = Math.floor(pad * 0.38) * 2; // top + bottom padding on headers
  const worstCondLines  = 3;
  const worstHdrContent = Math.ceil(colDateFont * lh)
                        + Math.ceil(colWxFont   * lh)
                        + Math.ceil(colWxFont   * lh) * worstCondLines
                        + Math.ceil(colWindFont * lh)
                        + (hdrGap * 3);
  const badgesBlock     = maxBadgeCount > 0
    ? hdrGap + (maxBadgeCount * badgeRowH) + ((maxBadgeCount - 1) * hdrGap)
    : 0;
  const worstHdrHeight  = hdrPad + worstHdrContent + badgesBlock;

  // Alert strip height: each banner is its font + vertical padding; gaps between banners.
  const bannerRowH  = alertBannerFont + Math.floor(pad * 0.3) * 2;
  const bannerGap   = Math.floor(pad * 0.25);
  const alertStripH = activeAlerts.length > 0
    ? (activeAlerts.length * bannerRowH) + ((activeAlerts.length - 1) * bannerGap)
    : 0;

  // Outer gap between flex children (label, alert strip, panels grid).
  const outerGap = Math.floor(pad * 0.5);

  // Available height for the panels grid.
  let panelsH = height - (pad * 2);
  if (showLabel)         panelsH -= labelHeight + outerGap;
  if (alertStripH > 0)   panelsH -= alertStripH + outerGap;

  // Available body height = panels height minus worst-case header.
  const stripPadV = Math.floor(pad * 0.3) * 2;
  const bodyH     = panelsH - worstHdrHeight;

  // Per-slot height: vertical padding + time label + margin + temp + margin + emoji + divider.
  const slotPadV = Math.floor(pad * 0.28) + Math.floor(pad * 0.22);
  const slotH    = slotPadV
                 + wxTimeFont + 3
                 + wxTempFont + 2
                 + wxEmojiFont
                 + Math.floor(pad * 0.22) + 1;

  // Safety margin (0.85) ensures the last slot never grazes the body boundary.
  const maxSlots = Math.max(1, Math.floor((bodyH - stripPadV) * 0.85 / slotH));

  // Build hourly slots now that maxSlots is known.
  const hourlySlots = buildHourlyStripSlots(hourlyPeriods, todayStr, now, maxSlots);

  // --- CSS ---
  // Layout approach: .panels is a CSS grid with (1 + rightDayCount) columns and
  // 2 rows. Row 1 (auto height) holds all headers; row 2 (1fr) holds all bodies.
  // The grid automatically sizes row 1 to the tallest header across all columns,
  // so all headers are always the same height without any JS measurement.
  // DOM order: today-header, all day-col-headers, today-body, all day-col-bodies.
  //
  // Visual structure per column:
  //   today: bright-blue header (border-radius top) + dark-blue body (border-radius bottom)
  //   days:  mid-blue header (border-radius top) + dark body (border-radius bottom)
  const colsTemplate = leftWidth + 'px repeat(' + rightDayCount + ', 1fr)';

  const styles = (
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body {' +
    '  width: '  + width  + 'px; height: ' + height + 'px;' +
    '  overflow: hidden; background: #0d1b2a; color: #dde6f0;' +
    '  font-family: Arial, Helvetica, sans-serif, "Noto Emoji";' +
    '}' +

    // Outer flex column — label (optional), alert strip (optional), panels grid.
    '.outer {' +
    '  width: '  + width  + 'px; height: ' + height + 'px;' +
    '  padding: ' + pad + 'px;' +
    '  display: flex; flex-direction: column;' +
    '  gap: '     + outerGap + 'px;' +
    '}' +

    // "FFD Calendar" title — full layout only.
    (showLabel
      ? '.cal-label {' +
        '  font-size: '     + labelFont + 'px; font-weight: 700;' +
        '  letter-spacing: 0.2em; text-transform: uppercase;' +
        '  color: #5b9ecf; text-align: center;' +
        '  height: '        + labelHeight + 'px;' +
        '  line-height: '   + labelHeight + 'px;' +
        '  flex-shrink: 0;' +
        '}'
      : '') +

    // Active NWS alert banners — only rendered when active alerts exist.
    '.alert-strip {' +
    '  display: flex; flex-direction: column;' +
    '  gap: ' + bannerGap + 'px; flex-shrink: 0;' +
    '}' +
    '.alert-banner {' +
    '  border-radius: 4px;' +
    '  padding: '   + Math.floor(pad * 0.3) + 'px ' + pad + 'px;' +
    '  font-size: ' + alertBannerFont + 'px; font-weight: 700;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.alert-warning  { background:#5c1a1a; border-left:4px solid #c0392b; color:#f0a8a8; }' +
    '.alert-watch    { background:#4a2a0a; border-left:4px solid #d68910; color:#f0d08a; }' +
    '.alert-advisory { background:#3a3a1a; border-left:4px solid #b7950b; color:#e0d890; }' +

    // ── PANELS GRID ──
    // CSS grid: row 1 = auto (sizes to tallest header); row 2 = 1fr (fills remaining).
    // column-gap spaces columns apart; row-gap:0 keeps each header flush against its body.
    '.panels {' +
    '  display: grid;' +
    '  grid-template-columns: ' + colsTemplate + ';' +
    '  grid-template-rows: auto 1fr;' +
    '  column-gap: ' + Math.floor(pad * 0.55) + 'px;' +
    '  row-gap: 0;' +
    '  flex: 1; overflow: hidden; min-height: 0;' +
    '}' +

    // ── TODAY HEADER (grid row 1, col 1) ──
    // Rounded top corners; border-bottom separates from body below.
    // No height set — grid row auto-sizes to the tallest header across all columns.
    '.left-header {' +
    '  background: #1a3a5c;' +
    '  border-radius: 6px 6px 0 0;' +
    '  padding: '        + Math.floor(pad * 0.38) + 'px ' + Math.floor(pad * 0.45) + 'px;' +
    '  border-bottom: 2px solid #2d5a8e;' +
    '  display: flex; flex-direction: column;' +
    '  gap: '            + hdrGap + 'px;' +
    '}' +

    // ── DAY COLUMN HEADERS (grid row 1, cols 2+) ──
    // Identical structure to today header; background differs.
    '.day-col-header {' +
    '  background: #132338;' +
    '  border-radius: 6px 6px 0 0;' +
    '  padding: '        + Math.floor(pad * 0.38) + 'px ' + Math.floor(pad * 0.35) + 'px;' +
    '  border-bottom: 1px solid #1e3a5a;' +
    '  display: flex; flex-direction: column;' +
    '  gap: '            + hdrGap + 'px;' +
    '}' +

    // Shared header date line.
    '.hdr-date {' +
    '  font-size: '  + colDateFont + 'px; font-weight: 700;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.hdr-date .today-label  { color: #ffffff; }' +
    '.hdr-date .today-sep    { color: #5b9ecf; }' +
    '.hdr-date .today-short  { color: #5b9ecf; }' +
    '.hdr-date .col-date-text { color: #5b9ecf; }' +

    // Shared weather rows.
    '.hdr-hl { font-size: ' + colWxFont + 'px; font-weight: 700; color: #dde6f0; }' +
    '.hdr-hl .hi { color: #f0a060; }' +
    '.hdr-hl .lo { color: #80c8f0; }' +
    // Condition text wraps freely — no line-clamp. The CSS grid row auto-sizes
    // to the tallest header content, so all headers expand uniformly to match
    // the column with the longest forecast text.
    '.hdr-cond {' +
    '  font-size: '    + colWxFont + 'px; color: #a8d1f0;' +
    '  line-height: 1.4;' +
    '}' +
    '.hdr-wind { font-size: ' + colWindFont + 'px; color: #7ab3d9; }' +

    // Future alert badge rows.
    // Fixed height = 2 text lines + padding + 2px borders. Using a fixed height
    // (rather than free-wrap) keeps all badge rows the same height within each
    // column regardless of individual text length, so badge rows stack evenly.
    // display:flex + align-items:center vertically centers single-line text in
    // the 2-line box; 2-line text fills it naturally.
    '.future-alert-badge {' +
    '  border-radius: 3px;' +
    '  padding: '      + Math.floor(pad * 0.12) + 'px ' + Math.floor(pad * 0.35) + 'px;' +
    '  font-size: '    + badgeFont + 'px; font-weight: 600;' +
    '  height: '       + badgeRowH + 'px; overflow: hidden;' +
    '  display: flex; align-items: center;' +
    '  border: 1px solid transparent; line-height: 1.4;' +
    '}' +
    '.badge-warning   { background:#3a1a1a; border-color:#c0392b; color:#f0a8a8; }' +
    '.badge-watch     { background:#2e2a1a; border-color:#d68910; color:#f0d08a; }' +
    '.badge-advisory  { background:#3a3a1a; border-color:#b7950b; color:#e0d890; }' +
    // Invisible spacer — same fixed height as a real badge, no visible content.
    '.badge-placeholder {' +
    '  background: transparent !important;' +
    '  border-color: transparent !important;' +
    '  color: transparent !important;' +
    '  pointer-events: none;' +
    '}' +

    // ── TODAY BODY (grid row 2, col 1) ──
    // Rounded bottom corners complete the visual column started by left-header.
    // Horizontal flex: hourly weather strip (left) + events column (right).
    '.left-body {' +
    '  background: #132338;' +
    '  border-radius: 0 0 6px 6px;' +
    '  display: flex; flex-direction: row;' +
    '  overflow: hidden; min-height: 0;' +
    '}' +

    // Hourly weather strip.
    '.wx-strip {' +
    '  width: '      + WEATHER_STRIP_WIDTH + 'px; flex-shrink: 0;' +
    '  background: #0f1e2e; border-right: 1px solid #1e3a5a;' +
    '  display: flex; flex-direction: column;' +
    '  overflow: hidden;' +
    '  padding: '    + Math.floor(pad * 0.3) + 'px 0;' +
    '}' +
    '.wx-slot {' +
    '  display: flex; flex-direction: column; align-items: center;' +
    '  padding: '    + Math.floor(pad * 0.28) + 'px 0 ' + Math.floor(pad * 0.22) + 'px;' +
    '  flex-shrink: 0;' +
    '}' +
    '.wx-time {' +
    '  font-size: '  + wxTimeFont + 'px; color: #4a9eda;' +
    '  font-weight: 700; line-height: 1; margin-bottom: 3px;' +
    '}' +
    '.wx-time.now-label { color: #f0a060; letter-spacing: 0.05em; }' +
    '.wx-temp {' +
    '  font-size: '  + wxTempFont + 'px; font-weight: 700;' +
    '  color: #dde6f0; line-height: 1; margin-bottom: 2px;' +
    '}' +
    '.wx-emoji { font-size: ' + wxEmojiFont + 'px; line-height: 1; }' +
    '.wx-divider {' +
    '  width: '      + Math.floor(WEATHER_STRIP_WIDTH * 0.6) + 'px;' +
    '  border-top: 1px solid #1e3a5a;' +
    '  margin-top: ' + Math.floor(pad * 0.22) + 'px;' +
    '}' +

    // Today events column.
    '.today-events {' +
    '  flex: 1; overflow: hidden;' +
    '  padding: '    + Math.floor(pad * 0.45) + 'px ' + Math.floor(pad * 0.5) + 'px;' +
    '  display: flex; flex-direction: column;' +
    '}' +

    // All-day shift color banners — shared by today and day column bodies.
    '.allday-banner {' +
    '  background: #1e4d7a; border-left: 3px solid #4a9eda; border-radius: 3px;' +
    '  padding: '       + Math.floor(pad * 0.25) + 'px ' + Math.floor(pad * 0.45) + 'px;' +
    '  margin-bottom: ' + Math.floor(pad * 0.28) + 'px;' +
    '  font-size: '     + bannerFont + 'px; color: #a8d1f0;' +
    '  overflow: hidden;' + // Change to 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' to suppress wrapping
    '}' +

    // Stacked event: time label on its own line above title.
    '.today-event {' +
    '  margin-bottom: '  + Math.floor(pad * 0.42) + 'px;' +
    '  padding-bottom: ' + Math.floor(pad * 0.32) + 'px;' +
    '  border-bottom: 1px solid #1a3050; flex-shrink: 0;' +
    '}' +
    '.today-event:last-child { border-bottom: none; margin-bottom: 0; }' +
    '.today-evt-time {' +
    '  font-size: '  + evtTimeFont + 'px; font-weight: 700;' +
    '  color: #4a9eda; line-height: 1.2;' +
    '}' +
    '.today-evt-title {' +
    '  font-size: '  + evtTitleFont + 'px; font-weight: 600; color: #dde6f0;' +
    '  line-height: 1.3;' +
    '  overflow: hidden;' + // Change to 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' to suppress wrapping
    '}' +
    '.today-evt-loc {' +
    '  font-size: '  + evtLocFont + 'px; color: #7ab3d9; margin-top: 1px;' +
    '  overflow: hidden;' + // Change to 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' to suppress wrapping
    '}' +

    // ── DAY COLUMN BODIES (grid row 2, cols 2+) ──
    // Rounded bottom corners complete the visual column started by day-col-header.
    '.day-col-body {' +
    '  background: #0f1e2e;' +
    '  border-radius: 0 0 6px 6px;' +
    '  overflow: hidden; min-height: 0;' +
    '  padding: ' + Math.floor(pad * 0.32) + 'px;' +
    '}' +
    '.day-event { margin-bottom: ' + Math.floor(pad * 0.30) + 'px; }' +
    '.day-time {' +
    '  font-size: ' + dayTimeFont + 'px; color: #4a9eda; font-weight: 600;' +
    '}' +
    '.day-title {' +
    '  font-size: ' + dayTitleFont + 'px; color: #c8dae8;' +
    '  overflow: hidden;' + // Change to 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' to suppress wrapping
    '}' +
    '.no-events {' +
    '  font-size: ' + noEventsFont + 'px; color: #3d5a73; font-style: italic;' +
    '}'
  );

  // --- Build active alert banners ---
  let alertStripHtml = '';
  if (activeAlerts.length > 0) {
    alertStripHtml = '<div class="alert-strip">';
    for (const alert of activeAlerts) {
      const p   = alert.properties;
      const cls = getAlertBannerClass(p);
      const txt = (
        '\u26A0 ' +
        (p.event || 'Weather Alert') +
        ' \u2014 ' +
        // Use p.ends (actual weather event end) if available, falling back to
      // p.expires (alert product expiry). NWS often sets expires to when they
      // plan to issue the next update, which can be hours before the hazard ends.
      formatExpiresLabel(p.ends || p.expires, todayStr)
      );
      alertStripHtml += (
        '<div class="alert-banner ' + cls + '">' +
          escapeHtml(txt) +
        '</div>'
      );
    }
    alertStripHtml += '</div>';
  }

  // --- Helper: build badge rows HTML for one date ---
  // Renders exactly maxBadgeCount elements: real badges where alerts exist,
  // invisible .badge-placeholder elements to pad columns with fewer alerts.
  // Returns empty string when maxBadgeCount === 0 (no future alerts anywhere).
  function buildBadgeRowsHtml(dateStr) {
    if (maxBadgeCount === 0) return '';
    const badges = badgesPerDate[dateStr] || [];
    let html = '';

    for (const alert of badges) {
      const p      = alert.properties;
      const cls    = getAlertBadgeClass(p);
      const timing = formatAlertTiming(p, dateStr);
      const txt    = '\u26A0 ' + (p.event || 'Alert') + ' \u00B7 ' + timing;
      html += (
        '<div class="future-alert-badge ' + cls + '">' +
          escapeHtml(txt) +
        '</div>'
      );
    }

    // Pad to maxBadgeCount with invisible placeholder rows.
    const needed = maxBadgeCount - badges.length;
    for (let i = 0; i < needed; i++) {
      html += '<div class="future-alert-badge badge-placeholder">&nbsp;</div>';
    }

    return html;
  }

  // --- Helper: build weather rows HTML (H/L, condition, wind) ---
  // Shared by both today header and day column headers.
  function buildWeatherRowsHtml(wx) {
    if (!wx) return '';
    let html = '';

    let hlInner = '';
    if (wx.high !== null && wx.low !== null) {
      hlInner = (
        '<span class="hi">H: ' + escapeHtml(String(wx.high)) + '\u00B0</span>' +
        '&ensp;' +
        '<span class="lo">L: ' + escapeHtml(String(wx.low))  + '\u00B0</span>'
      );
    } else if (wx.high !== null) {
      hlInner = '<span class="hi">H: ' + escapeHtml(String(wx.high)) + '\u00B0</span>';
    } else if (wx.low !== null) {
      hlInner = '<span class="lo">L: ' + escapeHtml(String(wx.low)) + '\u00B0</span>';
    }
    if (hlInner) html += '<div class="hdr-hl">' + hlInner + '</div>';

    if (wx.shortForecast) {
      html += (
        '<div class="hdr-cond">' +
          escapeHtml(mapConditionToEmoji(wx.shortForecast) + ' ' + wx.shortForecast) +
        '</div>'
      );
    }

    if (wx.wind) {
      html += '<div class="hdr-wind">' + escapeHtml(wx.wind.trim()) + '</div>';
    }

    return html;
  }

  // --- Build today header HTML ---
  const todayShort    = formatDateShort(todayStr);
  const todayDateHtml = (
    '<div class="hdr-date">' +
      '<span class="today-label">Today</span>' +
      '<span class="today-sep"> &mdash; </span>' +
      '<span class="today-short">' + escapeHtml(todayShort) + '</span>' +
    '</div>'
  );
  const todayHeaderHtml = (
    '<div class="left-header">' +
      todayDateHtml +
      buildWeatherRowsHtml(dailyWeatherMap[todayStr]) +
      buildBadgeRowsHtml(todayStr) +
    '</div>'
  );

  // --- Build day column headers HTML ---
  // Collected separately so all headers can be emitted before any body,
  // matching the CSS grid row order: row 1 = all headers, row 2 = all bodies.
  let allColHeadersHtml = '';
  for (const dateStr of displayDates.slice(1)) {
    const colDateHtml = (
      '<div class="hdr-date">' +
        '<span class="col-date-text">' + escapeHtml(formatDateShort(dateStr)) + '</span>' +
      '</div>'
    );
    allColHeadersHtml += (
      '<div class="day-col-header">' +
        colDateHtml +
        buildWeatherRowsHtml(dailyWeatherMap[dateStr]) +
        buildBadgeRowsHtml(dateStr) +
      '</div>'
    );
  }

  // --- Build today body HTML ---
  // Hourly weather strip.
  let wxStripHtml = '';
  if (hourlySlots.length > 0) {
    wxStripHtml = '<div class="wx-strip">';
    for (let i = 0; i < hourlySlots.length; i++) {
      const slot    = hourlySlots[i];
      const timeCls = slot.isNow ? 'wx-time now-label' : 'wx-time';
      const divider = (i < hourlySlots.length - 1) ? '<div class="wx-divider"></div>' : '';
      wxStripHtml += (
        '<div class="wx-slot">' +
          '<span class="' + timeCls + '">' + escapeHtml(slot.label) + '</span>' +
          '<span class="wx-temp">' + escapeHtml(String(slot.temp)) + '\u00B0</span>' +
          '<span class="wx-emoji">' + slot.emoji + '</span>' +
          divider +
        '</div>'
      );
    }
    wxStripHtml += '</div>';
  }

  // Today calendar events.
  const todayEvts  = getEventsForDate(events, todayStr);
  const todayAD    = sortAllDayEvents(todayEvts.filter(function(e) { return e.allDay; }));
  const todayTimed = todayEvts.filter(function(e) { return !e.allDay; }).sort(sortByStart);

  let todayEventsHtml = '';
  for (const e of todayAD) {
    todayEventsHtml += (
      '<div class="allday-banner"' + getAllDayBannerStyle(e.summary) + '>' +
        escapeHtml(e.summary || 'All Day') +
      '</div>'
    );
  }
  if (todayTimed.length === 0 && todayAD.length === 0) {
    todayEventsHtml += '<div class="no-events">No events today</div>';
  } else {
    for (const e of todayTimed) {
      todayEventsHtml += (
        '<div class="today-event">' +
          '<div class="today-evt-time">' + escapeHtml(formatTime(e.start)) + '</div>' +
          '<div class="today-evt-title">' + escapeHtml(e.summary || '(No title)') + '</div>' +
          (e.location
            ? '<div class="today-evt-loc">' + escapeHtml(e.location) + '</div>'
            : '') +
        '</div>'
      );
    }
  }

  const todayBodyHtml = (
    '<div class="left-body">' +
      wxStripHtml +
      '<div class="today-events">' + todayEventsHtml + '</div>' +
    '</div>'
  );

  // --- Build day column bodies HTML ---
  let allColBodiesHtml = '';
  for (const dateStr of displayDates.slice(1)) {
    const dayEvts = getEventsForDate(events, dateStr);
    const dayAD   = sortAllDayEvents(dayEvts.filter(function(e) { return e.allDay; }));
    const dayTmd  = dayEvts.filter(function(e) { return !e.allDay; }).sort(sortByStart);

    let colContent = '';
    for (const e of dayAD) {
      colContent += (
        '<div class="allday-banner"' + getAllDayBannerStyle(e.summary) + '>' +
          escapeHtml(e.summary || 'All Day') +
        '</div>'
      );
    }
    if (dayTmd.length === 0 && dayAD.length === 0) {
      colContent += '<div class="no-events">No events</div>';
    } else {
      for (const e of dayTmd) {
        colContent += (
          '<div class="day-event">' +
            '<div class="day-time">' + escapeHtml(formatTime(e.start)) + '</div>' +
            '<div class="day-title">' + escapeHtml(e.summary || '(No title)') + '</div>' +
          '</div>'
        );
      }
    }

    allColBodiesHtml += '<div class="day-col-body">' + colContent + '</div>';
  }

  // --- Assemble full page ---
  // Grid children order: all headers (row 1) then all bodies (row 2).
  const body = (
    '<div class="outer">' +
      (showLabel ? '<div class="cal-label">FFD Calendar</div>' : '') +
      alertStripHtml +
      '<div class="panels">' +
        todayHeaderHtml +
        allColHeadersHtml +
        todayBodyHtml +
        allColBodiesHtml +
      '</div>' +
    '</div>'
  );

  return buildHtmlDoc(width, height, styles, body);
}
function buildStripLayout(events, displayDates, layout, layoutKey) {
  const { width, height } = layout;

  const pad          = Math.floor(height * 0.030);
  const dateColWidth = Math.floor(width * 0.22);
  const dayHeadFont  = Math.floor(height * 0.026);
  const timeFont     = Math.floor(height * 0.025);
  const titleFont    = Math.floor(height * 0.026);
  const bannerFont   = Math.floor(height * 0.023);
  const noEventsFont = Math.floor(height * 0.022);
  const timeColWidth = Math.floor((width - dateColWidth) * 0.36);
  const rowGap       = Math.floor(pad * 0.45);

  const styles = (
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body {' +
    '  width: '  + width  + 'px; height: ' + height + 'px;' +
    '  overflow: hidden; background: #0d1b2a; color: #dde6f0;' +
    '  font-family: Arial, Helvetica, sans-serif, "Noto Emoji";' +
    '}' +
    '.strip {' +
    '  width: '   + width  + 'px; height: ' + height + 'px;' +
    '  padding: ' + pad    + 'px; overflow: hidden;' +
    '  display: flex; flex-direction: column;' +
    '  gap: '     + rowGap + 'px;' +
    '}' +

    // Each day is a horizontal row: date column left, events column right.
    '.day-row {' +
    '  display: flex; flex-direction: row; flex-shrink: 0;' +
    '  min-height: 0;' +
    '}' +

    // Date column — fixed width, top-aligned, right border acts as divider.
    '.day-date {' +
    '  width: '        + dateColWidth + 'px; flex-shrink: 0;' +
    '  padding-right: ' + Math.floor(pad * 0.5) + 'px;' +
    '  padding-top: '   + Math.floor(pad * 0.05) + 'px;' +
    '  border-right: 2px solid #1e3a5a;' +
    '  font-size: '    + dayHeadFont + 'px; font-weight: 700; color: #5b9ecf;' +
    '  line-height: 1.3;' +
    '}' +

    // Events column — fills remaining width, left padding creates separation.
    '.day-events {' +
    '  flex: 1; min-width: 0;' +
    '  padding-left: ' + Math.floor(pad * 0.5) + 'px;' +
    '  display: flex; flex-direction: column;' +
    '}' +

    '.allday-banner {' +
    '  background: #1e4d7a; border-left: 3px solid #4a9eda; border-radius: 3px;' +
    '  padding: '       + Math.floor(pad * 0.18) + 'px ' + Math.floor(pad * 0.4) + 'px;' +
    '  margin-bottom: ' + Math.floor(pad * 0.14) + 'px;' +
    '  font-size: '     + bannerFont + 'px; color: #a8d1f0;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '  flex-shrink: 0;' +
    '}' +

    '.event-row {' +
    '  display: flex; gap: ' + Math.floor(pad * 0.4) + 'px;' +
    '  margin-bottom: ' + Math.floor(pad * 0.14) + 'px;' +
    '}' +
    '.event-time {' +
    '  width: '         + timeColWidth + 'px; flex-shrink: 0;' +
    '  font-size: '     + timeFont + 'px; color: #4a9eda; font-weight: 600;' +
    '}' +
    '.event-title {' +
    '  flex: 1; min-width: 0;' +
    '  font-size: '     + titleFont + 'px; color: #c8dae8;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.no-events {' +
    '  font-size: '     + noEventsFont + 'px; color: #3d5a73; font-style: italic;' +
    '}'
  );

  let rowsHtml = '';

  for (const dateStr of displayDates) {
    const dayEvts = getEventsForDate(events, dateStr);
    const dayAD   = sortAllDayEvents(dayEvts.filter(e =>  e.allDay));
    const dayTmd  = dayEvts.filter(e => !e.allDay).sort(sortByStart);

    // Format date as two lines: "Mon" on top, "3/18" below, for compact display.
    const shortLabel = formatDateShort(dateStr); // e.g. "Mon 3/18"
    const spaceIdx   = shortLabel.indexOf(' ');
    const dateLine1  = spaceIdx !== -1 ? shortLabel.substring(0, spaceIdx) : shortLabel;
    const dateLine2  = spaceIdx !== -1 ? shortLabel.substring(spaceIdx + 1) : '';

    let eventsHtml = '';
    for (const e of dayAD) {
      eventsHtml +=
        '<div class="allday-banner"' + getAllDayBannerStyle(e.summary) + '>' +
          escapeHtml(e.summary || 'All Day') +
        '</div>';
    }
    if (dayTmd.length === 0 && dayAD.length === 0) {
      eventsHtml += '<div class="no-events">No events</div>';
    } else {
      for (const e of dayTmd) {
        eventsHtml +=
          '<div class="event-row">' +
            '<div class="event-time">' + escapeHtml(formatTime(e.start)) + '</div>' +
            '<div class="event-title">' + escapeHtml(e.summary || '(No title)') + '</div>' +
          '</div>';
      }
    }

    rowsHtml +=
      '<div class="day-row">' +
        '<div class="day-date">' +
          escapeHtml(dateLine1) +
          (dateLine2 ? '<br>' + escapeHtml(dateLine2) : '') +
        '</div>' +
        '<div class="day-events">' + eventsHtml + '</div>' +
      '</div>';
  }

  return buildHtmlDoc(width, height, styles, '<div class="strip">' + rowsHtml + '</div>');
}


// =============================================================================
// EVENT HELPERS
// =============================================================================

// Returns all events from the pool that fall on the given YYYY-MM-DD date string.
// For all-day events, checks whether the date falls within the start..end range.
// ICS DTEND for all-day events is exclusive (the day after the last day), so
// the comparison uses >= start and < end.
// For timed events, compares the event's start time converted to Central time.
function getEventsForDate(events, dateStr) {
  return events.filter(event => {
    if (!event.start) return false;

    if (event.allDay) {
      const startStr = event.startStr || '';
      // Fall back to startStr if no endStr (single-day all-day event).
      const endStr   = event.endStr   || '';
      if (!endStr) return dateStr === startStr;
      return dateStr >= startStr && dateStr < endStr;
    }

    return toLocalDateStr(event.start) === dateStr;
  });
}

// Sorts events ascending by start time.
function sortByStart(a, b) {
  return (a.start ? a.start.getTime() : 0) -
         (b.start ? b.start.getTime() : 0);
}


// =============================================================================
// ERROR PAGE
// =============================================================================

function renderErrorPage(message, layout) {
  const { width, height } = layout;
  const fontSize = Math.floor(Math.min(width, height) * 0.022);

  return new Response(
    '<!DOCTYPE html>' +
    '<html lang="en">' +
    '<head>' +
    '<meta charset="UTF-8">' +
    '<meta http-equiv="refresh" content="' + ERROR_RETRY_SECONDS + '">' +
    '<title>Station Calendar</title>' +
    '<style>' +
    'html, body {' +
    '  width: '    + width  + 'px; height: ' + height + 'px;' +
    '  margin: 0; padding: 0; overflow: hidden;' +
    '  background: #0d1b2a; color: #5b9ecf;' +
    '  font-family: Arial, Helvetica, sans-serif, "Noto Emoji";' +
    '  font-size: ' + fontSize + 'px;' +
    '  display: flex; align-items: center; justify-content: center;' +
    '  text-align: center;' +
    '}' +
    '</style>' +
    '</head>' +
    '<body>' + escapeHtml(message) + '</body>' +
    '</html>',
    {
      status: 200,
      headers: {
        'Content-Type':           'text/html; charset=utf-8',
        'Cache-Control':          'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    }
  );
}
