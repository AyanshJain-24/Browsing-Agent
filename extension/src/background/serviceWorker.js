/**
 * Voice Browser Agent - Background Service Worker Router
 * 
 * Acts as the central communication router between the React Side Panel,
 * active/background browser tabs, and webpage content scripts.
 * 
 * Responsibilities:
 * 1. Side panel open behavior & lifecycle
 * 2. Active tab change tracking (chrome.tabs.onActivated)
 * 3. Page navigation & load tracking (chrome.tabs.onUpdated)
 * 4. Content script lifecycle & SPA navigation routing (PAGE_READY, PAGE_CONTEXT_CHANGED)
 * 5. Routing GET_PAGE_SNAPSHOT requests to the active tab or specific tab (GET_TAB_SNAPSHOT)
 * 6. Multi-tab management (OPEN_TAB, SWITCH_TAB, CLOSE_TAB, LIST_TABS, CLOSE_TASK_TABS)
 * 7. Safe tab resolution and Chrome restricted-URL guardrails
 * 8. Task-to-tabs association tracking
 */

// Configure side panel to open upon extension icon click
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error('[ServiceWorker] Side panel behavior setup error:', error));
}

// Fallback action click handler for Chrome versions requiring manual trigger
chrome.action.onClicked.addListener(async (tab) => {
  if (chrome.sidePanel && chrome.sidePanel.open && tab?.windowId) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } catch (err) {
      console.warn('[ServiceWorker] Could not open side panel programmatically:', err);
    }
  }
});

/**
 * In-memory map linking active task IDs to the browser tabs created for them:
 * Map<taskId, Set<tabId>>
 */
const taskTabsRegistry = new Map();
const taskStateStore = new Map();

function registerTaskTab(taskId, tabId) {
  if (!taskId || !tabId) return;
  if (!taskTabsRegistry.has(taskId)) {
    taskTabsRegistry.set(taskId, new Set());
  }
  taskTabsRegistry.get(taskId).add(tabId);
}

function unregisterTaskTab(taskId, tabId) {
  if (!taskId || !tabId) return;
  const set = taskTabsRegistry.get(taskId);
  if (set) {
    set.delete(tabId);
    if (set.size === 0) taskTabsRegistry.delete(taskId);
  }
}

/**
 * Broadcasts an event to the extension side panel if it is currently open.
 * Silently catches errors if no receiver is active.
 * @param {Object} payload
 */
function notifySidepanel(payload) {
  try {
    chrome.runtime.sendMessage(payload).catch(() => {
      // Expected when side panel is closed
    });
  } catch {
    // Silently ignore
  }
}

/**
 * Checks whether a tab URL is a restricted internal browser page
 * where Chrome disallows content script execution.
 * @param {string} url
 * @returns {boolean}
 */
export function isRestrictedUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const cleanUrl = url.trim().toLowerCase();
  const restrictedPrefixes = [
    'chrome://',
    'chrome-extension://',
    'chrome-search://',
    'chrome-untrusted://',
    'chrome-error://',
    'edge://',
    'brave://',
    'opera://',
    'devtools://',
    'view-source:',
    'about:',
    'data:',
    'javascript:',
    'https://chromewebstore.google.com',
    'https://chrome.google.com/webstore'
  ];
  return restrictedPrefixes.some((prefix) => cleanUrl.startsWith(prefix));
}

/**
 * Safely resolves the currently active, focused browser tab.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getTargetTab() {
  try {
    // 1. Prefer active tab in the last focused user window
    const [lastFocusedTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (lastFocusedTab) return lastFocusedTab;

    // 2. Fall back to active tab in current window
    const [currentWindowTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return currentWindowTab || null;
  } catch (err) {
    console.error('[ServiceWorker] Error querying tabs:', err);
    return null;
  }
}

/**
 * Waits for a specific tab to reach "complete" loading status.
 * @param {number} tabId
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<chrome.tabs.Tab>}
 */
