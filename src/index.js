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
//                  and active/future alert banners and per-day alert badges.
//   split / tri  → Strip view: compact chronological list grouped by day.
//                  No weather data displayed (layout too narrow).
//
// All-day events are rendered as colored banners at the top of each day.
// Events can be filtered by exact title match or substring match.
//
// ICS timestamp handling:
//   - UTC timestamps (ending in Z) are converted to Central time
//   - Local timestamps with TZID parameter use the specified timezone
//   - Floating timestamps (no Z, no TZID) are treated as Central time
//   - All-day events (date-only DTSTART) are handled as full-day entries
//
// NWS weather data (wide/full layouts only):
//   - Daily forecast: high/low temp, condition emoji, wind per day column
//   - Hourly forecast: remaining hours of today shown in a 75px left strip
//     inside the today panel, every WEATHER_HOUR_INTERVAL hours
//   - Alerts: active alerts shown as banners above the panel row;
//     future alerts shown as small badges in each affected day's header.
//     Multi-day alerts appear on every day their validity window overlaps.
//     All headers render the same number of badge rows (maxBadgeCount) so
//     heights stay uniform — days with fewer alerts get invisible placeholders.
//     Badge rows are omitted entirely when no visible day has future alerts.
//   All NWS fetches fail gracefully: weather is simply omitted if unavailable.
//
// Caching strategy:
//   - Rendered HTML is cached per layout in the Workers Cache API for
//     CACHE_SECONDS seconds, matching the page meta-refresh interval.
//   - NWS daily and hourly forecasts are edge-cached for 3600s (1 hour) via
//     cf.cacheTtl; alerts are edge-cached for 900s (15 min).
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
//   - Nextcloud credentials stored as Cloudflare Worker secrets
//   - HTTP Basic auth used for WebDAV; app password rather than account password
//   - NWS_USER_AGENT stored as a plain wrangler.toml var (not sensitive)
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
// Useful after configuration changes that affect the rendered output.
const CACHE_VERSION = 2;

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
const FILTER_EXACT = [
  // 'A Shift',
  // 'B Shift',
  // 'C Shift',
];

// Event titles to exclude when the title CONTAINS this string anywhere (case-insensitive).
const FILTER_CONTAINS = [
  // Example: 'Cancelled',
];

// Custom colors for specific all-day event banners.
// Key: event title (case-insensitive exact match).
// bg = background color, border = left accent bar, text = text color.
const ALLDAY_COLORS = {
  'A Shift': { bg: '#1a4d2e', border: '#2d8a50', text: '#a8f0be' },
  'B Shift': { bg: '#e8e8e8', border: '#808080', text: '#1a1a1a' },
  'C Shift': { bg: '#4d1a1a', border: '#c0392b', text: '#f0a8a8' },
};

// --- NWS Weather Configuration ---

// NWS forecast office and grid coordinates for Fargo, ND.
// Verified via: https://api.weather.gov/points/46.8772,-96.7898
// These values are static for Fargo and do not need to change between stations
// (the 2.5km NWS grid produces identical forecasts across Fargo's ~6-mile area).
const NWS_OFFICE   = 'FGF';
const NWS_GRID_X   = 65;
const NWS_GRID_Y   = 57;

// NWS public zone code for Cass County, ND — used for the alerts endpoint.
const NWS_ALERT_ZONE = 'NDZ039';

// How many hourly periods to skip between slots in the today panel strip.
// 2 = show every other hour (e.g. NOW, 2 PM, 4 PM, 6 PM...).
// Increase if the strip feels crowded; decrease for more granularity.
const WEATHER_HOUR_INTERVAL = 2;

// Width in pixels of the hourly weather strip inside the today panel body.
const WEATHER_STRIP_WIDTH = 75;


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
    const cache    = caches.default;
    const cacheKey = new Request(
      'https://calendar-display-cache.internal/v' + CACHE_VERSION +
      '/' + layoutKey,
      { method: 'GET' }
    );

    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      return cachedResponse;
    }

    try {

      // --- Data Fetching ---
      // Strip layouts only need the ICS file.
      // Split layouts fetch ICS and all three NWS endpoints in parallel to
      // minimise total latency. Each NWS fetch catches its own errors and
      // returns null on failure — the calendar renders without weather rather
      // than returning an error page.
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

      // Parse and filter calendar events.
      const allEvents = parseIcs(icsText);
      const events    = applyFilters(allEvents);

      // Build the ordered list of date strings in Central time.
      const todayStr     = getTodayString();
      const displayDates = getDisplayDates(todayStr, DAYS_TO_SHOW);

      // Render the appropriate layout.
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
          'Cache-Control':          'no-store',
          'X-Content-Type-Options': 'nosniff',
          // NOTE: X-Frame-Options intentionally NOT set — loaded as iframe.
        },
      });

      // Cache the rendered page server-side.
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
      console.error('Worker unhandled error:', err);
      return renderErrorPage('A system error occurred. Retrying shortly.', layout);
    }
  },
};


// =============================================================================
// DATE AND TIME HELPERS
// =============================================================================

// Returns today's date string (YYYY-MM-DD) in America/Chicago time.
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
  const base  = new Date(todayStr + 'T12:00:00Z');
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    dates.push(d.toISOString().substring(0, 10));
  }
  return dates;
}

// Formats a YYYY-MM-DD string as a long label, e.g. "Monday, March 18".
function formatDateLong(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday:  'long',
    month:    'long',
    day:      'numeric',
  }).format(d);
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

// Formats an hour label for the hourly weather strip, e.g. "2 PM", "10 PM".
// NWS hourly periods always start on the hour so minute is always :00.
function formatHourLabel(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour:     'numeric',
    hour12:   true,
  }).format(date);
}

// Formats a timestamp as a short hour string for alert timing labels.
// Returns clean labels: "6 PM", "noon", "midnight", "6:30 PM".
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
// Required Worker secrets (Cloudflare dashboard):
//   NEXTCLOUD_URL      — Full WebDAV URL to the ICS file
//   NEXTCLOUD_USERNAME — Nextcloud username
//   NEXTCLOUD_PASSWORD — Nextcloud app password (not account password)

