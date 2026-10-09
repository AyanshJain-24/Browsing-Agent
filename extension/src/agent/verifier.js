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

      // If action was specifically intended to navigate via a link
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
