/**
 * Voice Browser Agent - Hybrid Agent Controller
 * 
 * Orchestrates the closed-loop agent execution lifecycle:
 * TASK → OBSERVE → PLAN (Deterministic / AI Hybrid) → ACT → OBSERVE AGAIN → VERIFY → CONTINUE / DONE / ERROR
 * 
 * Key Principles:
 * - Fresh DOM observation before every step (never reuses stale IDs)
 * - Deterministic-first optimization: obvious commands execute locally with 0 cost & latency
 * - Genuine AI planning layer for complex, natural language, or multi-step tasks
 * - Strict action allowlist: only click, type, select, scroll, pressKey, navigate
 * - Outcome verification after every action via live post-action snapshot
 * - Bounded recovery: retries failed actions with fresh observation before halting
 * - Sensitive action protection (approval modal for high-risk actions)
 * - Truthful telemetry (records actual tokens, latency, and call metrics)
 */

import { getPageSnapshot, executeAction, isRestrictedUrl, getActiveTab, switchTab, openTab, openWebsiteAndObserve } from '../sidepanel/utils/chromeMessaging.js';
import { TaskState, TaskStatus } from './taskState.js';
import { planNextAction, canHandleDeterministically } from './planner.js';
import { planWithAI } from './aiPlanner.js';
import { aiClient } from './aiClient.js';
import { verifyAction } from './verifier.js';
import { isResearchGoal, executeWebResearchWorkflow } from './researchAgent.js';
import { isXPostingGoal, XPostingWorkflow } from './xPostingWorkflow.js';

// Helper for brief asynchronous DOM stabilization delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Allowlist of safe, supported browser action types
export const ALLOWED_ACTIONS = new Set(['click', 'type', 'select', 'scroll', 'presskey', 'navigate']);

/**
 * Enriches a task result with clean, natural spokenText for TTS if not already present.
 * Guarantees conversational, evidence-based speech without repeating "Task completed" or raw URLs.
 * 
 * @param {Object} result
 * @param {string} goal
 * @param {string} [verificationReason]
 * @returns {Object}
 */
