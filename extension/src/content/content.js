/**
 * Voice Browser Agent - Content Script Entry Point
 * 
 * Injected into active webpages to bridge communication
 * between the extension side panel/service worker and the live DOM.
 * 
 * Handles incoming runtime messages:
 * 1. GET_PAGE_SNAPSHOT -> Calls observer.js to extract DOM hierarchy & interactive elements
 * 2. EXECUTE_ACTION    -> Calls executor.js to perform simulated browser interactions
 * 
 * Dispatches outbound signals:
 * - PAGE_READY           -> Notifies service worker when content script is initialized
 * - PAGE_CONTEXT_CHANGED -> Notifies service worker on SPA client-side URL changes
 */

import { observePageElements } from './observer.js';
import { executeAction } from './executor.js';

console.log('[Voice Browser Agent] Content script active on:', window.location.href);

// ============================================================================
// 1. INBOUND MESSAGE LISTENER
// ============================================================================
chrome.runtime.onMessage?.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    return false;
  }

  // GET_PAGE_SNAPSHOT: Observe current webpage state
  if (message.type === 'GET_PAGE_SNAPSHOT' || message.type === 'PAGE_QUERY') {
    try {
      const snapshot = observePageElements();
      sendResponse({
        success: true,
        type: 'PAGE_SNAPSHOT',
        data: snapshot
      });
    } catch (err) {
      sendResponse({
        success: false,
        type: 'ERROR',
        error: `Observation failed: ${err.message}`
      });
    }
    return true; // Keep channel open for response
  }

  // EXECUTE_ACTION: Perform explicit browser action command
  if (message.type === 'EXECUTE_ACTION' || message.type === 'EXECUTE_STEP') {
    const actionCommand = message.action || message.command || message;

    executeAction(actionCommand)
      .then((result) => {
        if (result && result.success) {
          sendResponse({
            success: true,
            type: 'ACTION_RESULT',
            result
          });
        } else {
          sendResponse({
            success: false,
            type: 'ERROR',
            error: result?.error || 'Action execution failed',
            result
          });
        }
      })
      .catch((err) => {
        sendResponse({
          success: false,
          type: 'ERROR',
          error: `Executor exception: ${err.message}`
        });
      });

    return true; // Keep message channel open for asynchronous Promise resolution
  }

  return false;
});

// ============================================================================
// 2. OUTBOUND LIFECYCLE SIGNALS & SPA NAVIGATION DETECTION
// ============================================================================

// Notify service worker that content script is ready in this tab
try {
  chrome.runtime.sendMessage({
    type: 'PAGE_READY',
    url: window.location.href
  }).catch(() => {
    // Expected if background service worker is idle or extension sidepanel closed
  });
} catch {
  // Graceful fallback
}

// Track client-side SPA navigations (pushState, replaceState, popstate, hashchange, navigation API)
// without running heavy or continuous full-page DOM MutationObservers.
(function setupSpaTracking() {
  let lastUrl = window.location.href;

  function handleUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      try {
        chrome.runtime.sendMessage({
          type: 'PAGE_CONTEXT_CHANGED',
          url: currentUrl
        }).catch(() => {});
      } catch {
        // Silently catch context disconnect
      }
    }
  }

  // Wrap pushState
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    handleUrlChange();
  };

  // Wrap replaceState
  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    handleUrlChange();
  };

  window.addEventListener('popstate', handleUrlChange);
  window.addEventListener('hashchange', handleUrlChange);

  // Modern browser Navigation API support (Chrome 102+)
  if (typeof window.navigation !== 'undefined' && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('currententrychange', handleUrlChange);
  }

  // Targeted observer on <title> element only to detect client-side route changes
  const titleEl = document.querySelector('title');
  if (titleEl) {
    const titleObserver = new MutationObserver(() => {
      handleUrlChange();
    });
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
})();

// Expose helper functions on window for manual development testing in Chrome DevTools Console
if (typeof window !== 'undefined') {
  window.__vba_observe = observePageElements;
  window.__vba_execute = executeAction;
}
