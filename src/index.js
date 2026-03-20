// =============================================================================
// calendar-display — Cloudflare Worker
// =============================================================================
// Fetches a .ics calendar file from Nextcloud via WebDAV and renders it as a
// styled HTML calendar page for fire station displays.
//
// Two layout designs based on the ?layout= URL parameter:
//   wide / full  → Split view: today's events in a left panel,
//                  next N-1 days as columns in a right panel
//   split / tri  → Strip view: compact chronological list grouped by day
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
// Caching strategy:
//   - Rendered HTML is cached per layout in the Workers Cache API for
//     CACHE_SECONDS seconds, matching the page meta-refresh interval.
//   - This prevents redundant Nextcloud fetches and ICS parsing on
//     every display load. Increment CACHE_VERSION to bust all cached pages.
//   - Cache-Control: no-store on HTML responses prevents browser caching.
//     The Workers Cache API handles server-side caching independently.
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
//   - URL parameters sanitized before use
//   - All calendar content HTML-escaped before injection into pages
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
const DAYS_TO_SHOW = 5;

// Page auto-refresh interval in seconds. 900 = 15 minutes.
// Also controls how long rendered HTML is cached in the Workers Cache API.
const CACHE_SECONDS = 900;

// Increment this integer to immediately invalidate all cached pages.
// Useful after configuration changes that affect the rendered output,
// such as updating ALLDAY_COLORS, FILTER_EXACT, or DAYS_TO_SHOW.
const CACHE_VERSION = 1;

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
const ALLDAY_COLORS = {
  'A Shift': { bg: '#1a4d2e', border: '#2d8a50', text: '#a8f0be' },
  'B Shift': { bg: '#e8e8e8', border: '#808080', text: '#1a1a1a' },
  'C Shift': { bg: '#4d1a1a', border: '#c0392b', text: '#f0a8a8' },
};


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

    // wide/full → split view.  split/tri → upcoming strip.
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

      // Fetch the raw ICS text from Nextcloud via WebDAV.
      // Credentials are stored as Worker secrets — never in source code.
      // An app password is used rather than the account password so it can
      // be revoked independently without affecting the Nextcloud account.
      const icsText = await fetchIcsFromNextcloud(
        env.NEXTCLOUD_URL,
        env.NEXTCLOUD_USERNAME,
        env.NEXTCLOUD_PASSWORD
      );

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
        : buildSplitLayout(events, displayDates, layout, layoutKey);

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
// EVENT FILTERING
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
    '<style>' + styles + '</style>' +
    '</head>' +
    '<body>' + body + '</body>' +
    '</html>'
  );
}


// =============================================================================
// SPLIT LAYOUT — wide / full
// =============================================================================
// Left panel: today's events with prominent time and title display.
// Right panel: remaining days as equal-width columns.
// All-day events rendered as colored banners at the top of each panel.

