/**
 * Voice Browser Agent - General-Purpose DOM Observer Engine
 * 
 * "The Eyes of the Browser Agent"
 * 
 * Inspects any live webpage and generates a compact, structured JSON snapshot
 * separated into three distinct domains:
 * 1. PAGE METADATA: Title, URL, domain, language, description, canonical link.
 * 2. READABLE CONTENT: Semantic main text, headings, paragraphs, lists, tables, meaningful images.
 * 3. INTERACTIVE CONTROLS: Inputs, buttons, links, forms (with temporary in-memory registry IDs).
 * 
 * Designed for low latency, low token footprint, and minimal AI cost.
 * Untrusted webpage data is normalized and sanitized without modifying the host DOM.
 */

// ============================================================================
// PAYLOAD LIMITS & CONFIGURATION CONSTANTS
// ============================================================================
// Sensible limits prevent uncontrolled payload growth on huge pages (e.g. Wikipedia, Reddit)
// ensuring fast serialization, low network overhead, and cheap LLM context window usage.
const LIMITS = {
  MAX_HEADINGS: 15,          // Captures major section outlines without minor sub-headings
  MAX_PARAGRAPHS: 30,        // Captures key article text without bloat
  MAX_PARAGRAPH_LENGTH: 300, // Long paragraphs are clipped to preserve high-level meaning
  MAX_LISTS: 8,              // Top visible bulleted/numbered lists
  MAX_LIST_ITEMS: 8,         // Maximum items per list
  MAX_LIST_ITEM_LENGTH: 120, // Max text length per list item
  MAX_TABLES: 4,             // Top visible comparison/data tables
  MAX_TABLE_ROWS: 8,         // Maximum rows per table
  MAX_TABLE_CELL_LENGTH: 60, // Maximum string length per cell
  MAX_IMAGES: 10,            // Relevant descriptive images
  MAX_INPUTS: 30,            // Comprehensive form field coverage
  MAX_BUTTONS: 25,           // Major interactive call-to-actions
  MAX_LINKS: 50,             // Compact, intelligently ranked links
  MAX_FORMS: 5               // Form blocks on page
};

// ============================================================================
// IN-MEMORY TEMPORARY ELEMENT REGISTRY
// ============================================================================
// Generates session/snapshot identifiers (e.g. "element-1", "element-2") mapped to real
// DOM nodes in memory. These IDs are TEMPORARY to the current observation lifecycle,
// allowing executor.js to reference target nodes later WITHOUT injecting visible attributes
// or altering the webpage's DOM tree.
const elementRegistry = new Map();
let nextElementId = 1;

/**
 * Registers a DOM element and returns a temporary identifier.
 * @param {Element} element
 * @returns {string} Temporary ID (e.g. "element-1")
 */
function registerElement(element) {
  const id = `element-${nextElementId++}`;
  elementRegistry.set(id, element);
  return id;
}

/**
 * Retrieves a registered DOM node by its temporary snapshot ID.
 * Exported for future action executors (click, type, scroll).
 * @param {string} id
 * @returns {Element|null}
 */
export function getRegisteredElement(id) {
  return elementRegistry.get(id) || null;
}

// ============================================================================
// TEXT NORMALIZATION & UTILITY HELPERS
// ============================================================================

/**
 * Normalizes text by trimming whitespace, collapsing repeated spaces/newlines,
 * and applying an optional maximum character cap.
 * 
 * Example: "  Artificial \n\n   Intelligence  " -> "Artificial Intelligence"
 * 
 * @param {string} text - Raw input string
 * @param {number} maxLength - Max characters before appending ellipsis (0 for no limit)
 * @returns {string} Normalized string
 */
function normalizeText(text, maxLength = 0) {
  if (!text || typeof text !== 'string') return '';
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (maxLength > 0 && cleaned.length > maxLength) {
    return cleaned.slice(0, maxLength) + '…';
  }
  return cleaned;
}

/**
 * Checks whether an element is visible to a human user in the browser.
 * Filters out hidden, zero-sized, transparent, and display:none elements.
 * @param {Element} element
 * @returns {boolean}
 */
function isVisible(element) {
  if (!element || !(element instanceof Element)) return false;

  // Modern browser API for comprehensive visibility detection
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({
      checkOpacity: true,
      checkVisibilityCSS: true
    });
  }

  // Fallback checks
  const style = window.getComputedStyle(element);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0'
  ) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Determines if an element is located inside non-content containers (script, style,
 * noscript, svg, or common boilerplate chrome like nav, footer, header).
 * 
 * IMPORTANT: This helper is used exclusively when extracting READABLE CONTENT
 * so that menus, headers, and footers don't pollute article text.
 * It is NOT applied to interactive elements (e.g. a Login button in a header is kept).
 * 
 * @param {Element} element
 * @returns {boolean}
 */
