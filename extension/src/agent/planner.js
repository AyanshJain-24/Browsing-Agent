/**
 * Voice Browser Agent - Deterministic Action Planner
 * 
 * Translates supported natural user commands into verified, safe browser actions
 * using the live DOM observation snapshot.
 * 
 * Safety Guarantees:
 * - Deterministic parsing only (no LLM, no arbitrary eval, no hallucinations)
 * - Safe URL validation (http/https only)
 * - Sensitive action blocking (refuses checkout, payments, purchases, account deletion)
 * - Password field protection (refuses automatic password entry)
 * - Ambiguity detection (refuses ambiguous targets instead of clicking randomly)
 * - Transparent error explanations when commands are unsupported
 */

/**
 * Normalizes user goal string.
 * @param {string} text
 * @returns {string}
 */
function cleanGoal(text) {
  return String(text || '').trim().replace(/[.,!?;:]+$/, '');
}

/**
 * Attempts to parse a valid URL from a user command.
 * @param {string} rawUrl
 * @returns {string|null} Valid absolute HTTP/HTTPS URL, or null
 */
function parseUrl(rawUrl) {
  let target = rawUrl.trim();
  // Strip trailing punctuation
  target = target.replace(/[.,!?;:]+$/, '');

  if (!target.startsWith('http://') && !target.startsWith('https://')) {
    // If it looks like a domain name (e.g. wikipedia.org, google.com)
    if (/^[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/.*)?$/.test(target)) {
      target = `https://${target}`;
    } else {
      return null;
    }
  }

  try {
    const parsed = new URL(target);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Checks if target text or goal represents a sensitive or high-risk transaction.
 * @param {string} text
 * @returns {boolean}
 */
export function isSensitiveAction(text) {
  if (!text || typeof text !== 'string') return false;
  const sensitiveRegex = /\b(buy\b|purchase\b|pay\b|payment\b|checkout\b|book\s+(?:me\s+)?(?:a\s+)?flight|flight|place\s*order|credit\s*card|bank\s*account|delete\s+(?:my\s+)?(?:user\s+)?account|delete\s+account|remove\s*all|transfer\s*money)\b/i;
  return sensitiveRegex.test(text);
}

/**
 * Extracts normalized target name from click/tap/select commands.
 * Handles diverse natural phrasings such as:
 * - "Click Current events"
 * - "Click Current events link"
 * - "Click on the Current events link"
 * - "Click link Current events"
 * - "Click the link to Current events"
 * - "Click 'Current events'"
 * 
 * @param {string} goal
 * @returns {string|null}
 */
/**
 * Extracts normalized target name from click/tap/select commands.
 * Handles diverse natural phrasings such as:
 * - "Click Current events"
 * - "Click Current events link"
 * - "Click on the Current events link"
 * - "Click link Current events"
 * - "Click the link to Current events"
 * - "Click 'Current events'"
 * - "find and click a 'Delete Account' button"
 * - "search and click Delete Account button"
 * 
 * @param {string} goal
 * @returns {string|null}
 */
export function extractClickTarget(goal) {
  if (!goal || typeof goal !== 'string') return null;

  const prefixRegex = /^(?:find\s+(?:and|&)\s+click|search\s+(?:and|&)\s+click|locate\s+(?:and|&)\s+click|click|press|tap|select|choose)\s+(?:on\s+)?(?:the\s+)?(?:a\s+|an\s+)?(?:link\s+to\s+|link\s+for\s+|link\s*:\s*|link\s+|button\s+for\s+|button\s*:\s*|button\s+|filter\s+for\s+|filter\s*:\s*|filter\s+|option\s+for\s+|option\s*:\s*|option\s+)?/i;

  let target = null;
  if (prefixRegex.test(goal)) {
    target = goal.replace(prefixRegex, '').trim();
  } else {
    // Check "filter by <option>" for single filter options (e.g. "filter by Live", "filter by 4K")
    const filterByMatch = goal.match(/^filter\s+by\s+["']?([a-zA-Z0-9_-]+)["']?$/i);
    if (filterByMatch) {
      target = filterByMatch[1].trim();
    }
  }

  if (!target) return null;

  // Strip trailing qualifiers if present: "link", "button", "tab", "menu", "option", "filter"
  target = target.replace(/\s+(?:button|link|tab|menu|option|filter)$/i, '').trim();

  // Strip surrounding quotes
  target = target.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

  return target || null;
}

/**
 * Detects whether an element candidate is a weak or unrelated match
 * (e.g. an unrelated product card, search result, price tag, or specs).
 * 
 * Safety Guarantee: Never treats a product, search result, or unrelated button
 * as the requested target based on a weak text match.
 * 
 * @param {Object} item - Candidate DOM element descriptor
 * @param {string} normalizedTarget - Target name requested by user
 * @returns {boolean} True if the candidate is an unrelated weak match
 */
export function isWeakOrUnrelatedMatch(item, normalizedTarget) {
  if (!item || !normalizedTarget) return true;
  const text = (item.text || item.ariaLabel || item.title || '').toLowerCase().trim();
  if (!text) return true;

  // Exact match is always strong and valid
  if (text === normalizedTarget) return false;

  // Account intent protection: prevent matching unrelated account-containing elements
  const isAccountTarget = /^(?:my\s*account|account|your\s*account|user\s*account)$/i.test(normalizedTarget);
  if (isAccountTarget) {
    // Exact synonyms are strong valid matches
    if (/^(?:my\s*account|account|your\s*account|user\s*account|profile)$/i.test(text)) {
      return false;
    }

    // Reject destructive operations unless explicitly requested
    if (/\b(?:delete|close|remove|terminate|deactivate)\b/i.test(text) && !/\b(?:delete|close|remove|terminate|deactivate)\b/i.test(normalizedTarget)) {
      return true;
    }

    // Reject financial/banking operations unless explicitly requested
    if (/\b(?:bank|checking|savings|card|credit|deposit|withdrawal)\b/i.test(text) && !/\b(?:bank|checking|savings|card|credit)\b/i.test(normalizedTarget)) {
      return true;
    }

    // Reject registration, creation, or login promotions unless explicitly requested
    if (/\b(?:create|sign\s*up|register|no\s*account|new\s*account|switch)\b/i.test(text) && !/\b(?:create|sign\s*up|register|switch)\b/i.test(normalizedTarget)) {
      return true;
    }
  }

  // If target has multiple words (e.g. "delete account"), all key words must appear in text
  const targetWords = normalizedTarget.split(/\s+/).filter((w) => w.length > 2);
  if (targetWords.length > 1) {
    const missingWord = targetWords.some((w) => !text.includes(w));
    if (missingWord) return true;
  }

  // Detect product cards, prices, and catalog items
  const hasProductPrice = /[₹$€£]\s*\d+|\b\d{1,3}(?:,\d{3})+\b/.test(text);
  const hasProductSpecs = /\b(?:gb\s*ram|ssd|hdd|core\s*i[3579]|ryzen|mah|inches|inch|reviews?|ratings?)\b/i.test(text);
  const isMuchLonger = text.length > normalizedTarget.length * 3 && text.length > 40;

  if (hasProductPrice || hasProductSpecs || isMuchLonger) {
    // If user prompt did not specifically search for a product or price, reject as unrelated
    if (!normalizedTarget.includes('laptop') && !normalizedTarget.includes('₹') && !normalizedTarget.includes('$')) {
      return true;
    }
  }

  return false;
}

/**
 * Finds matching button or link elements from the snapshot.
 * Disambiguates duplicate targets (e.g. top-level chip vs in-menu option, header account vs footer link).
 * 
 * @param {string} targetName
 * @param {Object} snapshot
 * @returns {{ exactMatches: Array, partialMatches: Array }}
 */
export function findClickableElements(targetName, snapshot) {
  const normalizedTarget = targetName.toLowerCase().trim();
  const buttons = snapshot.interactive?.buttons || snapshot.buttons || [];
  const links = snapshot.interactive?.links || snapshot.links || [];
  const candidates = [...buttons, ...links];

  const exactMatches = [];
  const partialMatches = [];

  const isAccountTarget = /^(?:my\s*account|account|your\s*account|user\s*account)$/i.test(normalizedTarget);

  for (const item of candidates) {
    // Skip disabled elements when finding clickable targets
    if (item.disabled) continue;

    const text = (item.text || '').toLowerCase().trim();
    const aria = (item.ariaLabel || '').toLowerCase().trim();
    const title = (item.title || '').toLowerCase().trim();

    // Check account synonyms as exact matches
    const isExactAccountMatch = isAccountTarget && (
      text === 'account' || text === 'my account' || text === 'your account' || text === 'user account' || text === 'profile' ||
      aria === 'account' || aria === 'my account' || aria === 'your account' || aria === 'user account' || aria === 'profile' ||
      title === 'account' || title === 'my account' || title === 'your account' || title === 'user account' || title === 'profile'
    );

    if (
      isExactAccountMatch ||
      text === normalizedTarget ||
      aria === normalizedTarget ||
      title === normalizedTarget
    ) {
      exactMatches.push(item);
    } else if (
      (text && (text.startsWith(normalizedTarget) || text.includes(normalizedTarget))) ||
      (aria && (aria.startsWith(normalizedTarget) || aria.includes(normalizedTarget))) ||
      (title && (title.startsWith(normalizedTarget) || title.includes(normalizedTarget)))
    ) {
      if (!isWeakOrUnrelatedMatch(item, normalizedTarget)) {
        partialMatches.push(item);
      }
    }
  }

  // DISAMBIGUATION:
  // 1. If multiple candidates match (e.g. chip "Live" vs menu option "Live"):
  // Prefer candidate inside an active/open menu container (inMenu: true)
  if (exactMatches.length > 1) {
    const inMenuMatches = exactMatches.filter((m) => m.inMenu);
    if (inMenuMatches.length === 1) {
      return { exactMatches: inMenuMatches, partialMatches: [] };
    }
  }

  // 2. Disambiguate account / navigation buttons:
  // If multiple exact matches exist (e.g. header account button vs footer account overview link),
  // prefer elements in navigation/header or with ariaHasPopup or buttons over footer links
  if (exactMatches.length > 1 && isAccountTarget) {
    const popupButtons = exactMatches.filter((m) => m.ariaHasPopup || m.tag === 'button');
    if (popupButtons.length === 1) {
      return { exactMatches: popupButtons, partialMatches: [] };
    }
  }

  if (exactMatches.length === 0 && partialMatches.length > 1) {
    const inMenuMatches = partialMatches.filter((m) => m.inMenu);
    if (inMenuMatches.length === 1) {
      return { exactMatches: [], partialMatches: inMenuMatches };
    }

    if (isAccountTarget) {
      const popupButtons = partialMatches.filter((m) => m.ariaHasPopup || m.tag === 'button');
      if (popupButtons.length === 1) {
        return { exactMatches: [], partialMatches: popupButtons };
      }
    }
  }

  return { exactMatches, partialMatches };
}

/**
 * Identifies the best candidate search input on the page.
 * @param {Object} snapshot
 * @returns {Object|null}
 */
function findSearchInput(snapshot) {
  const inputs = snapshot.interactive?.inputs || snapshot.inputs || [];

  // Priority 1: type="search"
  for (const input of inputs) {
    if (input.type === 'search' && !input.disabled) return input;
  }

  // Priority 2: name or placeholder containing "search", "query", or "q"
  for (const input of inputs) {
    if (input.disabled) continue;
    const name = (input.name || '').toLowerCase();
    const placeholder = (input.placeholder || '').toLowerCase();
    const label = (input.label || '').toLowerCase();

    if (
      name === 'q' ||
      name === 'search' ||
      name.includes('search') ||
      placeholder.includes('search') ||
      label.includes('search')
    ) {
      return input;
    }
  }

  // Priority 3: first visible text input inside a form with search keywords
  for (const input of inputs) {
    if (input.disabled) continue;
    if (input.type === 'text' && (input.placeholder || input.label)) {
      return input;
    }
  }

  return null;
}

/**
 * Plans the next deterministic browser action for a given user goal and page snapshot.
 * 
 * @param {string} rawGoal - Original user prompt
 * @param {Object} snapshot - Fresh page snapshot from observer.js
 * @param {Object} taskState - Current TaskState instance
 * @returns {{
 *   status: 'ACTION' | 'DONE' | 'ERROR',
 *   action?: Object,
 *   label?: string,
 *   isLastStep?: boolean,
 *   result?: Object,
 *   error?: string
 * }}
 */
export function planNextAction(rawGoal, snapshot, taskState) {
  const goal = cleanGoal(rawGoal);

  if (!goal) {
    return {
      status: 'ERROR',
      error: 'Cannot plan action: command is empty.'
    };
  }

  if (!snapshot || !snapshot.page) {
    return {
      status: 'ERROR',
      error: 'Cannot plan action: page snapshot is unavailable.'
    };
  }

  const clickTarget = extractClickTarget(goal);

  // Security guardrail for direct non-click commands: refuse high-risk financial, booking, or destructive actions
  if (!clickTarget && isSensitiveAction(goal)) {
    return {
      status: 'ERROR',
      requiresApproval: true,
      error: `Refusing sensitive action: "${rawGoal}". Automated booking, payment, purchase, checkout, or destructive operations are blocked for safety and require explicit user authorization.`
    };
  }

  // ==========================================================================
  // 1. SCROLL COMMANDS
  // ==========================================================================
  if (/^(?:scroll\s*down|page\s*down|scroll\s*down\s*a\s*bit|scroll\s*to\s*bottom)/i.test(goal)) {
    return {
      status: 'ACTION',
      action: { action: 'scroll', direction: 'down', amount: 500 },
      label: 'Scroll down page by 500px',
      isLastStep: true,
      result: {
        title: 'Scrolled down',
        answer: "I've scrolled down the page.",
        spokenText: "I've scrolled down the page.",
        meta: 'Scrolled down by 500px.'
      }
    };
  }

  if (/^(?:scroll\s*up|page\s*up|scroll\s*up\s*a\s*bit|scroll\s*to\s*top)/i.test(goal)) {
    return {
      status: 'ACTION',
      action: { action: 'scroll', direction: 'up', amount: 500 },
      label: 'Scroll up page by 500px',
      isLastStep: true,
      result: {
        title: 'Scrolled up',
        answer: "I've scrolled up the page.",
        spokenText: "I've scrolled up the page.",
        meta: 'Scrolled up by 500px.'
      }
    };
  }

  // ==========================================================================
  // 2. NAVIGATION COMMANDS
  // ==========================================================================
  const navMatch = goal.match(/^(?:open|go\s*to|navigate\s*to|visit)\s+([^\s]+)/i);
  if (navMatch) {
    const rawUrl = navMatch[1];
    const validUrl = parseUrl(rawUrl);

    if (validUrl) {
      return {
        status: 'ACTION',
        action: { action: 'navigate', url: validUrl },
        label: `Navigate to ${validUrl}`,
        isLastStep: true,
        result: {
          title: `Opened ${validUrl}`,
          answer: `I've opened ${validUrl}. What would you like to explore?`,
          spokenText: `I've opened ${validUrl}. What would you like to explore?`,
          meta: `Navigated to ${validUrl}.`
        }
      };
    }

    // If not a valid web URL, check if this is an on-page action (e.g. "open Filters", "open menu", or compound filter flow)
    const isFilterOrMenuCommand =
      Boolean(clickTarget) ||
      /(?:filters?|menu|dropdown)\b/i.test(goal) ||
      /(?:open|click|toggle)\s+filters.*?(?:and\s+)?(?:click|select|choose|filter\s+by)\s+([a-zA-Z0-9_-]+)/i.test(goal);

    if (!isFilterOrMenuCommand) {
      return {
        status: 'ERROR',
        error: `Invalid URL format for navigation: "${rawUrl}". Please provide a valid web address (e.g. "https://example.com" or "wikipedia.org").`
      };
    }
    // Otherwise fall through to click and menu handling below
  }

  // ==========================================================================
  // 3. SEARCH COMMANDS (MULTI-STEP)
  // ==========================================================================
  const searchMatch = goal.match(/^(?:search\s*for|search)\s+(?:["']?)([^"']+)(?:["']?)$/i);
  if (searchMatch) {
    const searchQuery = searchMatch[1].trim();

    if (!searchQuery) {
      return {
        status: 'ERROR',
        error: 'Please provide a search query (e.g. "Search for laptops").'
      };
    }

    const searchInput = findSearchInput(snapshot);
    if (!searchInput) {
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
      return {
        status: 'ACTION',
        action: { action: 'navigate', url: searchUrl },
        label: `Search Google for "${searchQuery}"`,
        isLastStep: true,
        result: {
          title: `Search for ${searchQuery}`,
          answer: `I've searched for ${searchQuery}. Would you like me to summarize the results?`,
          spokenText: `I've searched for ${searchQuery}. Would you like me to summarize the results?`,
          meta: `Navigated to Google search results for "${searchQuery}".`
        }
      };
    }

    // Step 1: Check if search query has already been typed
    const currentValue = (searchInput.value || '').trim();
    if (currentValue.toLowerCase() !== searchQuery.toLowerCase()) {
      return {
        status: 'ACTION',
        action: { action: 'type', elementId: searchInput.id, text: searchQuery },
        label: `Type search query "${searchQuery}"`,
        isLastStep: false // Multi-step: step 2 will press Enter
      };
    }

    // Step 2: Query already typed into input -> press Enter to submit search
    return {
      status: 'ACTION',
      action: { action: 'pressKey', key: 'Enter', elementId: searchInput.id },
      label: `Submit search for "${searchQuery}"`,
      isLastStep: true,
      result: {
        title: `Search for ${searchQuery}`,
        answer: `I've searched for ${searchQuery}. Would you like me to summarize the results?`,
        spokenText: `I've searched for ${searchQuery}. Would you like me to summarize the results?`,
        meta: `Submitted search query for "${searchQuery}".`
      }
    };
  }

  // ==========================================================================
  // 4. FIND TEXT COMMANDS
  // ==========================================================================
  const isQuestionOrReasoning = /\b(tell\s*me|what\s*(?:is|the)?|explain|summarize|summary|describe|about|why|how|bullet\s*points)\b/i.test(goal);
  const findMatch = !isQuestionOrReasoning && (
    goal.match(/^(?:find|search\s*for|look\s*for)\s+["']?([^"']+)["']?\s+(?:on\s*this\s*page|in\s*this\s*page|here)$/i) ||
    goal.match(/^find\s+["']?([^"']+)["']?$/i)
  );

  if (findMatch) {
    const queryText = findMatch[1].trim().toLowerCase();
    if (/\b(heading|title|main)\b/i.test(queryText)) {
      // Vague semantic inquiry should fall through to AI reasoning
      return {
        status: 'ERROR',
        error: `Semantic inquiry "${queryText}" requires AI reasoning.`
      };
    }

    // Check headings
    const headings = snapshot.content?.headings || snapshot.headings || [];
    for (const h of headings) {
      if (h.text && h.text.toLowerCase().includes(queryText)) {
        if (h.id) {
          return {
            status: 'ACTION',
            action: { action: 'scroll', elementId: h.id },
            label: `Scroll to heading "${h.text}"`,
            isLastStep: true
          };
        }
        return {
          status: 'DONE',
          result: {
            title: `Found section "${h.text}"`,
            meta: `Heading matches "${queryText}" on current page.`
          }
        };
      }
    }

    // Check interactive elements (buttons, links)
    const { exactMatches, partialMatches } = findClickableElements(queryText, snapshot);
    const candidate = exactMatches[0] || partialMatches[0];
    if (candidate && candidate.id) {
      return {
        status: 'ACTION',
        action: { action: 'scroll', elementId: candidate.id },
        label: `Scroll to element "${candidate.text}"`,
        isLastStep: true
      };
    }

    // Check paragraphs
    const paragraphs = snapshot.content?.paragraphs || [];
    for (const p of paragraphs) {
      const pText = typeof p === 'string' ? p : p.text || '';
      if (pText.toLowerCase().includes(queryText)) {
        const snippet = pText.slice(0, 100);
        return {
          status: 'DONE',
          result: {
            title: `Found text on page`,
            meta: `Match: "${snippet}…"`
          }
        };
      }
    }

    return {
      status: 'ERROR',
      error: `Could not find text "${queryText}" on the current page.`
    };
  }

  // ==========================================================================
  // 5. TYPE COMMANDS
  // ==========================================================================
  const typeMatch = goal.match(/^(?:type|enter|write|fill)\s+["']?([^"']+)["']?\s+(?:in|into)\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (typeMatch) {
    const textToType = typeMatch[1].trim();
    const targetInputName = typeMatch[2].trim().toLowerCase();

    const inputs = snapshot.interactive?.inputs || snapshot.inputs || [];
    const matchedInputs = inputs.filter((input) => {
      if (input.disabled) return false;
      const label = (input.label || '').toLowerCase();
      const placeholder = (input.placeholder || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      return (
        label.includes(targetInputName) ||
        placeholder.includes(targetInputName) ||
        name.includes(targetInputName)
      );
    });

    if (matchedInputs.length === 0) {
      return {
        status: 'ERROR',
        error: `No input field matching "${targetInputName}" was found on this page.`
      };
    }

    const targetInput = matchedInputs[0];

    // Security check: Never type passwords automatically
    if (targetInput.type === 'password') {
      return {
        status: 'ERROR',
        error: 'Security policy: automated entry into password fields is blocked.'
      };
    }

    return {
      status: 'ACTION',
      action: { action: 'type', elementId: targetInput.id, text: textToType },
      label: `Type "${textToType}" into ${targetInput.label || targetInput.placeholder || targetInputName}`,
      isLastStep: true
    };
  }

  // ==========================================================================
  // 6. CLICK & DYNAMIC MENU COMMANDS
  // ==========================================================================

  // 6A. COMPOUND FILTERS -> OPTION WORKFLOW (e.g. "open Filters, and click Live")
  const filterFlowMatch = goal.match(/(?:open|click|toggle)\s+filters.*?(?:and\s+)?(?:click|select|choose|filter\s+by)\s+([a-zA-Z0-9_-]+)/i);
  if (filterFlowMatch) {
    const filterOptionName = filterFlowMatch[1].trim();

    // Check if Filters menu is already open
    const { exactMatches: filterExact, partialMatches: filterPartial } = findClickableElements('Filters', snapshot);
    const filterBtn = filterExact[0] || filterPartial[0];
    const isMenuOpen = (snapshot.interactive?.buttons || []).some((b) => b.inMenu) || filterBtn?.ariaExpanded === 'true';

    // Step A: If Filters menu is not open yet, open Filters first as commanded
    if (!isMenuOpen && filterBtn) {
      return {
        status: 'ACTION',
        action: {
          action: 'click',
          elementId: filterBtn.id,
          targetText: 'Filters',
          targetTag: 'button',
          opensMenu: true
        },
        label: 'Open Filters menu',
        isLastStep: false
      };
    }

    // Step B: Filters menu is open (or filter button not found), select the requested option
    const { exactMatches: liveExact, partialMatches: livePartial } = findClickableElements(filterOptionName, snapshot);
    const liveCandidate = liveExact[0] || (liveExact.length === 0 && livePartial[0]);

    if (liveCandidate) {
      return {
        status: 'ACTION',
        action: {
          action: 'click',
          elementId: liveCandidate.id,
          targetText: liveCandidate.text || filterOptionName,
          targetHref: liveCandidate.href || null,
          targetTag: liveCandidate.href ? 'a' : 'filter',
          isFilter: true
        },
        label: `Click "${liveCandidate.text || filterOptionName}" filter`,
        isLastStep: true,
        result: {
          title: `Selected ${filterOptionName} Filter`,
          answer: `I've applied the ${filterOptionName} filter.`,
          spokenText: `I've applied the ${filterOptionName} filter.`,
          meta: `Selected ${filterOptionName} filter.`
        }
      };
    }

    if (isMenuOpen) {
      // Menu is already open but option is still not found
      return {
        status: 'ERROR',
        error: `Filters menu is open, but "${filterOptionName}" option was not found on the page.`
      };
    }
  }

  // 6B. OPEN FILTERS / MENU COMMAND (e.g. "open Filters", "open menu")
  const openMenuMatch = goal.match(/^open\s+(?:the\s+)?(filters?|menu|dropdown)\b/i);
  if (openMenuMatch) {
    const targetName = openMenuMatch[1];
    const { exactMatches, partialMatches } = findClickableElements(targetName, snapshot);
    const filterBtn = exactMatches[0] || partialMatches[0];
    if (filterBtn) {
      return {
        status: 'ACTION',
        action: {
          action: 'click',
          elementId: filterBtn.id,
          targetText: filterBtn.text || targetName,
          targetTag: 'button',
          opensMenu: true
        },
        label: `Open ${targetName}`,
        isLastStep: false
      };
    }
  }

  if (clickTarget) {
    const targetName = clickTarget;
    const { exactMatches, partialMatches } = findClickableElements(targetName, snapshot);

    // Requirement 4: If requested button does not exist on the current page, report
    // "Button not found on the current page." Do not substitute an unrelated element.
    if (exactMatches.length === 0 && partialMatches.length === 0) {
      const isDeleteAccount = targetName.toLowerCase().includes('delete') || goal.toLowerCase().includes('delete');
      return {
        status: 'ERROR',
        error: isDeleteAccount
          ? 'Button not found on the current page.'
          : `No button or link matching "${targetName}" was found on this page. Button not found on the current page.`
      };
    }

    if (exactMatches.length === 1) {
      const target = exactMatches[0];
      const isLink = Boolean(target.href);
      const isFilter = /^(?:live|4k|hd|subtitles|creative\s*commons|under\s*4\s*minutes|this\s*week|today)\b/i.test(target.text || targetName);
      const opensMenu = /^(?:filters?|menu|dropdown)\b/i.test(target.text || targetName) || Boolean(target.ariaHasPopup);

      // Requirement 6: Keep existing safety policy - require confirmation before consequential actions
      if (isSensitiveAction(target.text) || isSensitiveAction(targetName) || isSensitiveAction(goal)) {
        return {
          status: 'WAITING_FOR_APPROVAL',
          requiresApproval: true,
          action: {
            action: 'click',
            elementId: target.id,
            targetText: target.text || targetName,
            targetHref: target.href || null,
            targetTag: isLink ? 'a' : 'button',
            ariaLabel: target.ariaLabel || null,
            title: target.title || null,
            dataTestId: target.dataTestId || null,
            role: target.role || null
          },
          label: `Click ${isLink ? 'link' : 'button'} "${target.text || targetName}"`,
          explanation: `Consequential action detected: "${target.text || targetName}". Deleting an account or performing consequential operations requires user confirmation.`
        };
      }

      return {
        status: 'ACTION',
        action: {
          action: 'click',
          elementId: target.id,
          targetText: target.text || targetName,
          targetHref: target.href || null,
          targetTag: isLink ? 'a' : (isFilter ? 'filter' : 'button'),
          ariaLabel: target.ariaLabel || null,
          title: target.title || null,
          dataTestId: target.dataTestId || null,
          role: target.role || null,
          ariaHasPopup: target.ariaHasPopup || null,
          ariaExpanded: target.ariaExpanded || null,
          ...(opensMenu ? { opensMenu: true } : {}),
          ...(isFilter ? { isFilter: true } : {})
        },
        label: `Click ${isLink ? 'link' : (isFilter ? 'filter' : (opensMenu ? 'menu' : 'button'))} "${target.text || targetName}"`,
        isLastStep: true,
        result: {
          title: `Clicked ${target.text || targetName}`,
          answer: `I've clicked ${target.text || targetName}.`,
          spokenText: `I've clicked ${target.text || targetName}.`,
          meta: `Clicked ${target.text || targetName}.`
        }
      };
    }

    if (exactMatches.length > 1) {
      return {
        status: 'ERROR',
        error: `Ambiguous command: multiple elements on this page match "${targetName}". Please clarify which link or button to click.`
      };
    }

    if (partialMatches.length === 1) {
      const target = partialMatches[0];
      const isLink = Boolean(target.href);
      const isFilter = /^(?:live|4k|hd|subtitles|creative\s*commons|under\s*4\s*minutes|this\s*week|today)\b/i.test(target.text || targetName);
      const opensMenu = /^(?:filters?|menu|dropdown)\b/i.test(target.text || targetName) || Boolean(target.ariaHasPopup);

      if (isWeakOrUnrelatedMatch(target, targetName)) {
        return {
          status: 'ERROR',
          error: 'Button not found on the current page.'
        };
      }

      if (isSensitiveAction(target.text) || isSensitiveAction(targetName) || isSensitiveAction(goal)) {
        return {
          status: 'WAITING_FOR_APPROVAL',
          requiresApproval: true,
          action: {
            action: 'click',
            elementId: target.id,
            targetText: target.text || targetName,
            targetHref: target.href || null,
            targetTag: isLink ? 'a' : 'button',
            ariaLabel: target.ariaLabel || null,
            title: target.title || null,
            dataTestId: target.dataTestId || null,
            role: target.role || null
          },
          label: `Click ${isLink ? 'link' : 'button'} "${target.text || targetName}"`,
          explanation: `Consequential action detected: "${target.text || targetName}". Requires user confirmation.`
        };
      }

      return {
        status: 'ACTION',
        action: {
          action: 'click',
          elementId: target.id,
          targetText: target.text || targetName,
          targetHref: target.href || null,
          targetTag: isLink ? 'a' : (isFilter ? 'filter' : 'button'),
          ariaLabel: target.ariaLabel || null,
          title: target.title || null,
          dataTestId: target.dataTestId || null,
          role: target.role || null,
          ariaHasPopup: target.ariaHasPopup || null,
          ariaExpanded: target.ariaExpanded || null,
          ...(opensMenu ? { opensMenu: true } : {}),
          ...(isFilter ? { isFilter: true } : {})
        },
        label: `Click ${isLink ? 'link' : (isFilter ? 'filter' : (opensMenu ? 'menu' : 'button'))} "${target.text || targetName}"`,
        isLastStep: true,
        result: {
          title: `Clicked ${target.text || targetName}`,
          answer: `I've clicked ${target.text || targetName}.`,
          spokenText: `I've clicked ${target.text || targetName}.`,
          meta: `Clicked ${target.text || targetName}.`
        }
      };
    }

    if (partialMatches.length > 1) {
      const sampleNames = partialMatches.slice(0, 3).map((m) => `"${m.text || m.ariaLabel || targetName}"`).join(', ');
      return {
        status: 'ERROR',
        error: `Ambiguous command: found ${partialMatches.length} matching elements (${sampleNames}). Please clarify which one to click.`
      };
    }

    return {
      status: 'ERROR',
      error: 'Button not found on the current page.'
    };
  }

  // ==========================================================================
  // 7. UNSUPPORTED COMMAND FALLBACK
  // ==========================================================================
  return {
    status: 'ERROR',
    error: `Unsupported command: "${rawGoal}". The Deterministic Planner supports: "Scroll down/up", "Open [URL]", "Find [text]", "Click [name]", "Search for [query]", "Type [text] into [input]".`
  };
}

/**
 * Alias for planNextAction representing explicit deterministic planning.
 */
export const planDeterministic = planNextAction;

/**
 * Evaluates whether a user goal can be safely and reliably handled
 * locally by the deterministic planner without making an AI/LLM network request.
 * 
 * @param {string} rawGoal
 * @param {Object} snapshot
 * @returns {boolean}
 */
export function canHandleDeterministically(rawGoal, snapshot) {
  const goal = cleanGoal(rawGoal);
  if (!goal || !snapshot || !snapshot.page) return false;

  // Sensitive actions are always handled locally for safety
  if (isSensitiveAction(goal)) return true;

  // 1. Scroll commands
  if (/^(?:scroll\s*down|page\s*down|scroll\s*down\s*a\s*bit|scroll\s*to\s*bottom|scroll\s*up|page\s*up|scroll\s*up\s*a\s*bit|scroll\s*to\s*top)/i.test(goal)) {
    return true;
  }

  // 2. Navigation commands with valid URL
  const navMatch = goal.match(/^(?:open|go\s*to|navigate\s*to|visit)\s+([^\s]+)/i);
  if (navMatch && parseUrl(navMatch[1])) {
    return true;
  }

  // 3. Search commands (handles either via search input or Google search navigation)
  const searchMatch = goal.match(/^(?:search\s*for|search)\s+(?:["']?)([^"']+)(?:["']?)$/i);
  if (searchMatch) {
    return true;
  }

  // 4. Find text commands if target text exists on page
  // Exclude natural-language questions, comprehension, and compound requests that require AI reasoning
  const isQuestionOrReasoning = /\b(tell\s*me|what\s*(?:is|the)?|explain|summarize|summary|describe|about|why|how|bullet\s*points)\b/i.test(goal);
  if (!isQuestionOrReasoning) {
    const findMatch =
      goal.match(/^(?:find|search\s*for|look\s*for)\s+["']?([^"']+)["']?\s+(?:on\s*this\s*page|in\s*this\s*page|here)$/i) ||
      goal.match(/^find\s+["']?([^"']+)["']?$/i);
    if (findMatch) {
      const queryText = findMatch[1].trim().toLowerCase();
      if (!/\b(heading|title|main)\b/i.test(queryText)) {
        const headings = snapshot.content?.headings || snapshot.headings || [];
        const paragraphs = snapshot.content?.paragraphs || [];
        const hasHeading = headings.some((h) => h.text && h.text.toLowerCase().includes(queryText));
        const hasParagraph = paragraphs.some((p) => {
          const t = typeof p === 'string' ? p : p.text || '';
          return t.toLowerCase().includes(queryText);
        });
        if (hasHeading || hasParagraph) return true;
      }
    }
  }

  // 5. Type commands if matching input exists
  const typeMatch = goal.match(/^(?:type|enter|write|fill)\s+["']?([^"']+)["']?\s+(?:in|into)\s+(?:the\s+)?["']?([^"']+)["']?$/i);
  if (typeMatch) {
    const targetInputName = typeMatch[2].trim().toLowerCase();
    const inputs = snapshot.interactive?.inputs || snapshot.inputs || [];
    const hasInput = inputs.some((inp) => {
      if (inp.disabled) return false;
      const label = (inp.label || '').toLowerCase();
      const placeholder = (inp.placeholder || '').toLowerCase();
      const name = (inp.name || '').toLowerCase();
      return label.includes(targetInputName) || placeholder.includes(targetInputName) || name.includes(targetInputName);
    });
    if (hasInput) return true;
  }

  // 6. Click commands if exactly 1 matching candidate exists
  const clickTarget = extractClickTarget(goal);
  if (clickTarget) {
    const { exactMatches, partialMatches } = findClickableElements(clickTarget, snapshot);
    if (exactMatches.length === 1 || (exactMatches.length === 0 && partialMatches.length === 1)) {
      return true;
    }
  }

  // 7. Compound Filter -> Option flow (e.g. "open Filters, and click Live")
  const filterFlowMatch = goal.match(/(?:open|click|toggle)\s+filters.*?(?:and\s+)?(?:click|select|choose|filter\s+by)\s+([a-zA-Z0-9_-]+)/i);
  if (filterFlowMatch) {
    const targetFilter = filterFlowMatch[1].trim();
    const { exactMatches: liveExact, partialMatches: livePartial } = findClickableElements(targetFilter, snapshot);
    const { exactMatches: filterExact, partialMatches: filterPartial } = findClickableElements('Filters', snapshot);
    if (liveExact.length === 1 || filterExact.length === 1 || livePartial.length === 1 || filterPartial.length === 1) {
      return true;
    }
  }

  return false;
}