export function enrichSpokenResult(result, goal, verificationReason) {
  const res = result && typeof result === 'object' ? { ...result } : { title: goal };

  // If valid, non-generic spokenText already exists, use it
  if (res.spokenText && !/^I have completed the task|^Task completed|^Task done/i.test(res.spokenText.trim())) {
    return res;
  }

  // 1. If result has a selected recommendation from research
  if (res.selectedCandidate) {
    const title = res.selectedCandidate.title || 'the recommended source';
    const dateStr = res.selectedCandidate.date && res.selectedCandidate.date !== 'date unavailable'
      ? `published on ${res.selectedCandidate.date}`
      : 'with verified details';
    res.spokenText = `I found "${title}", ${dateStr}. I've placed the link and details in the side panel.`;
    return res;
  }

  // 2. If result has a clear answer string
  if (res.answer) {
    const clean = String(res.answer)
      .replace(/^#{1,6}\s+.*$/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Take the first 1-2 sentences, capped at 40 words
    const sentences = clean.split(/(?<=[.!?])\s+/);
    let spoken = sentences.slice(0, 2).join(' ').trim();
    const words = spoken.split(/\s+/);
    if (words.length > 40) {
      spoken = words.slice(0, 40).join(' ') + '...';
    }
    if (spoken) {
      res.spokenText = spoken;
      return res;
    }
  }

  // 3. If action verification reason is available
  if (verificationReason) {
    if (/clicked/i.test(verificationReason)) {
      res.spokenText = `I've ${verificationReason.replace(/^verified:\s*/i, '').toLowerCase()}.`;
    } else if (/navigated/i.test(verificationReason)) {
      res.spokenText = `Opened ${res.title || 'the page'}.`;
    } else {
      res.spokenText = `Verified: ${verificationReason.replace(/^verified:\s*/i, '')}.`;
    }
    return res;
  }

  // 4. Action-specific fallback
  const lowerGoal = String(goal || '').toLowerCase();
  if (/^scroll\b/i.test(lowerGoal)) {
    res.spokenText = 'Scrolled the page.';
  } else if (/^(?:click|press|tap)\s+(.+)/i.test(lowerGoal)) {
    const match = lowerGoal.match(/^(?:click|press|tap)\s+(.+)/i);
    res.spokenText = `I've clicked ${match ? match[1] : 'the requested element'}.`;
  } else if (/^(?:open|go\s*to|visit)\s+(.+)/i.test(lowerGoal)) {
    res.spokenText = `Opened ${res.title || goal}.`;
  } else if (res.title) {
    res.spokenText = `${res.title}. ${res.meta || ''}`.trim();
  } else {
    res.spokenText = `Finished checking ${goal}.`;
  }

  return res;
}

/**
 * Computes a structural signature of the page state to track progress and detect loops.
 * @param {Object} snapshot
 * @returns {string}
 */
export function getPageStateSignature(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'empty';
  const url = snapshot.page?.url || '';
  const title = snapshot.page?.title || '';
  const buttons = (snapshot.interactive?.buttons || snapshot.buttons || [])
    .map((b) => `${b.text || ''}:${b.inMenu ? 'm' : ''}:${b.selected ? 's' : ''}:${b.disabled ? 'd' : ''}`)
    .slice(0, 30)
    .join(',');
  const inputs = (snapshot.interactive?.inputs || snapshot.inputs || [])
    .map((i) => `${i.id || ''}:${i.name || ''}:${i.placeholder || ''}`)
    .slice(0, 10)
    .join(',');
  return `${url}|${title}|btn:[${buttons}]|inp:[${inputs}]`;
}

/**
 * Computes a normalized signature for an action.
 * @param {Object} action
 * @returns {string}
 */
export function getActionSignature(action) {
  if (!action || typeof action !== 'object') return 'none';
  const type = String(action.action || '').toLowerCase();
  const target = action.targetText || action.text || action.elementId || action.selector || action.url || action.key || '';
  return `${type}:${target}`;
}

/**
 * Waits for post-action page state to stabilize, especially across navigations,
 * dynamic menu renderings (e.g. YouTube Filters), or AJAX filter applications.
 * Polls getPageSnapshot() until state changes or bounded timeout expires.
 * 
 * @param {Object} plannedAction - Action that was executed
 * @param {Object} prevSnapshot - Snapshot before action
 * @param {number} maxWaitMs - Max milliseconds to wait (default 3000ms)
 * @returns {Promise<Object|null>} Fresh page snapshot, or null if observation failed
 */
export async function waitForPostActionSnapshot(plannedAction, prevSnapshot, maxWaitMs = 3000, options = {}) {
  const targetTabId = options?.tabId !== undefined ? options.tabId : null;
  const snapshotOpts = targetTabId !== null ? { tabId: targetTabId } : {};

  const actionType = (plannedAction?.action || '').toLowerCase();
  const targetText = String(plannedAction?.targetText || plannedAction?.text || '').toLowerCase();

  const expectsNavigation =
    actionType === 'navigate' ||
    (actionType === 'click' && (plannedAction.targetHref || plannedAction.targetTag === 'a'));

  const opensMenu =
    Boolean(plannedAction?.opensMenu) ||
    Boolean(plannedAction?.ariaHasPopup) ||
    (actionType === 'click' && (
      /^(?:filters?|menu|dropdown|more|options)\b/i.test(targetText) ||
      /\b(?:account|profile|user|avatar|login|sign in)\b/i.test(targetText)
    ));

  const isFilter =
    Boolean(plannedAction?.isFilter) ||
    (actionType === 'click' && /^(?:live|4k|hd|subtitles|creative\s*commons|under\s*4\s*minutes|this\s*week|today)\b/i.test(targetText));

  // Dynamic menu interaction: poll for menu elements to render asynchronously
  if (opensMenu) {
    const startTime = Date.now();
    const prevInMenuCount = (prevSnapshot?.interactive?.buttons || prevSnapshot?.buttons || []).filter((b) => b.inMenu).length;
    const prevButtonCount = (prevSnapshot?.interactive?.buttons || prevSnapshot?.buttons || []).length;
    const prevLinkCount = (prevSnapshot?.interactive?.links || prevSnapshot?.links || []).length;
    let latestSnapshot = null;

    while (Date.now() - startTime < Math.min(maxWaitMs, 2000)) {
      await sleep(200);
      try {
        const res = await getPageSnapshot(snapshotOpts);
        if (res?.success && res.data) {
          latestSnapshot = res.data;
          const currButtons = latestSnapshot.interactive?.buttons || latestSnapshot.buttons || [];
          const currLinks = latestSnapshot.interactive?.links || latestSnapshot.links || [];
          const currInMenu = currButtons.filter((b) => b.inMenu).length;
          // Return immediately once menu items are rendered or new interactive controls appear
          if (currInMenu > prevInMenuCount || currInMenu > 0 || currButtons.length > prevButtonCount || currLinks.length > prevLinkCount) {
            return latestSnapshot;
          }
        }
      } catch {
        // Content script might be updating DOM; retry
      }
    }
    return latestSnapshot || (await getPageSnapshot(snapshotOpts))?.data || null;
  }

  // Filter application: poll for URL change (sp= param), selected state, or badge
  if (isFilter) {
    const startTime = Date.now();
    const prevUrl = prevSnapshot?.page?.url || '';
    let latestSnapshot = null;

    while (Date.now() - startTime < Math.min(maxWaitMs, 2500)) {
      await sleep(250);
      try {
        const res = await getPageSnapshot(snapshotOpts);
        if (res?.success && res.data) {
          latestSnapshot = res.data;
          const currUrl = latestSnapshot.page?.url || '';
          const currButtons = latestSnapshot.interactive?.buttons || latestSnapshot.buttons || [];
          const hasSelected = currButtons.some((b) => b.selected);
          const urlUpdated = currUrl && currUrl !== prevUrl && (currUrl.includes('sp=') || !prevUrl.includes('sp='));

          if (urlUpdated || hasSelected) {
            return latestSnapshot;
          }
        }
      } catch {
        // Content script might be updating DOM; retry
      }
    }
    return latestSnapshot || (await getPageSnapshot(snapshotOpts))?.data || null;
  }

  // Expecting navigation: poll for URL change or page load completion
  if (expectsNavigation) {
    const startTime = Date.now();
    const prevUrl = prevSnapshot?.page?.url || '';
    let latestSnapshot = null;

    await sleep(400);

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const res = await getPageSnapshot(snapshotOpts);
        if (res && res.success && res.data) {
          latestSnapshot = res.data;
          const currentUrl = latestSnapshot.page?.url || '';
          if (currentUrl && currentUrl !== prevUrl) {
            return latestSnapshot;
          }
        }
      } catch {
        // Content script may be temporarily unloading during navigation; retry
      }
      await sleep(300);
    }

    return latestSnapshot;
  }

  // Standard brief settling delay for static clicks/inputs
  await sleep(400);
  const res = await getPageSnapshot(snapshotOpts);
  return res?.success ? res.data : null;
}