function waitForTabLoad(tabId, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let timer = null;

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        cleanup();
        resolve(tab);
      }
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Initial check in case it is already complete
    chrome.tabs.get(tabId).then((currentTab) => {
      if (currentTab?.status === 'complete') {
        cleanup();
        resolve(currentTab);
      }
    }).catch(() => {});

    timer = setTimeout(async () => {
      cleanup();
      try {
        const fallbackTab = await chrome.tabs.get(tabId);
        resolve(fallbackTab);
      } catch (err) {
        reject(new Error(`Timeout waiting for tab ${tabId} to complete loading.`));
      }
    }, timeoutMs);
  });
}

// ============================================================================
// TAB LIFECYCLE LISTENERS (AUTOMATIC CONTEXT SYNCHRONIZATION)
// ============================================================================

// 1. Tab switching: Fires when user switches to a different tab (Tab A -> Tab B)
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    notifySidepanel({
      type: 'ACTIVE_TAB_CHANGED',
      tabId: activeInfo.tabId,
      url: tab?.url,
      title: tab?.title,
      isRestricted: isRestrictedUrl(tab?.url)
    });
  } catch (err) {
    notifySidepanel({
      type: 'ACTIVE_TAB_CHANGED',
      tabId: activeInfo.tabId
    });
  }
});

// 2. Navigation / Page Loading: Fires when a tab navigates or loads
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only trigger on meaningful events (page load complete or URL changed)
  if (changeInfo.status === 'complete' || changeInfo.url) {
    const activeTab = await getTargetTab();
    // Only broadcast if the updated tab is the user's currently focused tab
    if (activeTab && activeTab.id === tabId) {
      notifySidepanel({
        type: 'ACTIVE_TAB_UPDATED',
        tabId,
        url: tab.url,
        title: tab.title,
        status: changeInfo.status,
        isRestricted: isRestrictedUrl(tab.url)
      });
    }
  }
});

// Clean up closed tabs from task registry
chrome.tabs.onRemoved.addListener((closedTabId) => {
  for (const [taskId, set] of taskTabsRegistry.entries()) {
    if (set.has(closedTabId)) {
      set.delete(closedTabId);
      if (set.size === 0) taskTabsRegistry.delete(taskId);
    }
  }
});