function isInsideBoilerplateContainer(element) {
  return Boolean(
    element.closest('script, style, noscript, svg, nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]')
  );
}

/**
 * Resolves the primary semantic content container on the page.
 * Prefers <main>, <article>, or [role="main"]. If none exist or are invisible,
 * falls back to document.body.
 * @returns {Element}
 */
function getContentRoot() {
  const candidates = document.querySelectorAll('main, article, [role="main"]');
  for (const candidate of candidates) {
    if (isVisible(candidate) && candidate.innerText && candidate.innerText.trim().length > 50) {
      return candidate;
    }
  }
  return document.body || document.documentElement;
}

/**
 * Finds the human-readable label associated with an interactive input.
 * Inspects aria-label, aria-labelledby, <label for="...">, wrapping <label>,
 * and placeholder attributes in priority order.
 * @param {HTMLElement} inputElement
 * @returns {string}
 */
function getAssociatedLabel(inputElement) {
  // 1. Direct aria-label
  if (inputElement.hasAttribute('aria-label')) {
    return normalizeText(inputElement.getAttribute('aria-label'), 80);
  }

  // 2. Referenced aria-labelledby
  const labelledBy = inputElement.getAttribute('aria-labelledby');
  if (labelledBy) {
    const labelEl = document.getElementById(labelledBy);
    if (labelEl) return normalizeText(labelEl.textContent, 80);
  }

  // 3. Explicit <label for="id">
  if (inputElement.id) {
    try {
      const explicitLabel = document.querySelector(`label[for="${CSS.escape(inputElement.id)}"]`);
      if (explicitLabel) return normalizeText(explicitLabel.textContent, 80);
    } catch {
      // Ignore CSS selector escape errors on unusual characters
    }
  }

  // 4. Wrapping <label>
  const parentLabel = inputElement.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true);
    clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
    const labelText = normalizeText(clone.textContent, 80);
    if (labelText) return labelText;
  }

  // 5. Fallback placeholder or title attribute
  return normalizeText(
    inputElement.getAttribute('placeholder') || inputElement.getAttribute('title') || '',
    80
  );
}

// ============================================================================
// 1. PAGE METADATA EXTRACTION
// ============================================================================

/**
 * Extracts high-level page metadata including title, URL, domain, language,
 * meta description, and canonical URL.
 * @returns {Object}
 */
function extractPageMetadata() {
  const metaDescription =
    document.querySelector('meta[name="description"]')?.getAttribute('content') ||
    document.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
    '';

  const canonicalLink =
    document.querySelector('link[rel="canonical"]')?.getAttribute('href') ||
    '';

  return {
    title: normalizeText(document.title || 'Untitled Page', 120),
    url: window.location.href,
    hostname: window.location.hostname,
    language: document.documentElement.lang || 'en',
    description: normalizeText(metaDescription, 200),
    canonicalUrl: canonicalLink ? new URL(canonicalLink, window.location.href).href : '',
    scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    scrollX: Math.round(window.scrollX || window.pageXOffset || 0),
    maxScrollY: Math.max(0, (document.documentElement?.scrollHeight || 0) - window.innerHeight)
  };
}

// ============================================================================
// 2. READABLE CONTENT EXTRACTION
// ============================================================================

/**
 * Extracts visible section headings (h1, h2, h3) representing page hierarchy.
 * @returns {Array<Object>}
 */
function extractHeadings() {
  const headings = [];
  const headingElements = document.querySelectorAll('h1, h2, h3');

  for (const el of headingElements) {
    if (!isVisible(el)) continue;
    const text = normalizeText(el.textContent, 120);
    if (text) {
      headings.push({
        id: registerElement(el),
        tag: el.tagName.toLowerCase(),
        text
      });
      if (headings.length >= LIMITS.MAX_HEADINGS) break;
    }
  }

  return headings;
}

/**
 * Extracts visible, meaningful paragraphs from the primary content root.
 * Filters out short UI fragments, boilerplate chrome, and empty tags.
 * @param {Element} contentRoot
 * @returns {Array<string>}
 */
function extractParagraphs(contentRoot) {
  const paragraphs = [];
  const pElements = contentRoot.querySelectorAll('p');

  for (const p of pElements) {
    if (!isVisible(p)) continue;
    if (isInsideBoilerplateContainer(p)) continue;

    const text = normalizeText(p.textContent, LIMITS.MAX_PARAGRAPH_LENGTH);
    // Ignore short fragments like copyright notices, single words, or dates (< 20 chars)
    if (text && text.length >= 20) {
      paragraphs.push(text);
      if (paragraphs.length >= LIMITS.MAX_PARAGRAPHS) break;
    }
  }

  return paragraphs;
}