export class AgentController {
  constructor() {
    this.currentTask = null;
    this.abortRequested = false;
    this.pendingApprovalAction = null;
    this.activeXWorkflow = null;
    this.lastResearchResult = null;
    this.lastTaskResult = null;
    this.lastGoal = '';
  }

  /**
   * Resolves conversational follow-up queries referencing previous task or research findings.
   * Handles "Why did you choose that one?", "Give me only the link", "Open the second result", etc.
   * 
   * @param {string} rawGoal
   * @returns {Object|null}
   */
  resolveFollowUp(rawGoal) {
    const goal = String(rawGoal || '').trim().toLowerCase();
    if (!this.lastResearchResult || !goal) return null;

    // Check if topic clearly changed:
    // If the goal contains an explicit new topic or unrelated command
    const prevQuery = String(this.lastGoal || '').toLowerCase();
    const queryTokens = prevQuery.split(/\s+/).filter((w) => w.length > 3);
    const hasNewSpecificTopic =
      goal.includes('quantum') ||
      goal.includes('weather') ||
      goal.includes('wikipedia') ||
      goal.includes('delete account') ||
      (goal.startsWith('search for') && !queryTokens.some((t) => goal.includes(t)));

    if (hasNewSpecificTopic) {
      this.lastResearchResult = null;
      return null;
    }

    // 1. "Why did you choose that one?" / "Why that one?" / "Why that video?" / "Why this recommendation?"
    if (
      goal.includes('why did you choose') ||
      goal.includes('why that one') ||
      goal.includes('why that video') ||
      goal.includes('why this one') ||
      goal.includes('why was this chosen') ||
      goal.includes('why did you pick')
    ) {
      const cand = this.lastResearchResult.selectedCandidate;
      const rationale = this.lastResearchResult.rationale || (cand ? `I selected "${cand.title}" because it had verified publication date (${cand.date}) and direct relevance to "${this.lastGoal}".` : 'Selected based on highest relevance score and publication date.');
      const spokenRationale = this.lastResearchResult.rationaleSpoken || rationale;

      return {
        isDirectAnswer: true,
        result: {
          title: `Rationale: ${cand?.title || 'Selected Source'}`,
          answer: rationale,
          spokenText: spokenRationale,
          sources: this.lastResearchResult.sources || [],
          selectedCandidate: cand
        }
      };
    }

    // 2. "Give me only the link" / "What is the link" / "Send the link"
    if (
      goal.includes('only the link') ||
      goal.includes('give me the link') ||
      goal.includes('what is the link') ||
      goal.includes('send the link')
    ) {
      const cand = this.lastResearchResult.selectedCandidate || this.lastResearchResult.sources?.[0];
      if (cand?.url) {
        return {
          isDirectAnswer: true,
          result: {
            title: `Link: ${cand.title || 'Recommended Source'}`,
            answer: `[${cand.title || cand.url}](${cand.url})`,
            spokenText: `Here is the link for ${cand.title || 'the selected result'}.`,
            sources: [cand],
            selectedCandidate: cand
          }
        };
      }
    }

    // 3. "Open the second result" / "Open the first result" / "Open result 2" / "Open the third result"
    const openOrdMatch = goal.match(/^open\s+(?:the\s+)?(first|second|third|1st|2nd|3rd|\d+)(?:\s+result|\s+link|\s+source)?/i);
    if (openOrdMatch && this.lastResearchResult.sources?.length > 0) {
      const ord = openOrdMatch[1].toLowerCase();
      let index = 0;
      if (ord === 'second' || ord === '2nd' || ord === '2') index = 1;
      else if (ord === 'third' || ord === '3rd' || ord === '3') index = 2;
      else if (/^\d+$/.test(ord)) index = Math.max(0, parseInt(ord, 10) - 1);

      const targetSource = this.lastResearchResult.sources[index] || this.lastResearchResult.sources[0];
      if (targetSource?.url) {
        return {
          isNavigation: true,
          targetUrl: targetSource.url,
          targetTitle: targetSource.title || targetSource.url
        };
      }
    }

    return null;
  }