// ============================================================================
// MAIN MESSAGE ROUTER LISTENER
// ============================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  // Diagnostic Ping
  if (message.type === 'PING') {
    sendResponse({ status: 'PONG', timestamp: Date.now() });
    return false;
  }

  // Basic Tab Metadata Query
  if (message.type === 'GET_ACTIVE_TAB') {
    (async () => {
      const tab = await getTargetTab();
      sendResponse({ tab });
    })();
    return true; // Keep channel open
  }

  // ==========================================================================
  // MULTI-TAB MANAGEMENT (PHASE 7.5)
  // ==========================================================================

  // 1. OPEN_TAB: Opens a URL in a new tab (foreground or background)
  if (message.type === 'OPEN_TAB') {
    (async () => {
      const { url, active = false, waitForLoad = true, taskId } = message;

      if (!url || typeof url !== 'string') {
        sendResponse({ success: false, error: 'Missing or invalid URL parameter.' });
        return;
      }

      if (isRestrictedUrl(url)) {
        sendResponse({
          success: false,
          type: 'RESTRICTED',
          isRestricted: true,
          url,
          error: 'Chrome restricts extensions from controlling this page. Open a regular website to continue.'
        });
        return;
      }

      try {
        const createdTab = await chrome.tabs.create({
          url,
          active: Boolean(active)
        });

        if (taskId && createdTab.id) {
          registerTaskTab(taskId, createdTab.id);
        }

        let loadedTab = createdTab;
        if (waitForLoad && createdTab.id) {
          try {
            loadedTab = await waitForTabLoad(createdTab.id, 8000);
          } catch {
            // Proceed with best-effort tab reference if timeout reached
          }
        }

        sendResponse({
          success: true,
          tab: {
            id: loadedTab.id,
            url: loadedTab.url || url,
            title: loadedTab.title || '',
            status: loadedTab.status
          }
        });
      } catch (err) {
        sendResponse({ success: false, error: `Failed to open tab: ${err.message}` });
      }
    })();
    return true;
  }

  // 2. SWITCH_TAB: Makes a specific tab active and focused
  if (message.type === 'SWITCH_TAB') {
    (async () => {
      const { tabId } = message;
      if (!tabId) {
        sendResponse({ success: false, error: 'Missing tabId parameter.' });
        return;
      }

      try {
        const updatedTab = await chrome.tabs.update(tabId, { active: true });
        sendResponse({ success: true, tabId: updatedTab.id });
      } catch (err) {
        sendResponse({ success: false, error: `Failed to switch to tab ${tabId}: ${err.message}` });
      }
    })();
    return true;
  }

  // 3. CLOSE_TAB: Closes a specific tab
  if (message.type === 'CLOSE_TAB') {
    (async () => {
      const { tabId, taskId } = message;
      if (!tabId) {
        sendResponse({ success: false, error: 'Missing tabId parameter.' });
        return;
      }

      try {
        await chrome.tabs.remove(tabId);
        if (taskId) unregisterTaskTab(taskId, tabId);
        sendResponse({ success: true, tabId });
      } catch (err) {
        sendResponse({ success: false, error: `Failed to close tab ${tabId}: ${err.message}` });
      }
    })();
    return true;
  }

  // 4. LIST_TABS: Enumerates accessible browser tabs
  if (message.type === 'LIST_TABS') {
    (async () => {
      try {
        const allTabs = await chrome.tabs.query({});
        const mapped = allTabs.map((t) => ({
          id: t.id,
          url: t.url,
          title: t.title,
          active: t.active,
          isRestricted: isRestrictedUrl(t.url)
        }));
        sendResponse({ success: true, tabs: mapped });
      } catch (err) {
        sendResponse({ success: false, error: `Failed to list tabs: ${err.message}` });
      }
    })();
    return true;
  }

  // 5. GET_TAB_SNAPSHOT: Observes accessible page content in a specific tab
  if (message.type === 'GET_TAB_SNAPSHOT') {
    (async () => {
      const { tabId } = message;
      if (!tabId) {
        sendResponse({ success: false, error: 'Missing tabId parameter.' });
        return;
      }

      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab) {
          sendResponse({ success: false, error: `Tab with ID ${tabId} not found.` });
          return;
        }

        if (isRestrictedUrl(tab.url)) {
          sendResponse({
            success: false,
            type: 'RESTRICTED',
            isRestricted: true,
            url: tab.url,
            error: 'Chrome restricts extensions from controlling this page. Open a regular website to continue.'
          });
          return;
        }

        // Send snapshot request directly to target tab's content script
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_SNAPSHOT' });
        if (!response) {
          sendResponse({ success: false, error: `Empty response received from tab ${tabId}.` });
        } else {
          sendResponse(response);
        }
      } catch (err) {
        const isAccessOrPermissionErr =
          err.message?.includes('Cannot access') ||
          err.message?.includes('extensions gallery') ||
          err.message?.includes('host permission');

        sendResponse({
          success: false,
          type: isAccessOrPermissionErr ? 'RESTRICTED' : 'ERROR',
          isRestricted: Boolean(isAccessOrPermissionErr),
          error: isAccessOrPermissionErr
            ? `Cannot inspect or interact with restricted or unpermitted browser page (${err.message}).`
            : `Could not connect to webpage content script in tab ${tabId}. The page may still be loading.`
        });
      }
    })();
    return true;
  }

  // 6. CLOSE_TASK_TABS: Closes all tabs opened for a task (except keepTabId)
  if (message.type === 'CLOSE_TASK_TABS') {
    (async () => {
      const { taskId, keepTabId } = message;
      if (!taskId) {
        sendResponse({ success: false, error: 'Missing taskId parameter.' });
        return;
      }

      const tabsToClose = taskTabsRegistry.get(taskId);
      if (tabsToClose) {
        for (const tid of tabsToClose) {
          if (tid !== keepTabId) {
            try {
              await chrome.tabs.remove(tid);
            } catch {
              // Tab may already be closed
            }
          }
        }
        taskTabsRegistry.delete(taskId);
      }
      sendResponse({ success: true });
    })();
    return true;
  }

  // Content script signals from webpage (PAGE_READY or SPA PAGE_CONTEXT_CHANGED)
  if (message.type === 'PAGE_READY' || message.type === 'PAGE_CONTEXT_CHANGED') {
    (async () => {
      const activeTab = await getTargetTab();
      if (activeTab && sender.tab && activeTab.id === sender.tab.id) {
        notifySidepanel({
          type: 'ACTIVE_TAB_UPDATED',
          tabId: sender.tab.id,
          url: message.url
        });
      }
    })();
    sendResponse({ received: true });
    return false;
  }

  // Session task state recovery store (Map<taskId, Object>)
  if (message.type === 'REGISTER_TASK_STATE') {
    if (message.taskId && message.state) {
      taskStateStore.set(message.taskId, {
        ...message.state,
        savedAt: Date.now()
      });
      sendResponse({ success: true, taskId: message.taskId });
    } else {
      sendResponse({ success: false, error: 'Missing taskId or state payload.' });
    }
    return false;
  }

  if (message.type === 'GET_TASK_STATE') {
    const state = message.taskId ? taskStateStore.get(message.taskId) : null;
    sendResponse({ success: Boolean(state), state });
    return false;
  }

  // Forwarding Webpage Requests (GET_PAGE_SNAPSHOT, EXECUTE_ACTION)
  if (
    message.type === 'GET_PAGE_SNAPSHOT' ||
    message.type === 'PAGE_QUERY' ||
    message.type === 'EXECUTE_ACTION' ||
    message.type === 'EXECUTE_STEP'
  ) {
    (async () => {
      // Pin to specific tabId if requested, preventing tab-switch collisions
      let tab = null;
      if (message.tabId) {
        try {
          tab = await chrome.tabs.get(message.tabId);
        } catch {
          tab = null;
        }
        if (!tab || !tab.id) {
          sendResponse({
            success: false,
            type: 'ERROR',
            error: `Target tab ${message.tabId} is no longer available (closed or invalid).`
          });
          return;
        }
      } else {
        tab = await getTargetTab();
      }

      // Case 1: No active tab found
      if (!tab || !tab.id) {
        sendResponse({
          success: false,
          type: 'ERROR',
          error: 'No active browser tab found to communicate with.'
        });
        return;
      }

      // Case 2: Restricted browser page (chrome://, webstore, etc.)
      if (isRestrictedUrl(tab.url)) {
        sendResponse({
          success: false,
          type: 'RESTRICTED',
          isRestricted: true,
          url: tab.url || '',
          error: 'Chrome restricts extensions from controlling this page. Open a regular website to continue.'
        });
        return;
      }

      // Case 3: Forward message to content script in the target tab with bounded retry for late readiness
      let response = null;
      let lastErr = null;
      const isSnapshot = message.type === 'GET_PAGE_SNAPSHOT' || message.type === 'PAGE_QUERY';
      const maxAttempts = isSnapshot ? 3 : 1;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          response = await chrome.tabs.sendMessage(tab.id, message);
          if (response) break;
        } catch (err) {
          lastErr = err;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }
      }

      if (response) {
        sendResponse(response);
      } else {
        const err = lastErr || new Error('Empty response received from webpage content script.');
        console.warn('[ServiceWorker] tabs.sendMessage error:', err.message);
        const isAccessOrPermissionErr =
          isRestrictedUrl(tab.url) ||
          err.message?.includes('Cannot access') ||
          err.message?.includes('extensions gallery') ||
          err.message?.includes('host permission');

        sendResponse({
          success: false,
          type: isAccessOrPermissionErr ? 'RESTRICTED' : 'ERROR',
          isRestricted: Boolean(isAccessOrPermissionErr),
          url: tab.url || '',
          error: isAccessOrPermissionErr
            ? 'Chrome restricts extensions from controlling this page. Open a regular website to continue.'
            : 'Could not connect to the webpage content script. Please ensure the page is fully loaded or refresh the tab.'
        });
      }
    })();

    return true; // Keep message channel open for async response
  }

  return false;
});
