/**
 * Voice Browser Agent - Chrome Messaging Utility
 * 
 * Provides clean, decoupled async methods for the React Side Panel
 * and Agent Controller to communicate with the background Service Worker,
 * manage browser tabs, and inspect page DOM snapshots.
 */

/**
 * Checks whether the current runtime has access to Chrome Extension APIs.
 * Useful for development fallback when running in standalone Vite preview (localhost:5173).
 * @returns {boolean}
 */
export function isExtensionEnvironment() {
  return typeof chrome !== 'undefined' && Boolean(chrome?.runtime?.sendMessage);
}

/**
 * Standard friendly message when extension encounters a restricted browser page.
 */
export const RESTRICTED_PAGE_MESSAGE = 'Chrome restricts extensions from controlling this page. Open a regular website to continue.';

/**
 * Checks whether a given URL is a privileged or restricted Chrome page
 * where extensions cannot inject content scripts.
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
 * Requests a full structured DOM snapshot from the currently active webpage tab.
 * 
 * Flow:
 * React Side Panel -> Service Worker -> Content Script -> observer.js -> Page Snapshot
 * 
 * @returns {Promise<{ success: boolean, type: string, data?: Object, error?: string }>}
 */
export async function getPageSnapshot(options = {}) {
  if (!isExtensionEnvironment()) {
    return {
      success: false,
      type: 'ERROR',
      error: 'Running outside Chrome Extension context (standalone dev mode).'
    };
  }

  try {
    const tabId = typeof options === 'number' ? options : options?.tabId;
    const response = await chrome.runtime.sendMessage({
      type: 'GET_PAGE_SNAPSHOT',
      ...(tabId ? { tabId } : {})
    });

    if (!response) {
      return {
        success: false,
        type: 'ERROR',
        error: 'No response received from background service worker.'
      };
    }

    return response;
  } catch (err) {
    return {
      success: false,
      type: 'ERROR',
      error: err.message || 'Failed to send message to background service worker.'
    };
  }
}

/**
 * Dispatches an explicit browser action command to the active webpage tab.
 * 
 * Flow:
 * React Side Panel -> Service Worker -> Content Script -> executor.js -> Real DOM Action -> Result
 * 
 * @param {Object} actionCommand - e.g. { action: "click", elementId: "element-1" }
 * @param {Object} [options] - Optional execution options (e.g. { tabId })
 * @returns {Promise<{ success: boolean, type: string, result?: Object, error?: string }>}
 */
export async function executeAction(actionCommand, options = {}) {
  if (!isExtensionEnvironment()) {
    return {
      success: false,
      type: 'ERROR',
      error: 'Running outside Chrome Extension context (standalone dev mode).'
    };
  }

  if (!actionCommand || typeof actionCommand !== 'object' || !actionCommand.action) {
    return {
      success: false,
      type: 'ERROR',
      error: "Invalid action command: missing required 'action' property."
    };
  }

  try {
    const tabId = typeof options === 'number' ? options : options?.tabId;
    const response = await chrome.runtime.sendMessage({
      type: 'EXECUTE_ACTION',
      action: actionCommand,
      ...(tabId ? { tabId } : {})
    });

    if (!response) {
      return {
        success: false,
        type: 'ERROR',
        error: 'No response received from executor.'
      };
    }

    return response;
  } catch (err) {
    return {
      success: false,
      type: 'ERROR',
      error: err.message || 'Failed to dispatch action command to service worker.'
    };
  }
}

/**
 * Retrieves the currently active user tab and its metadata.
 * @returns {Promise<{ success: boolean, tab?: chrome.tabs.Tab, error?: string }>}
 */
