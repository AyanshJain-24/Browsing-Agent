/**
 * Voice Browser Agent - Chrome Messaging Utility
 * 
 * Provides clean, decoupled async methods for the React Side Panel
 * to communicate with the background Service Worker and Content Script.
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
 * Requests a full structured DOM snapshot from the currently active webpage tab.
 * 
 * Flow:
 * React Side Panel -> Service Worker -> Content Script -> observer.js -> Page Snapshot
 * 
 * @returns {Promise<{ success: boolean, type: string, data?: Object, error?: string }>}
 */
export async function getPageSnapshot() {
  if (!isExtensionEnvironment()) {
    return {
      success: false,
      type: 'ERROR',
      error: 'Running outside Chrome Extension context (standalone dev mode).'
    };
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_PAGE_SNAPSHOT'
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
 * @returns {Promise<{ success: boolean, type: string, result?: Object, error?: string }>}
 */
export async function executeAction(actionCommand) {
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
    const response = await chrome.runtime.sendMessage({
      type: 'EXECUTE_ACTION',
      action: actionCommand
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
