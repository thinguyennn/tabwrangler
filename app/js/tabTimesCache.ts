// In-memory cache for tabTimes to prevent constant disk I/O on tab switching
// and background `checkToClose` evaluations.
let memoryTabTimes: { [tabId: string]: number } = {};
let memoryTabTimesByUrl: { [url: string]: number } = {};
let isInitialized = false;

export function initTabTimes(
  initialData: { [tabId: string]: number },
  initialUrlData?: { [url: string]: number },
) {
  memoryTabTimes = { ...initialData };
  if (initialUrlData) memoryTabTimesByUrl = { ...initialUrlData };
  isInitialized = true;
  console.debug(
    "[tabTimesCache] Initialized from storage with",
    Object.keys(memoryTabTimes).length,
    "tabs",
  );
}

export function getTabTimes(): { [tabId: string]: number } {
  if (!isInitialized) {
    console.warn("[tabTimesCache] getTabTimes called before initialization!");
  }
  return memoryTabTimes;
}

export function setTabTime(tabId: string, time: number) {
  memoryTabTimes[tabId] = time;
}

export function setTabTimes(tabIds: string[], time: number) {
  tabIds.forEach((id) => {
    memoryTabTimes[id] = time;
  });
}

export function removeTabTime(tabId: string) {
  delete memoryTabTimes[tabId];
}

/**
 * Specifically used in checkToClose to instantly update the cache without triggering
 * the debounce timer for every single audible/active tab on every single 5s tick.
 * We rely on the end of checkToClose to trigger the sync if needed.
 */
export function setTabTimeSilent(tabId: string, time: number) {
  memoryTabTimes[tabId] = time;
}

export function setTabTimeByUrlSilent(url: string, time: number) {
  memoryTabTimesByUrl[url] = time;
}

export function cleanUpTabTimesByUrl(aliveUrls: string[]) {
  const aliveSet = new Set(aliveUrls);
  for (const url of Object.keys(memoryTabTimesByUrl)) {
    if (!aliveSet.has(url)) {
      delete memoryTabTimesByUrl[url];
    }
  }
}

/**
 * Instantly forces a write to chrome.storage.local without waiting for the debounce.
 * Useful for when the browser/window is closing and we need to guarantee a save.
 */
export async function forceSyncTabTimes() {
  if (!isInitialized) return;
  try {
    await chrome.storage.local.set({
      tabTimes: memoryTabTimes,
      tabTimesByUrl: memoryTabTimesByUrl,
    });
    console.debug("[tabTimesCache] Force-synced tabTimes to disk.");
  } catch (err) {
    console.error("[tabTimesCache] Failed to force-sync tabTimes to disk:", err);
  }
}
