/**
 * Voice Browser Agent - AI Response Validator
 * 
 * Strictly validates and normalizes JSON responses returned by AI providers.
 * 
 * Security Guardrails:
 * - Reject malformed JSON, markdown-wrapped non-JSON, and unknown action types.
 * - Enforce strict action allowlist matching executor.js contracts:
 *   click, type, select, scroll, pressKey, navigate
 * - Reject any executable code, scripts, eval, or unexpected parameters.
 * - Validate HTTP/HTTPS protocols for navigation.
 */

export const ALLOWED_ACTIONS = new Set(['click', 'type', 'select', 'scroll', 'presskey', 'navigate']);

export const ALLOWED_STATUSES = new Set([
  'ACTION',
  'DONE',
  'WAITING_FOR_APPROVAL',
  'NEEDS_CLARIFICATION',
  'ERROR'
]);

/**
 * Strips markdown code block wrappers (e.g. ```json ... ```) if returned by model.
 * @param {string} text
 * @returns {string}
 */
export function extractCleanJson(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text.trim();

  // Strip ```json ... ``` or ``` ... ```
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlockMatch) {
    cleaned = codeBlockMatch[1].trim();
  }

  // If text starts with non-{ and has { ... }
  const jsonObjectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonObjectMatch) {
    cleaned = jsonObjectMatch[0];
  }

  return cleaned;
}

/**
 * Validates a navigation URL.
 * @param {string} url
 * @returns {{ valid: boolean, href?: string, error?: string }}
 */
function validateNavigationUrl(url) {
  if (!url || typeof url !== 'string') {
    return { valid: false, error: 'Missing navigation URL' };
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, error: `Disallowed URL protocol '${parsed.protocol}'. Only http: and https: are permitted.` };
    }
    return { valid: true, href: parsed.href };
  } catch {
    return { valid: false, error: `Malformed URL: "${url}"` };
  }
}

/**
 * Validates the raw text from an AI model into a safe, structured plan object.
 * 
 * @param {string} rawText - Raw completion from provider
 * @returns {{ valid: boolean, plan?: Object, error?: string }}
 */
export function validateAIPlanResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { valid: false, error: 'Empty response received from AI model' };
  }

  const jsonStr = extractCleanJson(rawText);
  let parsed;

  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    return {
      valid: false,
      error: `Model response is not valid JSON: ${err.message}`,
      rawText: rawText.slice(0, 300)
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, error: 'Model response must be a JSON object', rawText };
  }

  // 1. Validate status
  const rawStatus = String(parsed.status || '').trim().toUpperCase();
  if (!ALLOWED_STATUSES.has(rawStatus)) {
    return {
      valid: false,
      error: `Invalid plan status '${parsed.status}'. Must be one of: ${Array.from(ALLOWED_STATUSES).join(', ')}`,
      rawText
    };
  }

  const plan = {
    status: rawStatus,
    explanation: String(parsed.explanation || '').slice(0, 200),
    isLastStep: Boolean(parsed.isLastStep)
  };

  // 2. Handle non-ACTION statuses
  if (rawStatus === 'DONE') {
    plan.result = parsed.result && typeof parsed.result === 'object'
      ? parsed.result
      : { title: parsed.explanation || 'Task completed' };
    return { valid: true, plan };
  }

  if (rawStatus === 'WAITING_FOR_APPROVAL') {
    plan.requiresApproval = true;
    plan.explanation = parsed.explanation || 'This action requires explicit user confirmation.';
    if (parsed.action && typeof parsed.action === 'object') {
      plan.action = parsed.action;
    }
    return { valid: true, plan };
  }

  if (rawStatus === 'NEEDS_CLARIFICATION') {
    plan.clarificationQuestion = parsed.clarificationQuestion || parsed.explanation || 'Could you please clarify your request?';
    return { valid: true, plan };
  }

  if (rawStatus === 'ERROR') {
    plan.error = parsed.error || parsed.explanation || 'The model could not fulfill this task.';
    return { valid: true, plan };
  }

  // 3. Status is ACTION: Validate action payload
  const rawAction = parsed.action;
  if (!rawAction || typeof rawAction !== 'object' || Array.isArray(rawAction)) {
    return {
      valid: false,
      error: 'Plan status is ACTION but missing valid "action" object',
      rawText
    };
  }

  const actionType = String(rawAction.action || '').trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(actionType)) {
    return {
      valid: false,
      error: `Security guardrail: action '${rawAction.action}' is not in the allowed actions allowlist. Allowed actions: ${Array.from(ALLOWED_ACTIONS).join(', ')}`,
      rawText
    };
  }

  const validatedAction = { action: actionType };

  // Validate action specific properties
  switch (actionType) {
    case 'click': {
      if (!rawAction.elementId || typeof rawAction.elementId !== 'string') {
        return { valid: false, error: 'Click action requires string "elementId"' };
      }
      validatedAction.elementId = rawAction.elementId.trim();
      if (rawAction.targetHref) validatedAction.targetHref = String(rawAction.targetHref);
      if (rawAction.targetText) validatedAction.targetText = String(rawAction.targetText);
      break;
    }

    case 'type': {
      if (!rawAction.elementId || typeof rawAction.elementId !== 'string') {
        return { valid: false, error: 'Type action requires string "elementId"' };
      }
      validatedAction.elementId = rawAction.elementId.trim();
      validatedAction.text = String(rawAction.text ?? rawAction.value ?? '');
      break;
    }

    case 'select': {
      if (!rawAction.elementId || typeof rawAction.elementId !== 'string') {
        return { valid: false, error: 'Select action requires string "elementId"' };
      }
      validatedAction.elementId = rawAction.elementId.trim();
      validatedAction.value = String(rawAction.value ?? rawAction.text ?? '');
      break;
    }

    case 'scroll': {
      if (rawAction.elementId) {
        validatedAction.elementId = String(rawAction.elementId).trim();
      } else {
        const direction = String(rawAction.direction || 'down').toLowerCase();
        validatedAction.direction = direction === 'up' ? 'up' : 'down';
        const rawAmt = Number(rawAction.amount);
        validatedAction.amount = !isNaN(rawAmt) && rawAmt > 0 ? Math.min(rawAmt, 2000) : 500;
      }
      break;
    }

    case 'presskey': {
      validatedAction.action = 'pressKey'; // Normalize camelCase for executor
      validatedAction.key = String(rawAction.key || 'Enter');
      if (rawAction.elementId) validatedAction.elementId = String(rawAction.elementId).trim();
      break;
    }

    case 'navigate': {
      const urlCheck = validateNavigationUrl(rawAction.url);
      if (!urlCheck.valid) {
        return { valid: false, error: urlCheck.error };
      }
      validatedAction.url = urlCheck.href;
      break;
    }
  }

  plan.action = validatedAction;
  plan.label = plan.explanation || `Execute ${validatedAction.action}`;

  return { valid: true, plan };
}
