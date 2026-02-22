import { StorageLocalPersistState, getStorageLocalPersist } from "./queries";
import {
  removeTabAndIncrementRemoved,
  setTabTime,
  setTabTimes,
} from "./actions/localStorageActions";
import settings from "./settings";

type WrangleOption = "exactURLMatch" | "hostnameAndTitleMatch" | "withDuplicates";

export const AVERAGE_TAB_BYTES_SIZE = 600;

export function findPositionByURL(savedTabs: chrome.tabs.Tab[], url: string | null = ""): number {
  return savedTabs.findIndex((item: chrome.tabs.Tab) => item.url === url && url != null);
}

export function findPositionByHostnameAndTitle(
  savedTabs: chrome.tabs.Tab[],
  url = "",
  title = "",
): number {
  const hostB = new URL(url).hostname;
  return savedTabs.findIndex((tab: chrome.tabs.Tab) => {
    const hostA = new URL(tab.url || "").hostname;
    return hostA === hostB && tab.title === title;
  });
}

export function getURLPositionFilterByWrangleOption(
  savedTabs: chrome.tabs.Tab[],
  option: WrangleOption,
): (tab: chrome.tabs.Tab) => number {
  if (option === "hostnameAndTitleMatch") {
    return (tab: chrome.tabs.Tab): number =>
      findPositionByHostnameAndTitle(savedTabs, tab.url, tab.title);
  } else if (option === "exactURLMatch") {
    return (tab: chrome.tabs.Tab): number => findPositionByURL(savedTabs, tab.url);
  }

  // `'withDupes'` && default
  return () => -1;
}

// Note: Mutates `storageLocalPersist`!
export function wrangleTabs(
  storageLocalPersist: StorageLocalPersistState,
  tabs: Array<chrome.tabs.Tab>,
) {
  // No tabs, nothing to do
  if (tabs.length === 0) return;

  const maxTabs = settings.get<number>("maxTabs");
  const wrangleOption = settings.get<WrangleOption>("wrangleOption");
  const findURLPositionByWrangleOption = getURLPositionFilterByWrangleOption(
    storageLocalPersist.savedTabs,
    wrangleOption,
  );

  const tabIdsToRemove: Array<number> = [];
  for (let i = 0; i < tabs.length; i++) {
    const existingTabPosition = findURLPositionByWrangleOption(tabs[i]);
    const closingDate = Date.now();

    if (existingTabPosition > -1) {
      storageLocalPersist.savedTabs.splice(existingTabPosition, 1);
    }

    // @ts-expect-error `closedAt` is a TW expando property on tabs
    tabs[i].closedAt = closingDate;
    storageLocalPersist.savedTabs.unshift(tabs[i]);
    storageLocalPersist.totalTabsWrangled += 1;

    const tabId = tabs[i].id;
    if (tabId != null) {
      tabIdsToRemove.push(tabId);
    }
  }

  // Note: intentionally not awaiting tab removal! If removal does need to be awaited then this
  // function must be rewritten to get store values before/after async operations.
  if (tabIdsToRemove.length > 0) chrome.tabs.remove(tabIdsToRemove);

  // Trim saved tabs to the max allocated by the setting. Browser extension storage is limited and
  // thus cannot allow saved tabs to grow indefinitely.
  if (storageLocalPersist.savedTabs.length - maxTabs > 0) {
    const tabsToTrim = storageLocalPersist.savedTabs.splice(maxTabs);
    console.log("Exceeded maxTabs (%d), trimming older tabs:", maxTabs);
    console.log(tabsToTrim.map((t) => t.url));
    storageLocalPersist.savedTabs = storageLocalPersist.savedTabs.splice(0, maxTabs);
  }
}

export async function wrangleTabsAndPersist(tabs: Array<chrome.tabs.Tab>) {
  // No tabs, nothing to do
  if (tabs.length === 0) return;

  const storageLocalPersist = await getStorageLocalPersist();
  wrangleTabs(storageLocalPersist, tabs);
  await chrome.storage.local.set({
    "persist:localStorage": storageLocalPersist,
  });
}

export async function initTabs() {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  await setTabTimes(
    tabs.map((tab) => String(tab.id)),
    Date.now(),
  );
}

