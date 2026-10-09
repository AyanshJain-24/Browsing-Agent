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

import { getPageSnapshot, executeAction } from '../sidepanel/utils/chromeMessaging.js';
import { TaskState, TaskStatus } from './taskState.js';
import { planNextAction, canHandleDeterministically } from './planner.js';
import { planWithAI } from './aiPlanner.js';
import { verifyAction } from './verifier.js';

// Helper for brief asynchronous DOM stabilization delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Allowlist of safe, supported browser action types
export const ALLOWED_ACTIONS = new Set(['click', 'type', 'select', 'scroll', 'presskey', 'navigate']);

/**
 * Waits for post-action page state to stabilize, especially across navigations.
 * Polls getPageSnapshot() until URL changes or timeout expires.
 * 
 * @param {Object} plannedAction - Action that was executed
 * @param {Object} prevSnapshot - Snapshot before action
 * @param {number} maxWaitMs - Max milliseconds to wait for navigation (default 3000ms)
 * @returns {Promise<Object|null>} Fresh page snapshot, or null if observation failed
 */
export async function waitForPostActionSnapshot(plannedAction, prevSnapshot, maxWaitMs = 3000) {
  const expectsNavigation =
    plannedAction.action === 'navigate' ||
    (plannedAction.action === 'click' && (plannedAction.targetHref || plannedAction.targetTag === 'a'));

  // If not expecting navigation, standard brief settling delay is sufficient
  if (!expectsNavigation) {
    await sleep(400);
    const res = await getPageSnapshot();
    return res?.success ? res.data : null;
  }

  // Expecting navigation: poll for URL change or page load completion
  const startTime = Date.now();
  const prevUrl = prevSnapshot?.page?.url || '';
  let latestSnapshot = null;

  await sleep(400);

  while (Date.now() - startTime < maxWaitMs) {
    try {
      const res = await getPageSnapshot();
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

export class AgentController {
  constructor() {
    this.currentTask = null;
    this.abortRequested = false;
    this.pendingApprovalAction = null;
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
      maxRetries = 2
    } = options;

    // If a task is currently executing, stop it first
    if (this.currentTask && !this.currentTask.isTerminal()) {
      this.stopTask();
    }

    this.abortRequested = false;
    this.pendingApprovalAction = null;
    this.currentTask = new TaskState(goal, {
      plannerMode: plannerMode === 'deterministic' ? 'Deterministic' : 'AI Hybrid'
    });

    const notify = () => {
      if (typeof onUpdate === 'function') {
        onUpdate(this.currentTask.toSnapshot());
      }
    };

    notify();

    let failureCount = 0;
    let lastFailure = null;

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

        const observeResponse = await getPageSnapshot();
        if (!observeResponse || !observeResponse.success || !observeResponse.data) {
          const err = observeResponse?.error || 'Could not observe webpage. The tab may be restricted or closed.';
          this.currentTask.fail(err);
          notify();
          break;
        }

        const snapshot = observeResponse.data;

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
          (!plan || plan.status === 'ERROR');

        if (needsAI) {
          this.currentTask.transition(TaskStatus.AI_PLANNING, 'AI analyzing goal and page elements...');
          notify();

          try {
            plan = await planWithAI(this.currentTask.goal, snapshot, this.currentTask, {
              lastFailure,
              provider
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
          this.currentTask.complete(plan.result);
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

        const stepLabel = plan.label || plan.explanation || `Execute ${plannedAction.action}`;

        // Record the step in timeline
        this.currentTask.recordStepStart(stepLabel, plannedAction);

        // ====================================================================
        // STEP C: ACT (Execute Action via Executor)
        // ====================================================================
        this.currentTask.transition(TaskStatus.EXECUTING, `Executing: ${stepLabel}`);
        notify();

        const execResponse = await executeAction(plannedAction);
        const execResult = execResponse?.result || execResponse;

        // Check low-level execution failure immediately
        if (!execResponse || execResponse.success === false || execResult?.success === false) {
          const errMsg = execResponse?.error || execResult?.error || 'Executor failed to perform action.';

          if (failureCount < maxRetries && this.currentTask.plannerMode !== 'Deterministic') {
            failureCount++;
            lastFailure = { action: plannedAction, reason: errMsg };
            this.currentTask.recordStepFailure(errMsg, `Retry ${failureCount}/${maxRetries}`);
            this.currentTask.transition(TaskStatus.PLANNING, `Action failed (${errMsg}). Re-planning step (attempt ${failureCount + 1})...`);
            notify();
            await sleep(400);
            continue; // Re-observe and re-plan within bounded recovery limit
          }

          this.currentTask.recordStepFailure(errMsg);
          this.currentTask.fail(`Action execution failed: ${errMsg}`);
          notify();
          break;
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

        const postSnapshot = await waitForPostActionSnapshot(plannedAction, snapshot);

        // ====================================================================
        // STEP E: VERIFY (Outcome Verification)
        // ====================================================================
        const verification = verifyAction(plannedAction, snapshot, postSnapshot, execResult);

        if (!verification.verified) {
          if (failureCount < maxRetries) {
            failureCount++;
            lastFailure = { action: plannedAction, reason: verification.reason };
            this.currentTask.recordStepFailure(verification.reason, `Retry ${failureCount}/${maxRetries}`);
            this.currentTask.transition(TaskStatus.PLANNING, `Verification failed (${verification.reason}). Re-observing and re-planning...`);
            notify();
            await sleep(400);
            continue; // Re-observe and re-plan within bounded recovery limit
          }

          // Retries exhausted - NEVER claim success
          this.currentTask.recordStepFailure(verification.reason);
          this.currentTask.fail(`Action verification failed: ${verification.reason}`);
          notify();
          break;
        }

        // Verification succeeded! Reset retry trackers
        failureCount = 0;
        lastFailure = null;
        this.currentTask.recordStepSuccess(verification.reason);
        notify();

        // If this was marked as the final step of the plan
        if (plan.isLastStep) {
          this.currentTask.complete({
            title: this.currentTask.goal,
            meta: `Verified: ${verification.reason}`
          });
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

    return this.currentTask.toSnapshot();
  }

  /**
   * Explicitly stops the currently running task.
   */
  stopTask() {
    this.abortRequested = true;
    if (this.currentTask && !this.currentTask.isTerminal()) {
      this.currentTask.stop();
    }
  }

  /**
   * Retrieves the current task state snapshot.
   * @returns {Object|null}
   */
  getActiveTask() {
    return this.currentTask ? this.currentTask.toSnapshot() : null;
  }
}

// Export singleton instance for side panel usage
export const agentController = new AgentController();
