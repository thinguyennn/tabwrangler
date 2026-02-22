/* eslint-disable sort-imports */
import { ASYNC_LOCK, migrateLocal } from "./js/storage";
import { getStorageLocalPersist, getStorageSyncPersist } from "./js/queries";
import {
  cleanUpTabTimesByUrl,
  forceSyncTabTimes,
  getTabTimes,
  initTabTimes,
  setTabTimeByUrlSilent,
  setTabTimeSilent,
} from "./js/tabTimesCache";
import {
  createShouldTabBeClosedFilter,
  initTabs,
  onNewTab,
  removeTab,
  updateClosedCount,
  updateLastAccessed,
  wrangleTabs,
  wrangleTabsAndPersist,
} from "./js/tabUtil";
import Menus from "./js/menus";
import { removeAllSavedTabs } from "./js/actions/localStorageActions";
import settings from "./js/settings";
import { debounce } from "./js/debounce";
/* eslint-enable sort-imports */

const menus = new Menus();

// Flag to prevent onNewTab from resetting tab times during startup.
// Chrome fires tabs.onCreated for restored tabs on restart, which would
// reset their countdowns before the startup migration can preserve them.
let startupComplete = false;

function setPaused(paused: boolean): Promise<void> {
  if (paused) {
    return chrome.action.setIcon({ path: "img/icon-paused.png" });
  } else {
    return chrome.action.setIcon({ path: "img/icon.png" });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const debouncedUpdateLastAccessed = debounce((tabId: any) => {
  updateLastAccessed(tabId);
}, 1000);
chrome.runtime.onInstalled.addListener(async () => {
  await settings.init();
  if (settings.get("createContextMenu")) Menus.create();
  migrateLocal();
});

chrome.tabs.onActivated.addListener(function onActivated(tabInfo) {
  // settings.init() removed — already called in startup() before scheduleCheckToClose.
  if (settings.get("createContextMenu")) menus.updateContextMenus(tabInfo.tabId);

  if (settings.get("debounceOnActivated")) {
    debouncedUpdateLastAccessed(tabInfo.tabId);
  } else {
    updateLastAccessed(tabInfo.tabId);
  }
});
chrome.tabs.onCreated.addListener((tab: chrome.tabs.Tab) => {
  // During startup, Chrome fires onCreated for all restored tabs. Skip
  // updateLastAccessed for these to avoid resetting their preserved countdowns.
  if (!startupComplete) {
    console.debug("[onCreated] Skipping during startup for tab", tab.id);
    return;
  }
  onNewTab(tab);
});
chrome.tabs.onRemoved.addListener(removeTab);

chrome.tabs.onReplaced.addListener(function replaceTab(addedTabId: number, removedTabId: number) {
  ASYNC_LOCK.acquire(["local.tabTimes", "persist:settings"], async () => {
    // Read lockedIds from sync storage
    const { lockedIds } = await chrome.storage.sync.get({ lockedIds: [] });

    // Replace tab ID in array of locked IDs if the removed tab was locked
    if (lockedIds.indexOf(removedTabId) !== -1) {
      lockedIds.splice(lockedIds.indexOf(removedTabId), 1, addedTabId);
      await chrome.storage.sync.set({ lockedIds });
      console.debug("[onReplaced] Re-locked tab: removedId, addedId", removedTabId, addedTabId);
    }

    // Replace tab ID in object of tab times keeping the same time remaining for the added tab ID
    const tabTimes = getTabTimes();
    if (tabTimes[String(removedTabId)]) {
      setTabTimeSilent(String(addedTabId), tabTimes[String(removedTabId)]);
      delete tabTimes[String(removedTabId)];
      await forceSyncTabTimes(); // Force a sync to disk
      console.debug("[onReplaced] Replaced tab time: removedId, addedId", removedTabId, addedTabId);
    }
  });
});

chrome.commands.onCommand.addListener((command) => {
  switch (command) {
    case "lock-unlock-active-tab":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        settings.toggleTabs(tabs);
      });
      break;
    case "wrangle-current-tab":
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        wrangleTabsAndPersist(tabs);
      });
      break;
    default:
      break;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  switch (areaName) {
    case "local": {
      if ("persist:localStorage" in changes) {
        updateClosedCount();
      }
      break;
    }

    case "sync": {
      if (changes.daysInactive || changes.minutesInactive || changes.secondsInactive) {
        // Reset stored `tabTimes` because setting was changed otherwise old times may exceed new
        // setting value.
        initTabs();

        // Also immediately reschedule the closing check so the new interval format takes effect
        scheduleCheckToClose();
      }

      if (changes["persist:settings"]) {
        if (
          changes["persist:settings"]?.newValue.paused !==
          changes["persist:settings"]?.oldValue?.paused
        ) {
          setPaused(changes["persist:settings"].newValue.paused);
        }
      }

      if (changes.showBadgeCount) {
        updateClosedCount(changes.showBadgeCount.newValue);
      }
      break;
    }
  }
});