export function onNewTab(tab: chrome.tabs.Tab) {
  console.debug("[onNewTab] updating new tab", tab);
  // Track new tab's time to close.
  if (tab.id != null) updateLastAccessed(tab.id);
}

export async function removeTab(tabId: number) {
  // Unlock synchronously (in-memory settings cache only, async sync to storage happens inside).
  settings.unlockTab(tabId);
  // Remove tabTime and increment totalTabsRemoved in sequential operations instead of
  // two interleaved lock acquisitions from separate callers.
  await removeTabAndIncrementRemoved(String(tabId));
}

export async function updateClosedCount(
  showBadgeCount: boolean = settings.get("showBadgeCount"),
): Promise<void> {
  let text;
  if (showBadgeCount) {
    const localStorage = await getStorageLocalPersist();
    const savedTabsLength = localStorage.savedTabs.length;
    text = savedTabsLength === 0 ? "" : savedTabsLength.toString();
  } else {
    text = "";
  }
  chrome.action.setBadgeText({ text });
}

export async function updateLastAccessed(tabOrTabId: chrome.tabs.Tab | number): Promise<void> {
  let tabId;
  if (typeof tabOrTabId !== "number" && typeof tabOrTabId.id !== "number") {
    console.log("Error: `tabOrTabId.id` is not an number", tabOrTabId.id);
    return;
  } else if (typeof tabOrTabId === "number") {
    tabId = tabOrTabId;
    await setTabTime(String(tabId), Date.now());
  } else {
    tabId = tabOrTabId.id;
    await setTabTime(String(tabId), tabOrTabId?.lastAccessed ?? new Date().getTime());
  }
}

export function getWhitelistMatch(
  url: string | undefined,
  { whitelist }: { whitelist: string[] },
): string | null {
  if (url == null) return null;
  for (let i = 0; i < whitelist.length; i++) {
    if (url.indexOf(whitelist[i]) !== -1) {
      return whitelist[i];
    }
  }
  return null;
}

export function isTabLocked(
  tab: chrome.tabs.Tab,
  {
    filterAudio,
    filterGroupedTabs,
    lockedIds,
    whitelist,
  }: {
    filterAudio: boolean;
    filterGroupedTabs: boolean;
    lockedIds: number[] | Set<number>;
    whitelist: string[];
  },
): boolean {
  const tabWhitelistMatch = getWhitelistMatch(tab.url, { whitelist });
  const hasLockedId =
    lockedIds instanceof Set ? lockedIds.has(tab.id!) : lockedIds.indexOf(tab.id!) !== -1;
  return (
    tab.pinned ||
    !!tabWhitelistMatch ||
    (tab.id != null && hasLockedId) ||
    !!(filterGroupedTabs && "groupId" in tab && tab.groupId > 0) ||
    !!(tab.audible && filterAudio)
  );
}

export function shouldTabBeClosed(tab: chrome.tabs.Tab): boolean {
  return !isTabLocked(tab, {
    filterAudio: settings.get("filterAudio"),
    filterGroupedTabs: settings.get("filterGroupedTabs"),
    lockedIds: settings.get("lockedIds"),
    whitelist: settings.get("whitelist"),
  });
}

/**
 * Factory that builds the filter context (Set, settings) **once** and returns a reusable
 * predicate. Use this instead of `shouldTabBeClosed` when filtering arrays of tabs so that
 * `lockedIds` is converted to a Set once rather than once per tab.
 *
 * Example:
 *   tabs.filter(createShouldTabBeClosedFilter())
 */
export function createShouldTabBeClosedFilter(): (tab: chrome.tabs.Tab) => boolean {
  const filterAudio: boolean = settings.get("filterAudio");
  const filterGroupedTabs: boolean = settings.get("filterGroupedTabs");
  // Convert array to Set once so isTabLocked gets O(1) lookups for every tab.
  const lockedIds = new Set<number>(settings.get<number[]>("lockedIds"));
  const whitelist: string[] = settings.get("whitelist");
  return (tab: chrome.tabs.Tab) =>
    !isTabLocked(tab, { filterAudio, filterGroupedTabs, lockedIds, whitelist });
}