async function fetchIcsFromNextcloud(nextcloudUrl, username, password) {
  const credentials = btoa(username + ':' + password);

  const res = await fetch(nextcloudUrl, {
    method:  'GET',
    headers: { 'Authorization': 'Basic ' + credentials },
    // Bypass Cloudflare edge cache so the Worker always gets the current file.
    cf: { cacheTtl: 0 },
  });

  if (!res.ok) {
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
//   - Set a User-Agent header (NWS requires this for all API requests)
//   - Use cf.cacheTtl to let Cloudflare's edge cache hold NWS responses,
//     reducing how often the Worker actually contacts api.weather.gov
//   - Return null on any error so callers can degrade gracefully
//
// NWS_USER_AGENT is set in wrangler.toml as a plain [vars] entry and accessed
// via env.NWS_USER_AGENT. It is not sensitive — it appears in outbound headers.

// Fetches the 7-day daily forecast for the configured Fargo grid point.
// Returns the periods array or null on failure.
// Edge-cached for 3600s (1 hour); NWS updates daily forecasts ~4x per day.
async function fetchNwsDaily(userAgent) {
  const url = (
    'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y +
    '/forecast'
  );
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: 3600 },
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
// Edge-cached for 3600s (1 hour); NWS updates hourly forecasts ~once per hour.
async function fetchNwsHourly(userAgent) {
  const url = (
    'https://api.weather.gov/gridpoints/' +
    NWS_OFFICE + '/' + NWS_GRID_X + ',' + NWS_GRID_Y +
    '/forecast/hourly'
  );
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: 3600 },
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
// Edge-cached for 900s (15 min) to match the page cache interval.
async function fetchNwsAlerts(userAgent) {
  const url = 'https://api.weather.gov/alerts/active?zone=' + NWS_ALERT_ZONE;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/geo+json' },
      cf: { cacheTtl: 900 },
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
// condition; nighttime periods supply the low. If only one type is available
// for a date (e.g. the daytime period has already passed), only that value
// is set; the other is null and callers omit it from the display.
function buildDailyWeatherMap(periods) {
  const map = {};
  if (!periods) return map;

  for (const p of periods) {
    // NWS startTime is an ISO 8601 string with a timezone offset.
    const startDate = new Date(p.startTime);
    const dateStr   = toLocalDateStr(startDate);

    if (!map[dateStr]) {
      map[dateStr] = { high: null, low: null, shortForecast: null, wind: null };
    }

    if (p.isDaytime) {
      map[dateStr].high          = p.temperature;
      map[dateStr].shortForecast = p.shortForecast;
      // Combine windDirection ("NW") and windSpeed ("18 mph") into one string.
      map[dateStr].wind = (p.windDirection || '') + ' ' + (p.windSpeed || '');
    } else {
      map[dateStr].low = p.temperature;
      // Use nighttime forecast/wind only if no daytime period exists for this date.
      if (!map[dateStr].shortForecast) {
        map[dateStr].shortForecast = p.shortForecast;
        map[dateStr].wind = (p.windDirection || '') + ' ' + (p.windSpeed || '');
      }
    }
  }

  return map;
}

// Builds the list of hourly slots to render in the today panel's weather strip.
// Starts from the current hour (labeled "NOW") and takes every
// WEATHER_HOUR_INTERVAL-th period for the remainder of today only.
// Returns an array of { isNow, label, temp, emoji } objects, or [] if no data.
function buildHourlyStripSlots(hourlyPeriods, todayStr, now) {
  if (!hourlyPeriods) return [];

  // Floor to the start of the current UTC hour so the current period
  // (whose startTime equals that hour boundary) is included.
  const nowMs          = now.getTime();
  const currentHourMs  = nowMs - (nowMs % 3600000);

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
  // i tracks which period to include next; start at 0 (current hour = "NOW"),
  // then advance by WEATHER_HOUR_INTERVAL each time.
  let nextIndex = 0;

  for (let i = 0; i < todayPeriods.length; i++) {
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
// prevent a broad match (e.g. "rain") from shadowing a specific one
// (e.g. "thunderstorm" or "freezing rain").
function mapConditionToEmoji(shortForecast) {
  if (!shortForecast) return '\uD83C\uDF21'; // default thermometer
  const f = shortForecast.toLowerCase();

  if (f.includes('thunderstorm'))                          return '\u26C8\uFE0F'; // ⛈
  if (f.includes('blizzard'))                             return '\u2744\uFE0F'; // ❄️
  if (f.includes('freezing rain') ||
      f.includes('freezing drizzle') ||
      f.includes('wintry mix') ||
      f.includes('sleet'))                                return '\uD83C\uDF28'; // 🌨
  if (f.includes('snow'))                                 return '\u2744\uFE0F'; // ❄️
  if (f.includes('rain') || f.includes('shower'))        return '\uD83C\uDF27'; // 🌧
  if (f.includes('drizzle'))                             return '\uD83C\uDF26'; // 🌦
  if (f.includes('fog') || f.includes('haze') ||
      f.includes('smoke') || f.includes('mist'))         return '\uD83C\uDF2B'; // 🌫
  if (f.includes('blustery') || f.includes('windy') ||
      f.includes('breezy'))                              return '\uD83D\uDCA8'; // 💨
  if (f.includes('mostly cloudy'))                       return '\uD83C\uDF25'; // 🌥
  if (f.includes('partly cloudy') ||
      f.includes('partly sunny'))                        return '\u26C5';       // ⛅
  if (f.includes('mostly sunny') ||
      f.includes('mostly clear'))                        return '\uD83C\uDF24'; // 🌤
  if (f.includes('sunny') || f.includes('clear'))       return '\u2600\uFE0F'; // ☀️
  if (f.includes('cloudy') || f.includes('overcast'))   return '\u2601\uFE0F'; // ☁️
  return '\uD83C\uDF21'; // 🌡 default
}

// Returns the list of alert features whose validity window overlaps the given
// date and that should be shown as a badge on that date's column header.
//
// Rules:
//   For today's panel: show only alerts that have not yet started (onset > now).
//     Alerts already active are shown in the top banner and not repeated here.
//   For future day columns: show all non-expired alerts whose validity window
//     overlaps that date, including those already active — crews on those
//     future shifts need to see the alert regardless of when it started.
//
// Filters out test/cancelled alerts (status !== 'Actual' or messageType === 'Cancel').
function getBadgeAlertsForDate(alertFeatures, dateStr, todayStr, now) {
  if (!alertFeatures) return [];

  return alertFeatures.filter(function(f) {
    const p = f.properties;
    if (!p)                              return false;
    if (p.status !== 'Actual')          return false;
    if (p.messageType === 'Cancel')     return false;

    const onset   = p.onset   ? new Date(p.onset)   : null;
    const expires = p.expires ? new Date(p.expires) : null;
    if (!onset || !expires)            return false;
    if (expires <= now)                return false; // already expired

    const onsetDateStr  = toLocalDateStr(onset);
    const expireDateStr = toLocalDateStr(expires);

    // Alert must overlap this date.
    if (onsetDateStr > dateStr || expireDateStr < dateStr) return false;

    // For today: only show alerts that haven't started yet.
    if (dateStr === todayStr) return onset > now;

    // For future days: show all overlapping non-expired alerts.
    return true;
  });
}

// Returns the list of currently active alert features (onset <= now < expires).
// Used to build the top-of-page active alert banners.
function getActiveAlerts(alertFeatures, now) {
  if (!alertFeatures) return [];

  return alertFeatures.filter(function(f) {
    const p = f.properties;
    if (!p || p.status !== 'Actual' || p.messageType === 'Cancel') return false;
    const onset   = p.onset   ? new Date(p.onset)   : null;
    const expires = p.expires ? new Date(p.expires) : null;
    if (!onset || !expires)  return false;
    return onset <= now && expires > now;
  });
}

// Sorts an alert array by descending severity so the most critical alert
// appears first. Used when displaying multiple simultaneous alerts.
function sortAlertsBySeverity(alerts) {
  const order = { extreme: 0, severe: 1, moderate: 2, minor: 3 };
  return alerts.slice().sort(function(a, b) {
    const sa = order[(a.properties.severity || '').toLowerCase()] ?? 4;
    const sb = order[(b.properties.severity || '').toLowerCase()] ?? 4;
    return sa - sb;
  });
}

// Returns the CSS class for an alert banner (active strip at top of page).
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

// Returns a short timing label for a future alert badge on a specific date:
//   "begins 6 PM"   — alert starts on this date
//   "until noon"    — alert expires on this date (started on a prior date)
//   "all day"       — alert spans the entire date (started before, ends after)
// If onset and expires are both on the same date, "begins H" is returned.
function formatAlertTiming(alertProperties, dateStr) {
  const onset   = alertProperties.onset   ? new Date(alertProperties.onset)   : null;
  const expires = alertProperties.expires ? new Date(alertProperties.expires) : null;

  const onsetDateStr  = onset   ? toLocalDateStr(onset)   : null;
  const expireDateStr = expires ? toLocalDateStr(expires) : null;

  if (onsetDateStr === dateStr) {
    return 'begins ' + formatHourOnly(onset);
  }
  if (expireDateStr === dateStr) {
    return 'until ' + formatHourOnly(expires);
  }
  return 'all day';
}

// Formats the expiry time of an active alert for the top-of-page banner.
// Returns a string like "until Thursday 6 PM".
function formatExpiresLabel(expiresStr) {
  if (!expiresStr) return '';
  const d = new Date(expiresStr);
  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday:  'long',
  }).format(d);
  return 'until ' + day + ' ' + formatHourOnly(d);
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
//   4. Floating local:  DTSTART:20260318T090000  (no Z, no TZID — Central)
//
// Exchange emits Windows timezone names in quotes (e.g. "Central Standard Time").
// These are stripped of quotes and mapped to IANA names via windowsToIana().

function parseIcs(icsText) {
  const normalized = icsText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines      = unfoldLines(normalized.split('\n'));

  const events = [];
  let current  = null;

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    // Preserve original case for params — TZID values must not be uppercased.
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

function parseDatetimeProp(value, params) {
  if (params.includes('VALUE=DATE') || /^\d{8}$/.test(value)) {
    const yr  = parseInt(value.substring(0, 4), 10);
    const mo  = parseInt(value.substring(4, 6), 10) - 1;
    const dy  = parseInt(value.substring(6, 8), 10);
    const date    = new Date(Date.UTC(yr, mo, dy, 12, 0, 0));
    const dateStr = value.substring(0, 4) + '-' +
                    value.substring(4, 6) + '-' +
                    value.substring(6, 8);
    return { date, allDay: true, dateStr };
  }

  if (value.endsWith('Z')) {
    const date = parseRawDateTime(value.slice(0, -1));
    if (!date) return null;
    return { date, allDay: false, dateStr: toLocalDateStr(date) };
  }

  const tzidMatch = params.match(/TZID=([^;]+)/i);
  if (tzidMatch) {
    const rawTzid  = tzidMatch[1].replace(/^"|"$/g, '').trim();
    const ianaZone = windowsToIana(rawTzid);
    const date     = parseLocalDateTimeInZone(value, ianaZone);
    if (!date) return null;
    return { date, allDay: false, dateStr: toLocalDateStr(date) };
  }

  const date = parseLocalDateTimeInZone(value, 'America/Chicago');
  if (!date) return null;
  return { date, allDay: false, dateStr: toLocalDateStr(date) };
}

function parseRawDateTime(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(
    parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10),
    parseInt(m[4], 10), parseInt(m[5], 10),     parseInt(m[6], 10)
  ));
}

function parseLocalDateTimeInZone(value, tzid) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;

  try {
    const [, yr, mo, dy, hr, mn, sc] = m;
    const utcApprox = new Date(Date.UTC(
      parseInt(yr, 10), parseInt(mo, 10) - 1, parseInt(dy, 10),
      parseInt(hr, 10), parseInt(mn, 10),     parseInt(sc, 10)
    ));

    const parts = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(utcApprox)) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }

    const displayedMs = Date.UTC(
      parseInt(parts.year,   10), parseInt(parts.month,  10) - 1,
      parseInt(parts.day,    10), parseInt(parts.hour,   10) % 24,
      parseInt(parts.minute, 10), parseInt(parts.second, 10)
    );
    const intendedMs = Date.UTC(
      parseInt(yr, 10), parseInt(mo, 10) - 1, parseInt(dy, 10),
      parseInt(hr, 10), parseInt(mn, 10),     parseInt(sc, 10)
    );

    return new Date(utcApprox.getTime() - (displayedMs - intendedMs));
  } catch (e) {
    console.error(
      'Datetime parse error for value "' + value +
      '" in timezone "' + tzid + '":', e
    );
    return null;
  }
}