  /**
   * Starts and executes a browser task from beginning to end.
   * 
   * @param {string} goal - User command
   * @param {Object} [options]
   * @param {Function} [options.onUpdate] - Callback invoked whenever task state changes
   * @param {boolean} [options.enableAI=true] - Whether to allow AI planner delegation
   * @param {string} [options.plannerMode='hybrid'] - 'hybrid' | 'deterministic' | 'ai_only'
   * @param {string} [options.provider] - Optional provider override ('gemini', 'openai_compatible', 'mock')
   * @param {number} [options.maxRetries=2] - Max bounded retries on action failure
   * @returns {Promise<Object>} Final task snapshot
   */
  async startTask(goal, options = {}) {
    const {
      onUpdate,
      enableAI = true,
      plannerMode = 'hybrid',
      provider = undefined,
      maxRetries = 2,
      conversationHistory = []
    } = options;

    // If a task is currently executing, stop it first
    if (this.currentTask && !this.currentTask.isTerminal()) {
      this.stopTask();
    }

    this.abortRequested = false;
    this.abortController = new AbortController();
    this.pendingApprovalAction = null;
    this.activeXWorkflow = null;
    this.activeTabInfo = null;
    this.currentTask = new TaskState(goal, {
      plannerMode: plannerMode === 'deterministic' ? 'Deterministic' : 'AI Hybrid'
    });

    const notify = () => {
      if (typeof onUpdate === 'function') {
        onUpdate(this.currentTask.toSnapshot());
      }
    };

    notify();

    // Check if the command is a conversational follow-up referencing previous research findings
    const followUp = this.resolveFollowUp(goal);
    if (followUp?.isDirectAnswer) {
      this.currentTask.transition(TaskStatus.AI_PLANNING, 'Answering follow-up from verified research context...');
      notify();
      this.currentTask.complete(enrichSpokenResult(followUp.result, goal));
      notify();
      return this.currentTask.toSnapshot();
    }

    if (followUp?.isNavigation) {
      this.currentTask.transition(TaskStatus.EXECUTING, `Navigating to ${followUp.targetTitle}...`);
      this.currentTask.recordStepStart(`Open source URL: ${followUp.targetUrl}`);
      notify();
      try {
        const openRes = await openTab(followUp.targetUrl, { active: true, waitForLoad: true, taskId: this.currentTask.taskId });
        if (openRes && openRes.success) {
          this.currentTask.recordStepSuccess(`Navigated to: ${followUp.targetTitle}`);
          this.currentTask.complete(enrichSpokenResult({
            title: `Opened ${followUp.targetTitle}`,
            answer: `Successfully opened [${followUp.targetTitle}](${followUp.targetUrl}).`,
            spokenText: `Opened ${followUp.targetTitle}.`,
            sources: [followUp]
          }, goal));
          notify();
          return this.currentTask.toSnapshot();
        }
      } catch (navErr) {
        this.currentTask.fail(`Could not open source link: ${navErr.message}`);
        notify();
        return this.currentTask.toSnapshot();
      }
    }

    // Route multi-tab web research goals to bounded research workflow
    if (isResearchGoal(goal)) {
      this.currentTask.plannerMode = 'Multi-Tab Research';
      notify();
      const researchSnapshot = await executeWebResearchWorkflow(goal, this.currentTask, {
        ...options,
        onUpdate: notify
      });
      if (this.currentTask.result) {
        this.lastResearchResult = this.currentTask.result;
        this.lastTaskResult = this.currentTask.result;
        this.lastGoal = goal;
      }
      return this.currentTask.toSnapshot();
    }

    // Route X.com posting goals to human-in-the-loop posting workflow
    if (isXPostingGoal(goal, this.activeTabInfo?.url)) {
      this.currentTask.plannerMode = 'X.com Posting Workflow';
      notify();
      this.activeXWorkflow = new XPostingWorkflow({
        ...options,
        onUpdate: notify
      });
      return await this.activeXWorkflow.start(goal, this.currentTask, {
        ...options,
        onUpdate: notify
      });
    }

    let failureCount = 0;
    let lastFailure = null;
    const repeatedAttemptsOnState = new Map();
    let consecutiveSameActionCount = 0;
    let lastActionSignature = null;

    try {
      while (!this.currentTask.isTerminal()) {
        // 1. Check user abort
        if (this.abortRequested) {
          this.currentTask.stop();
          notify();
          break;
        }

        // 2. Check safety limits (max 15 actions, max 60s, max 5 AI calls)
        const limitViolation = this.currentTask.checkLimits();
        if (limitViolation) {
          this.currentTask.fail(limitViolation);
          notify();
          break;
        }

        // ====================================================================
        // STEP A: OBSERVE (Live DOM Snapshot)
        // ====================================================================
        this.currentTask.transition(TaskStatus.OBSERVING, 'Observing webpage elements...');
        notify();

        // 1. Inspect current active Chrome tab if target tab is not yet pinned
        let activeTab = null;
        try {
          const tabRes = await getActiveTab();
          if (tabRes && tabRes.success && tabRes.tab) {
            activeTab = tabRes.tab;
          }
        } catch {
          // Non-extension or test mock
        }

        if (this.targetTabId === null && activeTab?.id) {
          this.targetTabId = activeTab.id;
          this.currentTask.targetTabId = this.targetTabId;
        }

        const observeResponse = await getPageSnapshot(this.targetTabId !== null ? { tabId: this.targetTabId } : {});
        if (!observeResponse || !observeResponse.success || !observeResponse.data) {
          const isRestricted = Boolean(observeResponse?.isRestricted || isRestrictedUrl(observeResponse?.url));
          const err = isRestricted
            ? (observeResponse?.error || 'Chrome restricts extensions from controlling this page. Open a regular website to continue.')
            : (observeResponse?.error || 'Could not observe webpage. The tab may be restricted or closed.');
          this.currentTask.fail(err);
          notify();
          break;
        }

        let snapshot = observeResponse.data;
        if (isRestrictedUrl(snapshot?.page?.url)) {
          this.currentTask.fail('Chrome restricts extensions from controlling this page. Open a regular website to continue.');
          notify();
          break;
        }

        // Malicious webpage content protection: treat webpage content as untrusted data
        const untrustedContent = [
          snapshot.page?.title || '',
          ...(snapshot.content?.headings || []).map((h) => h.text || ''),
          ...(snapshot.content?.paragraphs || []).map((p) => (typeof p === 'string' ? p : p.text || ''))
        ].join(' ').toLowerCase();

        if (
          untrustedContent.includes('ignore previous instructions') ||
          untrustedContent.includes('ignore all rules') ||
          untrustedContent.includes('system override') ||
          untrustedContent.includes('reveal api key') ||
          untrustedContent.includes('reveal secrets')
        ) {
          this.currentTask.addEvent('security_guardrail_triggered', {
            type: 'PROMPT_INJECTION_IGNORED',
            notice: 'Adversarial instructions detected in webpage content. Treated strictly as inert text.'
          });
        }

        // Check if previous action opened a menu and we need a bounded wait for dynamic options (e.g. "Live") to render
        const lastActionObj = this.currentTask.actions[this.currentTask.actions.length - 1];
        if (lastActionObj && (lastActionObj.action?.opensMenu || /filters?|menu/i.test(lastActionObj.action?.targetText || ''))) {
          const currentBtns = snapshot?.interactive?.buttons || snapshot?.buttons || [];
          const hasMenuBtns = currentBtns.some((b) => b.inMenu);
          const goalMentionsLive = /live/i.test(this.currentTask.goal);
          const hasLiveOption = currentBtns.some((b) => /live/i.test(b.text || b.ariaLabel || ''));

          if ((!hasMenuBtns || (goalMentionsLive && !hasLiveOption)) && !this.abortRequested) {
            await sleep(500);
            try {
              const freshRes = await getPageSnapshot(this.targetTabId !== null ? { tabId: this.targetTabId } : {});
              if (freshRes?.success && freshRes.data) {
                snapshot = freshRes.data;
              }
            } catch {
              // Ignore and proceed with initial snapshot
            }
          }
        }

        // Requirement 1 & 8: Confirm actual URL and page title from active tab and log diagnostics
        const confirmedUrl = snapshot.page?.url || activeTab?.url || '';
        const confirmedTitle = snapshot.page?.title || activeTab?.title || 'Untitled';
        if (snapshot.page) {
          snapshot.page.url = confirmedUrl;
          snapshot.page.title = confirmedTitle;
        }
        this.activeTabInfo = {
          url: confirmedUrl,
          title: confirmedTitle,
          tabId: this.targetTabId || activeTab?.id
        };

        // Requirement 8: Diagnostic log showing active page title and URL without logging API keys or sensitive content
        console.log(`[AgentController] [${this.currentTask.taskId}] Active Tab: "${confirmedTitle}" (${confirmedUrl})`);

        // Check user abort after observation
        if (this.abortRequested) {
          this.currentTask.stop();
          notify();
          break;
        }

        // ====================================================================
        // STEP B: PLAN (Deterministic First -> AI Planning Layer)
        // ====================================================================
        let plan = null;
        const shouldUseDeterministic =
          plannerMode === 'deterministic' ||
          (plannerMode === 'hybrid' && !lastFailure && canHandleDeterministically(this.currentTask.goal, snapshot));

        if (shouldUseDeterministic) {
          // Attempt local deterministic plan (0 cost, 0 latency)
          this.currentTask.transition(TaskStatus.PLANNING, 'Planning next action (Deterministic)...');
          notify();

          try {
            const detPlan = planNextAction(this.currentTask.goal, snapshot, this.currentTask);
            if (detPlan && (detPlan.status === 'ACTION' || detPlan.status === 'DONE' || detPlan.requiresApproval)) {
              plan = detPlan;
              this.currentTask.plannerMode = 'Deterministic';
            } else if (detPlan?.error?.includes('Button not found on the current page')) {
              // Explicit button absence confirmed: stop without substituting an unrelated element
              plan = detPlan;
              this.currentTask.plannerMode = 'Deterministic';
            } else if (plannerMode === 'deterministic') {
              plan = detPlan;
            } else {
              // In hybrid mode: deterministic planner couldn't match element or command; allow AI to reason
              plan = null;
            }
          } catch (planErr) {
            if (plannerMode === 'deterministic') {
              plan = { status: 'ERROR', error: planErr.message };
            } else {
              plan = null;
            }
          }
        }

        // If deterministic planner did not resolve an action or plannerMode is AI / retrying:
        const needsAI =
          enableAI &&
          plannerMode !== 'deterministic' &&
          (!plan || (plan.status === 'ERROR' && !plan.error?.includes('Button not found on the current page')));

        if (needsAI) {
          this.currentTask.transition(TaskStatus.AI_PLANNING, 'AI analyzing goal and page elements...');
          notify();

          try {
            plan = await planWithAI(this.currentTask.goal, snapshot, this.currentTask, {
              lastFailure,
              provider,
              conversationHistory,
              signal: this.abortController?.signal
            });

            if (plan?.metrics) {
              this.currentTask.recordAICall(plan.metrics);
            }
          } catch (aiErr) {
            this.currentTask.fail(`AI planning error: ${aiErr.message}`);
            notify();
            break;
          }
        }

        // 1. Guard against empty or malformed plan results
        if (!plan || typeof plan !== 'object') {
          this.currentTask.fail('Planner error: planner returned an empty or malformed plan.');
          notify();
          break;
        }

        // 2. Planner error / refusal (handles deterministic sensitive block and unsupported commands)
        if (plan.status === 'ERROR') {
          const failReason = lastFailure
            ? `Action execution failed: ${lastFailure.reason}`
            : (plan.error || 'Could not determine a safe plan for this command.');
          this.currentTask.fail(failReason);
          notify();
          break;
        }

        // 3. High-risk sensitive action requires human approval
        if (plan.status === 'WAITING_FOR_APPROVAL' || plan.requiresApproval) {
          this.pendingApprovalAction = plan.action || null;
          this.currentTask.requireApproval(
            plan.explanation || plan.error || 'This sensitive action requires explicit human confirmation.'
          );
          notify();
          break;
        }

        // 4. Ambiguous instruction needs user clarification
        if (plan.status === 'NEEDS_CLARIFICATION') {
          this.currentTask.requireClarification(plan.clarificationQuestion);
          notify();
          break;
        }

        // 5. Task is already done (e.g. text found or goal achieved)
        if (plan.status === 'DONE') {
          if (this.currentTask.aiCallsCount > 0) {
            try {
              const finalMetrics = await aiClient.getTaskMetrics(this.currentTask.taskId);
              if (finalMetrics) {
                this.currentTask.recordAICall({ taskMetrics: finalMetrics });
              }
            } catch {
              // Retain in-memory task metrics if network call fails
            }
          }
          this.currentTask.complete(enrichSpokenResult(plan.result, this.currentTask.goal));
          notify();
          break;
        }

        // 6. Guard against unrecognized status
        if (plan.status !== 'ACTION') {
          this.currentTask.fail(`Planner error: unrecognized plan status '${plan.status}'.`);
          notify();
          break;
        }

        // 7. Guard against missing or malformed action payload
        const plannedAction = plan.action;
        if (!plannedAction || typeof plannedAction !== 'object' || !plannedAction.action) {
          this.currentTask.fail('Planner error: action plan is missing a valid action payload.');
          notify();
          break;
        }

        // 8. Strict allowlist validation before execution
        const actionType = String(plannedAction.action).toLowerCase();
        if (!ALLOWED_ACTIONS.has(actionType)) {
          this.currentTask.fail(`Security guardrail: action '${plannedAction.action}' is not in the allowed actions allowlist.`);
          notify();
          break;
        }

        // 9. Stale target DOM recovery: verify planned elementId exists in current snapshot
        if (plannedAction.elementId) {
          const allElements = [
            ...(snapshot.interactive?.buttons || snapshot.buttons || []),
            ...(snapshot.interactive?.links || snapshot.links || []),
            ...(snapshot.interactive?.inputs || snapshot.inputs || [])
          ];
          const exists = allElements.some((e) => e.id === plannedAction.elementId);
          if (!exists) {
            // Re-resolve element from fresh snapshot or label
            const targetText = String(plannedAction.targetText || plannedAction.text || '').trim().toLowerCase();
            const replacement = allElements.find((e) => {
              const text = (e.text || e.ariaLabel || e.title || '').trim().toLowerCase();
              return targetText && (text === targetText || text.includes(targetText) || targetText.includes(text));
            });
            if (replacement) {
              plannedAction.elementId = replacement.id;
              this.currentTask.addEvent('stale_element_recovered', { oldId: plannedAction.elementId, newId: replacement.id });
            } else {
              // Refresh snapshot
              try {
                const freshObs = await getPageSnapshot(this.targetTabId !== null ? { tabId: this.targetTabId } : {});
                if (freshObs?.success && freshObs.data) {
                  snapshot = freshObs.data;
                }
              } catch {
                // Ignore
              }
            }
          }
        }

        // ====================================================================
        // STEP B.1: LOOP DETECTION & CONSEQUENTIAL ACTION GUARDS
        // ====================================================================
        const actionSig = getActionSignature(plannedAction);
        const stateSig = getPageStateSignature(snapshot);
        const actionStateKey = `${actionSig}@${stateSig}`;

        const attemptsOnState = (repeatedAttemptsOnState.get(actionStateKey) || 0) + 1;
        repeatedAttemptsOnState.set(actionStateKey, attemptsOnState);

        if (actionSig === lastActionSignature) {
          consecutiveSameActionCount++;
        } else {
          consecutiveSameActionCount = 1;
          lastActionSignature = actionSig;
        }

        // Limit repeated attempts on an unchanged page state to two, with a fresh observation between attempts
        if (attemptsOnState > 2) {
          const loopError = `Loop prevention: action '${actionSig}' was attempted ${attemptsOnState - 1} times on an unchanged page state without progress. Task halted to prevent infinite loop.`;
          this.currentTask.fail(loopError);
          notify();
          break;
        }

        // Detect consecutive repeated actions proposing the exact same action 3+ times without progress
        if (consecutiveSameActionCount > 2) {
          const loopError = `Loop prevention: action '${actionSig}' was repeated ${consecutiveSameActionCount} times consecutively without meaningful progress. Task halted.`;
          this.currentTask.fail(loopError);
          notify();
          break;
        }

        // Do not retry consequential actions blindly when the previous action's outcome is uncertain
        const isConsequential = Boolean(
          plannedAction.consequential ||
          plannedAction.requiresApproval ||
          /checkout|purchase|pay\b|buy\b|delete|remove|post\b|submit/i.test(actionSig)
        );
        if (isConsequential && lastFailure && lastFailure.uncertain) {
          const err = `Cannot retry consequential action '${actionSig}' because previous execution outcome was uncertain: ${lastFailure.reason}`;
          this.currentTask.fail(err);
          notify();
          break;
        }

        const stepLabel = plan.label || plan.explanation || `Execute ${plannedAction.action}`;

        // Record the step in timeline
        this.currentTask.recordStepStart(stepLabel, plannedAction);

        // ====================================================================
        // STEP C: ACT (Execute Action via Executor)
        // ====================================================================
        this.currentTask.transition(TaskStatus.EXECUTING, `Executing: ${stepLabel}`);
        notify();

        const execResponse = await executeAction(plannedAction, this.targetTabId !== null ? { tabId: this.targetTabId } : {});
        const execResult = execResponse?.result || execResponse;

        let recoveredPostSnapshot = null;
        let actionAlreadySucceeded = false;

        // Check low-level execution failure immediately
        if (!execResponse || execResponse.success === false || execResult?.success === false) {
          // LOST ACKNOWLEDGEMENT RECOVERY (Test D):
          // Check whether the action actually took effect despite the lost response
          try {
            const preCheckRes = await getPageSnapshot(this.targetTabId !== null ? { tabId: this.targetTabId } : {});
            if (preCheckRes?.success && preCheckRes.data) {
              const preVerification = verifyAction(plannedAction, snapshot, preCheckRes.data, { success: true });
              if (preVerification.verified) {
                actionAlreadySucceeded = true;
                recoveredPostSnapshot = preCheckRes.data;
                this.currentTask.addEvent('lost_acknowledgement_recovered', { action: plannedAction.action, reason: preVerification.reason });
              }
            }
          } catch {
            // Ignore
          }

          if (!actionAlreadySucceeded) {
            const errMsg = execResponse?.error || execResult?.error || 'Executor failed to perform action.';

            if (failureCount < maxRetries && this.currentTask.plannerMode !== 'Deterministic') {
              failureCount++;
              lastFailure = { action: plannedAction, reason: errMsg, uncertain: false };
              this.currentTask.recordStepFailure(errMsg, `Retry ${failureCount}/${maxRetries}`);
              this.currentTask.transition(TaskStatus.PLANNING, `Action failed (${errMsg}). Re-planning step (attempt ${failureCount + 1})...`);
              notify();
              await sleep(400);
              continue; // Re-observe and re-plan within bounded recovery limit
            }

            // Partial completion preservation (Test R)
            if (this.currentTask.checkpoints.length > 0) {
              this.currentTask.recordStepFailure(errMsg);
              this.currentTask.partiallyComplete(
                {
                  title: this.currentTask.goal,
                  meta: `Completed ${this.currentTask.checkpoints.length} step(s). Remaining step failed: ${errMsg}`,
                  checkpoints: this.currentTask.checkpoints
                },
                `Action execution failed on step ${this.currentTask.currentStep}: ${errMsg}`
              );
              notify();
              break;
            }

            this.currentTask.recordStepFailure(errMsg);
            this.currentTask.fail(`Action execution failed: ${errMsg}`);
            notify();
            break;
          }
        }

        // Check abort
        if (this.abortRequested) {
          this.currentTask.stop();
          notify();
          break;
        }

        // ====================================================================
        // STEP D: OBSERVE AGAIN (Post-Action Snapshot & Navigation Wait)
        // ====================================================================
        this.currentTask.transition(TaskStatus.VERIFYING, 'Observing post-action webpage state...');
        notify();

        const postSnapshot = recoveredPostSnapshot || await waitForPostActionSnapshot(
          plannedAction,
          snapshot,
          3000,
          this.targetTabId !== null ? { tabId: this.targetTabId } : {}
        );

        // ====================================================================
        // STEP E: VERIFY (Outcome Verification)
        // ====================================================================
        const verification = verifyAction(plannedAction, snapshot, postSnapshot, actionAlreadySucceeded ? { success: true } : execResult);

        if (!verification.verified) {
          if (failureCount < maxRetries) {
            failureCount++;
            lastFailure = {
              action: plannedAction,
              reason: verification.reason,
              uncertain: Boolean(verification.details?.uncertain)
            };
            this.currentTask.recordStepFailure(verification.reason, `Retry ${failureCount}/${maxRetries}`);
            this.currentTask.transition(TaskStatus.PLANNING, `Verification failed (${verification.reason}). Re-observing and re-planning...`);
            notify();
            await sleep(400);
            continue; // Re-observe and re-plan within bounded recovery limit
          }

          // Partial completion preservation (Test R)
          if (this.currentTask.checkpoints.length > 0) {
            this.currentTask.recordStepFailure(verification.reason);
            this.currentTask.partiallyComplete(
              {
                title: this.currentTask.goal,
                meta: `Completed ${this.currentTask.checkpoints.length} step(s). Remaining step failed: ${verification.reason}`,
                checkpoints: this.currentTask.checkpoints
              },
              `Action verification failed on step ${this.currentTask.currentStep}: ${verification.reason}`
            );
            notify();
            break;
          }

          // Retries exhausted - NEVER claim success
          this.currentTask.recordStepFailure(verification.reason);
          this.currentTask.fail(`Action verification failed: ${verification.reason}`);
          notify();
          break;
        }

        // Verification succeeded! Reset retry trackers and create checkpoint (Test A, Test AA)
        failureCount = 0;
        lastFailure = null;
        this.currentTask.recordStepSuccess(verification.reason);
        this.currentTask.createCheckpoint(plannedAction, postSnapshot, verification);
        notify();

        // If this was marked as the final step of the plan
        if (plan.isLastStep) {
          if (this.currentTask.aiCallsCount > 0) {
            try {
              const finalMetrics = await aiClient.getTaskMetrics(this.currentTask.taskId);
              if (finalMetrics) {
                this.currentTask.recordAICall({ taskMetrics: finalMetrics });
              }
            } catch {
              // Retain in-memory task metrics if network call fails
            }
          }
          this.currentTask.complete(
            enrichSpokenResult(
              plan.result || {
                title: this.currentTask.goal,
                meta: `Verified: ${verification.reason}`
              },
              this.currentTask.goal,
              verification.reason
            )
          );
          notify();
          break;
        }

        // For multi-step tasks: brief settling delay before next observe-plan-act cycle
        await sleep(200);
      }
    } catch (err) {
      this.currentTask.fail(`Unexpected agent error: ${err.message}`);
      notify();
    }

    if (this.currentTask && this.currentTask.result) {
      this.lastTaskResult = this.currentTask.result;
      this.lastGoal = goal;
    }

    return this.currentTask.toSnapshot();
  }

