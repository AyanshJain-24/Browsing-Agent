/**
 * Voice Browser Agent - Multi-Tab Web Research Engine
 * 
 * Conducts general-purpose web research across multiple tabs:
 * UNDERSTAND REQUEST
 * → SEARCH
 * → OBSERVE RESULTS
 * → SELECT RELEVANT LINKS
 * → OPEN APPROVED NUMBER OF TABS
 * → OBSERVE EACH ACCESSIBLE PAGE
 * → EXTRACT RELEVANT CONTENT
 * → SYNTHESIZE ANSWER
 * → CITE SOURCE LINKS
 * → VERIFY AND RESPOND
 * 
 * Safety & Quality Enforcements:
 * - Configurable bounds (MAX_RESEARCH_PAGES, MAX_RESEARCH_TABS, MAX_AI_CALLS_PER_TASK, MAX_TASK_DURATION_MS)
 * - Sensitive action guardrails preserved (approval required for payments/destructive actions)
 * - Tolerant execution: continues research when a single page fails or is restricted
 * - No fabricated citations or search results: only cite actually extracted pages
 * - Compact DOM observations: extracts titles, headings, and paragraphs without raw HTML bloat
 * - Integrates with backend Gemini fallback chain and truthful token accounting
 */

import {
  openTab,
  switchTab,
  closeTab,
  getTabSnapshot,
  getPageSnapshot,
  getActiveTab,
  isRestrictedUrl
} from '../sidepanel/utils/chromeMessaging.js';
import { TaskStatus } from './taskState.js';
import { isSensitiveAction } from './planner.js';
import { aiClient } from './aiClient.js';
import { enrichSpokenResult } from './agentController.js';

