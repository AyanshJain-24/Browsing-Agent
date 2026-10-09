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
  const sensitiveRegex = /\b(buy\b|purchase\b|pay\b|payment\b|checkout\b|book\s+(?:me\s+)?(?:a\s+)?flight|flight|place\s*order|credit\s*card|bank\s*account|delete\s*(?:user\s+|my\s+)?account|remove\s*all|transfer\s*money)\b/i;
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
export function extractClickTarget(goal) {
  if (!goal || typeof goal !== 'string') return null;

  const prefixRegex = /^(?:click|press|tap|select)\s+(?:on\s+)?(?:the\s+)?(?:link\s+to\s+|link\s+for\s+|link\s*:\s*|link\s+|button\s+for\s+|button\s*:\s*|button\s+)?/i;
  if (!prefixRegex.test(goal)) return null;

  let target = goal.replace(prefixRegex, '').trim();

  // Strip trailing qualifiers if present: "link", "button", "tab"
  target = target.replace(/\s+(?:button|link|tab)$/i, '').trim();

  // Strip surrounding quotes
  target = target.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();

  return target || null;
}

/**
 * Finds matching button or link elements from the snapshot.
 * @param {string} targetName
 * @param {Object} snapshot
 * @returns {{ exactMatches: Array, partialMatches: Array }}
 */
function findClickableElements(targetName, snapshot) {
  const normalizedTarget = targetName.toLowerCase().trim();
  const buttons = snapshot.interactive?.buttons || snapshot.buttons || [];
  const links = snapshot.interactive?.links || snapshot.links || [];
  const candidates = [...buttons, ...links];

  const exactMatches = [];
  const partialMatches = [];

  for (const item of candidates) {
    const text = (item.text || '').toLowerCase().trim();
    const aria = (item.ariaLabel || '').toLowerCase().trim();
    const title = (item.title || '').toLowerCase().trim();

    if (text === normalizedTarget || aria === normalizedTarget || title === normalizedTarget) {
      exactMatches.push(item);
    } else if (
      (text && (text.startsWith(normalizedTarget) || text.includes(normalizedTarget))) ||
      (aria && (aria.startsWith(normalizedTarget) || aria.includes(normalizedTarget))) ||
      (title && (title.startsWith(normalizedTarget) || title.includes(normalizedTarget)))
    ) {
      partialMatches.push(item);
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

  // Security guardrail: refuse high-risk financial, booking, or destructive actions
  if (isSensitiveAction(goal)) {
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
      isLastStep: true
    };
  }

  if (/^(?:scroll\s*up|page\s*up|scroll\s*up\s*a\s*bit|scroll\s*to\s*top)/i.test(goal)) {
    return {
      status: 'ACTION',
      action: { action: 'scroll', direction: 'up', amount: 500 },
      label: 'Scroll up page by 500px',
      isLastStep: true
    };
  }

  // ==========================================================================
  // 2. NAVIGATION COMMANDS
  // ==========================================================================
  const navMatch = goal.match(/^(?:open|go\s*to|navigate\s*to|visit)\s+([^\s]+)/i);
  if (navMatch) {
    const rawUrl = navMatch[1];
    const validUrl = parseUrl(rawUrl);

    if (!validUrl) {
      return {
        status: 'ERROR',
        error: `Invalid URL format for navigation: "${rawUrl}". Please provide a valid web address (e.g. "https://example.com" or "wikipedia.org").`
      };
    }

    return {
      status: 'ACTION',
      action: { action: 'navigate', url: validUrl },
      label: `Navigate to ${validUrl}`,
      isLastStep: true
    };
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
      return {
        status: 'ERROR',
        error: 'No search input found on the current page. Please navigate to a search page first.'
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
      isLastStep: true
    };
  }

  // ==========================================================================
  // 4. FIND TEXT COMMANDS
  // ==========================================================================
  const findMatch =
    goal.match(/^(?:find|search\s*for|look\s*for)\s+["']?([^"']+)["']?\s+(?:on\s*this\s*page|in\s*this\s*page|here)$/i) ||
    goal.match(/^find\s+["']?([^"']+)["']?$/i);

  if (findMatch) {
    const queryText = findMatch[1].trim().toLowerCase();

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
  // 6. CLICK COMMANDS
  // ==========================================================================
  const clickTarget = extractClickTarget(goal);
  if (clickTarget) {
    const targetName = clickTarget;

    // Security check: block sensitive checkout, payment, or deletion actions
    if (isSensitiveAction(targetName)) {
      return {
        status: 'ERROR',
        requiresApproval: true,
        error: `Refusing sensitive action: automated purchase, checkout, payment, or deletion is blocked for safety.`
      };
    }

    const { exactMatches, partialMatches } = findClickableElements(targetName, snapshot);

    if (exactMatches.length === 1) {
      const target = exactMatches[0];
      const isLink = Boolean(target.href);
      return {
        status: 'ACTION',
        action: {
          action: 'click',
          elementId: target.id,
          targetText: target.text || targetName,
          targetHref: target.href || null,
          targetTag: isLink ? 'a' : 'button'
        },
        label: `Click ${isLink ? 'link' : 'button'} "${target.text || targetName}"`,
        isLastStep: true
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
      return {
        status: 'ACTION',
        action: {
          action: 'click',
          elementId: target.id,
          targetText: target.text || targetName,
          targetHref: target.href || null,
          targetTag: isLink ? 'a' : 'button'
        },
        label: `Click ${isLink ? 'link' : 'button'} "${target.text || targetName}"`,
        isLastStep: true
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
      error: `No button or link matching "${targetName}" was found on this page.`
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

  // 3. Search commands if a search input exists
  const searchMatch = goal.match(/^(?:search\s*for|search)\s+(?:["']?)([^"']+)(?:["']?)$/i);
  if (searchMatch && findSearchInput(snapshot)) {
    return true;
  }

  // 4. Find text commands if target text exists on page
  const findMatch =
    goal.match(/^(?:find|search\s*for|look\s*for)\s+["']?([^"']+)["']?\s+(?:on\s*this\s*page|in\s*this\s*page|here)$/i) ||
    goal.match(/^find\s+["']?([^"']+)["']?$/i);
  if (findMatch) {
    const queryText = findMatch[1].trim().toLowerCase();
    const headings = snapshot.content?.headings || snapshot.headings || [];
    const paragraphs = snapshot.content?.paragraphs || [];
    const hasHeading = headings.some((h) => h.text && h.text.toLowerCase().includes(queryText));
    const hasParagraph = paragraphs.some((p) => {
      const t = typeof p === 'string' ? p : p.text || '';
      return t.toLowerCase().includes(queryText);
    });
    if (hasHeading || hasParagraph) return true;
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

  return false;
}

