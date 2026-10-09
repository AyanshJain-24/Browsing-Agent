/**
 * Voice Browser Agent - Webpage Action Executor Engine
 * 
 * "The Hands of the Browser Agent"
 * 
 * Executes explicit, deterministic browser action commands dispatched by the agent.
 * Does NOT decide or plan actions; it strictly translates structured commands into
 * simulated user interactions on the active DOM.
 * 
 * Supported Actions:
 * - click      : Resolves element, scrolls into view, clicks
 * - type       : Resolves input/textarea, focuses, sets value, dispatches input & change events
 * - select     : Resolves <select>, matches option by value/text, dispatches change events
 * - scroll     : Scrolls window by amount/direction, or scrolls specific element into view
 * - pressKey   : Dispatches keyboard events (Enter, Tab, Escape, etc.) to target/active element
 * - navigate   : Safely navigates page to validated HTTP/HTTPS URL
 * 
 * Safety & Security:
 * - Uses in-memory elementRegistry from observer.js (no arbitrary eval or dynamic CSS injection)
 * - Strict URL protocol whitelisting (rejects javascript:, data:, file:)
 * - Masks password input text in console logs
 * - Returns structured, predictable result objects: { success: boolean, action: string, ... }
 */

import { getRegisteredElement } from './observer.js';

// Observability prefix for console logging
const LOG_PREFIX = '[Executor]';

/**
 * Internal logger that logs actions while masking sensitive values.
 * @param {string} message - Information message
 * @param {boolean} isError - True if error level
 */
function log(message, isError = false) {
  if (isError) {
    console.error(`${LOG_PREFIX} ${message}`);
  } else {
    console.log(`${LOG_PREFIX} ${message}`);
  }
}

/**
 * Resolves a temporary snapshot identifier (e.g. "element-1") to an active DOM element.
 * Validates element presence, attachment to the document, and interactability.
 * 
 * @param {string} elementId - Temporary ID assigned by observer.js
 * @returns {{ element?: Element, error?: string }}
 */
function resolveElement(elementId) {
  if (!elementId || typeof elementId !== 'string') {
    return { error: "Missing or invalid 'elementId' parameter" };
  }

  const element = getRegisteredElement(elementId);
  if (!element) {
    return {
      error: `Element '${elementId}' not found in registry. The page may have changed or the element was never registered.`
    };
  }

  // Check if element is still attached to document tree (e.g. SPA re-render could detach it)
  if (!element.isConnected) {
    return {
      error: `Element '${elementId}' is no longer attached to the document (stale DOM reference).`
    };
  }

  return { element };
}

// ============================================================================
// 1. CLICK ACTION
// ============================================================================

/**
 * Executes a click action on a registered element.
 * 
 * @param {Object} command - { action: "click", elementId: "element-7" }
 * @returns {Promise<Object>}
 */
async function handleClick(command) {
  const { elementId } = command;
  const { element, error } = resolveElement(elementId);
  if (error) {
    log(`Click failed: ${error}`, true);
    return { success: false, action: 'click', elementId, error };
  }

  // Check if disabled
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') {
    const disabledMsg = `Element '${elementId}' is disabled`;
    log(`Click failed: ${disabledMsg}`, true);
    return { success: false, action: 'click', elementId, error: disabledMsg };
  }

  try {
    // 1. Scroll element into viewport center
    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });

    // 2. Focus element if focusable
    if (typeof element.focus === 'function') {
      element.focus();
    }

    // 3. Dispatch standard mouse interaction events for modern web apps
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    element.click();

    log(`Clicked ${elementId} (<${element.tagName.toLowerCase()}>)`);
    return {
      success: true,
      action: 'click',
      elementId,
      tag: element.tagName.toLowerCase()
    };
  } catch (err) {
    const errMsg = `Click execution failed: ${err.message}`;
    log(errMsg, true);
    return { success: false, action: 'click', elementId, error: errMsg };
  }
}

// ============================================================================
// 2. TYPE ACTION
// ============================================================================