function buildSplitLayout(events, displayDates, layout, layoutKey) {
  const { width, height } = layout;

  // Show a "Station Calendar" title label only in the full layout.
  // Other layouts have a built-in title bar from the display system.
  const showLabel = (layoutKey === 'full');

  // --- Sizing — all values derived proportionally from layout dimensions ---
  const pad           = Math.floor(height * 0.030);
  const labelHeight   = showLabel ? Math.floor(height * 0.065) : 0;
  const panelHeight   = height - (pad * 2) - labelHeight;
  const leftWidth     = Math.floor(width * 0.36);
  const rightWidth    = width - leftWidth - (pad * 3);
  const rightDayCount = displayDates.length - 1;

  const todayHeaderFont = Math.floor(height * 0.046);
  const todayDateFont   = Math.floor(height * 0.030);
  const todayTimeFont   = Math.floor(height * 0.040);
  const todayAmPmFont   = Math.floor(height * 0.026);
  const todayTitleFont  = Math.floor(height * 0.030);
  const todayLocFont    = Math.floor(height * 0.022);
  const dayHeaderFont   = Math.floor(height * 0.028);
  const dayTimeFont     = Math.floor(height * 0.022);
  const dayTitleFont    = Math.floor(height * 0.023);
  const bannerFont      = Math.floor(height * 0.022);
  const noEventsFont    = Math.floor(height * 0.024);
  const labelFont       = Math.floor(height * 0.030);

  // --- Styles ---
  const styles = (
    '*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }' +
    'html, body {' +
    '  width: '  + width  + 'px; height: ' + height + 'px;' +
    '  overflow: hidden; background: #0d1b2a; color: #dde6f0;' +
    '  font-family: Arial, Helvetica, sans-serif;' +
    '}' +
    '.outer {' +
    '  width: '  + width  + 'px; height: ' + height + 'px;' +
    '  padding: ' + pad   + 'px; display: flex; flex-direction: column;' +
    '}' +

    // Title label (full layout only)
    (showLabel
      ? '.cal-label {' +
        '  font-size: '       + labelFont + 'px; font-weight: 700;' +
        '  letter-spacing: 0.2em; text-transform: uppercase;' +
        '  color: #5b9ecf; text-align: center;' +
        '  height: '          + labelHeight + 'px;' +
        '  line-height: '     + labelHeight + 'px;' +
        '  flex-shrink: 0;' +
        '}'
      : '') +

    // Panel row
    '.panels {' +
    '  display: flex; flex: 1; gap: ' + pad + 'px; overflow: hidden;' +
    '  height: ' + panelHeight + 'px;' +
    '}' +

    // Left (today) panel
    '.left {' +
    '  width: '          + leftWidth + 'px; flex-shrink: 0;' +
    '  background: #132338; border-radius: 6px;' +
    '  display: flex; flex-direction: column; overflow: hidden;' +
    '}' +
    '.left-header {' +
    '  background: #1a3a5c;' +
    '  padding: '        + Math.floor(pad * 0.7) + 'px ' + pad + 'px;' +
    '  border-bottom: 2px solid #2d5a8e; flex-shrink: 0;' +
    '}' +
    '.left-header .today-word {' +
    '  font-size: '      + todayHeaderFont + 'px; font-weight: 700; color: #fff;' +
    '}' +
    '.left-header .today-date {' +
    '  font-size: '      + todayDateFont + 'px; color: #7ab3d9; margin-top: 2px;' +
    '}' +
    '.left-body {' +
    '  flex: 1; overflow: hidden;' +
    '  padding: '        + Math.floor(pad * 0.5) + 'px;' +
    '}' +

    // All-day banners (shared by both panels)
    '.allday-banner {' +
    '  background: #1e4d7a; border-left: 3px solid #4a9eda; border-radius: 3px;' +
    '  padding: '        + Math.floor(pad * 0.28) + 'px ' + Math.floor(pad * 0.5) + 'px;' +
    '  margin-bottom: '  + Math.floor(pad * 0.3)  + 'px;' +
    '  font-size: '      + bannerFont + 'px; color: #a8d1f0;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +

    // Timed events in today panel
    '.today-event {' +
    '  display: flex; gap: ' + Math.floor(pad * 0.6) + 'px;' +
    '  margin-bottom: '  + Math.floor(pad * 0.45) + 'px;' +
    '  padding-bottom: ' + Math.floor(pad * 0.35) + 'px;' +
    '  border-bottom: 1px solid #1a3050;' +
    '}' +
    '.today-event:last-child { border-bottom: none; margin-bottom: 0; }' +
    '.today-time {' +
    '  min-width: '      + Math.floor(leftWidth * 0.27) + 'px;' +
    '  font-size: '      + todayTimeFont + 'px; font-weight: 700;' +
    '  color: #4a9eda; line-height: 1.15; flex-shrink: 0;' +
    '}' +
    '.today-time .ampm {' +
    '  font-size: '      + todayAmPmFont + 'px;' +
    '}' +
    '.today-info { flex: 1; overflow: hidden; }' +
    '.today-title {' +
    '  font-size: '      + todayTitleFont + 'px; font-weight: 600; color: #dde6f0;' +
    '  line-height: 1.3;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.today-loc {' +
    '  font-size: '      + todayLocFont + 'px; color: #7ab3d9; margin-top: 2px;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +

    // Right panel (day columns)
    '.right {' +
    '  flex: 1; display: flex;' +
    '  gap: '            + Math.floor(pad * 0.6) + 'px; overflow: hidden;' +
    '}' +
    '.day-col {' +
    '  flex: 1; background: #0f1e2e; border-radius: 6px;' +
    '  display: flex; flex-direction: column; overflow: hidden; min-width: 0;' +
    '}' +
    '.day-col-header {' +
    '  background: #132338; flex-shrink: 0;' +
    '  padding: '        + Math.floor(pad * 0.45) + 'px ' + Math.floor(pad * 0.4) + 'px;' +
    '  border-bottom: 1px solid #1e3a5a;' +
    '  font-size: '      + dayHeaderFont + 'px; font-weight: 700; color: #5b9ecf;' +
    '}' +
    '.day-col-body {' +
    '  flex: 1; overflow: hidden;' +
    '  padding: '        + Math.floor(pad * 0.35) + 'px;' +
    '}' +
    '.day-event { margin-bottom: ' + Math.floor(pad * 0.35) + 'px; }' +
    '.day-time {' +
    '  font-size: '      + dayTimeFont + 'px; color: #4a9eda; font-weight: 600;' +
    '}' +
    '.day-title {' +
    '  font-size: '      + dayTitleFont + 'px; color: #c8dae8;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.no-events {' +
    '  font-size: '      + noEventsFont + 'px; color: #3d5a73; font-style: italic;' +
    '}'
  );

  // --- Build today's left panel content ---
  const todayStr   = displayDates[0];
  const todayEvts  = getEventsForDate(events, todayStr);
  const todayAD    = todayEvts.filter(e =>  e.allDay);
  const todayTimed = todayEvts.filter(e => !e.allDay).sort(sortByStart);

  let todayContent = '';
  for (const e of todayAD) {
    todayContent +=
      '<div class="allday-banner"' + getAllDayBannerStyle(e.summary) + '>' +
        escapeHtml(e.summary || 'All Day') +
      '</div>';
  }

  if (todayTimed.length === 0 && todayAD.length === 0) {
    todayContent += '<div class="no-events">No events today</div>';
  } else {
    for (const e of todayTimed) {
      // Split time string into number and AM/PM for size-differentiated display.
      const timeStr  = formatTime(e.start);
      const tMatch   = timeStr.match(/^(\d+:\d+)\s*([AP]M)$/i);
      const timeNum  = tMatch ? tMatch[1] : timeStr;
      const timeAmPm = tMatch ? tMatch[2] : '';

      todayContent +=
        '<div class="today-event">' +
          '<div class="today-time">' +
            escapeHtml(timeNum) +
            (timeAmPm
              ? '<span class="ampm"> ' + escapeHtml(timeAmPm) + '</span>'
              : '') +
          '</div>' +
          '<div class="today-info">' +
            '<div class="today-title">' +
              escapeHtml(e.summary || '(No title)') +
            '</div>' +
            (e.location
              ? '<div class="today-loc">' + escapeHtml(e.location) + '</div>'
              : '') +
          '</div>' +
        '</div>';
    }
  }

  // Format today's header label: "Today — Monday" / "March 18"
  const todayLong    = formatDateLong(todayStr);
  const commaIdx     = todayLong.indexOf(',');
  const todayDayName = commaIdx !== -1
    ? todayLong.substring(0, commaIdx)
    : todayLong;
  const todayDatePart = commaIdx !== -1
    ? todayLong.substring(commaIdx + 1).trim()
    : '';

  // --- Build right panel day columns ---
  let rightHtml = '';
  for (const dateStr of displayDates.slice(1)) {
    const dayEvts = getEventsForDate(events, dateStr);
    const dayAD   = dayEvts.filter(e =>  e.allDay);
    const dayTmd  = dayEvts.filter(e => !e.allDay).sort(sortByStart);

    let colContent = '';
    for (const e of dayAD) {
      colContent +=
        '<div class="allday-banner"' + getAllDayBannerStyle(e.summary) + '>' +
          escapeHtml(e.summary || 'All Day') +
        '</div>';
    }
    if (dayTmd.length === 0 && dayAD.length === 0) {
      colContent += '<div class="no-events">No events</div>';
    } else {
      for (const e of dayTmd) {
        colContent +=
          '<div class="day-event">' +
            '<div class="day-time">' + escapeHtml(formatTime(e.start)) + '</div>' +
            '<div class="day-title">' + escapeHtml(e.summary || '(No title)') + '</div>' +
          '</div>';
      }
    }

    rightHtml +=
      '<div class="day-col">' +
        '<div class="day-col-header">' + escapeHtml(formatDateShort(dateStr)) + '</div>' +
        '<div class="day-col-body">'   + colContent + '</div>' +
      '</div>';
  }

  // --- Assemble full page ---
  const body =
    '<div class="outer">' +
      (showLabel ? '<div class="cal-label">Station Calendar</div>' : '') +
      '<div class="panels">' +
        '<div class="left">' +
          '<div class="left-header">' +
            '<div class="today-word">Today &mdash; ' +
              escapeHtml(todayDayName) +
            '</div>' +
            '<div class="today-date">' + escapeHtml(todayDatePart) + '</div>' +
          '</div>' +
          '<div class="left-body">' + todayContent + '</div>' +
        '</div>' +
        '<div class="right">' + rightHtml + '</div>' +
      '</div>' +
    '</div>';

  return buildHtmlDoc(width, height, styles, body);
}