/**
 * Extracts visible ordered and unordered lists (e.g. features, specs, steps).
 * Skips navigation menus and footer link clusters.
 * @param {Element} contentRoot
 * @returns {Array<Object>}
 */
function extractLists(contentRoot) {
  const lists = [];
  const listElements = contentRoot.querySelectorAll('ul, ol');

  for (const list of listElements) {
    if (!isVisible(list)) continue;
    if (isInsideBoilerplateContainer(list)) continue;

    // Collect list items
    const items = [];
    const liElements = list.querySelectorAll(':scope > li');

    for (const li of liElements) {
      if (!isVisible(li)) continue;
      const text = normalizeText(li.textContent, LIMITS.MAX_LIST_ITEM_LENGTH);
      if (text) {
        items.push(text);
        if (items.length >= LIMITS.MAX_LIST_ITEMS) break;
      }
    }

    // Only include lists with meaningful content (at least 2 items)
    if (items.length >= 2) {
      lists.push({
        type: list.tagName.toLowerCase() === 'ol' ? 'ordered' : 'unordered',
        items
      });
      if (lists.length >= LIMITS.MAX_LISTS) break;
    }
  }

  return lists;
}

/**
 * Extracts data tables (e.g. pricing, comparison grids, specs) into compact row arrays.
 * @returns {Array<Object>}
 */
function extractTables() {
  const tables = [];
  const tableElements = document.querySelectorAll('table');

  for (const table of tableElements) {
    if (!isVisible(table)) continue;

    const caption = normalizeText(table.querySelector('caption')?.textContent || '', 100);

    // Extract table headers
    const headerCells = table.querySelectorAll('thead th, tr:first-child th');
    const headers = [];
    for (const th of headerCells) {
      headers.push(normalizeText(th.textContent, LIMITS.MAX_TABLE_CELL_LENGTH));
    }

    // Extract table rows
    const rows = [];
    const rowElements = table.querySelectorAll('tbody tr, tr');

    for (const tr of rowElements) {
      // Skip the header row if it only contains th elements
      if (tr.querySelector('th') && !tr.querySelector('td')) continue;

      const cells = [];
      for (const td of tr.querySelectorAll('td, th')) {
        cells.push(normalizeText(td.textContent, LIMITS.MAX_TABLE_CELL_LENGTH));
      }

      if (cells.length > 0 && cells.some((c) => c.length > 0)) {
        rows.push(cells);
        if (rows.length >= LIMITS.MAX_TABLE_ROWS) break;
      }
    }

    // Only include tables with structured data
    if (headers.length > 0 || rows.length > 0) {
      tables.push({
        caption,
        headers,
        rows
      });
      if (tables.length >= LIMITS.MAX_TABLES) break;
    }
  }

  return tables;
}

/**
 * Extracts metadata for meaningful, visible content images (alt text & titles).
 * Filters out tracking pixels, tiny icons (< 32px), and decorative empty-alt graphics.
 * @returns {Array<Object>}
 */
function extractImages() {
  const images = [];
  const imgElements = document.querySelectorAll('img');

  for (const img of imgElements) {
    if (!isVisible(img)) continue;

    // Filter tiny decorative icons and tracking pixels
    const rect = img.getBoundingClientRect();
    if (rect.width < 32 || rect.height < 32) continue;

    const alt = normalizeText(img.getAttribute('alt') || '', 120);
    const title = normalizeText(img.getAttribute('title') || '', 120);

    // Skip images with zero descriptive text
    if (!alt && !title) continue;

    // Register clickable images (inside links or with pointer cursor)
    const isClickable = Boolean(img.closest('a') || window.getComputedStyle(img).cursor === 'pointer');
    const id = isClickable ? registerElement(img) : undefined;

    images.push({
      ...(id && { id }),
      alt,
      title: title || undefined
    });

    if (images.length >= LIMITS.MAX_IMAGES) break;
  }

  return images;
}

// ============================================================================
// 3. INTERACTIVE CONTROLS EXTRACTION
// ============================================================================

/**
 * Extracts interactive input fields (text, textarea, select, checkbox, radio).
 * Sensitive password values are strictly excluded.
 * @returns {Array<Object>}
 */