function unescapeIcs(str) {
  return str
    .replace(/\\n/gi, '\n')
    .replace(/\\\\/g, '\\')
    .replace(/\\;/g,  ';')
    .replace(/\\,/g,  ',');
}

// Maps Windows timezone names (Exchange/Outlook) to IANA identifiers.
function windowsToIana(windowsTz) {
  const map = {
    'Eastern Standard Time':            'America/New_York',
    'Eastern Summer Time':              'America/New_York',
    'Central Standard Time':            'America/Chicago',
    'Central Summer Time':              'America/Chicago',
    'Mountain Standard Time':           'America/Denver',
    'Mountain Summer Time':             'America/Denver',
    'US Mountain Standard Time':        'America/Phoenix',
    'Pacific Standard Time':            'America/Los_Angeles',
    'Pacific Summer Time':              'America/Los_Angeles',
    'Alaskan Standard Time':            'America/Anchorage',
    'Hawaiian Standard Time':           'Pacific/Honolulu',
    'UTC':                              'UTC',
    'Greenwich Standard Time':          'UTC',
    'Canada Central Standard Time':     'America/Regina',
    'Atlantic Standard Time':           'America/Halifax',
    'Newfoundland Standard Time':       'America/St_Johns',
    'GMT Standard Time':                'Europe/London',
    'Romance Standard Time':            'Europe/Paris',
    'Central Europe Standard Time':     'Europe/Budapest',
    'Central European Standard Time':   'Europe/Warsaw',
    'W. Europe Standard Time':          'Europe/Berlin',
    'E. Europe Standard Time':          'Europe/Nicosia',
    'AUS Eastern Standard Time':        'Australia/Sydney',
    'Tokyo Standard Time':              'Asia/Tokyo',
    'China Standard Time':              'Asia/Shanghai',
  };
  return map[windowsTz] || windowsTz;
}


