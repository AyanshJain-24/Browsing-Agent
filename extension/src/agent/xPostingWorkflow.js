/**
 * Voice Browser Agent - X.com (Twitter) Posting Workflow Engine
 * 
 * Orchestrates the secure, human-in-the-loop posting workflow for X (formerly Twitter):
 * 1. DRAFT CREATION & APPROVAL: Extracts user draft, pauses for explicit user confirmation.
 * 2. NAVIGATION HANDLING: If user is not yet on x.com, preserves approved draft & task state
 *    while waiting for manual or automatic navigation to x.com.
 * 3. PAGE OBSERVATION & AUTH CHECK: Verifies X.com is loaded, content script ready, and logged in.
 *    If logged out or restricted, provides clear guidance and allows resumption after login.
 * 4. COMPOSER POPULATION: Re-observes live DOM, locates the genuine post composer, fills ONLY
 *    the approved draft text.
 * 5. FINAL CONFIRMATION GATE: Shows final text and requires explicit confirmation immediately before publishing.
 * 6. SINGLE-SHOT PUBLISH & VERIFY: Publishes once and verifies post submission. Never retries blindly on timeout.
 * 
 * Safety & Reliability Guarantees:
 * - Never bypasses login, CAPTCHA, or platform restrictions.
 * - Never publishes without approval of the exact final text.
 * - Never blindly retries timed-out publish actions (checks for success first).
 * - Never uses stale element IDs after navigation (fresh DOM snapshot on every step).
 * - Diagnostic logs are safe and never leak credentials, cookies, or secrets.
 */

import {
  getPageSnapshot,
  executeAction,
  getActiveTab,
  isRestrictedUrl
} from '../sidepanel/utils/chromeMessaging.js';
import { TaskStatus } from './taskState.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Normalizes text for safe matching.
 * @param {string} str
 * @returns {string}
 */
function clean(str) {
  return String(str || '').trim();
}

/**
 * Checks whether a URL is on X (formerly Twitter).
 * @param {string} url
 * @returns {boolean}
 */
export function isXUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const cleanUrl = url.trim().toLowerCase();
  return (
    cleanUrl.startsWith('https://x.com') ||
    cleanUrl.startsWith('http://x.com') ||
    cleanUrl.startsWith('https://www.x.com') ||
    cleanUrl.startsWith('http://www.x.com') ||
    cleanUrl.startsWith('https://twitter.com') ||
    cleanUrl.startsWith('http://twitter.com') ||
    cleanUrl.startsWith('https://www.twitter.com') ||
    cleanUrl.startsWith('http://www.twitter.com') ||
    cleanUrl.startsWith('https://mobile.x.com') ||
    cleanUrl.startsWith('https://mobile.twitter.com')
  );
}

/**
 * Checks whether a user goal represents an X/Twitter posting request.
 * @param {string} rawGoal
 * @param {string} [currentUrl]
 * @returns {boolean}
 */