/**
 * Types text into an input, textarea, or contenteditable element.
 * Dispatches input and change events so frameworks like React, Vue, and Angular
 * register state updates properly.
 * 
 * @param {Object} command - { action: "type", elementId: "element-3", text: "..." }
 * @returns {Promise<Object>}
 */
async function handleType(command) {
  const { elementId } = command;
  const text = command.text ?? command.value ?? '';
  const { element, error } = resolveElement(elementId);
  if (error) {
    log(`Type failed: ${error}`, true);
    return { success: false, action: 'type', elementId, error };
  }

  const tag = element.tagName.toLowerCase();
  const isInput = tag === 'input' || tag === 'textarea';
  const isContentEditable = Boolean(element.isContentEditable);

  if (!isInput && !isContentEditable) {
    const errType = `Element '${elementId}' (<${tag}>) is not an editable input, textarea, or contenteditable element`;
    log(`Type failed: ${errType}`, true);
    return { success: false, action: 'type', elementId, error: errType };
  }

  // Check disabled and readOnly states
  if (element.disabled) {
    const errDis = `Element '${elementId}' is disabled`;
    log(`Type failed: ${errDis}`, true);
    return { success: false, action: 'type', elementId, error: errDis };
  }
  if (element.readOnly) {
    const errRo = `Element '${elementId}' is read-only`;
    log(`Type failed: ${errRo}`, true);
    return { success: false, action: 'type', elementId, error: errRo };
  }

  const isPassword = tag === 'input' && (element.type || '').toLowerCase() === 'password';

  try {
    // 1. Scroll into view and focus
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.focus();

    // 2. Set value with React/cross-framework compatibility
    if (isInput) {
      // Modern frameworks (React 16+) override the HTMLInputElement.prototype.value setter.
      // Calling the prototype setter ensures internal framework state trackers update.
      const prototype = Object.getPrototypeOf(element);
      const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      const htmlInputSetter = Object.getOwnPropertyDescriptor(
        tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype,
        'value'
      )?.set;

      const setter = prototypeValueSetter || htmlInputSetter;
      if (setter) {
        setter.call(element, String(text));
      } else {
        element.value = String(text);
      }
    } else if (isContentEditable) {
      element.innerText = String(text);
    }

    // 3. Dispatch input and change events
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

    // Privacy safeguard: never print raw password values to console logs
    const loggedText = isPassword ? '[PROTECTED]' : `"${String(text).slice(0, 30)}${String(text).length > 30 ? '…' : ''}"`;
    log(`Typed in ${elementId} (value: ${loggedText})`);

    return {
      success: true,
      action: 'type',
      elementId,
      length: String(text).length
    };
  } catch (err) {
    const errMsg = `Type execution failed: ${err.message}`;
    log(errMsg, true);
    return { success: false, action: 'type', elementId, error: errMsg };
  }
}

// ============================================================================
// 3. SELECT ACTION
// ============================================================================

/**
 * Selects an option in a <select> dropdown element by value or text.
 * 
 * @param {Object} command - { action: "select", elementId: "element-5", value: "..." }
 * @returns {Promise<Object>}
 */
