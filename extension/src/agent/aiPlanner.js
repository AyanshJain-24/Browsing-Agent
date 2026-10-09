/**
 * Voice Browser Agent - AI Planning Layer
 * 
 * Interprets natural language instructions using backend LLM reasoning.
 * 
 * Safety & Quality Enforcements:
 * 1. Pre-flight sensitive action check (payments, flight booking, destructive actions blocked)
 * 2. Strict allowlist validation of model action proposal
 * 3. Element ID validation against live snapshot
 * 4. Transparent explanations and clarification support
 * 5. Truthful token and latency telemetry
 */

import { aiClient } from './aiClient.js';
import { isSensitiveAction } from './planner.js';

export const ALLOWED_ACTIONS = new Set(['click', 'type', 'select', 'scroll', 'presskey', 'navigate']);

/**
 * Plans the next browser action using LLM reasoning.
 * 
 * @param {string} rawGoal - User's instruction
 * @param {Object} snapshot - Live DOM observation from observer.js
 * @param {Object} [taskState] - Current TaskState instance
 * @param {Object} [options]
 * @param {Object} [options.lastFailure] - Prior failed action details if retrying
 * @param {string} [options.provider] - Optional provider override
 * @returns {Promise<{
 *   status: 'ACTION' | 'DONE' | 'WAITING_FOR_APPROVAL' | 'NEEDS_CLARIFICATION' | 'ERROR',
 *   action?: Object,
 *   label?: string,
 *   explanation?: string,
 *   isLastStep?: boolean,
 *   requiresApproval?: boolean,
 *   clarificationQuestion?: string,
 *   result?: Object,
 *   error?: string,
 *   metrics?: Object
 * }>}
 */
export async function planWithAI(rawGoal, snapshot, taskState, options = {}) {
  const goal = String(rawGoal || '').trim();

  if (!goal) {
    return {
      status: 'ERROR',
      error: 'Cannot plan action: command is empty.'
    };
  }

  // Pre-flight security guardrail: block sensitive financial or destructive actions
  if (isSensitiveAction(goal)) {
    return {
      status: 'WAITING_FOR_APPROVAL',
      requiresApproval: true,
      explanation: `Sensitive action detected: "${rawGoal}". Automated booking, payment, purchase, or destructive operations require explicit human authorization.`
    };
  }

  if (!snapshot || !snapshot.page) {
    return {
      status: 'ERROR',
      error: 'Cannot plan action: webpage observation is unavailable.'
    };
  }

  // Extract compact execution history from taskState
  const history = taskState?.actions?.map((a) => ({
    label: a.label,
    action: a.action,
    state: a.state
  })) || [];

  // Call AI Planning backend
  const aiResponse = await aiClient.requestPlan({
    goal,
    observation: snapshot,
    history,
    lastFailure: options.lastFailure || null,
    provider: options.provider
  });

  if (!aiResponse || !aiResponse.success) {
    return {
      status: 'ERROR',
      error: aiResponse?.error || 'AI planning service request failed.',
      code: aiResponse?.code || 'AI_ERROR'
    };
  }

  const plan = aiResponse.plan;
  const metrics = aiResponse.metrics;

  // Process plan by status
  switch (plan.status) {
    case 'DONE': {
      return {
        status: 'DONE',
        explanation: plan.explanation || 'Task completed',
        result: plan.result || { title: goal, meta: plan.explanation },
        metrics
      };
    }

    case 'WAITING_FOR_APPROVAL': {
      return {
        status: 'WAITING_FOR_APPROVAL',
        requiresApproval: true,
        explanation: plan.explanation || 'Action requires user approval.',
        action: plan.action,
        metrics
      };
    }

    case 'NEEDS_CLARIFICATION': {
      return {
        status: 'NEEDS_CLARIFICATION',
        clarificationQuestion: plan.clarificationQuestion || plan.explanation || 'Please clarify your instruction.',
        explanation: plan.explanation,
        metrics
      };
    }

    case 'ERROR': {
      return {
        status: 'ERROR',
        error: plan.error || plan.explanation || 'Could not plan safe action for this task.',
        metrics
      };
    }

    case 'ACTION': {
      const plannedAction = plan.action;
      if (!plannedAction || typeof plannedAction !== 'object' || !plannedAction.action) {
        return {
          status: 'ERROR',
          error: 'AI planner returned an ACTION status without an action payload.',
          metrics
        };
      }

      const actionType = String(plannedAction.action).toLowerCase();
      if (!ALLOWED_ACTIONS.has(actionType)) {
        return {
          status: 'ERROR',
          error: `Security guardrail: AI proposed disallowed action '${plannedAction.action}'.`,
          metrics
        };
      }

      // Check if action text or target indicates sensitive transaction
      if (
        isSensitiveAction(plannedAction.targetText) ||
        isSensitiveAction(plannedAction.text) ||
        isSensitiveAction(plannedAction.url)
      ) {
        return {
          status: 'WAITING_FOR_APPROVAL',
          requiresApproval: true,
          explanation: `Sensitive action detected in proposed step: "${plannedAction.action}". Requires user confirmation.`,
          action: plannedAction,
          metrics
        };
      }

      const label = plan.explanation || `Execute ${plannedAction.action}`;

      return {
        status: 'ACTION',
        action: plannedAction,
        label,
        explanation: plan.explanation,
        isLastStep: Boolean(plan.isLastStep),
        metrics
      };
    }

    default: {
      return {
        status: 'ERROR',
        error: `AI planner returned unrecognized plan status '${plan.status}'.`,
        metrics
      };
    }
  }
}
