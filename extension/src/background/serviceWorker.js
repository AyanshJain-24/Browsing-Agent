/**
 * Voice Browser Agent - Background Service Worker Router
 * 
 * Acts as the central communication router between the React Side Panel
 * and the active webpage Content Script.
 * 
 * Responsibilities:
 * 1. Side panel open behavior & lifecycle
 * 2. Active tab change tracking (chrome.tabs.onActivated)
 * 3. Page navigation & load tracking (chrome.tabs.onUpdated)
 * 4. Content script lifecycle & SPA navigation routing (PAGE_READY, PAGE_CONTEXT_CHANGED)
 * 5. Routing GET_PAGE_SNAPSHOT requests to the active tab
 * 6. Routing EXECUTE_ACTION commands to the active tab
 * 7. Safe tab resolution and Chrome restricted-URL guardrails
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
function isRestrictedUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const restrictedPrefixes = [
    'chrome://',
    'chrome-extension://',
    'chrome-search://',
    'chrome-untrusted://',
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
  return restrictedPrefixes.some((prefix) => url.startsWith(prefix));
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

  // Forwarding Webpage Requests (GET_PAGE_SNAPSHOT, EXECUTE_ACTION)
  if (
    message.type === 'GET_PAGE_SNAPSHOT' ||
    message.type === 'PAGE_QUERY' ||
    message.type === 'EXECUTE_ACTION' ||
    message.type === 'EXECUTE_STEP'
  ) {
    (async () => {
      const tab = await getTargetTab();

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
          type: 'ERROR',
          isRestricted: true,
          url: tab.url || '',
          error: `Cannot inspect or interact with restricted browser pages (${tab.url || 'internal page'}). Please switch to a regular website.`
        });
        return;
      }

      // Case 3: Forward message to content script in the active tab
      try {
        const response = await chrome.tabs.sendMessage(tab.id, message);
        if (!response) {
          sendResponse({
            success: false,
            type: 'ERROR',
            url: tab.url || '',
            error: 'Empty response received from webpage content script.'
          });
        } else {
          sendResponse(response);
        }
      } catch (err) {
        // Typically occurs if page was opened before extension loaded or is still navigating
        console.warn('[ServiceWorker] tabs.sendMessage error:', err.message);
        sendResponse({
          success: false,
          type: 'ERROR',
          url: tab.url || '',
          error: 'Could not connect to the webpage content script. Please ensure the page is fully loaded or refresh the tab.'
        });
      }
    })();

    return true; // Keep message channel open for async response
  }

  return false;
});