function extractInputs() {
  const inputs = [];
  const inputElements = document.querySelectorAll('input, textarea, select');

  for (const el of inputElements) {
    const rawType = (el.getAttribute('type') || el.tagName.toLowerCase()).toLowerCase();
    // Ignore non-input hidden types, submit buttons (captured in extractButtons)
    if (rawType === 'hidden' || rawType === 'submit' || rawType === 'button') continue;
    if (!isVisible(el)) continue;

    const id = registerElement(el);
    const label = getAssociatedLabel(el);
    const placeholder = normalizeText(el.getAttribute('placeholder') || '', 80);
    const name = el.getAttribute('name') || '';

    // Handle values appropriately by field type
    let value = '';
    if (rawType === 'checkbox' || rawType === 'radio') {
      value = el.checked ? 'checked' : 'unchecked';
    } else if (el.tagName.toLowerCase() === 'select') {
      const selectedOption = el.options[el.selectedIndex];
      value = selectedOption ? normalizeText(selectedOption.textContent, 50) : '';
    } else if (rawType === 'password') {
      value = '[HIDDEN]'; // Never extract raw password text
    } else {
      value = normalizeText(el.value || '', 60);
    }

    inputs.push({
      id,
      tag: el.tagName.toLowerCase(),
      type: rawType,
      name,
      label,
      placeholder,
      value,
      disabled: Boolean(el.disabled),
      required: Boolean(el.required)
    });

    if (inputs.length >= LIMITS.MAX_INPUTS) break;
  }

  return inputs;
}

/**
 * Extracts interactive buttons (<button>, input[type="button|submit"], [role="button"]).
 * @returns {Array<Object>}
 */
function extractButtons() {
  const buttons = [];
  const buttonElements = document.querySelectorAll(
    'button, input[type="button"], input[type="submit"], [role="button"]'
  );

  for (const el of buttonElements) {
    if (!isVisible(el)) continue;

    const text = normalizeText(
      el.textContent || el.getAttribute('aria-label') || el.getAttribute('value') || '',
      80
    );

    // Skip empty icon-less buttons with no accessible name
    if (!text) continue;

    const id = registerElement(el);
    buttons.push({
      id,
      tag: el.tagName.toLowerCase(),
      text,
      ariaLabel: normalizeText(el.getAttribute('aria-label') || '', 80),
      disabled: Boolean(el.disabled)
    });

    if (buttons.length >= LIMITS.MAX_BUTTONS) break;
  }

  return buttons;
}

/**
 * Intelligently extracts, ranks, and deduplicates prominent visible links.
 * 
 * Rather than blindly slicing the first 40 links (which often grabs header/nav spam),
 * it scans candidate links, scores them by relevance (preferring main article links,
 * meaningful text, unique URLs, and penalizing footer/social boilerplate),
 * and returns a compact, top-ranked set along with transparency counts:
 * {
 *   links: [...],
 *   totalLinks: number,
 *   returnedLinks: number
 * }
 * 
 * @returns {{ links: Array<Object>, totalLinks: number, returnedLinks: number }}
 */