function getTabsOlderThan(tabTimes: { [tabId: string]: number }, time: number): Array<number> {
  const ret: Array<number> = [];
  for (const [key, value] of Object.entries(tabTimes)) {
    if (!time || value < time) {
      ret.push(parseInt(key, 10));
    }
  }
  return ret;
}

// Name for the chrome.alarms-based check-to-close alarm.
const CHECK_TO_CLOSE_ALARM = "checkToClose";

function scheduleCheckToClose() {
  const stayOpenTime = settings.get<number>("stayOpen");
  // Calculate a proportional interval — check ~20 times across the stayOpen window.
  // chrome.alarms minimum is 30 seconds (0.5 min). Cap is 3 hours = 10800000ms.
  const intervalMs = Math.max(30000, Math.min(10800000, stayOpenTime / 20));
  const intervalMinutes = intervalMs / 60000;

  console.debug(
    `[scheduleCheckToClose] Scheduling next check in ${Math.round(intervalMs / 1000)}s`,
  );
  // Using chrome.alarms instead of setTimeout so the alarm survives service worker suspension.
  // The previous alarm (if any) is replaced because we use a fixed name.
  chrome.alarms.create(CHECK_TO_CLOSE_ALARM, { delayInMinutes: intervalMinutes });
}

async function checkToClose() {
  const startTime = Date.now();
  try {
    const storageSyncPersist = await getStorageSyncPersist();
    if (storageSyncPersist.paused) return; // Extension is paused, no work needs to be done.

    const cutOff = new Date().getTime() - settings.get<number>("stayOpen");
    const minTabs = settings.get<number>("minTabs");
    const tabsToCloseCandidates = await ASYNC_LOCK.acquire("local.tabTimes", async () => {
      const allTabs = await chrome.tabs.query({});
      const tabTimes = getTabTimes(); // Read from synchronous in-memory cache

      // Tabs which have been locked via the checkbox.
      const lockedIds = new Set(settings.get<Array<number>>("lockedIds"));
      const toCut = new Set(getTabsOlderThan(tabTimes, cutOff));
      const updatedAt = Date.now();

      // Update selected tabs to make sure they don't get closed.
      const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      activeTabs.forEach((tab) => {
        setTabTimeSilent(String(tab.id), updatedAt);
      });

      // Update audible tabs if the setting is enabled to prevent them from being closed.
      if (settings.get("filterAudio") === true) {
        // Note: This does not use the `audible:true` filter in `.query` because it is broken in
        // some Chromium browsers.
        // @see https://github.com/tabwrangler/tabwrangler/issues/519
        allTabs.forEach((tab) => {
          if (tab.audible) setTabTimeSilent(String(tab.id), updatedAt);
        });
      }

      const shouldTabBeClosed = createShouldTabBeClosedFilter();

      function findTabsToCloseCandidates(
        tabs: chrome.tabs.Tab[],
        { resetIfNoCandidates }: { resetIfNoCandidates: boolean },
      ): chrome.tabs.Tab[] {
        // Filter out tabs that should not be closed (pinned, audible, grouped, whitelisted)
        tabs = tabs.filter(shouldTabBeClosed);

        let tabsToCut = tabs.filter((tab) => tab.id == null || toCut.has(tab.id));
        if (tabs.length - minTabs <= 0) {
          // * We have less than minTab tabs, abort.
          // * Also, reset the last accessed time of our current tabs so they don't get closed
          //   when we add a new one
          for (let i = 0; i < tabs.length; i++) {
            const tabId = tabs[i].id;
            if (tabId != null && resetIfNoCandidates) setTabTimeSilent(String(tabId), updatedAt);
          }
          return [];
        }

        // If cutting will reduce us below `minTabs`, only remove the first N to get to `minTabs`.
        tabsToCut = tabsToCut.splice(0, tabs.length - minTabs);
        if (tabsToCut.length === 0) {
          return [];
        }

        const candidates = [];
        for (let i = 0; i < tabsToCut.length; i++) {
          const tabId = tabsToCut[i].id;
          if (tabId == null) continue;
          if (lockedIds.has(tabId)) {
            // Update its time so it gets checked less frequently.
            // Would also be smart to just never add it.
            // @todo: fix that.
            setTabTimeSilent(String(tabId), updatedAt);
            continue;
          }
          candidates.push(tabsToCut[i]);
        }
        return candidates;
      }

      let candidateTabs: chrome.tabs.Tab[] = [];
      if (settings.get("minTabsStrategy") === "allWindows") {
        // * "allWindows" - sum tabs across all open browser windows
        candidateTabs = findTabsToCloseCandidates(allTabs, {
          resetIfNoCandidates: false,
        });
      } else {
        // * "givenWindow" (default) - count tabs within any given window
        const windows = await chrome.windows.getAll({ populate: false });

        // Group existing allTabs by windowId to avoid a heavy populate: true query.
        const tabsByWindowId = allTabs.reduce(
          (acc, tab) => {
            if (tab.windowId != null) {
              if (!acc[tab.windowId]) acc[tab.windowId] = [];
              acc[tab.windowId].push(tab);
            }
            return acc;
          },
          {} as Record<number, chrome.tabs.Tab[]>,
        );

        candidateTabs = windows
          .map((win) =>
            win.id == null
              ? []
              : findTabsToCloseCandidates(tabsByWindowId[win.id] || [], {
                resetIfNoCandidates: win.focused,
              }),
          )
          .reduce((acc, candidates) => acc.concat(candidates), []);
      }

      // Cleanup the cache to string keys for alive tabs only
      const aliveTabIds = new Set(allTabs.map((t) => String(t.id)));
      for (const tabId of Object.keys(tabTimes)) {
        if (!aliveTabIds.has(tabId)) {
          delete tabTimes[tabId];
        }
      }

      const aliveUrls = new Set<string>();
      for (const tab of allTabs) {
        if (tab.id != null) {
          const time = tabTimes[String(tab.id)] || updatedAt;
          setTabTimeSilent(String(tab.id), time);
          // Also store by URL so countdowns survive browser restart (tab IDs change).
          if (tab.url) {
            setTabTimeByUrlSilent(tab.url, time);
            aliveUrls.add(tab.url);
          }
        }
      }

      cleanUpTabTimesByUrl(Array.from(aliveUrls));

      await forceSyncTabTimes(); // Instantly sync `tabTimes` and `tabTimesByUrl` memory caches to storage

      return candidateTabs;
    });

    // Candidates were already filtered by shouldTabBeClosed inside the lock (line 198).
    // Settings don't change within a single cycle, so re-filtering is redundant.
    const tabsToClose = tabsToCloseCandidates;

    if (tabsToClose.length > 0) {
      await ASYNC_LOCK.acquire("persist:localStorage", async () => {
        const storageLocalPersist = await getStorageLocalPersist();
        wrangleTabs(storageLocalPersist, tabsToClose);
        await chrome.storage.local.set({
          "persist:localStorage": storageLocalPersist,
        });
      });
    }
  } catch (error) {
    console.error("[checkToClose]", error);
  } finally {
    const elapsedTime = Date.now() - startTime;
    if (elapsedTime > 5_000)
      console.warn(`[checkToClose] Took longer than maxExecutionTime: ${elapsedTime}ms`);
    scheduleCheckToClose();
  }
}

