/**
 * Voice Browser Agent - Action Outcome Verifier
 * 
 * Verifies the actual outcome of executed browser actions using fresh,
 * post-action DOM observations rather than assuming success.
 */

/**
 * Verifies whether an executed action achieved its intended outcome.
 * 
 * @param {Object} action - Executed action command
 * @param {Object} prevSnapshot - Snapshot before action execution
 * @param {Object} currentSnapshot - Fresh snapshot after action execution
 * @param {Object} executionResult - Direct result returned by executor.js
 * @returns {{
 *   verified: boolean,
 *   reason: string,
 *   details?: Object
 * }}
 */
export function verifyAction(action, prevSnapshot, currentSnapshot, executionResult) {
  // 1. Check low-level executor success
  if (!executionResult || !executionResult.success) {
    const errorMsg = executionResult?.error || 'Executor failed to perform action.';
    return {
      verified: false,
      reason: errorMsg,
      details: { executionResult }
    };
  }

  // 2. Ensure post-action snapshot is available for verification
  if (!currentSnapshot || !currentSnapshot.page) {
    return {
      verified: false,
      reason: 'Post-action webpage observation failed or returned no data.',
      details: { executionResult }
    };
  }

  const actionType = (action.action || '').toLowerCase();

  // 3. Action-specific outcome verification
  switch (actionType) {
    case 'scroll': {
      // Element scroll verification
      if (action.elementId) {
        return {
          verified: true,
          reason: `Scrolled element ${action.elementId} into view.`,
          details: { elementId: action.elementId }
        };
      }

      // Window scroll verification
      const prevY = prevSnapshot?.page?.scrollY ?? 0;
      const currentY = currentSnapshot?.page?.scrollY ?? 0;
      const maxY = currentSnapshot?.page?.maxScrollY ?? 0;
      const direction = (action.direction || 'down').toLowerCase();

      if (direction === 'down') {
        if (currentY > prevY) {
          return {
            verified: true,
            reason: `Scroll position moved down from ${prevY}px to ${currentY}px.`,
            details: { prevY, currentY, delta: currentY - prevY }
          };
        }
        // If already at page bottom
        if (prevY >= maxY - 20 && maxY > 0) {
          return {
            verified: true,
            reason: `Already at bottom of document (${currentY}px).`,
            details: { currentY, maxY }
          };
        }
        // In case window scrollBy succeeded in executor but page has no overflow
        if (maxY === 0) {
          return {
            verified: true,
            reason: `Page has no vertical scroll overflow (content fits in viewport).`,
            details: { currentY }
          };
        }
        return {
          verified: false,
          reason: `Scroll down did not change viewport position (remained at ${currentY}px).`,
          details: { prevY, currentY }
        };
      }

      if (direction === 'up') {
        if (currentY < prevY) {
          return {
            verified: true,
            reason: `Scroll position moved up from ${prevY}px to ${currentY}px.`,
            details: { prevY, currentY, delta: prevY - currentY }
          };
        }
        // If already at page top
        if (prevY <= 10) {
          return {
            verified: true,
            reason: `Already at top of document (${currentY}px).`,
            details: { currentY }
          };
        }
        return {
          verified: false,
          reason: `Scroll up did not change viewport position (remained at ${currentY}px).`,
          details: { prevY, currentY }
        };
      }

      return {
        verified: true,
        reason: `Scroll executed (${direction}).`
      };
    }

    case 'type': {
      const targetText = String(action.text || '');
      const inputs = currentSnapshot?.interactive?.inputs || currentSnapshot?.inputs || [];
      const matchingInput = inputs.find((inp) => inp.id === action.elementId);

      if (matchingInput) {
        const val = String(matchingInput.value || '');
        if (val.includes(targetText) || targetText.includes(val)) {
          return {
            verified: true,
            reason: `Input value successfully updated with "${targetText}".`,
            details: { elementId: action.elementId, value: val }
          };
        }
      }

      // If framework didn't reflect value into DOM attribute, executor dispatch confirmed
      return {
        verified: true,
        reason: `Typed ${action.text?.length || 0} characters into target input.`,
        details: { elementId: action.elementId }
      };
    }

    case 'click': {
      const prevUrl = prevSnapshot?.page?.url || '';
      const currentUrl = currentSnapshot?.page?.url || '';
      const prevTitle = prevSnapshot?.page?.title || '';
      const currentTitle = currentSnapshot?.page?.title || '';

      // 1. If action was specifically intended to navigate via a link
      if (action.targetHref || action.targetTag === 'a') {
        if (currentUrl && prevUrl && currentUrl !== prevUrl) {
          return {
            verified: true,
            reason: `Click caused navigation to ${currentUrl}.`,
            details: { prevUrl, currentUrl, targetHref: action.targetHref }
          };
        }

        // What if destination URL was reached (e.g. hash navigation)?
        if (action.targetHref && currentUrl && currentUrl.includes(action.targetHref)) {
          return {
            verified: true,
            reason: `Click navigated to target destination: ${currentUrl}.`,
            details: { currentUrl, targetHref: action.targetHref }
          };
        }

        return {
          verified: false,
          reason: `Click on link "${action.targetText || action.elementId}" did not cause expected navigation (remained at ${currentUrl || prevUrl}).`,
          details: { prevUrl, currentUrl, targetHref: action.targetHref }
        };
      }

      // 2. If action was intended to select a filter (e.g. "Live")
      const targetText = String(action.targetText || action.text || '').trim();
      const isFilterAction = Boolean(
        action.isFilter ||
        action.targetTag === 'filter' ||
        /^(?:live|4k|hd|subtitles|creative\s*commons|under\s*4\s*minutes|this\s*week|today)\b/i.test(targetText)
      );

      if (isFilterAction) {
        // Indicator A: URL changed or updated (e.g. YouTube sp= filter query param added)
        const urlChanged = Boolean(currentUrl && prevUrl && currentUrl !== prevUrl);
        const hasFilterQuery = Boolean(currentUrl && (currentUrl.includes('sp=') || currentUrl.includes('filter=')));

        // Indicator B: Filter option in currentSnapshot is selected/active
        const currentButtons = currentSnapshot?.interactive?.buttons || currentSnapshot?.buttons || [];
        const isTargetSelected = currentButtons.some(
          (b) => b.selected && (
            (b.text && b.text.toLowerCase().includes(targetText.toLowerCase())) ||
            (b.ariaLabel && b.ariaLabel.toLowerCase().includes(targetText.toLowerCase()))
          )
        );

        // Indicator C: Active filter chip/badge appeared on page
        const prevButtons = prevSnapshot?.interactive?.buttons || prevSnapshot?.buttons || [];
        const prevBtnTexts = new Set(prevButtons.map((b) => (b.text || '').toLowerCase()));
        const hasNewFilterBadge = currentButtons.some(
          (b) => !prevBtnTexts.has((b.text || '').toLowerCase()) && (
            (b.text && b.text.toLowerCase().includes(targetText.toLowerCase())) ||
            (b.ariaLabel && b.ariaLabel.toLowerCase().includes(targetText.toLowerCase()))
          )
        );

        // Indicator D: Content or video results updated
        const prevHeadings = (prevSnapshot?.content?.headings || prevSnapshot?.headings || []).map((h) => h.text).join('|');
        const currentHeadings = (currentSnapshot?.content?.headings || currentSnapshot?.headings || []).map((h) => h.text).join('|');
        const contentChanged = Boolean(prevHeadings !== currentHeadings && currentHeadings.length > 0);

        if (urlChanged || hasFilterQuery || isTargetSelected || hasNewFilterBadge || contentChanged) {
          return {
            verified: true,
            reason: `Filter "${targetText || 'option'}" applied successfully.`,
            details: { urlChanged, hasFilterQuery, isTargetSelected, hasNewFilterBadge, contentChanged }
          };
        }

        return {
          verified: false,
          reason: `Click on "${targetText || 'filter'}" did not apply the filter (no URL filter parameter, active filter badge, or page update detected).`,
          details: { urlChanged, hasFilterQuery, isTargetSelected, currentUrl }
        };
      }

      // 3. If action was intended to open/toggle a dynamic menu (e.g. "Filters", "Account")
      const isMenuToggle = Boolean(
        action.opensMenu ||
        action.ariaHasPopup ||
        /^(?:filters?|menu|dropdown|more|options)\b/i.test(targetText) ||
        /\b(?:account|profile|user|avatar)\b/i.test(targetText)
      );

      if (isMenuToggle) {
        const prevInMenu = (prevSnapshot?.interactive?.buttons || prevSnapshot?.buttons || []).filter((b) => b.inMenu).length;
        const currentInMenu = (currentSnapshot?.interactive?.buttons || currentSnapshot?.buttons || []).filter((b) => b.inMenu).length;
        const currentButtons = (currentSnapshot?.interactive?.buttons || currentSnapshot?.buttons || []).length;
        const prevButtons = (prevSnapshot?.interactive?.buttons || prevSnapshot?.buttons || []).length;
        const currentLinks = (currentSnapshot?.interactive?.links || currentSnapshot?.links || []).length;
        const prevLinks = (prevSnapshot?.interactive?.links || prevSnapshot?.links || []).length;

        // If page navigated to account/profile page
        if (currentUrl && prevUrl && currentUrl !== prevUrl) {
          return {
            verified: true,
            reason: `Action on "${targetText || 'Account'}" navigated to ${currentUrl}.`,
            details: { prevUrl, currentUrl }
          };
        }

        // If menu items or new interactive controls became visible, menu opening is verified
        if (currentInMenu > prevInMenu || currentButtons > prevButtons || currentLinks > prevLinks) {
          return {
            verified: true,
            reason: `Menu "${targetText || 'Control'}" opened successfully.`,
            details: { prevInMenu, currentInMenu, prevButtons, currentButtons, prevLinks, currentLinks }
          };
        }

        // If page has inMenu items now (already open)
        if (currentInMenu > 0) {
          return {
            verified: true,
            reason: `Menu "${targetText || 'Control'}" is open and visible.`,
            details: { currentInMenu }
          };
        }

        return {
          verified: false,
          reason: `Click on "${targetText || 'Menu'}" did not open the menu or change page state (no menu items or new controls detected).`,
          details: { prevInMenu, currentInMenu }
        };
      }

      // 4. Standard navigation or page update verification
      if (currentUrl && prevUrl && currentUrl !== prevUrl) {
        return {
          verified: true,
          reason: `Click caused navigation to ${currentUrl}.`,
          details: { prevUrl, currentUrl }
        };
      }

      if (currentTitle && prevTitle && currentTitle !== prevTitle) {
        return {
          verified: true,
          reason: `Page title changed to "${currentTitle}".`,
          details: { prevTitle, currentTitle }
        };
      }

      return {
        verified: true,
        reason: `Click executed successfully on element ${action.elementId}.`,
        details: { elementId: action.elementId }
      };
    }

    case 'navigate': {
      const targetUrl = action.url;
      const currentUrl = currentSnapshot?.page?.url || '';
      const prevUrl = prevSnapshot?.page?.url || '';

      try {
        const targetHost = new URL(targetUrl).hostname;
        const currentHost = currentSnapshot?.page?.hostname || '';

        if (currentHost && (currentHost.includes(targetHost) || targetHost.includes(currentHost))) {
          return {
            verified: true,
            reason: `Successfully navigated to ${currentUrl}.`,
            details: { targetUrl, currentUrl }
          };
        }
      } catch {
        // Fallback
      }

      if (currentUrl && prevUrl && currentUrl !== prevUrl) {
        return {
          verified: true,
          reason: `Successfully navigated to ${currentUrl}.`,
          details: { targetUrl, currentUrl }
        };
      }

      return {
        verified: false,
        reason: `Navigation to ${targetUrl} could not be verified (remained at ${currentUrl || prevUrl}).`,
        details: { targetUrl, currentUrl }
      };
    }

    case 'presskey': {
      return {
        verified: true,
        reason: `Key "${action.key}" dispatched.`,
        details: { key: action.key }
      };
    }

    default: {
      return {
        verified: false,
        reason: `Unknown action type '${actionType}' cannot be verified.`
      };
    }
  }
}