async function handleSelect(command) {
  const { elementId } = command;
  const targetValue = String(command.value ?? command.text ?? '').trim();
  const { element, error } = resolveElement(elementId);
  if (error) {
    log(`Select failed: ${error}`, true);
    return { success: false, action: 'select', elementId, error };
  }

  if (element.tagName.toLowerCase() !== 'select') {
    const errSelect = `Element '${elementId}' (<${element.tagName.toLowerCase()}>) is not a <select> dropdown`;
    log(`Select failed: ${errSelect}`, true);
    return { success: false, action: 'select', elementId, error: errSelect };
  }

  if (element.disabled) {
    const errDis = `Select element '${elementId}' is disabled`;
    log(`Select failed: ${errDis}`, true);
    return { success: false, action: 'select', elementId, error: errDis };
  }

  try {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    element.focus();

    const normalizedTarget = targetValue.toLowerCase();
    let matchedOption = null;

    // 1. Attempt exact or case-insensitive value match
    for (const option of element.options) {
      if (option.value.trim().toLowerCase() === normalizedTarget) {
        matchedOption = option;
        break;
      }
    }

    // 2. Fallback to option visible label/text match
    if (!matchedOption) {
      for (const option of element.options) {
        if (option.textContent.trim().toLowerCase() === normalizedTarget) {
          matchedOption = option;
          break;
        }
      }
    }

    if (!matchedOption) {
      const errNotFound = `Option matching '${targetValue}' was not found in <select id="${elementId}">`;
      log(`Select failed: ${errNotFound}`, true);
      return { success: false, action: 'select', elementId, error: errNotFound };
    }

    // Select the option
    matchedOption.selected = true;
    element.value = matchedOption.value;

    // Dispatch change and input events
    element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));

    log(`Selected option in ${elementId} (value: "${matchedOption.value}", text: "${matchedOption.textContent.trim()}")`);
    return {
      success: true,
      action: 'select',
      elementId,
      selectedValue: matchedOption.value,
      selectedText: matchedOption.textContent.trim()
    };
  } catch (err) {
    const errMsg = `Select execution failed: ${err.message}`;
    log(errMsg, true);
    return { success: false, action: 'select', elementId, error: errMsg };
  }
}

// ============================================================================
// 4. SCROLL ACTION
// ============================================================================

/**
 * Performs a scrolling action.
 * Supports window-level scrolling by direction & pixel amount,
 * or scrolling a specific element into view.
 * 
 * @param {Object} command - { action: "scroll", direction: "down"|"up", amount: 600, elementId?: string }
 * @returns {Promise<Object>}
 */
async function handleScroll(command) {
  // Scenario A: Scroll a specific element into view
  if (command.elementId) {
    const { elementId } = command;
    const { element, error } = resolveElement(elementId);
    if (error) {
      log(`Scroll failed: ${error}`, true);
      return { success: false, action: 'scroll', elementId, error };
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    log(`Scrolled element ${elementId} into view`);
    return {
      success: true,
      action: 'scroll',
      elementId
    };
  }

  // Scenario B: Window scrolling by direction and amount
  const direction = (command.direction || 'down').toLowerCase();
  const rawAmount = Number(command.amount);
  const amount = !isNaN(rawAmount) && rawAmount > 0 ? Math.min(rawAmount, 3000) : 500;

  try {
    const topDelta = direction === 'up' ? -amount : amount;
    window.scrollBy({ top: topDelta, left: 0, behavior: 'smooth' });

    log(`Scrolled window ${direction} by ${amount}px`);
    return {
      success: true,
      action: 'scroll',
      direction,
      amount
    };
  } catch (err) {
    const errMsg = `Scroll execution failed: ${err.message}`;
    log(errMsg, true);
    return { success: false, action: 'scroll', error: errMsg };
  }
}

// ============================================================================
// 5. KEYBOARD (PRESS KEY) ACTION
// ============================================================================

/**
 * Dispatches simulated keyboard events (Enter, Tab, Escape, Backspace, Arrows).
 * Dispatches to a target element if elementId is provided, or document.activeElement.
 * 
 * @param {Object} command - { action: "pressKey", key: "Enter", elementId?: string }
 * @returns {Promise<Object>}
 */
async function handlePressKey(command) {
  const key = command.key || 'Enter';

  // Resolve target element or fall back to active element
  let target = document.activeElement || document.body;
  if (command.elementId) {
    const { element, error } = resolveElement(command.elementId);
    if (!error && element) {
      target = element;
      if (typeof target.focus === 'function') target.focus();
    }
  }

  try {
    const eventInit = {
      key,
      code: key === 'Enter' ? 'Enter' : key === 'Tab' ? 'Tab' : key === 'Escape' ? 'Escape' : 'Key',
      bubbles: true,
      cancelable: true,
      view: window
    };

    target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    target.dispatchEvent(new KeyboardEvent('keyup', eventInit));

    // Special case: If key is "Enter" inside an input without a form preventDefault,
    // optionally submit form if appropriate
    if (key === 'Enter' && target.tagName && target.tagName.toLowerCase() === 'input') {
      const form = target.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        try {
          form.requestSubmit();
        } catch {
          // Fall back gracefully if form submission triggers validation errors
        }
      }
    }

    log(`Pressed key "${key}" on <${target.tagName.toLowerCase()}>`);
    return {
      success: true,
      action: 'pressKey',
      key,
      targetTag: target.tagName.toLowerCase()
    };
  } catch (err) {
    const errMsg = `PressKey execution failed: ${err.message}`;
    log(errMsg, true);
    return { success: false, action: 'pressKey', key, error: errMsg };
  }
}