async function startup() {
  // Load settings before proceeding; Settings reads from async browser storage.
  await settings.init();

  const storageSyncPersist = await getStorageSyncPersist();
  setPaused(storageSyncPersist.paused);

  // Because the badge count is external state, this side effect must be run once the value
  // is read from storage.
  updateClosedCount();

  if (settings.get("purgeClosedTabs") !== false) {
    await removeAllSavedTabs();
  }

  // Migrate tab times from previous session: after a browser restart, Chrome assigns new
  // tab IDs so the old ID-based tabTimes won't match. Use the URL-based map to carry over
  // countdowns from the previous session.
  await ASYNC_LOCK.acquire("local.tabTimes", async () => {
    const { tabTimes, tabTimesByUrl } = await chrome.storage.local.get({
      tabTimes: {},
      tabTimesByUrl: {},
    });
    const allTabs = await chrome.tabs.query({});
    const now = Date.now();
    let migrated = 0;

    const nextTabTimes: { [key: string]: number } = {};
    for (const tab of allTabs) {
      if (tab.id == null) continue;

      if (tabTimes[tab.id] != null) {
        // Tab ID still exists in storage (no restart, or same ID reused) — keep as-is.
        nextTabTimes[tab.id] = tabTimes[tab.id];
      } else if (tab.url && tabTimesByUrl[tab.url] != null) {
        // Tab ID changed (browser restart) but URL matches — carry over the old timestamp.
        nextTabTimes[tab.id] = tabTimesByUrl[tab.url];
        migrated++;
      } else {
        // Completely new tab — start a fresh countdown.
        nextTabTimes[tab.id] = now;
      }
    }

    initTabTimes(nextTabTimes, tabTimesByUrl); // Initialize the in-memory caches
    await forceSyncTabTimes(); // Sync disk so it instantly matches memory setup

    if (migrated > 0) {
      console.debug(`[startup] Migrated ${migrated} tab timer(s) from previous session via URL`);
    }
  });

  // Mark startup complete so onNewTab starts tracking new tabs normally.
  startupComplete = true;

  // Kick off checking for tabs to close
  scheduleCheckToClose();
}