export async function getActiveTab() {
  if (!isExtensionEnvironment()) {
    return { success: false, error: 'Outside extension environment.' };
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
    return { success: true, tab: res?.tab || null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Opens a new browser tab with a validated URL and tracks it against a task.
 * @param {string} url
 * @param {Object} [options]
 * @param {boolean} [options.active=false] - Whether to focus the new tab
 * @param {boolean} [options.waitForLoad=true] - Whether to wait for DOM complete
 * @param {string} [options.taskId] - Task ID to associate tab with
 * @returns {Promise<{ success: boolean, tab?: Object, error?: string, isRestricted?: boolean }>}
 */
export async function openTab(url, options = {}) {
  if (!isExtensionEnvironment()) {
    return { success: false, error: 'Outside extension environment.' };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'OPEN_TAB',
      url,
      active: options.active ?? false,
      waitForLoad: options.waitForLoad ?? true,
      taskId: options.taskId
    });
    return res || { success: false, error: 'No response from service worker.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Switches the active focused tab to a specific tabId.
 * @param {number} tabId
 * @returns {Promise<{ success: boolean, tabId?: number, error?: string }>}
 */
export async function switchTab(tabId) {
  if (!isExtensionEnvironment()) {
    return { success: false, error: 'Outside extension environment.' };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'SWITCH_TAB',
      tabId
    });
    return res || { success: false, error: 'No response from service worker.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Closes a specific tab.
 * @param {number} tabId
 * @param {string} [taskId]
 * @returns {Promise<{ success: boolean, tabId?: number, error?: string }>}
 */
export async function closeTab(tabId, taskId = undefined) {
  if (!isExtensionEnvironment()) {
    return { success: false, error: 'Outside extension environment.' };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'CLOSE_TAB',
      tabId,
      taskId
    });
    return res || { success: false, error: 'No response from service worker.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Enumerates browser tabs accessible to the extension.
 * @param {string} [taskId]
 * @returns {Promise<{ success: boolean, tabs?: Array, error?: string }>}
 */
export async function listTabs(taskId = undefined) {
  if (!isExtensionEnvironment()) {
    return { success: false, error: 'Outside extension environment.', tabs: [] };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'LIST_TABS',
      taskId
    });
    return res || { success: false, tabs: [] };
  } catch (err) {
    return { success: false, error: err.message, tabs: [] };
  }
}

/**
 * Retrieves a live page snapshot from a specific background or foreground tab.
 * @param {number} tabId
 * @returns {Promise<{ success: boolean, data?: Object, error?: string, isRestricted?: boolean }>}
 */
export async function getTabSnapshot(tabId) {
  if (!isExtensionEnvironment()) {
    return { success: false, error: 'Outside extension environment.' };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_TAB_SNAPSHOT',
      tabId
    });
    return res || { success: false, error: 'No response from tab snapshot handler.' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Closes all tabs created for a specific task (optionally preserving a target tab).
 * @param {string} taskId
 * @param {number} [keepTabId]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function closeTaskTabs(taskId, keepTabId = undefined) {
  if (!isExtensionEnvironment()) {
    return { success: false, error: 'Outside extension environment.' };
  }
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'CLOSE_TASK_TABS',
      taskId,
      keepTabId
    });
    return res || { success: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Opens a standard accessible website (e.g. Wikipedia) in a new tab,
 * waits for it to complete loading, and returns the tab and observation snapshot.
 * 
 * Requirement 3: Add an "Open a Website" action that opens a normal website
 * such as https://www.wikipedia.org in a new tab, then observes it after loading.
 * 
 * @param {string} [url='https://www.wikipedia.org']
 * @returns {Promise<{ success: boolean, tab?: Object, data?: Object, snapshot?: Object, error?: string }>}
 */
export async function openWebsiteAndObserve(url = 'https://www.wikipedia.org') {
  if (!isExtensionEnvironment()) {
    const mockSnapshot = {
      page: {
        url,
        title: 'Wikipedia, the free encyclopedia',
        hostname: 'www.wikipedia.org'
      },
      interactive: {
        buttons: [{ id: 'element-1', text: 'Search', tag: 'button' }],
        links: [{ id: 'element-2', text: 'Main page', href: 'https://en.wikipedia.org/wiki/Main_Page' }],
        inputs: [{ id: 'element-3', type: 'search', name: 'search' }]
      }
    };
    return {
      success: true,
      tab: { id: 1, url, title: 'Wikipedia, the free encyclopedia' },
      data: mockSnapshot,
      snapshot: mockSnapshot
    };
  }

  try {
    const openRes = await openTab(url, { active: true, waitForLoad: true });
    if (!openRes || !openRes.success) {
      return { success: false, error: openRes?.error || 'Failed to open website.' };
    }

    // Settling delay for initial scripts and DOM layout
    await new Promise((resolve) => setTimeout(resolve, 350));

    // Observe newly opened active tab
    const obsRes = await getPageSnapshot();
    const data = obsRes?.data || null;

    return {
      success: true,
      tab: openRes.tab,
      data,
      snapshot: data
    };
  } catch (err) {
    return { success: false, error: err.message || 'Error opening website.' };
  }
}
