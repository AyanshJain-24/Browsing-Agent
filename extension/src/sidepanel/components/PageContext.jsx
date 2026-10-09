import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getPageSnapshot, isExtensionEnvironment } from '../utils/chromeMessaging.js';

export default function PageContext() {
  const [context, setContext] = useState({
    site: 'Amazon',
    url: 'amazon.in',
    pageType: 'Search results',
    status: 'Connected',
    faviconLetter: 'A',
    isLive: false,
    errorMessage: '',
    summary: {
      inputs: 0,
      buttons: 0,
      links: 0,
      forms: 0,
      totalLinks: 0,
      returnedLinks: 0
    }
  });

  const [isLoading, setIsLoading] = useState(false);
  const debounceTimerRef = useRef(null);
  const currentScanIdRef = useRef(0);

  // Fetch live page snapshot from active tab via Service Worker -> Content Script -> observer.js
  const refreshPageSnapshot = useCallback(async () => {
    if (!isExtensionEnvironment()) {
      // In standalone Vite dev server (localhost:5173), keep mock preview
      setContext((prev) => ({
        ...prev,
        site: 'Amazon (Mock)',
        url: 'amazon.in',
        pageType: 'Mock Preview',
        status: 'Mock connected',
        faviconLetter: 'A',
        isLive: false,
        summary: {
          inputs: 3,
          buttons: 5,
          links: 18,
          forms: 1,
          totalLinks: 42,
          returnedLinks: 18
        }
      }));
      return;
    }

    const scanId = ++currentScanIdRef.current;
    setIsLoading(true);

    try {
      const response = await getPageSnapshot();

      // Discard stale responses if a newer tab switch/navigation occurred while waiting
      if (scanId !== currentScanIdRef.current) {
        return;
      }

      if (response && response.success && response.data) {
        const data = response.data;
        const page = data.page || {};
        const summary = data.summary || {};

        setContext({
          site: page.title ? page.title.slice(0, 32) : page.hostname || 'Active Webpage',
          url: page.url || page.hostname || '',
          pageType: 'Live tab',
          status: 'Connected',
          faviconLetter: (page.title ? page.title.charAt(0) : page.hostname?.charAt(0) || 'W').toUpperCase(),
          isLive: true,
          errorMessage: '',
          summary: {
            inputs: summary.inputCount ?? (data.interactive?.inputs?.length || 0),
            buttons: summary.buttonCount ?? (data.interactive?.buttons?.length || 0),
            links: summary.returnedLinks ?? summary.linkCount ?? (data.interactive?.links?.length || 0),
            forms: summary.formCount ?? (data.interactive?.forms?.length || 0),
            totalLinks: summary.totalLinks ?? (summary.linkCount || 0),
            returnedLinks: summary.returnedLinks ?? (data.interactive?.links?.length || 0)
          }
        });
      } else {
        // Handle restricted pages (chrome://, webstore) or unloaded content scripts gracefully
        const errMsg = response?.error || 'Page unavailable';
        setContext({
          site: 'Page unavailable',
          url: response?.url || 'Restricted browser page',
          pageType: 'Unavailable',
          status: 'Restricted',
          faviconLetter: '!',
          isLive: false,
          errorMessage: errMsg,
          summary: {
            inputs: 0,
            buttons: 0,
            links: 0,
            forms: 0,
            totalLinks: 0,
            returnedLinks: 0
          }
        });
      }
    } catch (err) {
      if (scanId !== currentScanIdRef.current) return;
      setContext({
        site: 'Error reading page',
        url: '',
        pageType: 'Error',
        status: 'Error',
        faviconLetter: '!',
        isLive: false,
        errorMessage: err.message || 'Failed to inspect page.',
        summary: {
          inputs: 0,
          buttons: 0,
          links: 0,
          forms: 0,
          totalLinks: 0,
          returnedLinks: 0
        }
      });
    } finally {
      if (scanId === currentScanIdRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // Debounced refresh scheduler to avoid duplicate scanning bursts (150-250ms debounce)
  const triggerDebouncedRefresh = useCallback((immediateReset = false) => {
    if (immediateReset) {
      // Immediately clear stale page info when switching tabs
      setContext((prev) => ({
        ...prev,
        site: 'Loading page...',
        url: 'Syncing tab...',
        pageType: 'Syncing',
        status: 'Syncing',
        faviconLetter: '⟳',
        isLive: false,
        errorMessage: '',
        summary: {
          inputs: 0,
          buttons: 0,
          links: 0,
          forms: 0,
          totalLinks: 0,
          returnedLinks: 0
        }
      }));
    }

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      refreshPageSnapshot();
    }, 200);
  }, [refreshPageSnapshot]);

  // Tab synchronization lifecycle
  useEffect(() => {
    // 1. Initial snapshot scan on side panel open
    refreshPageSnapshot();

    if (!isExtensionEnvironment()) return;

    // 2. Listen to background service worker router messages
    const handleRuntimeMessage = (message) => {
      if (!message || typeof message !== 'object') return;

      if (message.type === 'ACTIVE_TAB_CHANGED') {
        // Tab switch (Tab A -> Tab B): wipe stale data immediately and schedule scan
        triggerDebouncedRefresh(true);
      } else if (message.type === 'ACTIVE_TAB_UPDATED') {
        // Navigation completed or SPA route change: schedule debounced scan
        triggerDebouncedRefresh(false);
      }
    };

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    // 3. Direct tab events as secondary listener for maximum responsiveness
    const handleTabActivated = () => triggerDebouncedRefresh(true);
    const handleTabUpdated = (tabId, changeInfo) => {
      if (changeInfo.status === 'complete' || changeInfo.url) {
        triggerDebouncedRefresh(false);
      }
    };

    if (chrome.tabs?.onActivated) {
      chrome.tabs.onActivated.addListener(handleTabActivated);
    }
    if (chrome.tabs?.onUpdated) {
      chrome.tabs.onUpdated.addListener(handleTabUpdated);
    }

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      chrome.runtime.onMessage.removeListener(handleRuntimeMessage);
      if (chrome.tabs?.onActivated) {
        chrome.tabs.onActivated.removeListener(handleTabActivated);
      }
      if (chrome.tabs?.onUpdated) {
        chrome.tabs.onUpdated.removeListener(handleTabUpdated);
      }
    };
  }, [refreshPageSnapshot, triggerDebouncedRefresh]);

  const isConnected = context.status === 'Connected' || context.status === 'Mock connected';
  const isSyncing = context.status === 'Syncing';

  return (
    <section className="page-context-section" aria-label="Current browser context">
      <div className="page-context-header">
        <span className="page-context-label">Current Page</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div className="page-context-status">
            <span
              className="pulse-dot"
              style={{
                width: 6,
                height: 6,
                backgroundColor: isConnected
                  ? 'var(--status-success)'
                  : isSyncing
                  ? 'var(--accent-primary)'
                  : 'var(--status-warning)'
              }}
              aria-hidden="true"
            ></span>
            <span
              style={{
                color: isConnected
                  ? 'var(--status-success)'
                  : isSyncing
                  ? 'var(--accent-primary)'
                  : 'var(--status-warning)'
              }}
            >
              {context.status}
            </span>
          </div>

          <button
            type="button"
            onClick={refreshPageSnapshot}
            disabled={isLoading}
            title="Re-scan webpage DOM"
            aria-label="Refresh page inspection"
            style={{
              padding: '2px 5px',
              fontSize: '11px',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-card)'
            }}
          >
            {isLoading ? '⟳...' : '⟳ Scan'}
          </button>
        </div>
      </div>

      <div className="page-context-card">
        <div className="page-info-left">
          <div className="page-favicon" aria-hidden="true">
            {context.faviconLetter}
          </div>
          <div className="page-titles">
            <span className="page-name">{context.site}</span>
            <span className="page-url" title={context.url}>
              {context.url || 'Waiting for active tab...'}
            </span>
          </div>
        </div>
        <span className="page-badge">{context.pageType}</span>
      </div>

      {/* Real Interactive Elements Summary with Transparent Link Counts */}
      {isConnected && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginTop: 6,
            padding: '4px 8px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '10.5px',
            color: 'var(--text-secondary)'
          }}
        >
          <span><strong>Inputs:</strong> {context.summary.inputs}</span>
          <span><strong>Buttons:</strong> {context.summary.buttons}</span>
          <span
            title={
              context.summary.totalLinks
                ? `${context.summary.returnedLinks} top-ranked links of ${context.summary.totalLinks} total valid links detected`
                : ''
            }
          >
            <strong>Links:</strong>{' '}
            {context.summary.totalLinks && context.summary.totalLinks > context.summary.returnedLinks
              ? `${context.summary.returnedLinks} / ${context.summary.totalLinks}`
              : (context.summary.returnedLinks || context.summary.links)}
          </span>
          <span><strong>Forms:</strong> {context.summary.forms}</span>
        </div>
      )}

      {/* Restricted Page Warning if on chrome:// or error */}
      {!isConnected && !isSyncing && context.errorMessage && (
        <p
          style={{
            fontSize: '10.5px',
            color: 'var(--status-error)',
            marginTop: 4,
            lineHeight: 1.3
          }}
        >
          {context.errorMessage}
        </p>
      )}
    </section>
  );
}