startup();

// NOTE: lostEventsWatchdog is disabled because checkToClose now uses chrome.alarms,
// which survive service worker suspension natively. The watchdog's while(true) loop
// was actively preventing the service worker from sleeping between checks.
// Re-enable if alarms ever prove unreliable (the watchdog would detect broken alarms
// and force-reload the extension).
//
// let lastAlarm = 0;
// (async function lostEventsWatchdog() {
//   let quietCount = 0;
//   while (true) {
//     await new Promise((resolve) => setTimeout(resolve, 65000));
//     const now = Date.now();
//     const age = now - lastAlarm;
//     console.debug(
//       lastAlarm === 0
//         ? `[lostEventsWatchdog]: first alarm`
//         : `[lostEventsWatchdog]: last alarm ${age / 1000}s ago`,
//     );
//     if (age < 95000) {
//       quietCount = 0;
//     } else if (++quietCount >= 3) {
//       console.warn("[lostEventsWatchdog]: reloading!");
//       return chrome.runtime.reload();
//     } else {
//       chrome.alarms.create(`lostEventsWatchdog/${now}`, { delayInMinutes: 0.5 });
//     }
//   }
// })();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHECK_TO_CLOSE_ALARM) {
    checkToClose();
  }
});
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message === "reload") {
    console.warn("[runtime.onMessage]: Manual reload");
    chrome.runtime.reload();
    return true;
  } else if (message.action === "getTabTimes") {
    sendResponse(getTabTimes());
    return true;
  } else return false;
});

// If the browser is closing (the very last window is being removed), we want to make
// sure our in-memory cache is fully synced to disk immediately.
chrome.windows.onRemoved.addListener(async () => {
  const windows = await chrome.windows.getAll();
  // If no windows exist anymore, the browser is effectively shutting down.
  // We can't use Chrome's suspend event because edge cases exist where background scripts
  // die ungracefully. This gives us the best chance to save data.
  if (windows.length === 0) {
    console.debug("[windows.onRemoved] Last window closed, forcing tab times to disk...");
    await forceSyncTabTimes();
  }
});