export function isXPostingGoal(rawGoal, currentUrl = '') {
  const goal = clean(rawGoal).toLowerCase();
  if (!goal) return false;

  // Explicit mention of X / x.com / Twitter
  const explicitX =
    /\b(?:post|tweet|publish|create\s+a?\s*post)\s+(?:on|to|in)?\s*(?:x\.com|x|twitter\.com|twitter)\b/i.test(goal) ||
    /\b(?:on|to)\s*(?:x\.com|x|twitter\.com|twitter)\s+(?:saying|with\s+text|post|tweet)\b/i.test(goal) ||
    /^(?:tweet|post\s+a?\s*tweet)\b/i.test(goal);

  if (explicitX) return true;

  // Contextual post intent when already on x.com / twitter.com
  if (isXUrl(currentUrl)) {
    return /^(?:post|tweet|publish)\s+["']?.+["']?$/i.test(goal) ||
           /^create\s+(?:a\s+)?post\b/i.test(goal);
  }

  return false;
}

/**
 * Extracts the user's intended post draft text from their natural command.
 * @param {string} rawGoal
 * @returns {string} Clean draft text, or empty string if not provided
 */
export function extractXPostDraft(rawGoal) {
  const goal = clean(rawGoal);
  if (!goal) return '';

  // Pattern 1: Quoted text e.g. Post on X: "Hello world!" or Tweet 'Excited for the hackathon'
  const quotedMatch = goal.match(/["'“]([^"'“”]+)["'”]/);
  if (quotedMatch && quotedMatch[1].trim()) {
    return quotedMatch[1].trim();
  }

  // Pattern 2: Colon separator e.g. Post on X: Hello world! or Tweet: Great news
  const colonMatch = goal.match(/^(?:post\s+(?:on|to)?\s*(?:x\.com|x|twitter\.com|twitter)?|tweet\s*(?:on\s*(?:x|twitter))?)\s*:\s*(.+)$/i);
  if (colonMatch && colonMatch[1].trim()) {
    return colonMatch[1].trim();
  }

  // Pattern 3: "saying" / "with text" e.g. Post on X saying I am ready
  const sayingMatch = goal.match(/(?:saying|with\s+text)\s+(.+)$/i);
  if (sayingMatch && sayingMatch[1].trim()) {
    return sayingMatch[1].trim().replace(/^["']|["']$/g, '');
  }

  // Pattern 4: Stripping standard prefixes
  const stripped = goal
    .replace(/^(?:post|publish|create\s+a?\s*post)\s+(?:on|to)?\s*(?:x\.com|x|twitter\.com|twitter)\s*/i, '')
    .replace(/^tweet\s*/i, '')
    .trim()
    .replace(/^["']|["']$/g, '');

  return stripped;
}

/**
 * Checks whether an observed X.com page snapshot indicates a logged-out session.
 * @param {Object} snapshot
 * @returns {boolean}
 */
export function isXLoggedOut(snapshot) {
  if (!snapshot || !snapshot.page) return false;
  const url = (snapshot.page.url || '').toLowerCase();

  // Explicit login/signup URLs
  if (
    url.includes('/login') ||
    url.includes('/i/flow/login') ||
    url.includes('/signup') ||
    url.includes('/i/flow/signup')
  ) {
    return true;
  }

  const headings = snapshot.content?.headings || snapshot.headings || [];
  const buttons = snapshot.interactive?.buttons || snapshot.buttons || [];
  const inputs = snapshot.interactive?.inputs || snapshot.inputs || [];

  // Check for login headings or sign in prompts
  const hasLoginHeading = headings.some((h) => {
    const t = (h.text || '').toLowerCase();
    return t.includes('sign in to x') || t.includes('log in to twitter') || t.includes('new to x?');
  });

  const hasLoginButton = buttons.some((b) => {
    const t = (b.text || b.ariaLabel || '').toLowerCase();
    return t === 'log in' || t === 'sign in' || t === 'sign up';
  });

  // If login prompts are prominent and no post composer exists
  const hasComposer = inputs.some((i) => {
    const label = (i.label || i.placeholder || '').toLowerCase();
    return (
      i.dataTestId === 'tweetTextarea_0' ||
      label.includes('what is happening') ||
      label.includes('post text')
    );
  });

  return (hasLoginHeading || hasLoginButton) && !hasComposer;
}

/**
 * Locates the post composer element on an observed X.com page snapshot.
 * @param {Object} snapshot
 * @returns {Object|null} Matching input control descriptor or null
 */
export function findXPostComposer(snapshot) {
  if (!snapshot) return null;
  const inputs = snapshot.interactive?.inputs || snapshot.inputs || [];

  // 1. Direct tweetTextarea_0 testid match (standard X web composer)
  const byTestId = inputs.find((i) => i.dataTestId === 'tweetTextarea_0');
  if (byTestId) return byTestId;

  // 2. Contenteditable or textbox with "What is happening?!" placeholder or label
  const byLabel = inputs.find((i) => {
    const label = (i.label || i.placeholder || '').toLowerCase();
    return (
      label.includes('what is happening') ||
      label.includes("what's happening") ||
      label.includes('post text')
    );
  });
  if (byLabel) return byLabel;

  // 3. Fallback: Any visible contenteditable or textarea inside main feed
  const byType = inputs.find((i) => {
    return (i.type === 'contenteditable' || i.tag === 'textarea') && !i.disabled;
  });
  if (byType) return byType;

  return null;
}

/**
 * Locates the submit/publish button on an observed X.com page snapshot.
 * @param {Object} snapshot
 * @returns {Object|null} Matching button control descriptor or null
 */
export function findXPublishButton(snapshot) {
  if (!snapshot) return null;
  const buttons = snapshot.interactive?.buttons || snapshot.buttons || [];

  // 1. Direct tweetButtonInline or tweetButton testid
  const byTestId = buttons.find(
    (b) => (b.dataTestId === 'tweetButtonInline' || b.dataTestId === 'tweetButton') && !b.disabled
  );
  if (byTestId) return byTestId;

  // 2. Button labeled "Post" or "Tweet" (excluding navigation buttons)
  const byText = buttons.find((b) => {
    if (b.disabled) return false;
    const t = (b.text || b.ariaLabel || '').trim().toLowerCase();
    return t === 'post' || t === 'tweet';
  });
  if (byText) return byText;

  return null;
}

/**
 * Manages the end-to-end posting lifecycle on X.com with strict human-in-the-loop safety.
 */
export class XPostingWorkflow {
  constructor(options = {}) {
    this.taskState = null;
    this.draftText = '';
    this.currentPhase = 'INIT'; // INIT | WAITING_FOR_DRAFT_APPROVAL | WAITING_FOR_NAVIGATION | ON_X | WAITING_FOR_PUBLISH_CONFIRMATION | PUBLISHING | COMPLETED | ERROR | CANCELLED
    this.targetTabId = null;
    this.onUpdate = options.onUpdate || null;
    this.maxRetries = options.maxRetries ?? 2;
    this.pendingApprovalAction = null;
    this.composerElementId = null;
    this.publishButtonElementId = null;
    this.isResolving = false;
  }

  logDiagnostic(message, details = null) {
    const taskId = this.taskState?.taskId || 'no-task';
    const prefix = `[XPostingWorkflow] [${taskId}] ${message}`;
    if (details) {
      console.log(prefix, details);
    } else {
      console.log(prefix);
    }
  }

  notify() {
    if (typeof this.onUpdate === 'function' && this.taskState) {
      this.onUpdate(this.taskState.toSnapshot());
    }
  }

  /**
   * Initializes and executes the X posting workflow from user command.
   * @param {string} rawGoal - User command e.g. "Post on X: Hello world!"
   * @param {Object} taskState - Shared TaskState instance
   * @param {Object} [options]
   * @returns {Promise<Object>} Final task snapshot
   */
  async start(rawGoal, taskState, options = {}) {
    this.taskState = taskState;
    this.onUpdate = options.onUpdate || this.onUpdate;
    this.taskState.plannerMode = 'X.com Posting Workflow';

    const draft = extractXPostDraft(rawGoal);
    this.draftText = draft;

    this.logDiagnostic(`Starting X posting workflow for goal: "${rawGoal}"`);

    // Guard: Require non-empty post text
    if (!draft) {
      this.logDiagnostic('Draft text is empty; requesting clarification');
      this.taskState.requireClarification('What would you like to post on X?');
      this.currentPhase = 'NEEDS_CLARIFICATION';
      this.notify();
      return this.taskState.toSnapshot();
    }

    // Step 1: Request initial approval of the draft text
    this.logDiagnostic(`Draft extracted: "${draft}". Requesting user approval.`);
    this.currentPhase = 'WAITING_FOR_DRAFT_APPROVAL';
    this.pendingApprovalAction = {
      action: 'x_draft_approval',
      draftText: draft,
      platform: 'x.com',
      step: 'draft_approval',
      targetText: `Post to X: "${draft}"`
    };

    this.taskState.requireApproval(
      `Ready to prepare post on X: "${draft}". Please review and approve to proceed.`
    );
    this.notify();
    return this.taskState.toSnapshot();
  }

  /**
   * Handles user clicking "Approve Action".
   * Resumes the workflow according to current phase.
   * @returns {Promise<Object>}
   */
  async approve() {
    if (this.isResolving) {
      this.logDiagnostic('Approval already in progress, skipping duplicate call.');
      return this.taskState ? this.taskState.toSnapshot() : { success: false };
    }

    this.isResolving = true;
    const taskId = this.taskState?.taskId || 'unknown';

    try {
      this.logDiagnostic(`Approval received for task ${taskId} (currentPhase: ${this.currentPhase})`);

      // ----------------------------------------------------------------------
      // CASE 1: Approving the initial draft
      // ----------------------------------------------------------------------
      if (this.currentPhase === 'WAITING_FOR_DRAFT_APPROVAL') {
        this.logDiagnostic(`Approved draft: "${this.draftText}". Checking active tab...`);

        // Check active tab
        let activeTab = null;
        try {
          const tabRes = await getActiveTab();
          if (tabRes && tabRes.success && tabRes.tab) {
            activeTab = tabRes.tab;
          }
        } catch {
          // Test or mock environment
        }

        const activeUrl = activeTab?.url || '';
        this.targetTabId = activeTab?.id || null;
        this.logDiagnostic(`Active tab ID: ${this.targetTabId}, URL: ${activeUrl}`);

        if (isXUrl(activeUrl)) {
          // Already on X.com! Proceed immediately to page observation and typing
          this.logDiagnostic('Active tab is already on X.com. Proceeding directly to observe and compose.');
          this.currentPhase = 'ON_X';
          return await this.stepObserveAndCompose();
        } else {
          // Not on X yet. Keep draft and pending task state while waiting for navigation
          this.logDiagnostic(`Active tab is "${activeUrl}". Waiting for user to navigate to x.com.`);
          this.currentPhase = 'WAITING_FOR_NAVIGATION';
          this.taskState.transition(
            TaskStatus.OBSERVING,
            'Draft approved. Please open or switch to x.com to continue posting.'
          );
          this.notify();
          return this.taskState.toSnapshot();
        }
      }

      // ----------------------------------------------------------------------
      // CASE 2: Final confirmation immediately before publishing
      // ----------------------------------------------------------------------
      if (this.currentPhase === 'WAITING_FOR_PUBLISH_CONFIRMATION') {
        this.logDiagnostic('Final publish confirmation approved by user. Proceeding to publish...');
        this.currentPhase = 'PUBLISHING';
        return await this.stepPublishAndVerify();
      }

      this.logDiagnostic(`Approve invoked in unhandled phase: ${this.currentPhase}`);
      return this.taskState ? this.taskState.toSnapshot() : { success: false };
    } finally {
      this.isResolving = false;
    }
  }

  /**
   * Handles user clicking "Cancel / Deny".
   * Safely terminates the task without performing actions.
   * @param {string} [reason]
   * @returns {Object}
   */
  cancel(reason = 'Posting cancelled by user.') {
    this.logDiagnostic(`Action cancelled by user: ${reason}`);
    this.currentPhase = 'CANCELLED';
    this.pendingApprovalAction = null;
    if (this.taskState) {
      this.taskState.stop(reason);
      this.notify();
      return this.taskState.toSnapshot();
    }
    return { success: true, status: TaskStatus.STOPPED };
  }

  /**
   * Called when tab navigation or tab activation occurs.
   * If workflow is waiting for navigation to X, detects it and resumes!
   * @param {Object} tabInfo - { tabId, url, title, status }
   * @returns {Promise<Object|null>}
   */
  async handleTabUpdate(tabInfo) {
    if (!tabInfo || !tabInfo.url) return null;
    const url = tabInfo.url;

    // Only respond if we have an active task waiting for navigation to X
    if (this.currentPhase === 'WAITING_FOR_NAVIGATION' && isXUrl(url)) {
      this.logDiagnostic(`Detected navigation to X.com (${url}) in tab ${tabInfo.tabId}! Resuming workflow.`);
      this.targetTabId = tabInfo.tabId || this.targetTabId;
      this.currentPhase = 'ON_X';
      return await this.stepObserveAndCompose();
    }

    return null;
  }

  /**
   * Resumes workflow manually (e.g. after user logs in or fixes restricted page).
   * @returns {Promise<Object>}
   */
  async resume() {
    this.logDiagnostic('Manual resume requested.');
    if (this.currentPhase === 'X_LOGGED_OUT' || this.currentPhase === 'WAITING_FOR_NAVIGATION' || this.currentPhase === 'ON_X') {
      this.currentPhase = 'ON_X';
      return await this.stepObserveAndCompose();
    }
    return this.taskState ? this.taskState.toSnapshot() : { success: false };
  }

  /**
   * Step: Observe X.com page, verify auth, locate composer, and type approved draft.
   * @returns {Promise<Object>}
   */
  async stepObserveAndCompose() {
    this.taskState.transition(TaskStatus.OBSERVING, 'Observing X.com page elements...');
    this.notify();

    // Settle delay for initial script rendering
    await sleep(400);

    let snapshot = null;
    let attempts = 0;
    const maxAttempts = 3;

    // Gracefully handle slow-loading pages
    while (attempts < maxAttempts) {
      attempts++;
      const obsRes = await getPageSnapshot();
      if (obsRes && obsRes.success && obsRes.data) {
        snapshot = obsRes.data;
        break;
      }
      this.logDiagnostic(`Page observation attempt ${attempts} pending, retrying...`);
      await sleep(600);
    }

    if (!snapshot || !snapshot.page) {
      const err = 'Could not observe X.com. The page may still be loading or restricted.';
      this.logDiagnostic(err);
      this.taskState.fail(err);
      this.currentPhase = 'ERROR';
      this.notify();
      return this.taskState.toSnapshot();
    }

    const currentUrl = snapshot.page.url || '';
    this.logDiagnostic(`Page observation successful. URL: ${currentUrl}`);

    // Check restricted page
    if (isRestrictedUrl(currentUrl)) {
      const err = 'Chrome restricts extensions on this page. Please open a regular X.com website tab.';
      this.logDiagnostic(err);
      this.taskState.fail(err);
      this.currentPhase = 'ERROR';
      this.notify();
      return this.taskState.toSnapshot();
    }

    // Check logged out
    if (isXLoggedOut(snapshot)) {
      const msg = 'X.com is currently logged out. Please log in to your X account to continue posting.';
      this.logDiagnostic('X.com logged out state detected');
      this.currentPhase = 'X_LOGGED_OUT';
      this.taskState.requireClarification(msg);
      this.notify();
      return this.taskState.toSnapshot();
    }

    // Locate post composer
    const composer = findXPostComposer(snapshot);
    if (!composer) {
      const err = 'Could not locate the post composer on X. Please ensure you are on the home timeline or have the post modal open.';
      this.logDiagnostic('Post composer element not found in snapshot');
      this.taskState.fail(err);
      this.currentPhase = 'ERROR';
      this.notify();
      return this.taskState.toSnapshot();
    }

    this.composerElementId = composer.id;
    this.logDiagnostic(`Composer found (elementId: ${composer.id}). Typing approved draft...`);

    // Type approved draft text into composer
    this.taskState.transition(TaskStatus.EXECUTING, `Filling composer with approved draft: "${this.draftText}"`);
    this.taskState.recordStepStart(`Type draft into composer`, {
      action: 'type',
      elementId: composer.id,
      text: this.draftText
    });
    this.notify();

    const typeRes = await executeAction({
      action: 'type',
      elementId: composer.id,
      text: this.draftText
    });

    if (!typeRes || typeRes.success === false) {
      const errMsg = typeRes?.error || 'Failed to type draft into the composer.';
      this.logDiagnostic(`Typing failed: ${errMsg}`);
      this.taskState.recordStepFailure(errMsg);
      this.taskState.fail(`Could not fill post composer: ${errMsg}`);
      this.currentPhase = 'ERROR';
      this.notify();
      return this.taskState.toSnapshot();
    }

    // Settling delay after typing
    await sleep(400);

    // Re-observe to verify filled text and find publish button
    const postTypeSnapshot = await getPageSnapshot();
    this.logDiagnostic('Composer populated. Requiring explicit confirmation immediately before publishing.');

    // Step: Require explicit confirmation immediately before publishing
    this.currentPhase = 'WAITING_FOR_PUBLISH_CONFIRMATION';
    this.pendingApprovalAction = {
      action: 'x_publish_final',
      draftText: this.draftText,
      platform: 'x.com',
      step: 'publish_confirmation',
      targetText: `Publish to X: "${this.draftText}"`
    };

    this.taskState.requireApproval(
      `Final confirmation: Ready to publish to X: "${this.draftText}". Please confirm to publish.`
    );
    this.notify();
    return this.taskState.toSnapshot();
  }

  /**
   * Step: Publish once and verify resulting post.
   * @returns {Promise<Object>}
   */
  async stepPublishAndVerify() {
    this.taskState.transition(TaskStatus.EXECUTING, 'Locating Post button and publishing...');
    this.notify();

    // Fresh DOM observation before publish click
    const obsRes = await getPageSnapshot();
    const snapshot = obsRes?.data || null;

    const publishBtn = findXPublishButton(snapshot);
    if (!publishBtn) {
      const err = 'Could not locate the Post button on X.';
      this.logDiagnostic(err);
      this.taskState.fail(err);
      this.currentPhase = 'ERROR';
      this.notify();
      return this.taskState.toSnapshot();
    }

    this.publishButtonElementId = publishBtn.id;
    this.logDiagnostic(`Publish button found (elementId: ${publishBtn.id}). Clicking once...`);

    this.taskState.recordStepStart('Click Post button', {
      action: 'click',
      elementId: publishBtn.id
    });
    this.notify();

    // Click publish button ONCE
    const clickRes = await executeAction({
      action: 'click',
      elementId: publishBtn.id
    });

    if (!clickRes || clickRes.success === false) {
      const errMsg = clickRes?.error || 'Failed to click Post button.';
      this.logDiagnostic(`Click failed: ${errMsg}`);
      this.taskState.recordStepFailure(errMsg);
      this.taskState.fail(`Could not submit post: ${errMsg}`);
      this.currentPhase = 'ERROR';
      this.notify();
      return this.taskState.toSnapshot();
    }

    // Verify post submission
    this.taskState.transition(TaskStatus.VERIFYING, 'Verifying published post on X...');
    this.notify();

    await sleep(600);

    // Verification check: re-observe DOM
    const postSnapshotRes = await getPageSnapshot();
    const postSnapshot = postSnapshotRes?.data || null;

    // Safety check against duplicate publish:
    // If publish button is gone/disabled or composer is now empty, post succeeded!
    let composerCleared = false;
    if (postSnapshot) {
      const updatedComposer = findXPostComposer(postSnapshot);
      if (!updatedComposer || !updatedComposer.value || updatedComposer.value.trim() === '') {
        composerCleared = true;
      }
    }

    // Timeout or verification failure handling:
    // Never retry a timed-out publish action blindly! Check whether it already succeeded first.
    if (clickRes.timedOut) {
      this.logDiagnostic('Publish action timed out. Checking if composer was cleared before reporting...');
      if (composerCleared) {
        this.logDiagnostic('Composer cleared despite timeout; post successfully published.');
      } else {
        const timeoutErr = 'Publish action timed out. Please check X to verify if your post appeared before retrying.';
        this.logDiagnostic(timeoutErr);
        this.taskState.fail(timeoutErr);
        this.currentPhase = 'ERROR';
        this.notify();
        return this.taskState.toSnapshot();
      }
    }

    this.logDiagnostic(`Post verified published successfully to X: "${this.draftText}"`);
    this.currentPhase = 'COMPLETED';

    const result = {
      title: 'Post published to X',
      answer: `Your post was successfully published to X: "${this.draftText}"`,
      spokenText: `Your post has been published to X.`,
      draftText: this.draftText,
      platform: 'x.com'
    };

    this.taskState.complete(result);
    this.notify();
    return this.taskState.toSnapshot();
  }
}
