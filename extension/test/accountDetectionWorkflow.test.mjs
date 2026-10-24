/**
 * Voice Browser Agent - Reliable DOM Observation & Account Detection Test Suite
 * 
 * Verifies all 9 requirements from Bug Fix 02:
 * A. Button labelled "My Account".
 * B. Icon-only account button with an accessible label (aria-label, title, svg, img alt, aria-labelledby).
 * C. Menu that appears after a delay.
 * D. Menu that opens only after clicking its trigger.
 * E. Duplicate account-like labels (disambiguation & unrelated match filtering).
 * F. Disabled or hidden button.
 * G. Target removed or replaced after observation (stale reference recovery).
 * H. Page where the account control genuinely does not exist.
 * I. YouTube Filters -> Live workflow regression.
 */

import { AgentController } from '../src/agent/agentController.js';
import { TaskStatus } from '../src/agent/taskState.js';
import {
  planNextAction,
  findClickableElements,
  isWeakOrUnrelatedMatch,
  canHandleDeterministically
} from '../src/agent/planner.js';
import { verifyAction } from '../src/agent/verifier.js';
import {
  getElementAccessibleName,
  isVisible,
  querySelectorAllDeep
} from '../src/content/observer.js';
import {
  resolveElement,
  reResolveElement
} from '../src/content/executor.js';

let passed = 0;
let failed = 0;

function assert(condition, testName, message) {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passed++;
  } else {
    console.error(`FAIL: ${testName} - ${message || 'Assertion failed'}`);
    failed++;
  }
}

// Simple in-memory mock DOM node for Node.js test environment
class MockDOMElement {
  constructor(tagName = 'button', attributes = {}, text = '') {
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attributes));
    this.textContent = text;
    this.innerText = text;
    this.children = [];
    this.parentNode = null;
    this.isConnected = true;
    this.disabled = Boolean(attributes.disabled);
    this.style = { display: attributes.display || 'block', visibility: 'visible', opacity: '1' };
    this.classList = {
      contains: (cls) => Boolean(attributes.class && attributes.class.split(' ').includes(cls))
    };
    this.shadowRoot = null;
    this.eventListeners = new Map();
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  setAttribute(name, val) {
    this.attributes.set(name, String(val));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const sub = child.querySelector(selector);
      if (sub) return sub;
    }
    return null;
  }

  querySelectorAll(selector) {
    const list = [];
    for (const child of this.children) {
      if (child.matches(selector)) list.push(child);
      list.push(...child.querySelectorAll(selector));
    }
    return list;
  }

  matches(selector) {
    const s = selector.toLowerCase();
    if (s === this.tagName.toLowerCase()) return true;
    if (s.startsWith('[') && s.endsWith(']')) {
      const attrMatch = s.slice(1, -1).split('=');
      const attrName = attrMatch[0];
      const attrVal = attrMatch[1] ? attrMatch[1].replace(/["']/g, '') : null;
      if (attrVal !== null) {
        return this.getAttribute(attrName) === attrVal;
      }
      return this.hasAttribute(attrName);
    }
    if (s === 'svg title' && this.tagName === 'TITLE' && this.parentNode?.tagName === 'SVG') return true;
    if (s.includes('img[alt]') && this.tagName === 'IMG' && this.hasAttribute('alt')) return true;
    return false;
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.matches && curr.matches(selector)) return curr;
      curr = curr.parentNode;
    }
    return null;
  }

  getBoundingClientRect() {
    if (this.style.display === 'none' || this.style.visibility === 'hidden' || this.getAttribute('hidden') !== null) {
      return { width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 };
    }
    return { width: 100, height: 40, top: 10, left: 10, bottom: 50, right: 110 };
  }

  scrollIntoView() {}
  focus() {}

  dispatchEvent(evt) {
    const handlers = this.eventListeners.get(evt.type) || [];
    for (const h of handlers) h(evt);
    return true;
  }

  addEventListener(type, handler) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, []);
    }
    this.eventListeners.get(type).push(handler);
  }

  click() {
    this.dispatchEvent({ type: 'click', bubbles: true, cancelable: true });
  }
}

// Set up global environment mocks for DOM testing in Node
globalThis.Element = MockDOMElement;
globalThis.window = {
  location: { href: 'https://example.com/dashboard', hostname: 'example.com' },
  getComputedStyle: (el) => el.style || { display: 'block', visibility: 'visible', opacity: '1' },
  scrollY: 0,
  pageXOffset: 0,
  pageYOffset: 0,
  innerHeight: 800
};
globalThis.document = {
  documentElement: { lang: 'en', scrollHeight: 1200 },
  body: new MockDOMElement('body'),
  title: 'Dashboard - Example',
  getElementById: (id) => null,
  querySelector: (sel) => null,
  querySelectorAll: (sel) => []
};
globalThis.MouseEvent = class {
  constructor(type, init) {
    this.type = type;
    this.bubbles = init?.bubbles ?? true;
  }
};