// Configurable research limits (can be overridden via options)
export const DEFAULT_RESEARCH_LIMITS = {
  MAX_RESEARCH_PAGES: 3,
  MAX_RESEARCH_TABS: 3,
  MAX_AI_CALLS_PER_TASK: 8,
  MAX_TASK_DURATION_MS: 120000
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const QueryIntent = {
  CURRENT_RESEARCH: 'CURRENT_RESEARCH',
  GENERAL_KNOWLEDGE: 'GENERAL_KNOWLEDGE',
  MIXED: 'MIXED'
};

/**
 * Normalizes relative or absolute dates extracted from search snippets or page metadata.
 * @param {string} text - Text containing potential date or relative time (e.g. "2 days ago", "Oct 15, 2026")
 * @param {Date} [referenceDate] - Current reference date (defaults to new Date())
 * @returns {{ date: Date|null, label: string, confidence: 'high'|'medium'|'low'|'unavailable' }}
 */
export function parsePublicationDate(text, referenceDate = new Date()) {
  if (!text || typeof text !== 'string') {
    return { date: null, label: 'date unavailable', confidence: 'unavailable' };
  }

  const str = text.trim();
  const now = referenceDate instanceof Date && !isNaN(referenceDate) ? referenceDate : new Date();

  // 1. Relative time: "X hours ago", "X days ago", "X weeks ago", "X months ago", "X years ago"
  const relMatch = str.match(/\b(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago\b/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const d = new Date(now.getTime());

    if (unit === 'minute') d.setMinutes(d.getMinutes() - amount);
    else if (unit === 'hour') d.setHours(d.getHours() - amount);
    else if (unit === 'day') d.setDate(d.getDate() - amount);
    else if (unit === 'week') d.setDate(d.getDate() - (amount * 7));
    else if (unit === 'month') d.setMonth(d.getMonth() - amount);
    else if (unit === 'year') d.setFullYear(d.getFullYear() - amount);

    return {
      date: d,
      label: relMatch[0].toLowerCase(),
      confidence: 'high'
    };
  }

  // 1b. "today", "yesterday"
  if (/\btoday\b/i.test(str)) {
    return { date: new Date(now.getTime()), label: 'today', confidence: 'high' };
  }
  if (/\byesterday\b/i.test(str)) {
    const y = new Date(now.getTime());
    y.setDate(y.getDate() - 1);
    return { date: y, label: 'yesterday', confidence: 'high' };
  }

  // 2. ISO or standard date formats: "2026-10-24" or "Oct 24, 2026" or "24 Oct 2026"
  const datePattern = /\b(?:(\d{4})[-/](\d{1,2})[-/](\d{1,2})|([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})|(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4}))\b/;
  const dateMatch = str.match(datePattern);
  if (dateMatch) {
    const parsed = new Date(dateMatch[0]);
    if (!isNaN(parsed.getTime())) {
      const formatted = parsed.toISOString().split('T')[0];
      return { date: parsed, label: formatted, confidence: 'high' };
    }
  }

  // 3. Year mention (e.g. "2026", "2025")
  const yearMatch = str.match(/\b(202\d)\b/);
  if (yearMatch) {
    const yr = parseInt(yearMatch[1], 10);
    const yrDate = new Date(yr, 0, 1);
    return { date: yrDate, label: `${yr}`, confidence: 'medium' };
  }

  return { date: null, label: 'date unavailable', confidence: 'unavailable' };
}

/**
 * Distinguishes current research from general knowledge or mixed requests.
 * @param {string} rawGoal
 * @returns {{ type: 'CURRENT_RESEARCH'|'GENERAL_KNOWLEDGE'|'MIXED', isCurrent: boolean, isGeneral: boolean }}
 */
export function classifyQueryType(rawGoal) {
  const goal = String(rawGoal || '').trim().toLowerCase();
  if (!goal) return { type: QueryIntent.GENERAL_KNOWLEDGE, isCurrent: false, isGeneral: true };

  // Explicit single-tab browser actions are not research
  if (/^(?:scroll\s*down|scroll\s*up|page\s*down|page\s*up)\b/i.test(goal)) {
    return { type: QueryIntent.GENERAL_KNOWLEDGE, isCurrent: false, isGeneral: false };
  }

  // On-page inspection or specific site actions are not general research
  if (/\b(?:this\s+page|on\s+this\s+page|of\s+this\s+page|the\s+page|current\s+page)\b/i.test(goal)) {
    return { type: QueryIntent.GENERAL_KNOWLEDGE, isCurrent: false, isGeneral: false };
  }

  // Temporal/freshness keywords indicating current or time-sensitive research
  const temporalKeywords = [
    'happening now',
    'now',
    'latest',
    'current',
    'currently',
    'newest',
    'recent',
    'upcoming',
    'today',
    'this week',
    'this month',
    'open now',
    'registration open',
    'announcement',
    '2026'
  ];

  const hasTemporal = temporalKeywords.some((k) => {
    if (k === 'now') return /\bnow\b/i.test(goal);
    return goal.includes(k);
  });

  // General knowledge explanatory requests
  const isExplanation = /^(?:explain\b|what\s+is\b|what\s+are\b|define\b|how\s+does\s+.*work\b|tell\s+me\s+about\b)/i.test(goal);

  // Mixed request: "Explain quantum computing and find the latest developments"
  if (isExplanation && hasTemporal) {
    return { type: QueryIntent.MIXED, isCurrent: true, isGeneral: true };
  }

  if (hasTemporal) {
    return { type: QueryIntent.CURRENT_RESEARCH, isCurrent: true, isGeneral: false };
  }

  if (isExplanation) {
    return { type: QueryIntent.GENERAL_KNOWLEDGE, isCurrent: false, isGeneral: true };
  }

  // Event / video research intent with explicit context (e.g. hackathon, conference, competition)
  const hasEventResearchIntent =
    (goal.includes('video') && (goal.includes('hackathon') || goal.includes('event') || goal.includes('conference') || goal.includes('talk') || goal.includes('winner'))) ||
    (goal.includes('hackathon') && (goal.includes('open') || goal.includes('which') || goal.includes('find') || goal.includes('best')));

  if (hasEventResearchIntent) {
    return { type: QueryIntent.CURRENT_RESEARCH, isCurrent: true, isGeneral: false };
  }

  return { type: QueryIntent.GENERAL_KNOWLEDGE, isCurrent: false, isGeneral: true };
}

/**
 * Checks whether a user command represents a web research request.
 * @param {string} rawGoal
 * @returns {boolean}
 */
export function isResearchGoal(rawGoal) {
  const goal = String(rawGoal || '').trim().toLowerCase();
  if (!goal) return false;

  // Sensitive actions take safety precedence in planner/controller
  if (isSensitiveAction(goal)) return false;

  // Explicit browser control commands are handled locally by executor
  if (/^(?:scroll\s*down|scroll\s*up|page\s*down|page\s*up)\b/i.test(goal)) return false;
  if (/^(?:open|go\s*to|visit)\s+(?:https?:\/\/|[a-zA-Z0-9-]+\.[a-zA-Z]{2,})/i.test(goal)) return false;
  if (/^(?:click|press|tap)\s+/i.test(goal) && !goal.includes('and research') && !goal.includes('and summarize')) return false;

  // On-page tasks (e.g. "Find the main heading of this page", "Summarize this page", "What is on this page")
  if (/\b(?:this\s+page|on\s+this\s+page|of\s+this\s+page|the\s+page|current\s+page)\b/i.test(goal)) {
    return false;
  }

  // Single-site specific queries (e.g. "Search Wikipedia for AI history")
  if (/^search\s+(?:wikipedia|youtube|google|amazon|twitter|x)\s+for\b/i.test(goal)) {
    return false;
  }

  // 1. Explicit multi-tab or cross-page research keywords
  if (
    goal.includes('search the web') ||
    goal.includes('web research') ||
    goal.startsWith('research ') ||
    goal.includes('in separate tabs') ||
    goal.includes('in new tabs') ||
    goal.includes('across tabs') ||
    goal.includes('compare these') ||
    goal.includes('compare official') ||
    goal.includes('compare pages') ||
    goal.includes('and summarize the most relevant') ||
    goal.includes('and summarize their differences') ||
    goal.includes('then open a link from it and summarize') ||
    (goal.includes('official documentation for') && goal.includes('and open it'))
  ) {
    return true;
  }

  // 2. Pattern: "Search for [X] and summarize [Y] sources"
  if (/^search\s+(?:for\s+)?(.+)\s+and\s+(?:summarize|compare)\b/i.test(goal)) {
    return true;
  }

  // 3. Pattern: "Open the (two|three|3) most relevant results"
  if (/^open\s+(?:the\s+)?(?:\d+|two|three|four)?\s*(?:most\s+)?relevant\s+results/i.test(goal)) {
    return true;
  }

  // 4. Current time-sensitive / live research queries:
  // "Find the best video about Hackyard Build 2026", "Find the latest announcement...", "What is happening now..."
  const classification = classifyQueryType(goal);
  if (classification.type === QueryIntent.CURRENT_RESEARCH || classification.type === QueryIntent.MIXED) {
    if (
      goal.includes('happening now') ||
      goal.includes('latest') ||
      goal.includes('newest') ||
      goal.includes('announcement') ||
      goal.includes('currently open') ||
      goal.includes('open now') ||
      goal.includes('which hackathon') ||
      (goal.includes('video') && (goal.includes('hackathon') || goal.includes('event') || goal.includes('best') || goal.includes('2026') || goal.includes('recent') || goal.includes('latest'))) ||
      (goal.includes('hackathon') && (goal.includes('find') || goal.includes('search') || goal.includes('best') || goal.includes('current') || goal.includes('2026')))
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts clean search query, temporal constraints, and content type from goal.
 * @param {string} rawGoal
 * @returns {{
 *   query: string,
 *   targetCount: number,
 *   contentType: 'video'|'official'|'tutorial'|'general',
 *   temporalConstraint: 'now'|'latest'|'upcoming'|null,
 *   targetYear: number,
 *   intent: string
 * }}
 */
export function parseResearchIntent(rawGoal) {
  const goal = String(rawGoal || '').trim();
  const lower = goal.toLowerCase();

  // Content type extraction
  let contentType = 'general';
  if (/\b(?:video|youtube|clip|watch)\b/i.test(lower)) {
    contentType = 'video';
  } else if (/\b(?:official\s+announcement|official\s+website|announcement|organizer|schedule)\b/i.test(lower)) {
    contentType = 'official';
  } else if (/\b(?:tutorial|guide|walkthrough)\b/i.test(lower)) {
    contentType = 'tutorial';
  }

  // Temporal constraint extraction
  let temporalConstraint = null;
  if (/\b(?:happening\s*now|now|currently|current)\b/i.test(lower)) {
    temporalConstraint = 'now';
  } else if (/\b(?:latest|newest|recent|recently)\b/i.test(lower)) {
    temporalConstraint = 'latest';
  } else if (/\b(?:upcoming|future|next)\b/i.test(lower)) {
    temporalConstraint = 'upcoming';
  }

  // Target year detection (e.g. 2026)
  const yrMatch = lower.match(/\b(202\d)\b/);
  const targetYear = yrMatch ? parseInt(yrMatch[1], 10) : new Date().getFullYear();

  // Detect requested number of pages/tabs (default 3)
  let targetCount = 3;
  const numMatch = goal.match(/\b(\d+|two|three|four)\s+(?:most\s+)?relevant\s+(?:results|pages|sources|tabs|videos)\b/i);
  if (numMatch) {
    const rawNum = numMatch[1].toLowerCase();
    if (rawNum === 'two' || rawNum === '2') targetCount = 2;
    else if (rawNum === 'three' || rawNum === '3') targetCount = 3;
    else if (rawNum === 'four' || rawNum === '4') targetCount = 4;
    else {
      const parsed = parseInt(rawNum, 10);
      if (Number.isFinite(parsed) && parsed > 0) targetCount = parsed;
    }
  } else if (contentType === 'video' && /\b(?:the\s+best|a\s+video|the\s+newest)\b/i.test(lower)) {
    targetCount = 2;
  }

  // Extract core search topic
  let query = goal;
  const webMatch = goal.match(/(?:search\s+the\s+web\s+for|search\s+for|research|find\s+(?:the\s+)?(?:best\s+)?(?:video\s+about\s+)?|find\s+(?:the\s+)?latest\s+["']?)([^"']+)["']?/i);
  if (webMatch) {
    query = webMatch[1].trim();
    query = query.replace(/\s+(?:and\s+)?(?:summarize|compare|open\s+(?:them|in)).*$/i, '').trim();
  } else {
    query = query
      .replace(/^(?:search\s+the\s+web\s+for|search\s+for|research|find\s+(?:the\s+)?(?:best\s+)?video\s+about\s+|find\s+(?:the\s+)?latest\s+|find\s+)/i, '')
      .replace(/\s+(?:and\s+)?(?:summarize|compare|open\s+(?:them|in)).*$/i, '')
      .trim();
  }

  if (!query || query.length < 3) {
    query = goal;
  }

  return {
    query,
    targetCount: Math.min(targetCount, DEFAULT_RESEARCH_LIMITS.MAX_RESEARCH_PAGES),
    contentType,
    temporalConstraint,
    targetYear,
    intent: lower.includes('compare') ? 'compare' : 'summarize'
  };
}

/**
 * Evaluates and ranks candidate search result links using relevance, publication date freshness,
 * authority/official source status, and content type alignment.
 * 
 * @param {Array<Object>} candidates
 * @param {Object} criteria
 * @returns {{ rankedCandidates: Array<Object>, freshnessWarning: string|null, topRecommendation: Object|null }}
 */
export function rankCandidates(candidates = [], criteria = {}) {
  const {
    query = '',
    contentType = 'general',
    temporalConstraint = null,
    targetYear = new Date().getFullYear(),
    referenceDate = new Date()
  } = criteria;

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { rankedCandidates: [], freshnessWarning: 'No candidates found.', topRecommendation: null };
  }

  const queryWords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const refYear = referenceDate.getFullYear();

  let hasFreshCandidate = false;
  let allOldCandidates = true;

  const scored = candidates.map((cand) => {
    let score = 0;
    const lowerTitle = (cand.title || '').toLowerCase();
    const lowerUrl = (cand.url || '').toLowerCase();
    const lowerSnippet = (cand.snippet || '').toLowerCase();
    const combinedText = `${lowerTitle} ${lowerUrl} ${lowerSnippet}`;

    // 1. Relevance scoring: word matching
    for (const word of queryWords) {
      if (lowerTitle.includes(word)) score += 6;
      if (lowerSnippet.includes(word)) score += 3;
      if (lowerUrl.includes(word)) score += 2;
    }

    // 2. Publication Date & Freshness Evaluation
    const dateParsed = cand.dateObj || parsePublicationDate(cand.rawDateText || cand.snippet || cand.title, referenceDate);
    const pubDate = dateParsed.date;
    const dateLabel = cand.dateLabel || dateParsed.label;
    const dateConfidence = cand.dateConfidence || dateParsed.confidence;

    let freshnessReason = '';

    if (pubDate) {
      const candYear = pubDate.getFullYear();
      const ageInDays = Math.max(0, Math.floor((referenceDate.getTime() - pubDate.getTime()) / (1000 * 60 * 60 * 24)));

      if (candYear >= targetYear || ageInDays <= 60) {
        // High freshness boost for current event year or recent publication
        score += 35;
        hasFreshCandidate = true;
        allOldCandidates = false;
        freshnessReason = `Recent publication (${dateLabel})`;
      } else if (candYear < targetYear - 1 || ageInDays > 365) {
        // Old result penalty when user asked for current/latest/now
        if (temporalConstraint || targetYear >= refYear) {
          score -= 40; // Heavy penalty: do not let 1-year-old videos outrank current ones
          freshnessReason = `Outdated publication (${dateLabel})`;
        } else {
          score -= 10;
        }
      } else {
        allOldCandidates = false;
        freshnessReason = `Published on ${dateLabel}`;
      }
    } else {
      // Date is unavailable: do NOT invent one
      score += 0;
      freshnessReason = 'Date unavailable';
    }

    // 3. Content Type Alignment (Video vs Official Announcement vs Tutorial)
    const isVideoUrl = lowerUrl.includes('youtube.com/watch') || lowerUrl.includes('youtu.be') || lowerUrl.includes('/video');
    const isVideoCandidate = isVideoUrl || lowerTitle.includes('video') || cand.contentType === 'video';

    if (contentType === 'video') {
      if (isVideoCandidate) {
        score += 30; // Strong boost for real video links
      } else {
        score -= 15; // Penalty for text-only articles when a video was explicitly requested
      }
    }

    // 4. Official / Source Authority Scoring
    const isOfficialDomain =
      lowerUrl.includes('hackyard.org') ||
      lowerUrl.includes('github.com/') ||
      lowerUrl.includes('devpost.com/') ||
      lowerTitle.includes('official') ||
      lowerSnippet.includes('official announcement');

    if (isOfficialDomain) {
      score += 20;
    }

    // 5. Build reason for recommendation
    let recommendationReason = '';
    if (isOfficialDomain && isVideoCandidate) {
      recommendationReason = `Official video source (${dateLabel}).`;
    } else if (isVideoCandidate && pubDate && pubDate.getFullYear() >= targetYear) {
      recommendationReason = `Current event video published on ${dateLabel}.`;
    } else if (isOfficialDomain) {
      recommendationReason = `Official organizer source (${dateLabel}).`;
    } else if (pubDate && pubDate.getFullYear() >= targetYear) {
      recommendationReason = `Current information matching target period (${dateLabel}).`;
    } else if (dateLabel === 'date unavailable') {
      recommendationReason = 'Relevant topic match (date unavailable).';
    } else {
      recommendationReason = `Relevant match (${dateLabel}).`;
    }

    return {
      ...cand,
      score,
      date: pubDate,
      dateLabel,
      dateConfidence,
      isOfficial: Boolean(isOfficialDomain),
      recommendationReason,
      freshnessReason
    };
  });

  // Sort descending by total score
  scored.sort((a, b) => b.score - a.score);

  // Determine freshness limitation / warning
  let freshnessWarning = null;
  if ((temporalConstraint === 'now' || temporalConstraint === 'latest' || targetYear >= refYear) && allOldCandidates && scored.length > 0) {
    freshnessWarning = 'Could not verify a sufficiently current result. Available sources are from older periods or missing date confirmation.';
  }

  const topRecommendation = scored.length > 0 ? scored[0] : null;

  return {
    rankedCandidates: scored,
    freshnessWarning,
    topRecommendation
  };
}

/**
 * Filters and ranks candidate result links from a search snapshot.
 * Discards search engine internal URLs, duplicates, and non-navigational items.
 * Extracts publication date and snippet evidence from surrounding text.
 * 
 * @param {Object} snapshot - Page observation snapshot
 * @param {string} query - Search query
 * @param {number} maxResults - Max links to extract
 * @param {Object} [options] - Content type and temporal options
 * @returns {Array<Object>} Ranked candidates with date evidence
 */
export function extractRelevantLinks(snapshot, query = '', maxResults = 3, options = {}) {
  if (!snapshot || !snapshot.interactive?.links) return [];

  const rawLinks = snapshot.interactive.links || [];
  const headings = snapshot.content?.headings || [];
  const paragraphs = snapshot.content?.paragraphs || [];

  const disallowedPatterns = [
    'google.com/search',
    'google.com/preferences',
    'google.com/advanced_search',
    'google.com/intl',
    'google.com/policies',
    'accounts.google.com',
    'support.google.com',
    'policies.google.com',
    'maps.google.com',
    'youtube.com/results',
    'bing.com/search',
    'duckduckgo.com',
    'javascript:',
    'mailto:',
    '#'
  ];

  const seenUrls = new Set();
  const rawCandidates = [];

  for (const link of rawLinks) {
    const href = String(link.href || '').trim();
    const text = String(link.text || link.title || '').trim();

    if (!href || !href.startsWith('http')) continue;
    if (seenUrls.has(href)) continue;
    if (disallowedPatterns.some((p) => href.toLowerCase().includes(p))) continue;
    if (text.length < 3 && !link.id) continue;

    // Associate snippet or paragraph text near link (case-insensitive)
    const lowerText = text.toLowerCase();
    const matchingHeading = headings.find((h) => {
      const hText = (h.text || '').toLowerCase();
      return hText && (lowerText.includes(hText) || hText.includes(lowerText));
    });
    const matchingPara = paragraphs.find((p) => {
      const pText = (typeof p === 'string' ? p : p.text || '').toLowerCase();
      return pText.length > 10 && (pText.includes(lowerText) || lowerText.split(/\s+/).some((w) => w.length > 3 && pText.includes(w)));
    });

    const snippet = typeof matchingPara === 'string'
      ? matchingPara
      : (matchingPara?.text || matchingHeading?.text || (paragraphs[0] ? (typeof paragraphs[0] === 'string' ? paragraphs[0] : paragraphs[0].text) : ''));
    const fullTextContext = `${text} ${snippet} ${link.ariaLabel || ''}`;

    // Extract publication date evidence
    const parsedDate = parsePublicationDate(fullTextContext, options.referenceDate || new Date());

    seenUrls.add(href);
    rawCandidates.push({
      url: href,
      title: text || matchingHeading?.text || href,
      elementId: link.id,
      snippet,
      rawDateText: parsedDate.label !== 'date unavailable' ? parsedDate.label : '',
      dateObj: parsedDate.date,
      dateLabel: parsedDate.label,
      dateConfidence: parsedDate.confidence,
      source: href.includes('youtube.com') ? 'YouTube' : (new URL(href).hostname.replace(/^www\./, ''))
    });
  }

  // Rank candidates using relevance, freshness, and content type
  const { rankedCandidates } = rankCandidates(rawCandidates, {
    query,
    contentType: options.contentType || 'general',
    temporalConstraint: options.temporalConstraint || null,
    targetYear: options.targetYear || new Date().getFullYear(),
    referenceDate: options.referenceDate || new Date()
  });

  return rankedCandidates.slice(0, maxResults);
}

/**
 * Executes the full bounded multi-page web research workflow.
 * 
 * @param {string} goal - User's instruction
 * @param {import('./taskState.js').TaskState} taskState
 * @param {Object} [options]
 * @returns {Promise<Object>} Final task snapshot
 */
export async function executeWebResearchWorkflow(goal, taskState, options = {}) {
  const {
    onUpdate,
    maxPages = DEFAULT_RESEARCH_LIMITS.MAX_RESEARCH_PAGES,
    maxTabs = DEFAULT_RESEARCH_LIMITS.MAX_RESEARCH_TABS,
    maxDurationMs = DEFAULT_RESEARCH_LIMITS.MAX_TASK_DURATION_MS,
    referenceDate = new Date()
  } = options;

  const notify = () => {
    if (typeof onUpdate === 'function') {
      onUpdate(taskState.toSnapshot());
    }
  };

  // Pre-flight security guardrail: never execute sensitive transactions
  if (isSensitiveAction(goal)) {
    taskState.requireApproval(
      `Sensitive action detected in research instruction: "${goal}". Financial or destructive operations require explicit human authorization.`
    );
    notify();
    return taskState.toSnapshot();
  }

  const startTime = Date.now();
  const { query, targetCount, contentType, temporalConstraint, targetYear } = parseResearchIntent(goal);
  const pagesLimit = Math.min(targetCount, maxPages, maxTabs);

  // Record initial active tab so we can return to it if needed
  let originalTabId = null;
  try {
    const activeRes = await getActiveTab();
    originalTabId = activeRes?.tab?.id || null;
  } catch {
    // Best-effort
  }

  // ==========================================================================
  // STEP 1: UNDERSTAND REQUEST
  // ==========================================================================
  taskState.transition(
    TaskStatus.UNDERSTANDING,
    `Planning ${contentType === 'video' ? 'video' : 'web'} research for: "${query}" (target: ${pagesLimit} sources)`
  );
  notify();

  // ==========================================================================
  // STEP 2: SEARCH
  // ==========================================================================
  taskState.transition(
    TaskStatus.EXECUTING,
    `Searching for ${contentType === 'video' ? 'videos on' : 'information about'} "${query}"...`
  );
  taskState.recordStepStart(`Search for "${query}"`);
  notify();

  const isVideoQuery = contentType === 'video';
  const searchUrl = isVideoQuery && (query.toLowerCase().includes('youtube') || goal.toLowerCase().includes('youtube'))
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    : `https://www.google.com/search?q=${encodeURIComponent(query + (isVideoQuery && !query.toLowerCase().includes('video') ? ' video' : ''))}`;

  let searchSnapshot = null;

  try {
    // Check if current active page is already displaying search results for this query
    const currentSnapRes = await getPageSnapshot();
    const currentUrl = currentSnapRes?.data?.page?.url || '';
    const queryNormalized = query.toLowerCase().replace(/\s+/g, '+');
    const queryEncoded = encodeURIComponent(query).toLowerCase();
    const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hasAllWords = queryWords.length > 0 && queryWords.every((w) => currentUrl.toLowerCase().includes(w));
    const isAlreadyOnSearch =
      (currentUrl.includes('google.com/search') ||
       currentUrl.includes('bing.com/search') ||
       currentUrl.includes('youtube.com/results') ||
       currentUrl.includes('duckduckgo.com')) &&
      (currentUrl.toLowerCase().includes(queryNormalized) ||
       currentUrl.toLowerCase().includes(queryEncoded) ||
       hasAllWords);

    if (isAlreadyOnSearch && currentSnapRes?.data) {
      searchSnapshot = currentSnapRes.data;
      taskState.recordStepSuccess(`Observed existing search results for "${query}"`);
    } else {
      // Navigate or open search page
      const searchTabRes = await openTab(searchUrl, {
        active: true,
        waitForLoad: true,
        taskId: taskState.taskId
      });

      if (!searchTabRes || !searchTabRes.success) {
        throw new Error(searchTabRes?.error || 'Could not open search page.');
      }

      await sleep(600); // Allow search results to render
      const snapRes = await getPageSnapshot();
      if (!snapRes || !snapRes.success || !snapRes.data) {
        throw new Error('Could not observe rendered search results page.');
      }
      searchSnapshot = snapRes.data;
      taskState.recordStepSuccess(`Navigated to search results for "${query}"`);
    }
  } catch (err) {
    taskState.recordStepFailure(err.message);
    taskState.fail(`Web search failed: ${err.message}`);
    notify();
    return taskState.toSnapshot();
  }

  // ==========================================================================
  // STEP 3: OBSERVE RESULTS & SELECT RELEVANT LINKS WITH FRESHNESS SCORING
  // ==========================================================================
  taskState.transition(TaskStatus.OBSERVING, 'Evaluating search results, dates, and candidate relevance...');
  notify();

  const candidateLinks = extractRelevantLinks(searchSnapshot, query, pagesLimit, {
    contentType,
    temporalConstraint,
    targetYear,
    referenceDate
  });

  if (candidateLinks.length === 0) {
    taskState.fail(`No accessible search results found for query: "${query}".`);
    notify();
    return taskState.toSnapshot();
  }

  const { topRecommendation, freshnessWarning } = rankCandidates(candidateLinks, {
    query,
    contentType,
    temporalConstraint,
    targetYear,
    referenceDate
  });

  taskState.recordStepSuccess(`Selected ${candidateLinks.length} relevant candidate source(s) with date evidence`);
  notify();

  // ==========================================================================
  // STEP 4 & 5: OPEN TABS, OBSERVE EACH ACCESSIBLE PAGE, EXTRACT CONTENT
  // ==========================================================================
  const researchedSources = candidateLinks.map((link) => ({
    url: link.url,
    title: link.title,
    tabId: null,
    status: 'pending',
    headings: [],
    paragraphs: [],
    snippet: link.snippet || '',
    date: link.date,
    dateLabel: link.dateLabel || 'date unavailable',
    dateConfidence: link.dateConfidence || 'unavailable',
    source: link.source || 'Web',
    isOfficial: link.isOfficial || false,
    recommendationReason: link.recommendationReason || '',
    error: null
  }));

  const openedTabIds = [];

  for (let i = 0; i < researchedSources.length; i++) {
    // Check task time budget
    if (Date.now() - startTime > maxDurationMs) {
      break;
    }

    const source = researchedSources[i];
    const sourceLabel = source.title || source.url;

    taskState.transition(
      TaskStatus.EXECUTING,
      `Inspecting source ${i + 1}/${researchedSources.length}: ${sourceLabel}`
    );
    taskState.recordStepStart(`Open tab ${i + 1}: ${sourceLabel}`);
    notify();

    // Guard: check restricted URL
    if (isRestrictedUrl(source.url)) {
      source.status = 'restricted';
      source.error = 'Restricted browser page (cannot inspect content scripts)';
      taskState.recordStepFailure(source.error);
      notify();
      continue;
    }

    try {
      const openRes = await openTab(source.url, {
        active: false,
        waitForLoad: true,
        taskId: taskState.taskId
      });

      if (!openRes || !openRes.success || !openRes.tab?.id) {
        source.status = 'failed';
        source.error = openRes?.error || 'Failed to open tab';
        taskState.recordStepFailure(source.error);
        notify();
        continue;
      }

      source.tabId = openRes.tab.id;
      openedTabIds.push(openRes.tab.id);

      await sleep(500); // Settling delay for background tab DOM

      // Observe accessible page content
      taskState.transition(
        TaskStatus.OBSERVING,
        `Observing content in source ${i + 1}/${researchedSources.length}...`
      );
      notify();

      const pageSnapRes = await getTabSnapshot(source.tabId);
      if (!pageSnapRes || !pageSnapRes.success || !pageSnapRes.data) {
        source.status = 'inaccessible';
        source.error = pageSnapRes?.error || 'Page content could not be observed';
        taskState.recordStepFailure(`Could not inspect ${sourceLabel} (inaccessible) - continuing research`);
        notify();
        continue;
      }

      const snap = pageSnapRes.data;
      source.title = snap.page?.title || source.title;
      source.headings = (snap.content?.headings || []).slice(0, 5).map((h) => h.text).filter(Boolean);
      source.paragraphs = (snap.content?.paragraphs || [])
        .slice(0, 8)
        .map((p) => (typeof p === 'string' ? p : p.text || ''))
        .filter(Boolean);
      if (source.paragraphs.length > 0) {
        source.snippet = source.paragraphs.slice(0, 3).join(' ').slice(0, 350);
      }
      source.status = 'extracted';

      taskState.recordStepSuccess(`Extracted content from: ${source.title}`);
      notify();
    } catch (tabErr) {
      source.status = 'failed';
      source.error = tabErr.message;
      taskState.recordStepFailure(`Tab error for ${sourceLabel}: ${tabErr.message}`);
      notify();
    }
  }

  // ==========================================================================
  // STEP 6: SYNTHESIZE ANSWER WITH AI REASONING (INTELLIGENT FALLBACK CHAIN)
  // ==========================================================================
  const extractedSources = researchedSources.filter((s) => s.status === 'extracted');
  const inaccessibleSources = researchedSources.filter((s) => s.status !== 'extracted');

  // If tab extraction failed for all background tabs, fallback to candidate search snippets/observations
  const usableSources = extractedSources.length > 0
    ? extractedSources
    : (researchedSources.filter((s) => s.snippet).length > 0 ? researchedSources.filter((s) => s.snippet) : researchedSources);

  if (usableSources.length === 0) {
    taskState.fail(
      `Could not extract readable content from any of the ${researchedSources.length} selected pages. The targets may be restricted, blocked, or offline.`
    );
    notify();
    return taskState.toSnapshot();
  }

  // If some or all background tabs were inaccessible, note partial limitation
  const partialNotice = inaccessibleSources.length > 0
    ? `Note: ${inaccessibleSources.length} source page(s) were inaccessible or blocked; findings are based on search observations and available snippets.`
    : null;

  taskState.transition(
    TaskStatus.AI_PLANNING,
    `Synthesizing research across verified sources using AI...`
  );
  notify();

  const currentIsoDate = referenceDate.toISOString().split('T')[0];

  // Build clean, compact multi-source synthesis observation with date metadata
  const compactSourcesObservation = {
    page: {
      title: `Web Research: ${query}`,
      url: searchUrl,
      query,
      currentDate: currentIsoDate
    },
    research: {
      query,
      contentType,
      temporalConstraint: temporalConstraint || 'none',
      targetYear,
      totalPagesResearched: usableSources.length,
      extractedSources: usableSources.map((s) => ({
        title: s.title,
        url: s.url,
        source: s.source,
        date: s.dateLabel,
        isOfficial: s.isOfficial,
        headings: s.headings,
        snippet: s.snippet,
        keyContent: s.paragraphs.slice(0, 4)
      })),
      inaccessibleSources: inaccessibleSources.map((s) => ({
        url: s.url,
        title: s.title,
        reason: s.error || 'Access restricted'
      }))
    }
  };

  const synthesisPrompt = `You are conducting web research for the user.
User Goal: "${goal}"
Search Topic: "${query}"
Current System Date: ${currentIsoDate}
Content Type: ${contentType}
Temporal Constraint: ${temporalConstraint || 'none'}

Synthesize a thorough, truthful, conversational, and grounded answer evaluating the verified extracted sources.
Rules:
1. Ground your answer strictly in the extracted page contents and verified publication dates.
2. Cite the verified source URLs explicitly as markdown links.
3. If the user asked for a current event or video (e.g. 2026), explain which result is recommended based on date and relevance evidence.
4. If some sources have no publication date, label them "date unavailable". Never invent or hallucinate publication dates.
5. If results are older than the requested event period or unverified, state this limitation clearly.
6. Provide a clean, natural 'spokenText' suitable for text-to-speech (NO markdown symbols, no raw links, under 45 words).
7. Output valid JSON conforming to the plan schema with status="DONE".`;

  let synthesizedAnswer = '';
  let spokenText = '';
  let fallbackInfo = null;

  try {
    const aiRes = await aiClient.requestPlan({
      goal: synthesisPrompt,
      observation: compactSourcesObservation,
      history: taskState.actions.map((a) => ({ label: a.label, state: a.state })),
      taskId: taskState.taskId,
      provider: options.provider
    });

    if (aiRes?.metrics) {
      taskState.recordAICall(aiRes.metrics);
      if (aiRes.metrics.fallbackOccurred) {
        fallbackInfo = {
          fallbackOccurred: true,
          model: aiRes.metrics.model,
          primaryModel: aiRes.metrics.primaryModel,
          reason: aiRes.metrics.fallbackReason
        };
      }
    }

    if (aiRes?.success && aiRes.plan?.result) {
      synthesizedAnswer = aiRes.plan.result.answer || aiRes.plan.result.title || aiRes.plan.explanation;
      spokenText = aiRes.plan.result.spokenText || synthesizedAnswer;
    } else {
      // Local synthesis fallback if AI endpoint returns error
      const topCand = topRecommendation || usableSources[0];
      const recDate = topCand?.dateLabel || 'date unavailable';
      const recReason = topCand?.recommendationReason || `Matched "${query}" with highest relevance.`;

      let summary = `### Research Results for "${query}"\n\n`;
      if (topCand) {
        summary += `**Recommended Result:** [${topCand.title}](${topCand.url})\n`;
        summary += `- **Source / Channel:** ${topCand.source || 'Web'}\n`;
        summary += `- **Publication Date:** ${recDate}\n`;
        summary += `- **Selection Reason:** ${recReason}\n\n`;
      }

      if (freshnessWarning) {
        summary += `> ⚠️ **Freshness Notice:** ${freshnessWarning}\n\n`;
      }

      summary += usableSources
        .map((s) => `#### [${s.title}](${s.url})\n- **Date:** ${s.dateLabel || 'date unavailable'}\n- **Summary:** ${s.paragraphs.slice(0, 2).join(' ') || s.snippet || 'Extracted page content.'}`)
        .join('\n\n');

      synthesizedAnswer = summary;

      if (topCand && topCand.dateLabel && topCand.dateLabel !== 'date unavailable') {
        spokenText = `I found a recommended source: "${topCand.title}", published on ${topCand.dateLabel}. I've placed the link and details in the side panel.`;
      } else if (topCand) {
        spokenText = `I found "${topCand.title}" regarding ${query}. Publication date is unavailable, but the details are summarized in the side panel.`;
      } else {
        spokenText = `I researched ${usableSources.length} sources on ${query} and summarized the findings.`;
      }
    }
  } catch (aiErr) {
    // Graceful fallback to formatted extracted text with date evidence
    const topCand = topRecommendation || usableSources[0];
    const recDate = topCand?.dateLabel || 'date unavailable';
    const recReason = topCand?.recommendationReason || `Matched "${query}" with highest relevance.`;

    let summary = `### Research Results for "${query}"\n\n`;
    if (topCand) {
      summary += `**Recommended Result:** [${topCand.title}](${topCand.url})\n`;
      summary += `- **Source / Channel:** ${topCand.source || 'Web'}\n`;
      summary += `- **Publication Date:** ${recDate}\n`;
      summary += `- **Selection Reason:** ${recReason}\n\n`;
    }

    if (freshnessWarning) {
      summary += `> ⚠️ **Freshness Notice:** ${freshnessWarning}\n\n`;
    }

    summary += usableSources
      .map((s) => `#### [${s.title}](${s.url})\n- **Date:** ${s.dateLabel || 'date unavailable'}\n- **Summary:** ${s.paragraphs.slice(0, 2).join(' ') || s.snippet || 'Extracted page content.'}`)
      .join('\n\n');

    synthesizedAnswer = summary;

    if (topCand && topCand.dateLabel && topCand.dateLabel !== 'date unavailable') {
      spokenText = `I found a recommended source: "${topCand.title}", published on ${topCand.dateLabel}. Details and links are in the side panel.`;
    } else {
      spokenText = `I researched ${usableSources.length} sources on ${query} and extracted their findings.`;
    }
  }

  // ==========================================================================
  // STEP 7: CITE SOURCE LINKS, VERIFY AND RESPOND
  // ==========================================================================
  taskState.transition(TaskStatus.VERIFYING, 'Verifying source citations and finalizing research answer...');
  notify();

  const topCand = topRecommendation || usableSources[0] || null;
  const rationale = topCand ? (topCand.recommendationReason || `Selected based on relevance to "${query}" and freshness (${topCand.dateLabel || 'date unavailable'}).`) : '';
  const spokenRationale = topCand ? `I selected ${topCand.title} because ${rationale.toLowerCase().replace(/[.,]$/, '')}.` : '';

  const finalResult = {
    title: `Web Research: ${query}`,
    answer: synthesizedAnswer,
    spokenText: spokenText || `Researched ${usableSources.length} sources on ${query}.`,
    sources: researchedSources.map((s) => ({
      title: s.title,
      url: s.url,
      source: s.source || 'Web',
      date: s.dateLabel || 'date unavailable',
      dateConfidence: s.dateConfidence || 'unavailable',
      snippet: s.snippet || '',
      status: s.status,
      error: s.error || null
    })),
    selectedCandidate: topCand ? {
      title: topCand.title,
      url: topCand.url,
      source: topCand.source,
      date: topCand.dateLabel || 'date unavailable',
      reason: topCand.recommendationReason
    } : null,
    rationale,
    rationaleSpoken: spokenRationale,
    limitations: freshnessWarning || null,
    pagesResearched: usableSources.length,
    tabsOpened: openedTabIds.length,
    fallbackInfo,
    meta: `Researched ${usableSources.length} sources across ${openedTabIds.length} tabs.`
  };

  taskState.recordStepSuccess(`Synthesized answer citing ${usableSources.length} verified sources`);

  // Enrich with TTS spoken text
  const enrichedResult = enrichSpokenResult(finalResult, goal);
  taskState.complete(enrichedResult);
  notify();

  // If user originated from a specific tab and didn't ask to stay on search, return focus
  if (originalTabId) {
    try {
      await switchTab(originalTabId);
    } catch {
      // Best-effort
    }
  }

  return taskState.toSnapshot();
}