function extractLinks() {
  const allLinkElements = document.querySelectorAll('a[href]');
  let totalValidLinks = 0;

  const candidates = [];
  const seenHrefs = new Set();
  const textFrequency = new Map();

  for (const el of allLinkElements) {
    if (!isVisible(el)) continue;

    const rawHref = (el.getAttribute('href') || '').trim();
    // Discard empty, javascript:, in-page anchor hashes, and mailto/tel protocols
    if (
      !rawHref ||
      rawHref === '#' ||
      rawHref.startsWith('javascript:') ||
      rawHref.startsWith('mailto:') ||
      rawHref.startsWith('tel:')
    ) {
      continue;
    }

    const text = normalizeText(
      el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '',
      80
    );
    // Ignore completely empty links with no readable text or accessible description
    if (!text) continue;

    totalValidLinks++;

    // Fully resolved absolute URL
    const fullHref = el.href;

    // Deduplicate exact duplicate URLs (prefer earlier or better positioned link)
    if (seenHrefs.has(fullHref)) {
      continue;
    }
    seenHrefs.add(fullHref);

    // Track text frequency (e.g. repeated "Edit", "Reply", "View" links)
    const normalizedTextKey = text.toLowerCase();
    const count = (textFrequency.get(normalizedTextKey) || 0) + 1;
    textFrequency.set(normalizedTextKey, count);
    if (count > 3) {
      // Deprioritize repeated UI links that appear many times
      continue;
    }

    // --- RELEVANCE SCORING ---
    let score = 10; // Baseline score for any visible, non-empty link

    // 1. Content priority: Links inside <main>, <article>, or [role="main"]
    const insideMain = Boolean(el.closest('main, article, [role="main"]'));
    if (insideMain) score += 25;

    // 2. Navigation bar priority: Links inside <nav> or <header> are useful for site navigation
    const insideNav = Boolean(el.closest('nav, header, [role="navigation"]'));
    if (insideNav) score += 10;

    // 3. Footer deprioritization: Legal disclaimers, privacy policy, copyright in footer
    const insideFooter = Boolean(el.closest('footer, [role="contentinfo"]'));
    if (insideFooter) score -= 20;

    // 4. Sidebar / aside slight deprioritization
    const insideAside = Boolean(el.closest('aside, [role="complementary"]'));
    if (insideAside) score -= 5;

    // 5. Social sharing boilerplate detection
    const isSocialShare = /(facebook\.com\/sharer|twitter\.com\/intent|x\.com\/intent|linkedin\.com\/share|instagram\.com|pinterest\.com\/pin)/i.test(fullHref);
    if (isSocialShare) score -= 30;

    // 6. Text quality scoring
    if (text.length >= 4 && text.length <= 50) {
      score += 5; // Good descriptive link text
    }
    const isGenericText = /^(click here|read more|more|learn more|view all|here)$/i.test(text);
    if (isGenericText) score -= 10;

    candidates.push({
      el,
      text,
      href: fullHref,
      ariaLabel: normalizeText(el.getAttribute('aria-label') || '', 80),
      score
    });
  }

  // Sort candidate links by relevance score descending
  candidates.sort((a, b) => b.score - a.score);

  // Take the top ranked links up to LIMITS.MAX_LINKS (50)
  const topCandidates = candidates.slice(0, LIMITS.MAX_LINKS);

  const selectedLinks = topCandidates.map((candidate) => ({
    id: registerElement(candidate.el),
    text: candidate.text,
    href: candidate.href,
    visible: true,
    ariaLabel: candidate.ariaLabel || undefined
  }));

  return {
    links: selectedLinks,
    totalLinks: totalValidLinks,
    returnedLinks: selectedLinks.length
  };
}

/**
 * Extracts form containers and their submission attributes.
 * @returns {Array<Object>}
 */
function extractForms() {
  const forms = [];
  const formElements = document.querySelectorAll('form');

  for (const form of formElements) {
    if (!isVisible(form)) continue;

    const inputCount = form.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
    forms.push({
      id: form.id || '',
      action: form.getAttribute('action') || '',
      method: (form.getAttribute('method') || 'GET').toUpperCase(),
      inputCount
    });

    if (forms.length >= LIMITS.MAX_FORMS) break;
  }

  return forms;
}

// ============================================================================
// PRIMARY EXPORT: OBSERVE PAGE ELEMENTS
// ============================================================================

/**
 * Primary export: Generates a complete, structured, and compact snapshot
 * of the active webpage for the Voice Browser Agent.
 * 
 * Separates observations into:
 * - page: Metadata
 * - content: Readable document body (headings, paragraphs, lists, tables, images)
 * - interactive: Actionable controls (inputs, buttons, links, forms)
 * - summary: Element counts for high-level reasoning
 * 
 * @returns {Object} Complete structured page snapshot
 */
export function observePageElements() {
  // Clear registry on each new scan to avoid stale references from prior page states
  elementRegistry.clear();
  nextElementId = 1;

  // 1. Page Metadata
  const page = extractPageMetadata();

  // 2. Readable Content
  const contentRoot = getContentRoot();
  const headings = extractHeadings();
  const paragraphs = extractParagraphs(contentRoot);
  const lists = extractLists(contentRoot);
  const tables = extractTables();
  const images = extractImages();

  // 3. Interactive Controls
  const inputs = extractInputs();
  const buttons = extractButtons();
  const linkResult = extractLinks();
  const links = linkResult.links;
  const forms = extractForms();

  // 4. Return structured snapshot conforming to agent architecture
  return {
    page,
    content: {
      headings,
      paragraphs,
      lists,
      tables,
      images
    },
    interactive: {
      inputs,
      buttons,
      links,
      forms
    },
    summary: {
      headingCount: headings.length,
      paragraphCount: paragraphs.length,
      listCount: lists.length,
      tableCount: tables.length,
      imageCount: images.length,
      inputCount: inputs.length,
      buttonCount: buttons.length,
      linkCount: linkResult.returnedLinks,
      totalLinks: linkResult.totalLinks,
      returnedLinks: linkResult.returnedLinks,
      formCount: forms.length
    },
    // Backwards-compatibility aliases for existing consumer components
    headings,
    inputs,
    buttons,
    links,
    forms,
    timestamp: Date.now()
  };
}