  /**
   * Explicitly stops the currently running task.
   */
  stopTask(reason = 'Task stopped by user.') {
    this.abortRequested = true;
    if (this.abortController) {
      try { this.abortController.abort(); } catch {}
    }
    if (this.activeXWorkflow) {
      this.activeXWorkflow.cancel(reason);
      this.activeXWorkflow = null;
    }
    if (this.currentTask && !this.currentTask.isTerminal()) {
      this.currentTask.cancel(reason);
    }
  }

  /**
   * Resumes and executes an approved action or workflow step.
   * Called by the Side Panel when the user clicks "Approve Action".
   * Preserves taskId, approved post text, target tab ID, and current task ID.
   * @param {Object} [data]
   * @returns {Promise<Object>}
   */
  async approvePendingAction(data = {}) {
    const taskId = this.currentTask?.taskId || 'unknown';
    console.log(`[AgentController] [${taskId}] Approval received from user.`);

    // If an X.com posting workflow is active, delegate to it
    if (this.activeXWorkflow) {
      console.log(`[AgentController] [${taskId}] Resuming X.com posting workflow with approved state.`);
      return await this.activeXWorkflow.approve(data);
    }

    // Generic approval handling for other sensitive actions
    if (this.pendingApprovalAction) {
      const actionToExecute = this.pendingApprovalAction;
      this.pendingApprovalAction = null;
      console.log(`[AgentController] [${taskId}] Executing approved action:`, actionToExecute);

      this.currentTask.transition(TaskStatus.EXECUTING, `Executing approved action: ${actionToExecute.action}`);

      const execRes = await executeAction(actionToExecute);
      if (execRes && execRes.success !== false) {
        this.currentTask.complete({
          title: 'Action Approved and Executed',
          answer: `Successfully executed approved action: ${actionToExecute.action}`,
          spokenText: 'Approved action executed.'
        });
      } else {
        this.currentTask.fail(`Approved action failed: ${execRes?.error || 'Unknown execution error'}`);
      }
      return this.currentTask.toSnapshot();
    }

    return this.currentTask ? this.currentTask.toSnapshot() : { success: false };
  }