// =============================================================================
// STRIP LAYOUT — split / tri
// =============================================================================
// Compact list of upcoming days grouped by date, with all-day banners above
// timed events for each day. Designed for narrower display columns.

function buildStripLayout(events, displayDates, layout, layoutKey) {
  const { width, height } = layout;

  const pad           = Math.floor(height * 0.030);
  const dayHeadFont   = Math.floor(height * 0.030);
  const timeFont      = Math.floor(height * 0.025);
  const titleFont     = Math.floor(height * 0.026);
  const bannerFont    = Math.floor(height * 0.023);
  const noEventsFont  = Math.floor(height * 0.022);
  const timeColWidth  = Math.floor(width  * 0.30);

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
    '  gap: '     + Math.floor(pad * 0.55) + 'px;' +
    '}' +
    '.day-section { display: flex; flex-direction: column; flex-shrink: 0; }' +
    '.day-heading {' +
    '  font-size: '      + dayHeadFont + 'px; font-weight: 700; color: #5b9ecf;' +
    '  padding-bottom: ' + Math.floor(pad * 0.22) + 'px;' +
    '  border-bottom: 1px solid #1e3a5a;' +
    '  margin-bottom: '  + Math.floor(pad * 0.22) + 'px;' +
    '}' +
    '.allday-banner {' +
    '  background: #1e4d7a; border-left: 3px solid #4a9eda; border-radius: 3px;' +
    '  padding: '        + Math.floor(pad * 0.2) + 'px ' + Math.floor(pad * 0.4) + 'px;' +
    '  margin-bottom: '  + Math.floor(pad * 0.18) + 'px;' +
    '  font-size: '      + bannerFont + 'px; color: #a8d1f0;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.event-row {' +
    '  display: flex; gap: ' + Math.floor(pad * 0.4) + 'px;' +
    '  margin-bottom: '  + Math.floor(pad * 0.18) + 'px;' +
    '}' +
    '.event-time {' +
    '  width: '          + timeColWidth + 'px; flex-shrink: 0;' +
    '  font-size: '      + timeFont + 'px; color: #4a9eda; font-weight: 600;' +
    '}' +
    '.event-title {' +
    '  flex: 1; min-width: 0;' +
    '  font-size: '      + titleFont + 'px; color: #c8dae8;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;' +
    '}' +
    '.no-events {' +
    '  font-size: '      + noEventsFont + 'px; color: #3d5a73; font-style: italic;' +
    '}'
  );

  let sectionsHtml = '';

  for (const dateStr of displayDates) {
    const dayEvts = getEventsForDate(events, dateStr);
    const dayAD   = dayEvts.filter(e =>  e.allDay);
    const dayTmd  = dayEvts.filter(e => !e.allDay).sort(sortByStart);

    let sectionBody = '';
    for (const e of dayAD) {
      sectionBody +=
        '<div class="allday-banner"' + getAllDayBannerStyle(e.summary) + '>' +
          escapeHtml(e.summary || 'All Day') +
        '</div>';
    }
    if (dayTmd.length === 0 && dayAD.length === 0) {
      sectionBody += '<div class="no-events">No events</div>';
    } else {
      for (const e of dayTmd) {
        sectionBody +=
          '<div class="event-row">' +
            '<div class="event-time">' + escapeHtml(formatTime(e.start)) + '</div>' +
            '<div class="event-title">' + escapeHtml(e.summary || '(No title)') + '</div>' +
          '</div>';
      }
    }

    sectionsHtml +=
      '<div class="day-section">' +
        '<div class="day-heading">' + escapeHtml(formatDateShort(dateStr)) + '</div>' +
        sectionBody +
      '</div>';
  }

  return buildHtmlDoc(width, height, styles, '<div class="strip">' + sectionsHtml + '</div>');
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
