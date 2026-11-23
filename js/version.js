// Written by tools/stamp_version.py on every deploy. The same string is in index.html (stylesheet,
// entry script and import map), so one value decides whether a phone fetches fresh files.
export const APP_VERSION = '2026-11-23.1259';

/** Appends the version to a fixed same-origin URL so a changed deploy is never served from cache. */
export function versioned(url) {
  return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(APP_VERSION)}`;
}