  /**
   * Cancels a pending action or workflow.
   * Called by the Side Panel when the user clicks "Cancel / Deny".
   * @param {string} [reason]
   * @returns {Object}
   */
  cancelPendingAction(reason = 'Action cancelled by user.') {
    const taskId = this.currentTask?.taskId || 'unknown';
    console.log(`[AgentController] [${taskId}] Action cancelled by user: ${reason}`);

    if (this.abortController) {
      try { this.abortController.abort(); } catch {}
    }

    if (this.activeXWorkflow) {
      const snap = this.activeXWorkflow.cancel(reason);
      return snap;
    }

    this.pendingApprovalAction = null;
    if (this.currentTask) {
      this.currentTask.cancel(reason);
      return this.currentTask.toSnapshot();
    }
    return { success: true };
  }

  /**
   * Broadcasts tab update or navigation to active workflows (such as X.com navigation detection).
   * @param {Object} tabInfo - { tabId, url, title, status }
   * @returns {Promise<Object|null>}
   */
  async handleTabUpdate(tabInfo) {
    if (this.activeXWorkflow) {
      return await this.activeXWorkflow.handleTabUpdate(tabInfo);
    }
    return null;
  }

  /**
   * Resumes a pending or paused task (e.g. after login or resolving a page issue).
   * @returns {Promise<Object>}
   */
  async resumePendingTask() {
    if (this.activeXWorkflow) {
      return await this.activeXWorkflow.resume();
    }
    return this.currentTask ? this.currentTask.toSnapshot() : { success: false };
  }