// ============================================================================
// 6. NAVIGATION ACTION
// ============================================================================

/**
 * Safely navigates the active page to a destination URL.
 * Strictly verifies the URL protocol (whitelists http: and https:;
 * explicitly blocks javascript:, data:, file:, etc.).
 * 
 * @param {Object} command - { action: "navigate", url: "https://example.com" }
 * @returns {Promise<Object>}
 */
async function handleNavigate(command) {
  const rawUrl = command.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    const errUrl = "Missing or invalid 'url' parameter for navigation";
    log(`Navigate failed: ${errUrl}`, true);
    return { success: false, action: 'navigate', error: errUrl };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl, window.location.href);
  } catch (err) {
    const errParse = `Invalid URL format: ${err.message}`;
    log(`Navigate failed: ${errParse}`, true);
    return { success: false, action: 'navigate', error: errParse };
  }

  // Security whitelist: only allow standard web navigation schemes
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    const errProto = `Blocked navigation to disallowed protocol '${parsedUrl.protocol}'. Only http: and https: URLs are permitted.`;
    log(`Navigate failed: ${errProto}`, true);
    return { success: false, action: 'navigate', error: errProto };
  }

  try {
    log(`Navigating page to ${parsedUrl.href}`);
    window.location.href = parsedUrl.href;
    return {
      success: true,
      action: 'navigate',
      url: parsedUrl.href
    };
  } catch (err) {
    const errMsg = `Navigation failed: ${err.message}`;
    log(errMsg, true);
    return { success: false, action: 'navigate', error: errMsg };
  }
}

// ============================================================================
// PRIMARY DISPATCHER: EXECUTE ACTION
// ============================================================================

/**
 * Primary export: Receives an action command and delegates to the appropriate handler.
 * 
 * Supports both object signature:
 *   executeAction({ action: "click", elementId: "element-1" })
 * and legacy positional arguments:
 *   executeAction("type", "element-2", "Hello")
 * 
 * @param {Object|string} commandOrAction - Command object or action type name
 * @param {string} [elementIdOrSelector] - Element ID if using positional arguments
 * @param {*} [value] - Text/value payload if using positional arguments
 * @returns {Promise<Object>} Structured execution result
 */
export async function executeAction(commandOrAction, elementIdOrSelector, value) {
  // Normalize command parameters
  let command;
  if (typeof commandOrAction === 'object' && commandOrAction !== null) {
    command = { ...commandOrAction };
  } else if (typeof commandOrAction === 'string') {
    command = {
      action: commandOrAction,
      elementId: elementIdOrSelector,
      text: value,
      value
    };
  } else {
    return {
      success: false,
      action: 'unknown',
      error: 'Invalid action command: expected a command object'
    };
  }

  const action = (command.action || '').trim().toLowerCase();

  try {
    switch (action) {
      case 'click':
        return await handleClick(command);

      case 'type':
        return await handleType(command);

      case 'select':
        return await handleSelect(command);

      case 'scroll':
        return await handleScroll(command);

      case 'presskey':
      case 'press_key':
        return await handlePressKey(command);

      case 'navigate':
        return await handleNavigate(command);

      default:
        log(`Unknown action '${command.action}' requested`, true);
        return {
          success: false,
          action: command.action || 'unknown',
          error: `Unsupported action '${command.action}'. Supported actions: click, type, select, scroll, pressKey, navigate.`
        };
    }
  } catch (err) {
    log(`Unexpected error executing action '${action}': ${err.message}`, true);
    return {
      success: false,
      action,
      error: `Internal execution error: ${err.message}`
    };
  }
}
