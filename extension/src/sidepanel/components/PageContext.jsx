import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  getPageSnapshot,
  isExtensionEnvironment,
  isRestrictedUrl,
  openWebsiteAndObserve,
  RESTRICTED_PAGE_MESSAGE
} from '../utils/chromeMessaging.js';

export default function PageContext({ onPageChange }) {
  const [context, setContext] = useState({
    site: 'Active Webpage',
    url: '',
    pageType: 'Web tab',
    status: 'Connecting...',
    faviconLetter: 'W',
    isLive: false,
    isRestricted: false,
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
  const [isOpeningWebsite, setIsOpeningWebsite] = useState(false);
  const debounceTimerRef = useRef(null);
  const currentScanIdRef = useRef(0);
  const isRestrictedRef = useRef(false);
  const lastScannedUrlRef = useRef('');

  // Fetch live page snapshot from active tab via Service Worker -> Content Script -> observer.js
  const refreshPageSnapshot = useCallback(async () => {
    if (!isExtensionEnvironment()) {
      // In standalone Vite dev server (localhost:5173), keep mock preview
      const mockContext = {
        site: 'Example Domain (Preview)',
        url: 'https://example.com',
        pageType: 'Mock Preview',
        status: 'Mock connected',
        faviconLetter: 'E',
        isLive: false,
        isRestricted: false,
        errorMessage: '',
        summary: {
          inputs: 0,
          buttons: 2,
          links: 4,
          forms: 0,
          totalLinks: 4,
          returnedLinks: 4
        }
      };
      setContext(mockContext);
      onPageChange?.(mockContext);
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

        isRestrictedRef.current = false;
        lastScannedUrlRef.current = page.url || '';

        const nextContext = {
          site: page.title ? page.title.slice(0, 32) : page.hostname || 'Active Webpage',
          url: page.url || page.hostname || '',
          pageType: 'Live tab',
          status: 'Connected',
          faviconLetter: (page.title ? page.title.charAt(0) : page.hostname?.charAt(0) || 'W').toUpperCase(),
          isLive: true,
          isRestricted: false,
          errorMessage: '',
          summary: {
            inputs: summary.inputCount ?? (data.interactive?.inputs?.length || 0),
            buttons: summary.buttonCount ?? (data.interactive?.buttons?.length || 0),
            links: summary.returnedLinks ?? summary.linkCount ?? (data.interactive?.links?.length || 0),
            forms: summary.formCount ?? (data.interactive?.forms?.length || 0),
            totalLinks: summary.totalLinks ?? (summary.linkCount || 0),
            returnedLinks: summary.returnedLinks ?? (data.interactive?.links?.length || 0)
          }
        };
        setContext(nextContext);
        onPageChange?.(nextContext);
      } else {
        // Handle restricted pages (chrome://, chrome://extensions/, webstore) gracefully
        const isRestricted = Boolean(response?.isRestricted || isRestrictedUrl(response?.url));
        if (isRestricted) {
          isRestrictedRef.current = true;
          lastScannedUrlRef.current = response?.url || 'chrome://newtab/';

          const nextContext = {
            site: 'Privileged Chrome Page',
            url: response?.url || 'chrome://newtab/',
            pageType: 'Restricted',
            status: 'Restricted',
            faviconLetter: '🔒',
            isLive: false,
            isRestricted: true,
            errorMessage: RESTRICTED_PAGE_MESSAGE,
            summary: {
              inputs: 0,
              buttons: 0,
              links: 0,
              forms: 0,
              totalLinks: 0,
              returnedLinks: 0
            }
          };
          setContext(nextContext);
          onPageChange?.(nextContext);
        } else {
          isRestrictedRef.current = false;
          const errMsg = response?.error || 'Page unavailable';
          const nextContext = {
            site: 'Page unavailable',
            url: response?.url || '',
            pageType: 'Unavailable',
            status: 'Disconnected',
            faviconLetter: '!',
            isLive: false,
            isRestricted: false,
            errorMessage: errMsg,
            summary: {
              inputs: 0,
              buttons: 0,
              links: 0,
              forms: 0,
              totalLinks: 0,
              returnedLinks: 0
            }
          };
          setContext(nextContext);
          onPageChange?.(nextContext);
        }
      }
    } catch (err) {
      if (scanId !== currentScanIdRef.current) return;
      isRestrictedRef.current = false;
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
  }, [onPageChange]);

  // Requirement 3: Action that opens a normal website such as https://www.wikipedia.org in a new tab,
  // then observes it after loading.
  const handleOpenNormalWebsite = useCallback(async (targetUrl = 'https://www.wikipedia.org') => {
    setIsOpeningWebsite(true);
    try {
      if (!isExtensionEnvironment()) {
        const mockLoaded = {
          site: 'Wikipedia, the free encyclopedia',
          url: targetUrl,
          pageType: 'Live tab',
          status: 'Connected',
          faviconLetter: 'W',
          isLive: true,
          isRestricted: false,
          errorMessage: '',
          summary: {
            inputs: 1,
            buttons: 3,
            links: 12,
            forms: 1,
            totalLinks: 12,
            returnedLinks: 12
          }
        };
        isRestrictedRef.current = false;
        lastScannedUrlRef.current = targetUrl;
        setContext(mockLoaded);
        onPageChange?.(mockLoaded);
        return;
      }

      const res = await openWebsiteAndObserve(targetUrl);
      if (res && res.success) {
        isRestrictedRef.current = false;
        lastScannedUrlRef.current = '';
        await refreshPageSnapshot();
      }
    } catch (err) {
      console.warn('[PageContext] Failed to open website:', err);
    } finally {
      setIsOpeningWebsite(false);
    }
  }, [onPageChange, refreshPageSnapshot]);

  // Debounced refresh scheduler to avoid duplicate scanning bursts (150-250ms debounce)
  // Requirement 4: Do not repeatedly retry scanning a restricted page.
  const triggerDebouncedRefresh = useCallback((immediateReset = false, force = false) => {
    if (!force && isRestrictedRef.current && !immediateReset) {
      // Avoid repeatedly re-scanning when already on a known restricted page
      return;
    }

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
        // Requirement 7: When user switches to a normal website, automatically reconnect
        isRestrictedRef.current = false;
        lastScannedUrlRef.current = '';
        triggerDebouncedRefresh(true, true);
      } else if (message.type === 'ACTIVE_TAB_UPDATED') {
        // Requirement 4: Do not repeatedly retry scanning the same restricted page
        if (message.isRestricted && isRestrictedRef.current && (message.url === lastScannedUrlRef.current || !message.url)) {
          return;
        }
        triggerDebouncedRefresh(false);
      }
    };

    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    // 3. Direct tab events as secondary listener for maximum responsiveness
    const handleTabActivated = () => {
      isRestrictedRef.current = false;
      lastScannedUrlRef.current = '';
      triggerDebouncedRefresh(true, true);
    };

    const handleTabUpdated = (tabId, changeInfo) => {
      if (changeInfo.status === 'complete' || changeInfo.url) {
        if (isRestrictedRef.current && !changeInfo.url) {
          // Avoid repeated scanning of already-restricted page on status updates
          return;
        }
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
  const isRestricted = Boolean(context.isRestricted || context.status === 'Restricted');

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
                  : isRestricted
                  ? '#38bdf8'
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
                  : isRestricted
                  ? '#38bdf8'
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

      {/* Requirement 2 & 3: Friendly Informational Box for Restricted Browser Pages with "Open a Website" action */}
      {isRestricted && (
        <div
          className="restricted-page-banner"
          style={{
            marginTop: 8,
            padding: '10px 12px',
            background: 'rgba(56, 189, 248, 0.08)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: 'var(--radius-sm, 8px)',
            fontSize: '11.5px',
            color: 'var(--text-primary, #f1f5f9)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            lineHeight: 1.4
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <span style={{ fontSize: '15px', lineHeight: 1 }} aria-hidden="true">🔒</span>
            <span style={{ color: 'var(--text-secondary, #94a3b8)', fontSize: '11.5px' }}>
              {RESTRICTED_PAGE_MESSAGE}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
            <button
              type="button"
              className="btn-open-website"
              onClick={() => handleOpenNormalWebsite('https://www.wikipedia.org')}
              disabled={isOpeningWebsite}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'var(--accent-primary, #6366f1)',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '6px 12px',
                fontSize: '11.5px',
                fontWeight: 600,
                cursor: isOpeningWebsite ? 'not-allowed' : 'pointer',
                opacity: isOpeningWebsite ? 0.7 : 1,
                boxShadow: '0 1px 3px rgba(99, 102, 241, 0.3)',
                transition: 'all 0.2s ease'
              }}
              title="Open https://www.wikipedia.org in a new tab"
              aria-label="Open a Website"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
                <path d="M2 12h20" />
              </svg>
              <span>{isOpeningWebsite ? 'Opening Wikipedia...' : 'Open a Website'}</span>
            </button>
            <span style={{ fontSize: '10.5px', color: 'var(--text-muted, #64748b)' }}>
              (e.g. Wikipedia)
            </span>
          </div>
        </div>
      )}

      {/* Regular Error Warning if not connected and not restricted */}
      {!isConnected && !isSyncing && !isRestricted && context.errorMessage && (
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