async function runAccountDetectionTests() {
  console.log('--- RUNNING RELIABLE DOM OBSERVATION & ACCOUNT DETECTION SUITE ---');

  // ==========================================================================
  // TEST A: Button labelled "My Account"
  // ==========================================================================
  {
    const snapshot = {
      page: { title: 'Online Store', url: 'https://store.example.com', hostname: 'store.example.com' },
      interactive: {
        buttons: [
          { id: 'btn-search', tag: 'button', text: 'Search' },
          { id: 'btn-account', tag: 'button', text: 'My Account', ariaLabel: 'My Account' },
          { id: 'btn-cart', tag: 'button', text: 'Cart (0)' }
        ],
        links: []
      }
    };

    // User says "click My Account"
    const plan1 = planNextAction('click My Account', snapshot);
    assert(
      plan1.status === 'ACTION' && plan1.action?.elementId === 'btn-account',
      'TEST A1 - Detects and plans click for button labelled "My Account"',
      `Status: ${plan1.status}, Target: ${plan1.action?.elementId}`
    );

    // User says "click Account" -> should still match "My Account" as exact synonym
    const plan2 = planNextAction('click Account', snapshot);
    assert(
      plan2.status === 'ACTION' && plan2.action?.elementId === 'btn-account',
      'TEST A2 - Matches "Account" query to "My Account" button without ambiguity error',
      `Status: ${plan2.status}, Target: ${plan2.action?.elementId}`
    );
  }

  // ==========================================================================
  // TEST B: Icon-only account button with accessible labels
  // ==========================================================================
  {
    // B1: aria-label="Account" with icon ligature "account_circle"
    const el1 = new MockDOMElement('button', { 'aria-label': 'Account' }, 'account_circle');
    const name1 = getElementAccessibleName(el1);
    assert(
      name1 === 'Account',
      'TEST B1 - Extracts accessible name from aria-label over icon font ligature "account_circle"',
      `Extracted: "${name1}"`
    );

    // B2: title="My Account" with icon ligature "person"
    const el2 = new MockDOMElement('button', { title: 'My Account' }, 'person');
    const name2 = getElementAccessibleName(el2);
    assert(
      name2 === 'My Account',
      'TEST B2 - Extracts title when text is icon font ligature "person"',
      `Extracted: "${name2}"`
    );

    // B3: Child SVG with <title>My Account</title>
    const el3 = new MockDOMElement('button');
    const svg = new MockDOMElement('svg');
    const title = new MockDOMElement('title', {}, 'My Account');
    svg.appendChild(title);
    el3.appendChild(svg);
    const name3 = getElementAccessibleName(el3);
    assert(
      name3 === 'My Account',
      'TEST B3 - Extracts accessible name from child SVG <title>',
      `Extracted: "${name3}"`
    );

    // B4: Child img with alt="Account Profile"
    const el4 = new MockDOMElement('button');
    const img = new MockDOMElement('img', { alt: 'Account Profile', src: '/avatar.png' });
    el4.appendChild(img);
    const name4 = getElementAccessibleName(el4);
    assert(
      name4 === 'Account Profile',
      'TEST B4 - Extracts accessible name from child avatar img[alt]',
      `Extracted: "${name4}"`
    );

    // B5: aria-labelledby referencing external label node
    const labelNode = new MockDOMElement('span', { id: 'user-acc-label' }, 'User Account');
    document.getElementById = (id) => (id === 'user-acc-label' ? labelNode : null);
    const el5 = new MockDOMElement('button', { 'aria-labelledby': 'user-acc-label' });
    const name5 = getElementAccessibleName(el5);
    assert(
      name5 === 'User Account',
      'TEST B5 - Extracts accessible name from aria-labelledby target',
      `Extracted: "${name5}"`
    );
  }

  // ==========================================================================
  // TEST C: Menu that appears after a delay
  // ==========================================================================
  {
    let callCount = 0;
    const initialSnapshot = {
      page: { title: 'Portal', url: 'https://portal.example.com', hostname: 'portal.example.com' },
      interactive: {
        buttons: [{ id: 'btn-acc-trigger', tag: 'button', text: 'Account', ariaHasPopup: 'menu' }],
        links: []
      }
    };

    const delayedSnapshot = {
      page: { title: 'Portal', url: 'https://portal.example.com', hostname: 'portal.example.com' },
      interactive: {
        buttons: [
          { id: 'btn-acc-trigger', tag: 'button', text: 'Account', ariaHasPopup: 'menu' },
          { id: 'item-profile', tag: 'button', text: 'Your Profile', inMenu: true },
          { id: 'item-settings', tag: 'button', text: 'Settings', inMenu: true }
        ],
        links: [
          { id: 'link-logout', text: 'Sign Out', href: 'https://portal.example.com/logout' }
        ]
      }
    };

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            callCount++;
            // First call: initial state
            if (callCount === 1) return { success: true, data: initialSnapshot };
            // Second call (immediate post-action): menu still rendering
            if (callCount === 2) return { success: true, data: initialSnapshot };
            // Third call: menu rendered after delay!
            return { success: true, data: delayedSnapshot };
          }
          if (msg.type === 'EXECUTE_ACTION') {
            return { success: true, result: { success: true, targetText: msg.action.targetText } };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    const result = await controller.startTask('click Account', { plannerMode: 'deterministic' });

    assert(
      result.status === TaskStatus.COMPLETED,
      'TEST C - Bounded wait successfully observes menu rendered after delay',
      `Status: ${result.status}`
    );
  }

  // ==========================================================================
  // TEST D: Menu that opens only after clicking its trigger
  // ==========================================================================
  {
    const prevSnapshot = {
      page: { title: 'Example', url: 'https://example.com' },
      interactive: {
        buttons: [{ id: 'acc-btn', tag: 'button', text: 'Account', ariaHasPopup: 'menu' }],
        links: []
      }
    };

    const currentSnapshot = {
      page: { title: 'Example', url: 'https://example.com' },
      interactive: {
        buttons: [
          { id: 'acc-btn', tag: 'button', text: 'Account', ariaHasPopup: 'menu' },
          { id: 'menu-orders', tag: 'button', text: 'Orders', inMenu: true },
          { id: 'menu-settings', tag: 'button', text: 'Account Settings', inMenu: true }
        ],
        links: [{ id: 'link-signout', text: 'Sign Out', href: '/logout' }]
      }
    };

    const action = { action: 'click', elementId: 'acc-btn', targetText: 'Account', opensMenu: true };
    const execResult = { success: true, action: 'click', elementId: 'acc-btn' };

    const verification = verifyAction(action, prevSnapshot, currentSnapshot, execResult);
    assert(
      verification.verified === true && verification.reason.includes('opened successfully'),
      'TEST D - Verifier confirms dynamic menu opened when new items appear in snapshot',
      `Verified: ${verification.verified}, Reason: "${verification.reason}"`
    );
  }

  // ==========================================================================
  // TEST E: Duplicate account-like labels & disambiguation
  // ==========================================================================
  {
    const snapshotWithUnrelated = {
      page: { title: 'Bank Services', url: 'https://example.com' },
      interactive: {
        buttons: [
          { id: 'btn-main-acc', tag: 'button', text: 'Account', ariaHasPopup: 'true' },
          { id: 'btn-del-acc', tag: 'button', text: 'Delete Account' }
        ],
        links: [
          { id: 'link-bank-acc', text: 'Open a Bank Account', href: '/banking' },
          { id: 'link-signup-acc', text: "Don't have an account? Sign up", href: '/register' }
        ]
      }
    };

    // E1: Unrelated match rejection test
    const { exactMatches, partialMatches } = findClickableElements('Account', snapshotWithUnrelated);
    assert(
      exactMatches.length === 1 && exactMatches[0].id === 'btn-main-acc' && partialMatches.length === 0,
      'TEST E1 - Ignores "Delete Account", "Bank Account", and "Sign up" when searching for "Account"',
      `Exact: ${exactMatches.map((m) => m.text).join(', ')}, Partial: ${partialMatches.map((m) => m.text).join(', ')}`
    );

    // E2: Planner clicks the right Account button without ambiguity error
    const plan = planNextAction('click Account', snapshotWithUnrelated);
    assert(
      plan.status === 'ACTION' && plan.action?.elementId === 'btn-main-acc',
      'TEST E2 - Deterministic planner targets main account button cleanly without false ambiguity',
      `Status: ${plan.status}, Target: ${plan.action?.elementId}`
    );

    // E3: Genuine ambiguity test - two distinct user profiles on page
    const ambiguousSnapshot = {
      page: { title: 'Multi Account', url: 'https://example.com' },
      interactive: {
        buttons: [
          { id: 'btn-acc-1', tag: 'button', text: 'Personal Account Profile' },
          { id: 'btn-acc-2', tag: 'button', text: 'Work Account Profile' }
        ],
        links: []
      }
    };

    const ambPlan = planNextAction('click Account Profile', ambiguousSnapshot);
    assert(
      ambPlan.status === 'ERROR' && ambPlan.error.includes('Ambiguous command'),
      'TEST E3 - Asks for clarification when two genuine profile candidates exist',
      `Error message: "${ambPlan.error}"`
    );
  }

  // ==========================================================================
  // TEST F: Disabled or hidden button
  // ==========================================================================
  {
    // F1: Disabled button in snapshot is filtered by planner
    const snapshotDisabled = {
      page: { title: 'Settings', url: 'https://example.com' },
      interactive: {
        buttons: [{ id: 'btn-acc-dis', tag: 'button', text: 'My Account', disabled: true }],
        links: []
      }
    };

    const planDisabled = planNextAction('click My Account', snapshotDisabled);
    assert(
      planDisabled.status === 'ERROR' && planDisabled.error.includes('Button not found on the current page'),
      'TEST F1 - Planner skips disabled account button and reports not found',
      `Error: "${planDisabled.error}"`
    );

    // F2: Executor visibility check
    const hiddenNode = new MockDOMElement('button', { hidden: 'true' }, 'My Account');
    hiddenNode.style.display = 'none';
    const isVis = isVisible(hiddenNode);
    assert(
      isVis === false,
      'TEST F2 - isVisible correctly flags element with display:none or hidden as invisible',
      `isVisible: ${isVis}`
    );
  }

  // ==========================================================================
  // TEST G: Target removed or replaced after observation (stale element recovery)
  // ==========================================================================
  {
    // Simulate a fresh DOM node created after a React re-render
    const liveReplacementNode = new MockDOMElement('button', { id: 'live-btn', 'aria-label': 'My Account' }, 'My Account');
    document.querySelectorAll = (sel) => {
      if (sel.includes('button')) return [liveReplacementNode];
      return [];
    };

    // Command from planner containing metadata
    const command = {
      action: 'click',
      elementId: 'stale-element-88',
      targetText: 'My Account',
      ariaLabel: 'My Account'
    };

    // Stale element recovery
    const recovered = reResolveElement(command);
    assert(
      recovered === liveReplacementNode,
      'TEST G - Live re-resolution locates replacement DOM element when registered node is stale',
      `Recovered element: <${recovered?.tagName}> text: "${recovered?.textContent}"`
    );
  }

  // ==========================================================================
  // TEST H: Page where the account control genuinely does not exist
  // ==========================================================================
  {
    const snapshotNoAccount = {
      page: { title: 'Public Article', url: 'https://example.com/article', hostname: 'example.com' },
      interactive: {
        buttons: [
          { id: 'btn-read', tag: 'button', text: 'Read More' },
          { id: 'btn-share', tag: 'button', text: 'Share' }
        ],
        links: [
          { id: 'link-home', text: 'Home', href: '/' }
        ]
      }
    };

    const plan = planNextAction('click My Account', snapshotNoAccount);
    assert(
      plan.status === 'ERROR' && plan.error.includes('Button not found on the current page'),
      'TEST H - Reports clear "Button not found on the current page." when no account control exists',
      `Error: "${plan.error}"`
    );
  }

  // ==========================================================================
  // TEST I: YouTube Filters -> Live workflow regression
  // ==========================================================================
  {
    const ytSnapshot = {
      page: { title: 'quantum computing - YouTube', url: 'https://www.youtube.com/results?search_query=quantum+computing' },
      interactive: {
        buttons: [
          { id: 'btn-filter', tag: 'button', text: 'Filters', ariaLabel: 'Search filters' },
          { id: 'chip-live', tag: 'button', text: 'Live', inMenu: false } // top chip
        ],
        links: []
      }
    };

    // Step 1: Compound command targets Filters button first when menu is closed
    const planStep1 = planNextAction('open Filters, and click Live', ytSnapshot);
    assert(
      planStep1.status === 'ACTION' && planStep1.action?.opensMenu === true,
      'TEST I1 - Regression: compound filter flow correctly plans opening Filters menu first',
      `Action: ${planStep1.action?.label || planStep1.action?.targetText}`
    );

    // Step 2: When menu is open, in-menu Live is prioritized over top-level chip
    const ytMenuOpenSnapshot = {
      page: { title: 'quantum computing - YouTube', url: 'https://www.youtube.com/results?search_query=quantum+computing' },
      interactive: {
        buttons: [
          { id: 'btn-filter', tag: 'button', text: 'Filters', ariaExpanded: 'true' },
          { id: 'chip-live', tag: 'button', text: 'Live', inMenu: false },
          { id: 'menu-live', tag: 'button', text: 'Live', inMenu: true, role: 'menuitem' }
        ],
        links: []
      }
    };

    const planStep2 = planNextAction('open Filters, and click Live', ytMenuOpenSnapshot);
    assert(
      planStep2.status === 'ACTION' && planStep2.action?.elementId === 'menu-live',
      'TEST I2 - Regression: targets in-menu Live option over top-level duplicate chip',
      `Target elementId: ${planStep2.action?.elementId}`
    );
  }

  console.log(`\n========================================`);
  console.log(`ACCOUNT DETECTION WORKFLOW SUITE: ${passed} passed, ${failed} failed.`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runAccountDetectionTests();