// =============================================================================
// EVENT FILTERING
// =============================================================================

function applyFilters(events) {
  return events.filter(function(event) {
    const title      = (event.summary || '').trim();
    const titleLower = title.toLowerCase();

    for (const exact of FILTER_EXACT) {
      if (titleLower === exact.toLowerCase()) return false;
    }
    for (const substr of FILTER_CONTAINS) {
      if (titleLower.includes(substr.toLowerCase())) return false;
    }
    return true;
  });
}

// Returns an inline style string for an all-day event banner using ALLDAY_COLORS.
function getAllDayBannerStyle(summary) {
  const key = Object.keys(ALLDAY_COLORS).find(
    function(k) { return k.toLowerCase() === (summary || '').trim().toLowerCase(); }
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

function sanitizeParam(value) {
  if (!value || typeof value !== 'string') return null;
  return value.replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50);
}

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
// Right panel: day columns, each with daily forecast in the header and
//   stacked events in the body.
// Alert banners: active NWS alerts shown above the panel row.
// Alert badges: future/upcoming alerts shown as colored pills in each affected
//   day's column header. All headers render the same number of badge rows
//   (maxBadgeCount) so heights stay uniform across the display.

function buildSplitLayout(events, displayDates, layout, layoutKey, dailyPeriods, hourlyPeriods, alertFeatures) {
  const { width, height } = layout;
  const now      = new Date();
  const todayStr = displayDates[0];

  // Full layout shows a "Station Calendar" label; other layouts have their
  // own title bar from the display system.
  const showLabel = (layoutKey === 'full');

  // --- Sizing — all values derived proportionally from layout dimensions ---
  const pad = Math.floor(height * 0.030);

  const labelHeight = showLabel ? Math.floor(height * 0.065) : 0;

  // Left panel width — narrowed slightly when 5 day columns are shown.
  const rightDayCount = displayDates.length - 1;
  const leftRatio     = rightDayCount <= 4 ? 0.36 : 0.30;
  const leftWidth     = Math.floor(width * leftRatio);

  // Font sizes (proportional so both wide and full layouts look correct).
  const todayWordFont     = Math.floor(height * 0.040); // "Today" heading
  const todayDayFont      = Math.floor(height * 0.026); // "— Monday"
  const todayDateFont     = Math.floor(height * 0.021); // "April 1, 2026"
  const todayWxFont       = Math.floor(height * 0.019); // H/L + condition + wind line
  const badgeFont         = Math.floor(height * 0.016); // alert badge text
  const evtTimeFont       = Math.floor(height * 0.019); // stacked event time label
  const evtTitleFont      = Math.floor(height * 0.025); // event title
  const evtLocFont        = Math.floor(height * 0.018); // event location
  const wxTimeFont        = Math.floor(height * 0.016); // hourly strip time label
  const wxTempFont        = Math.floor(height * 0.020); // hourly strip temperature
  const wxEmojiFont       = Math.floor(height * 0.024); // hourly strip emoji
  const colDateFont       = Math.floor(height * 0.023); // day column date
  const colWxFont         = Math.floor(height * 0.017); // day column H/L + condition + wind
  const dayTimeFont       = Math.floor(height * 0.021); // day column event time
  const dayTitleFont      = Math.floor(height * 0.022); // day column event title
  const bannerFont        = Math.floor(height * 0.021); // all-day shift color banners
  const alertBannerFont   = Math.floor(height * 0.019); // active NWS alert banner text
  const noEventsFont      = Math.floor(height * 0.021); // "No events" label
  const labelFont         = Math.floor(height * 0.030); // "Station Calendar" title

  // --- Process NWS data ---
  const dailyWeatherMap = buildDailyWeatherMap(dailyPeriods);
  const hourlySlots     = buildHourlyStripSlots(hourlyPeriods, todayStr, now);

  // --- Process alerts ---
  const activeAlerts = sortAlertsBySeverity(getActiveAlerts(alertFeatures, now));

  // Compute per-date badge lists and the overall maximum badge count.
  // maxBadgeCount drives how many badge rows every column header renders
  // so all headers are exactly the same height.
  const badgesPerDate = {};
  for (const dateStr of displayDates) {
    const raw    = getBadgeAlertsForDate(alertFeatures, dateStr, todayStr, now);
    badgesPerDate[dateStr] = sortAlertsBySeverity(raw);
  }
  const maxBadgeCount = displayDates.reduce(function(max, d) {
    return Math.max(max, badgesPerDate[d].length);
  }, 0);

  // --- CSS ---
  const styles = (
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body {' +
    '  width: '  + width  + 'px; height: ' + height + 'px;' +
    '  overflow: hidden; background: #0d1b2a; color: #dde6f0;' +
    '  font-family: Arial, Helvetica, sans-serif;' +
    '}' +
    // Outer flex column — contains label (optional), alert strip (optional), panels.
    '.outer {' +
    '  width: '  + width  + 'px; height: ' + height + 'px;' +
    '  padding: ' + pad   + 'px;' +
    '  display: flex; flex-direction: column; gap: ' + Math.floor(pad * 0.5) + 'px;' +
    '}' +

    // "Station Calendar" label — full layout only.
    (showLabel
      ? '.cal-label {' +
        '  font-size: ' + labelFont + 'px; font-weight: 700;' +
        '  letter-spacing: 0.2em; text-transform: uppercase;' +
        '  color: #5b9ecf; text-align: center;' +
        '  height: ' + labelHeight + 'px; line-height: ' + labelHeight + 'px;' +
        '  flex-shrink: 0;' +
        '}'
      : '') +

    // Active NWS alert banners — shown only when alerts exist, flex-shrink: 0
    // so they take natural height and panels row gets the remaining space.
    '.alert-strip {' +
    '  display: flex; flex-direction: column;' +
    '  gap: ' + Math.floor(pad * 0.25) + 'px; flex-shrink: 0;' +
    '}' +
    '.alert-banner {' +
    '  border-radius: 4px; padding: ' + Math.floor(pad * 0.3) + 'px ' + pad + 'px;' +
    '  font-size: ' + alertBannerFont + 'px; font-weight: 700;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.alert-warning  { background:#5c1a1a; border-left:4px solid #c0392b; color:#f0a8a8; }' +
    '.alert-watch    { background:#4a2a0a; border-left:4px solid #d68910; color:#f0d08a; }' +
    '.alert-advisory { background:#3a3a1a; border-left:4px solid #b7950b; color:#e0d890; }' +

    // Panel row — flex:1 so it takes all remaining height after label + alert strip.
    '.panels {' +
    '  display: flex; flex: 1; gap: ' + pad + 'px;' +
    '  overflow: hidden; min-height: 0;' +
    '}' +

    // ── LEFT (TODAY) PANEL ──
    '.left {' +
    '  width: ' + leftWidth + 'px; flex-shrink: 0;' +
    '  background: #132338; border-radius: 6px;' +
    '  display: flex; flex-direction: column; overflow: hidden;' +
    '}' +

    // Today header — contains day/date text, daily weather row, badge rows.
    '.left-header {' +
    '  background: #1a3a5c;' +
    '  padding: ' + Math.floor(pad * 0.6) + 'px ' + Math.floor(pad * 0.8) + 'px;' +
    '  border-bottom: 2px solid #2d5a8e; flex-shrink: 0;' +
    '  display: flex; flex-direction: column; gap: ' + Math.floor(pad * 0.2) + 'px;' +
    '}' +
    '.today-top-row { display: flex; align-items: baseline; gap: 8px; }' +
    '.today-word {' +
    '  font-size: ' + todayWordFont + 'px; font-weight: 700; color: #fff;' +
    '}' +
    '.today-dash { font-size: ' + todayDayFont + 'px; color: #7ab3d9; }' +
    '.today-dayname { font-size: ' + todayDayFont + 'px; color: #7ab3d9; }' +
    '.today-date { font-size: ' + todayDateFont + 'px; color: #5a8ab0; }' +
    // Daily weather row in today header (H/L, condition emoji, wind).
    '.today-wx-row {' +
    '  display: flex; align-items: center; flex-wrap: wrap;' +
    '  gap: ' + Math.floor(pad * 0.6) + 'px;' +
    '  font-size: ' + todayWxFont + 'px;' +
    '}' +
    '.today-hl { font-weight: 700; color: #dde6f0; }' +
    '.today-hl .hi { color: #f0a060; }' +
    '.today-hl .lo { color: #80c8f0; }' +
    '.today-cond { color: #a8d1f0; }' +
    '.today-wind { color: #7ab3d9; }' +

    // ── FUTURE ALERT BADGES (shared by today header and day column headers) ──
    // Each badge is one fixed-height line. The same maxBadgeCount elements are
    // rendered in every column header — real badges where alerts exist, and
    // transparent .badge-placeholder elements elsewhere — keeping all headers
    // exactly the same height regardless of how many alerts each day has.
    '.future-alert-badge {' +
    '  border-radius: 3px;' +
    '  padding: ' + Math.floor(pad * 0.12) + 'px ' + Math.floor(pad * 0.35) + 'px;' +
    '  font-size: ' + badgeFont + 'px; font-weight: 600;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '  border: 1px solid transparent; line-height: 1.4;' +
    '}' +
    '.badge-warning   { background:#3a1a1a; border-color:#c0392b; color:#f0a8a8; }' +
    '.badge-watch     { background:#2e2a1a; border-color:#d68910; color:#f0d08a; }' +
    '.badge-advisory  { background:#3a3a1a; border-color:#b7950b; color:#e0d890; }' +
    // Invisible spacer — same height as a real badge, no visible content.
    // Used to pad columns that have fewer alerts than maxBadgeCount.
    '.badge-placeholder {' +
    '  background: transparent !important;' +
    '  border-color: transparent !important;' +
    '  color: transparent !important;' +
    '  pointer-events: none;' +
    '}' +

    // ── TODAY BODY — horizontal flex row: weather strip (left) + events (right) ──
    '.left-body {' +
    '  flex: 1; display: flex; flex-direction: row;' +
    '  overflow: hidden; min-height: 0;' +
    '}' +

    // Hourly weather strip — fixed width, slightly darker background to
    // visually separate it from the events column.
    '.wx-strip {' +
    '  width: ' + WEATHER_STRIP_WIDTH + 'px; flex-shrink: 0;' +
    '  background: #0f1e2e; border-right: 1px solid #1e3a5a;' +
    '  display: flex; flex-direction: column;' +
    '  overflow: hidden; padding: ' + Math.floor(pad * 0.3) + 'px 0;' +
    '}' +
    '.wx-slot {' +
    '  display: flex; flex-direction: column; align-items: center;' +
    '  padding: ' + Math.floor(pad * 0.28) + 'px 0 ' + Math.floor(pad * 0.22) + 'px;' +
    '  flex-shrink: 0;' +
    '}' +
    '.wx-time {' +
    '  font-size: ' + wxTimeFont + 'px; color: #4a9eda;' +
    '  font-weight: 700; line-height: 1; margin-bottom: 3px;' +
    '}' +
    '.wx-time.now-label { color: #f0a060; letter-spacing: 0.05em; }' +
    '.wx-temp {' +
    '  font-size: ' + wxTempFont + 'px; font-weight: 700;' +
    '  color: #dde6f0; line-height: 1; margin-bottom: 2px;' +
    '}' +
    '.wx-emoji { font-size: ' + wxEmojiFont + 'px; line-height: 1; }' +
    '.wx-divider {' +
    '  width: ' + Math.floor(WEATHER_STRIP_WIDTH * 0.6) + 'px;' +
    '  border-top: 1px solid #1e3a5a; margin-top: ' + Math.floor(pad * 0.22) + 'px;' +
    '}' +

    // Events column inside today panel.
    '.today-events {' +
    '  flex: 1; overflow: hidden;' +
    '  padding: ' + Math.floor(pad * 0.45) + 'px ' + Math.floor(pad * 0.5) + 'px;' +
    '  display: flex; flex-direction: column;' +
    '}' +

    // All-day shift banners (shared by today events and day column bodies).
    '.allday-banner {' +
    '  background: #1e4d7a; border-left: 3px solid #4a9eda; border-radius: 3px;' +
    '  padding: ' + Math.floor(pad * 0.25) + 'px ' + Math.floor(pad * 0.45) + 'px;' +
    '  margin-bottom: ' + Math.floor(pad * 0.28) + 'px;' +
    '  font-size: ' + bannerFont + 'px; color: #a8d1f0;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;' +
    '}' +

    // Stacked event: time label above title (instead of side-by-side).
    // This frees the full column width for both time and title, and is
    // consistent with the day column event format already in use.
    '.today-event {' +
    '  margin-bottom: ' + Math.floor(pad * 0.42) + 'px;' +
    '  padding-bottom: ' + Math.floor(pad * 0.32) + 'px;' +
    '  border-bottom: 1px solid #1a3050; flex-shrink: 0;' +
    '}' +
    '.today-event:last-child { border-bottom: none; margin-bottom: 0; }' +
    '.today-evt-time {' +
    '  font-size: ' + evtTimeFont + 'px; font-weight: 700;' +
    '  color: #4a9eda; line-height: 1.2;' +
    '}' +
    '.today-evt-title {' +
    '  font-size: ' + evtTitleFont + 'px; font-weight: 600; color: #dde6f0;' +
    '  line-height: 1.3;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.today-evt-loc {' +
    '  font-size: ' + evtLocFont + 'px; color: #7ab3d9; margin-top: 1px;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +

    // ── RIGHT PANEL — day columns ──
    '.right {' +
    '  flex: 1; display: flex;' +
    '  gap: ' + Math.floor(pad * 0.55) + 'px; overflow: hidden;' +
    '}' +
    '.day-col {' +
    '  flex: 1; background: #0f1e2e; border-radius: 6px;' +
    '  display: flex; flex-direction: column; overflow: hidden; min-width: 0;' +
    '}' +

    // Day column header — flex column containing date, weather rows, badge rows.
    '.day-col-header {' +
    '  background: #132338; flex-shrink: 0;' +
    '  padding: ' + Math.floor(pad * 0.38) + 'px ' + Math.floor(pad * 0.35) + 'px;' +
    '  border-bottom: 1px solid #1e3a5a;' +
    '  display: flex; flex-direction: column; gap: ' + Math.floor(pad * 0.15) + 'px;' +
    '}' +
    '.col-date {' +
    '  font-size: ' + colDateFont + 'px; font-weight: 700; color: #5b9ecf;' +
    '}' +
    '.col-hl { font-size: ' + colWxFont + 'px; font-weight: 700; color: #dde6f0; }' +
    '.col-hl .hi { color: #f0a060; }' +
    '.col-hl .lo { color: #80c8f0; }' +
    '.col-cond {' +
    '  font-size: ' + colWxFont + 'px; color: #a8d1f0;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.col-wind { font-size: ' + Math.floor(colWxFont * 0.94) + 'px; color: #7ab3d9; }' +

    // Day column body — events.
    '.day-col-body {' +
    '  flex: 1; overflow: hidden;' +
    '  padding: ' + Math.floor(pad * 0.32) + 'px ' + Math.floor(pad * 0.32) + 'px;' +
    '}' +
    '.day-event { margin-bottom: ' + Math.floor(pad * 0.30) + 'px; }' +
    '.day-time {' +
    '  font-size: ' + dayTimeFont + 'px; color: #4a9eda; font-weight: 600;' +
    '}' +
    '.day-title {' +
    '  font-size: ' + dayTitleFont + 'px; color: #c8dae8;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.no-events {' +
    '  font-size: ' + noEventsFont + 'px; color: #3d5a73; font-style: italic;' +
    '}'
  );

  // ── Build active alert banners ──
  // Only rendered if there are currently active alerts.
  let alertStripHtml = '';
  if (activeAlerts.length > 0) {
    alertStripHtml = '<div class="alert-strip">';
    for (const alert of activeAlerts) {
      const p    = alert.properties;
      const cls  = getAlertBannerClass(p);
      const text = (
        '\u26A0 ' +
        (p.event || 'Weather Alert') +
        ' \u2014 ' +
        formatExpiresLabel(p.expires)
      );
      alertStripHtml += (
        '<div class="alert-banner ' + cls + '">' +
          escapeHtml(text) +
        '</div>'
      );
    }
    alertStripHtml += '</div>';
  }

  // ── Helper: build the badge rows HTML for a given date ──
  // Renders exactly maxBadgeCount elements: real badges followed by
  // invisible placeholder elements to pad to the maximum count.
  // When maxBadgeCount === 0, returns an empty string (no badge rows at all).
  function buildBadgeRowsHtml(dateStr) {
    if (maxBadgeCount === 0) return '';
    const badges = badgesPerDate[dateStr] || [];
    let html = '';

    // Real badges (sorted by severity, most severe first).
    for (const alert of badges) {
      const p      = alert.properties;
      const cls    = getAlertBadgeClass(p);
      const timing = formatAlertTiming(p, dateStr);
      const text   = '\u26A0 ' + (p.event || 'Alert') + ' \u00B7 ' + timing;
      html += (
        '<div class="future-alert-badge ' + cls + '">' +
          escapeHtml(text) +
        '</div>'
      );
    }

    // Invisible placeholder rows to pad to maxBadgeCount.
    const needed = maxBadgeCount - badges.length;
    for (let i = 0; i < needed; i++) {
      html += '<div class="future-alert-badge badge-placeholder">&nbsp;</div>';
    }

    return html;
  }

  // ── Build today panel header ──
  const todayLong     = formatDateLong(todayStr);
  const commaIdx      = todayLong.indexOf(',');
  const todayDayName  = commaIdx !== -1 ? todayLong.substring(0, commaIdx) : todayLong;
  const todayDatePart = commaIdx !== -1 ? todayLong.substring(commaIdx + 1).trim() : '';

  // Daily weather row for today (shared format with day column headers).
  let todayWxRowHtml = '';
  const todayWx = dailyWeatherMap[todayStr];
  if (todayWx) {
    let hlHtml = '';
    if (todayWx.high !== null && todayWx.low !== null) {
      hlHtml = (
        '<span class="today-hl">' +
          '<span class="hi">H: ' + escapeHtml(String(todayWx.high)) + '\u00B0</span>' +
          '&ensp;' +
          '<span class="lo">L: ' + escapeHtml(String(todayWx.low))  + '\u00B0</span>' +
        '</span>'
      );
    } else if (todayWx.high !== null) {
      hlHtml = '<span class="today-hl"><span class="hi">H: ' + escapeHtml(String(todayWx.high)) + '\u00B0</span></span>';
    } else if (todayWx.low !== null) {
      hlHtml = '<span class="today-hl"><span class="lo">L: ' + escapeHtml(String(todayWx.low)) + '\u00B0</span></span>';
    }
    const condHtml = todayWx.shortForecast
      ? '<span class="today-cond">' + escapeHtml(mapConditionToEmoji(todayWx.shortForecast) + ' ' + todayWx.shortForecast) + '</span>'
      : '';
    const windHtml = todayWx.wind
      ? '<span class="today-wind">' + escapeHtml(todayWx.wind.trim()) + '</span>'
      : '';
    if (hlHtml || condHtml || windHtml) {
      todayWxRowHtml = '<div class="today-wx-row">' + hlHtml + condHtml + windHtml + '</div>';
    }
  }

  const todayHeaderHtml = (
    '<div class="left-header">' +
      '<div class="today-top-row">' +
        '<span class="today-word">Today</span>' +
        '<span class="today-dash">&mdash;</span>' +
        '<span class="today-dayname">' + escapeHtml(todayDayName) + '</span>' +
      '</div>' +
      '<div class="today-date">' + escapeHtml(todayDatePart) + '</div>' +
      todayWxRowHtml +
      buildBadgeRowsHtml(todayStr) +
    '</div>'
  );

  // ── Build today panel body (hourly strip + events) ──

  // Hourly weather strip (rendered only if hourly data is available).
  let wxStripHtml = '';
  if (hourlySlots.length > 0) {
    wxStripHtml = '<div class="wx-strip">';
    for (let i = 0; i < hourlySlots.length; i++) {
      const slot    = hourlySlots[i];
      const timeCls = slot.isNow ? 'wx-time now-label' : 'wx-time';
      // Add divider between slots (not after the last one).
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

  // Today's calendar events (stacked layout: time above title).
  const todayEvts  = getEventsForDate(events, todayStr);
  const todayAD    = todayEvts.filter(function(e) { return e.allDay; });
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

  const todayPanelHtml = (
    '<div class="left">' +
      todayHeaderHtml +
      '<div class="left-body">' +
        wxStripHtml +
        '<div class="today-events">' + todayEventsHtml + '</div>' +
      '</div>' +
    '</div>'
  );

  // ── Build right panel day columns ──
  let rightHtml = '';
  for (const dateStr of displayDates.slice(1)) {
    const dayEvts = getEventsForDate(events, dateStr);
    const dayAD   = dayEvts.filter(function(e) { return e.allDay; });
    const dayTmd  = dayEvts.filter(function(e) { return !e.allDay; }).sort(sortByStart);

    // Daily weather row for this column.
    let colWxHtml = '';
    const wx = dailyWeatherMap[dateStr];
    if (wx) {
      let hlHtml = '';
      if (wx.high !== null && wx.low !== null) {
        hlHtml = (
          '<div class="col-hl">' +
            '<span class="hi">H: ' + escapeHtml(String(wx.high)) + '\u00B0</span>' +
            '&ensp;' +
            '<span class="lo">L: ' + escapeHtml(String(wx.low))  + '\u00B0</span>' +
          '</div>'
        );
      } else if (wx.high !== null) {
        hlHtml = '<div class="col-hl"><span class="hi">H: ' + escapeHtml(String(wx.high)) + '\u00B0</span></div>';
      } else if (wx.low !== null) {
        hlHtml = '<div class="col-hl"><span class="lo">L: ' + escapeHtml(String(wx.low)) + '\u00B0</span></div>';
      }
      const condHtml = wx.shortForecast
        ? '<div class="col-cond">' + escapeHtml(mapConditionToEmoji(wx.shortForecast) + ' ' + wx.shortForecast) + '</div>'
        : '';
      const windHtml = wx.wind
        ? '<div class="col-wind">' + escapeHtml(wx.wind.trim()) + '</div>'
        : '';
      colWxHtml = hlHtml + condHtml + windHtml;
    }

    // Calendar events for this column.
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

    rightHtml += (
      '<div class="day-col">' +
        '<div class="day-col-header">' +
          '<div class="col-date">' + escapeHtml(formatDateShort(dateStr)) + '</div>' +
          colWxHtml +
          buildBadgeRowsHtml(dateStr) +
        '</div>' +
        '<div class="day-col-body">' + colContent + '</div>' +
      '</div>'
    );
  }

  // ── Assemble full page ──
  const body = (
    '<div class="outer">' +
      (showLabel ? '<div class="cal-label">Station Calendar</div>' : '') +
      alertStripHtml +
      '<div class="panels">' +
        todayPanelHtml +
        '<div class="right">' + rightHtml + '</div>' +
      '</div>' +
    '</div>'
  );

  return buildHtmlDoc(width, height, styles, body);
}


// =============================================================================
// STRIP LAYOUT — split / tri
// =============================================================================
// Compact list of upcoming days. No weather data — layout is too narrow.
// Unchanged from original.

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
    '  font-family: Arial, Helvetica, sans-serif;' +
    '}' +
    '.strip {' +
    '  width: '   + width  + 'px; height: ' + height + 'px;' +
    '  padding: ' + pad    + 'px; overflow: hidden;' +
    '  display: flex; flex-direction: column;' +
    '  gap: '     + rowGap + 'px;' +
    '}' +
    '.day-row {' +
    '  display: flex; flex-direction: row; flex-shrink: 0; min-height: 0;' +
    '}' +
    '.day-date {' +
    '  width: '         + dateColWidth + 'px; flex-shrink: 0;' +
    '  padding-right: ' + Math.floor(pad * 0.5) + 'px;' +
    '  padding-top: '   + Math.floor(pad * 0.05) + 'px;' +
    '  border-right: 2px solid #1e3a5a;' +
    '  font-size: '     + dayHeadFont + 'px; font-weight: 700; color: #5b9ecf;' +
    '  line-height: 1.3;' +
    '}' +
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
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0;' +
    '}' +
    '.event-row {' +
    '  display: flex; gap: ' + Math.floor(pad * 0.4) + 'px;' +
    '  margin-bottom: ' + Math.floor(pad * 0.14) + 'px;' +
    '}' +
    '.event-time {' +
    '  width: '     + timeColWidth + 'px; flex-shrink: 0;' +
    '  font-size: ' + timeFont + 'px; color: #4a9eda; font-weight: 600;' +
    '}' +
    '.event-title {' +
    '  flex: 1; min-width: 0;' +
    '  font-size: ' + titleFont + 'px; color: #c8dae8;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.no-events {' +
    '  font-size: ' + noEventsFont + 'px; color: #3d5a73; font-style: italic;' +
    '}'
  );

  let rowsHtml = '';

  for (const dateStr of displayDates) {
    const dayEvts = getEventsForDate(events, dateStr);
    const dayAD   = dayEvts.filter(function(e) { return e.allDay; });
    const dayTmd  = dayEvts.filter(function(e) { return !e.allDay; }).sort(sortByStart);

    const shortLabel = formatDateShort(dateStr);
    const spaceIdx   = shortLabel.indexOf(' ');
    const dateLine1  = spaceIdx !== -1 ? shortLabel.substring(0, spaceIdx) : shortLabel;
    const dateLine2  = spaceIdx !== -1 ? shortLabel.substring(spaceIdx + 1) : '';

    let eventsHtml = '';
    for (const e of dayAD) {
      eventsHtml += (
        '<div class="allday-banner"' + getAllDayBannerStyle(e.summary) + '>' +
          escapeHtml(e.summary || 'All Day') +
        '</div>'
      );
    }
    if (dayTmd.length === 0 && dayAD.length === 0) {
      eventsHtml += '<div class="no-events">No events</div>';
    } else {
      for (const e of dayTmd) {
        eventsHtml += (
          '<div class="event-row">' +
            '<div class="event-time">' + escapeHtml(formatTime(e.start)) + '</div>' +
            '<div class="event-title">' + escapeHtml(e.summary || '(No title)') + '</div>' +
          '</div>'
        );
      }
    }

    rowsHtml += (
      '<div class="day-row">' +
        '<div class="day-date">' +
          escapeHtml(dateLine1) +
          (dateLine2 ? '<br>' + escapeHtml(dateLine2) : '') +
        '</div>' +
        '<div class="day-events">' + eventsHtml + '</div>' +
      '</div>'
    );
  }

  return buildHtmlDoc(width, height, styles, '<div class="strip">' + rowsHtml + '</div>');
}


// =============================================================================
// EVENT HELPERS
// =============================================================================

// Returns all events that fall on the given YYYY-MM-DD date string.
function getEventsForDate(events, dateStr) {
  return events.filter(function(event) {
    if (!event.start) return false;

    if (event.allDay) {
      const startStr = event.startStr || '';
      const endStr   = event.endStr   || '';
      if (!endStr) return dateStr === startStr;
      // ICS DTEND for all-day events is exclusive (day after last day).
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
    '  font-family: Arial, Helvetica, sans-serif;' +
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