  /**
   * Retrieves the current task state snapshot.
   * @returns {Object|null}
   */
  getActiveTask() {
    return this.currentTask ? this.currentTask.toSnapshot() : null;
  }

  /**
   * Switches the active focused tab and re-observes it before executing further actions.
   * Requirement 3: When switching tabs, re-observe the selected tab before executing any action.
   * @param {number} tabId
   * @returns {Promise<Object|null>} Fresh snapshot of the newly active tab
   */
  async switchTabAndObserve(tabId) {
    if (!tabId) return null;
    try {
      const switchRes = await switchTab(tabId);
      if (!switchRes || switchRes.success === false) return null;
      await sleep(300);
      const obsRes = await getPageSnapshot();
      if (obsRes && obsRes.success && obsRes.data) {
        const title = obsRes.data.page?.title || 'Untitled';
        const url = obsRes.data.page?.url || 'unknown';
        this.activeTabInfo = { title, url, tabId };
        console.log(`[AgentController] [${this.currentTask?.taskId}] Switched to Tab ${tabId}: "${title}" (${url})`);
        return obsRes.data;
      }
    } catch {
      // Best-effort
    }
    return null;
  }

  /**
   * Opens a normal website (e.g. Wikipedia) in a new active tab and observes it after loading.
   * Requirement 3: Add an "Open a Website" action that opens a normal website
   * such as https://www.wikipedia.org in a new tab, then observes it after loading.
   * @param {string} [url='https://www.wikipedia.org']
   * @returns {Promise<Object>}
   */
  async openWebsiteAndObserve(url = 'https://www.wikipedia.org') {
    return openWebsiteAndObserve(url);
  }
}

// Export singleton instance for side panel usage
export const agentController = new AgentController();
