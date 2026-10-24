/**
 * Comprehensive Automated Verification Suite for Phase 5 Deterministic Agent
 * 
 * Verifies all requirements:
 * 1. Clicking uniquely identified links across diverse natural phrasings
 * 2. Handling ambiguous links without clicking the wrong element (clarification requested)
 * 3. Handling missing links gracefully
 * 4. Handling stale element IDs with structured errors
 * 5. Waiting for navigation and verifying destination URLs
 * 6. Rejecting sensitive flight-booking and payment commands before executor invocation
 * 7. Enforcing action allowlist and rejecting malformed/unknown plans
 * 8. Ensuring failed actions never produce a completed status
 * 9. Regression checks for scrolling, finding text, and multi-step search
 */

import { planNextAction, isSensitiveAction, extractClickTarget } from '../src/agent/planner.js';
import { verifyAction } from '../src/agent/verifier.js';
import { TaskState, TaskStatus } from '../src/agent/taskState.js';
import { AgentController, ALLOWED_ACTIONS, waitForPostActionSnapshot } from '../src/agent/agentController.js';

// Mock snapshot generator
function createMockSnapshot(overrides = {}) {
  return {
    page: {
      title: 'Wikipedia, the free encyclopedia',
      url: 'https://en.wikipedia.org/wiki/Main_Page',
      hostname: 'en.wikipedia.org',
      scrollY: 0,
      scrollX: 0,
      maxScrollY: 2000,
      ...(overrides.page || {})
    },
    content: {
      headings: [
        { id: 'element-1', tag: 'h1', text: 'Welcome to Wikipedia' },
        { id: 'element-2', tag: 'h2', text: "From today's featured article" }
      ],
      paragraphs: [
        'The quick brown fox jumps over the lazy dog in quantum computing research.',
        'Wikipedia is a free online encyclopedia written and maintained by a community of volunteers.'
      ],
      ...(overrides.content || {})
    },
    interactive: {
      inputs: [
        { id: 'element-10', tag: 'input', type: 'search', name: 'search', placeholder: 'Search Wikipedia', value: '' }
      ],
      buttons: [
        { id: 'element-20', tag: 'button', text: 'Search', ariaLabel: 'Search' }
      ],
      links: [
        { id: 'element-30', text: 'Current events', href: 'https://en.wikipedia.org/wiki/Portal:Current_events' },
        { id: 'element-31', text: 'About Wikipedia', href: 'https://en.wikipedia.org/wiki/Wikipedia:About' }
      ],
      ...(overrides.interactive || {})
    }
  };
}

let passed = 0;
let failed = 0;

function assert(condition, testName, message) {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passed++;
  } else {
    console.error(`FAIL: ${testName} - ${message}`);
    failed++;
  }
}

console.log('--- RUNNING DETERMINISTIC AGENT REGRESSION SUITE ---');

// ============================================================================
// PART A: LINK CLICKING & NAVIGATION TESTS
// ============================================================================

// TEST 1: Click uniquely identified link with diverse phrasings
{
  const snapshot = createMockSnapshot();
  const taskState = new TaskState('Click Current events');

  // Phrasing 1: "Click Current events"
  const plan1 = planNextAction('Click Current events', snapshot, taskState);
  assert(
    plan1.status === 'ACTION' &&
    plan1.action.action === 'click' &&
    plan1.action.elementId === 'element-30' &&
    plan1.action.targetHref === 'https://en.wikipedia.org/wiki/Portal:Current_events' &&
    plan1.action.targetTag === 'a',
    'TEST 1A - Plan Click Link ("Click Current events")',
    `Expected valid click plan with targetHref, got: ${JSON.stringify(plan1)}`
  );

  // Phrasing 2: "Click Current events link"
  const plan2 = planNextAction('Click Current events link', snapshot, taskState);
  assert(
    plan2.status === 'ACTION' && plan2.action.elementId === 'element-30',
    'TEST 1B - Plan Click Link with trailing "link"',
    `Expected match on element-30, got: ${JSON.stringify(plan2)}`
  );

  // Phrasing 3: "Click on the Current events link"
  const plan3 = planNextAction('Click on the Current events link', snapshot, taskState);
  assert(
    plan3.status === 'ACTION' && plan3.action.elementId === 'element-30',
    'TEST 1C - Plan Click Link with "Click on the ... link"',
    `Expected match on element-30, got: ${JSON.stringify(plan3)}`
  );

  // Phrasing 4: "Click link Current events"
  const plan4 = planNextAction('Click link Current events', snapshot, taskState);
  assert(
    plan4.status === 'ACTION' && plan4.action.elementId === 'element-30',
    'TEST 1D - Plan Click Link with "Click link ..."',
    `Expected match on element-30, got: ${JSON.stringify(plan4)}`
  );

  // Phrasing 5: "Click the 'Current events' link"
  const plan5 = planNextAction("Click the 'Current events' link", snapshot, taskState);
  assert(
    plan5.status === 'ACTION' && plan5.action.elementId === 'element-30',
    'TEST 1E - Plan Click Link with quotes and qualifiers',
    `Expected match on element-30, got: ${JSON.stringify(plan5)}`
  );

  // Outcome Verification when navigation succeeds
  const destSnapshot = createMockSnapshot({
    page: { url: 'https://en.wikipedia.org/wiki/Portal:Current_events', title: 'Current events - Wikipedia' }
  });
  const execResult = { success: true, action: 'click', elementId: 'element-30' };
  const verification = verifyAction(plan1.action, snapshot, destSnapshot, execResult);

  assert(
    verification.verified && verification.reason.toLowerCase().includes('navigation to'),
    'TEST 1F - Verify Click Navigation Success',
    `Expected navigation verification, got: ${verification.reason}`
  );
}

// TEST 2: Handling ambiguous links without clicking the wrong element
{
  const ambiguousSnapshot = createMockSnapshot({
    interactive: {
      links: [
        { id: 'element-40', text: 'Help', href: 'https://en.wikipedia.org/wiki/Help:Contents' },
        { id: 'element-41', text: 'Help', href: 'https://en.wikipedia.org/wiki/Wikipedia:Help_desk' }
      ]
    }
  });
  const taskState = new TaskState('Click Help');
  const plan = planNextAction('Click Help', ambiguousSnapshot, taskState);

  assert(
    plan.status === 'ERROR' && plan.error.includes('Ambiguous command'),
    'TEST 2A - Ambiguous Exact Link Match Stops Safely',
    `Expected ambiguous error, got: ${JSON.stringify(plan)}`
  );

  // Multiple partial matches
  const partialSnapshot = createMockSnapshot({
    interactive: {
      links: [
        { id: 'element-50', text: 'Donate to Wikipedia', href: 'https://donate.wikimedia.org' },
        { id: 'element-51', text: 'Contact Wikipedia', href: 'https://en.wikipedia.org/wiki/Wikipedia:Contact_us' }
      ]
    }
  });
  const planPartial = planNextAction('Click Wikipedia', partialSnapshot, taskState);
  assert(
    planPartial.status === 'ERROR' && planPartial.error.includes('Ambiguous command'),
    'TEST 2B - Ambiguous Partial Link Match Stops Safely',
    `Expected ambiguous error for multiple partial matches, got: ${JSON.stringify(planPartial)}`
  );
}

// TEST 3: Handling a missing link gracefully
{
  const snapshot = createMockSnapshot();
  const taskState = new TaskState('Click Nonexistent Link');
  const plan = planNextAction('Click Nonexistent Link', snapshot, taskState);

  assert(
    plan.status === 'ERROR' && plan.error.includes('No button or link matching'),
    'TEST 3 - Missing Link Handled Gracefully',
    `Expected clear missing element error, got: ${plan.error}`
  );
}

// TEST 4: Handling stale element ID during execution and verification
{
  const prevSnapshot = createMockSnapshot();
  const currentSnapshot = createMockSnapshot();
  const staleAction = { action: 'click', elementId: 'element-999', targetHref: 'https://example.com' };
  const staleExecResult = {
    success: false,
    action: 'click',
    elementId: 'element-999',
    error: "Element 'element-999' not found in registry. The page may have changed or the element was never registered."
  };

  const verification = verifyAction(staleAction, prevSnapshot, currentSnapshot, staleExecResult);
  assert(
    verification.verified === false && verification.reason.includes('not found in registry'),
    'TEST 4 - Stale Element ID Rejected By Verifier',
    `Expected stale element failure, got: ${verification.reason}`
  );
}

// TEST 5: Waiting for navigation and verifying destination
{
  const prevSnapshot = createMockSnapshot({ page: { url: 'https://en.wikipedia.org/wiki/Main_Page' } });
  const plannedAction = {
    action: 'click',
    elementId: 'element-30',
    targetText: 'Current events',
    targetHref: 'https://en.wikipedia.org/wiki/Portal:Current_events',
    targetTag: 'a'
  };

  // Case 5A: Navigation failed (URL remained unchanged) -> MUST FAIL verification
  const failedNavSnapshot = createMockSnapshot({ page: { url: 'https://en.wikipedia.org/wiki/Main_Page' } });
  const execResult = { success: true, action: 'click', elementId: 'element-30' };
  const failedVerification = verifyAction(plannedAction, prevSnapshot, failedNavSnapshot, execResult);

  assert(
    failedVerification.verified === false && failedVerification.reason.includes('did not cause expected navigation'),
    'TEST 5A - Click without Navigation Fails Verification',
    `Expected verification failure when URL does not change, got: ${JSON.stringify(failedVerification)}`
  );

  // Case 5B: Navigation succeeded -> MUST PASS verification
  const successNavSnapshot = createMockSnapshot({ page: { url: 'https://en.wikipedia.org/wiki/Portal:Current_events' } });
  const successVerification = verifyAction(plannedAction, prevSnapshot, successNavSnapshot, execResult);

  assert(
    successVerification.verified === true && successVerification.reason.includes('navigation to'),
    'TEST 5B - Click with Successful Navigation Passes Verification',
    `Expected verification success, got: ${JSON.stringify(successVerification)}`
  );
}

// ============================================================================
// PART B: UNSUPPORTED COMMAND SAFETY & ALLOWLIST TESTS
// ============================================================================

// TEST 6: Rejecting flight-booking and payment commands before executor invocation
{
  const snapshot = createMockSnapshot();
  const taskState = new TaskState('Book me a flight to Tokyo and pay for it');

  const plan = planNextAction('Book me a flight to Tokyo and pay for it', snapshot, taskState);
  assert(
    plan.status === 'ERROR' &&
    plan.requiresApproval === true &&
    plan.error.toLowerCase().includes('sensitive action'),
    'TEST 6A - Planner Rejects Flight Booking & Payment Command',
    `Expected sensitive action rejection with requiresApproval, got: ${JSON.stringify(plan)}`
  );

  // Test other sensitive variations
  const planPay = planNextAction('Pay for this order now', snapshot, taskState);
  assert(
    planPay.status === 'ERROR' && planPay.requiresApproval === true,
    'TEST 6B - Planner Rejects Direct Payment Command',
    `Expected sensitive action rejection, got: ${JSON.stringify(planPay)}`
  );

  const planDelete = planNextAction('Delete account now', snapshot, taskState);
  assert(
    planDelete.status === 'ERROR' && planDelete.requiresApproval === true,
    'TEST 6C - Planner Rejects Destructive Deletion Command',
    `Expected sensitive action rejection, got: ${JSON.stringify(planDelete)}`
  );
}

// TEST 7: AgentController rejects sensitive command WITHOUT calling executor
{
  let executorCallCount = 0;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === 'GET_PAGE_SNAPSHOT') {
          return { success: true, data: createMockSnapshot() };
        }
        if (msg.type === 'EXECUTE_ACTION') {
          executorCallCount++;
          return { success: true };
        }
        return { success: true };
      }
    }
  };

  const controller = new AgentController();
  const result = await controller.startTask('Book me a flight to Tokyo and pay for it');

  assert(
    (result.status === TaskStatus.ERROR || result.status === TaskStatus.WAITING_FOR_APPROVAL) &&
    executorCallCount === 0 &&
    (result.error || result.statusMessage || '').toLowerCase().includes('sensitive action'),
    'TEST 7 - Controller Stops Sensitive Command Before Executor Call',
    `Expected ERROR or WAITING_FOR_APPROVAL status and 0 executor calls, got status: ${result.status}, executor calls: ${executorCallCount}`
  );
}

// TEST 8: Action allowlist enforcement and malformed plan rejection
{
  assert(
    ALLOWED_ACTIONS.has('click') &&
    ALLOWED_ACTIONS.has('type') &&
    ALLOWED_ACTIONS.has('select') &&
    ALLOWED_ACTIONS.has('scroll') &&
    ALLOWED_ACTIONS.has('presskey') &&
    ALLOWED_ACTIONS.has('navigate'),
    'TEST 8A - Allowed Actions Set Contains Standard Primitives',
    `ALLOWED_ACTIONS contents: ${Array.from(ALLOWED_ACTIONS).join(', ')}`
  );

  assert(
    !ALLOWED_ACTIONS.has('executescript') &&
    !ALLOWED_ACTIONS.has('eval') &&
    !ALLOWED_ACTIONS.has('download'),
    'TEST 8B - Dangerous Actions Excluded From Allowlist',
    'Dangerous action types must not be in ALLOWED_ACTIONS'
  );

  const malformedPlanResult = verifyAction({ action: 'unknownDangerousAction' }, createMockSnapshot(), createMockSnapshot(), { success: true });
  assert(
    malformedPlanResult.verified === false && malformedPlanResult.reason.includes('Unknown'),
    'TEST 8C - Unknown Action Rejected By Verifier',
    `Expected unverified rejection for unknown action, got: ${malformedPlanResult.reason}`
  );
}

// TEST 9: Ensuring failed actions cannot produce completed status
{
  let executorAttempted = false;
  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === 'GET_PAGE_SNAPSHOT') {
          return { success: true, data: createMockSnapshot() };
        }
        if (msg.type === 'EXECUTE_ACTION') {
          executorAttempted = true;
          return { success: false, error: 'Target element was detached from document.' };
        }
        return { success: true };
      }
    }
  };

  const controller = new AgentController();
  const result = await controller.startTask('Click Current events');

  assert(
    result.status === TaskStatus.ERROR && result.status !== TaskStatus.COMPLETED,
    'TEST 9A - Failed Execution Cannot Produce Completed Status',
    `Expected ERROR status, got: ${result.status}`
  );
  assert(
    executorAttempted && result.error.includes('Target element was detached'),
    'TEST 9B - Failure Reason Faithfully Recorded',
    `Expected failure details in error, got: ${result.error}`
  );
}

// ============================================================================
// PART C: REGRESSION CHECKS (SCROLL, FIND TEXT, SEARCH, LIMITS)
// ============================================================================

// TEST 10: Scroll down and verify page position changes
{
  const snapshot1 = createMockSnapshot({ page: { scrollY: 0, maxScrollY: 2000 } });
  const taskState = new TaskState('Scroll down');
  const plan = planNextAction('Scroll down', snapshot1, taskState);

  assert(
    plan.status === 'ACTION' && plan.action.action === 'scroll' && plan.action.direction === 'down',
    'TEST 10A - Plan Scroll Down',
    'Expected scroll down action'
  );

  const snapshot2 = createMockSnapshot({ page: { scrollY: 500, maxScrollY: 2000 } });
  const execResult = { success: true, action: 'scroll', direction: 'down', amount: 500 };
  const verification = verifyAction(plan.action, snapshot1, snapshot2, execResult);

  assert(
    verification.verified && verification.details.currentY === 500,
    'TEST 10B - Verify Scroll Down Position',
    `Expected scroll position change verified, got: ${verification.reason}`
  );
}

// TEST 11: Scroll up and verify page position changes
{
  const snapshot1 = createMockSnapshot({ page: { scrollY: 800, maxScrollY: 2000 } });
  const taskState = new TaskState('Scroll up');
  const plan = planNextAction('Scroll up', snapshot1, taskState);

  assert(
    plan.status === 'ACTION' && plan.action.action === 'scroll' && plan.action.direction === 'up',
    'TEST 11A - Plan Scroll Up',
    'Expected scroll up action'
  );

  const snapshot2 = createMockSnapshot({ page: { scrollY: 300, maxScrollY: 2000 } });
  const execResult = { success: true, action: 'scroll', direction: 'up', amount: 500 };
  const verification = verifyAction(plan.action, snapshot1, snapshot2, execResult);

  assert(
    verification.verified && verification.details.currentY === 300,
    'TEST 11B - Verify Scroll Up Position',
    `Expected scroll up position change verified, got: ${verification.reason}`
  );
}

// TEST 12: Find visible text on page (paragraphs and headings)
{
  const snapshot = createMockSnapshot();
  const taskState = new TaskState('Find quantum computing on this page');
  const plan = planNextAction('Find quantum computing on this page', snapshot, taskState);

  assert(
    plan.status === 'DONE' && plan.result.title.includes('Found text'),
    'TEST 12 - Find Visible Text in Paragraphs',
    `Expected found text result, got status: ${plan.status}`
  );
}

// TEST 13: Search using an identifiable search input (multi-step type + submit)
{
  const snapshot1 = createMockSnapshot();
  const taskState = new TaskState('Search for IIT Guwahati');

  // Step 1: Type query
  const plan1 = planNextAction('Search for IIT Guwahati', snapshot1, taskState);
  assert(
    plan1.status === 'ACTION' && plan1.action.action === 'type' && plan1.action.text === 'IIT Guwahati',
    'TEST 13A - Search Step 1 (Type)',
    `Expected type action on search input, got ${JSON.stringify(plan1)}`
  );

  // Step 2: Query already typed -> press Enter to submit
  const snapshot2 = createMockSnapshot({
    interactive: {
      inputs: [
        { id: 'element-10', tag: 'input', type: 'search', name: 'search', value: 'IIT Guwahati' }
      ]
    }
  });
  const plan2 = planNextAction('Search for IIT Guwahati', snapshot2, taskState);
  assert(
    plan2.status === 'ACTION' && plan2.action.action === 'pressKey' && plan2.action.key === 'Enter',
    'TEST 13B - Search Step 2 (Submit)',
    `Expected pressKey Enter, got ${JSON.stringify(plan2)}`
  );
}

// TEST 14: General unsupported command handled cleanly
{
  const snapshot = createMockSnapshot();
  const taskState = new TaskState('Summarize European history');
  const plan = planNextAction('Summarize European history', snapshot, taskState);

  assert(
    plan.status === 'ERROR' && plan.error.includes('Unsupported command'),
    'TEST 14 - Generic Unsupported Command Handled Cleanly',
    `Expected unsupported command rejection, got: ${plan.error}`
  );
}

// TEST 15: Safety limits enforced
{
  const taskState = new TaskState('Scroll down', { maxActions: 2, maxDurationMs: 50 });
  taskState.recordStepStart('Step 1', { action: 'scroll' });
  taskState.recordStepSuccess('ok');
  taskState.recordStepStart('Step 2', { action: 'scroll' });
  taskState.recordStepSuccess('ok');

  const actionLimitErr = taskState.checkLimits();
  assert(
    actionLimitErr !== null && actionLimitErr.includes('safety limit of 2 actions'),
    'TEST 15A - Max Actions Limit Reached',
    `Expected max actions violation, got: ${actionLimitErr}`
  );

  const timedOutState = new TaskState('Long task', { maxDurationMs: 1 });
  const start = Date.now();
  while (Date.now() - start < 10) {}
  const timeLimitErr = timedOutState.checkLimits();

  assert(
    timeLimitErr !== null && timeLimitErr.includes('exceeded time limit'),
    'TEST 15B - Duration Timeout Limit Reached',
    `Expected timeout violation, got: ${timeLimitErr}`
  );
}

// ============================================================================
// PART D: SAFETY TEST 5 REGRESSION (AMAZON / ACER LAPTOP PAGE CONTEXT FIX)
// ============================================================================

// TEST 16A: Harmless product page without Delete Account button -> reports missing button, performs NO click
{
  let executorCallCount = 0;
  const harmlessSnapshot = createMockSnapshot({
    page: {
      url: 'https://www.example.com/products/acer-swift-go-14',
      title: 'Acer Swift Go 14 Laptop - TechStore',
      hostname: 'example.com'
    },
    interactive: {
      buttons: [
        { id: 'element-1', text: 'Add to Cart', tag: 'button' },
        { id: 'element-2', text: 'Filter by Price', tag: 'button' },
        { id: 'element-3', text: 'Acer Swift Go 14 (₹47,990) Specs', tag: 'button' }
      ],
      links: [
        { id: 'element-4', text: 'Customer Reviews', href: 'https://www.example.com/reviews' },
        { id: 'element-5', text: 'Back to Laptops', href: 'https://www.example.com/laptops' }
      ]
    }
  });

  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === 'GET_PAGE_SNAPSHOT') {
          return { success: true, data: harmlessSnapshot };
        }
        if (msg.type === 'EXECUTE_ACTION') {
          executorCallCount++;
          return { success: true };
        }
        return { success: true };
      }
    }
  };

  const controller = new AgentController();
  const result = await controller.startTask('find and click a "Delete Account" button');

  assert(
    result.status === TaskStatus.ERROR,
    'TEST 16A1 - Missing Delete Account button returns ERROR status on harmless page',
    `Expected ERROR status, got: ${result.status}`
  );

  assert(
    result.error.includes('Button not found on the current page'),
    'TEST 16A2 - Error message explicitly reports button not found on current page',
    `Expected "Button not found on the current page", got: ${result.error}`
  );

  assert(
    executorCallCount === 0,
    'TEST 16A3 - No click action was performed by executor',
    `Expected 0 executor calls, got: ${executorCallCount}`
  );

  assert(
    result.status !== TaskStatus.WAITING_FOR_APPROVAL,
    'TEST 16A4 - Did not trigger waiting for approval modal for non-existent button',
    `Status was unexpectedly: ${result.status}`
  );

  // Active tab diagnostics confirmed
  assert(
    controller.activeTabInfo && controller.activeTabInfo.url.includes('acer-swift-go-14'),
    'TEST 16A5 - Active tab URL confirmed from live snapshot in diagnostics',
    `Active tab: ${JSON.stringify(controller.activeTabInfo)}`
  );
}

// TEST 16B: Consequential action confirmation when button genuinely exists on page
{
  let executorCallCount = 0;
  const pageWithDeleteBtn = createMockSnapshot({
    page: {
      url: 'https://example.com/settings/profile',
      title: 'Account Settings - Profile',
      hostname: 'example.com'
    },
    interactive: {
      buttons: [
        { id: 'element-del', text: 'Delete Account', tag: 'button' },
        { id: 'element-save', text: 'Save Changes', tag: 'button' }
      ],
      links: []
    }
  });

  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === 'GET_PAGE_SNAPSHOT') {
          return { success: true, data: pageWithDeleteBtn };
        }
        if (msg.type === 'EXECUTE_ACTION') {
          executorCallCount++;
          return { success: true };
        }
        return { success: true };
      }
    }
  };

  const controller = new AgentController();
  const result = await controller.startTask('find and click a "Delete Account" button');

  assert(
    result.status === TaskStatus.WAITING_FOR_APPROVAL,
    'TEST 16B1 - Genuinely existing Delete Account button transitions to WAITING_FOR_APPROVAL',
    `Expected WAITING_FOR_APPROVAL, got: ${result.status}`
  );

  assert(
    result.status === TaskStatus.WAITING_FOR_APPROVAL && controller.pendingApprovalAction?.elementId === 'element-del',
    'TEST 16B2 - Requires approval targeting actual Delete Account element ID',
    `Pending action: ${JSON.stringify(controller.pendingApprovalAction)}`
  );

  assert(
    executorCallCount === 0,
    'TEST 16B3 - Consequential action requires confirmation before executor call',
    `Expected 0 executor calls before approval, got: ${executorCallCount}`
  );
}

// TEST 16C: Weak text match rejection: never treat an unrelated product or search result as the requested target
{
  let executorCallCount = 0;
  const productPageWithWeakMatch = createMockSnapshot({
    page: {
      url: 'https://www.amazon.in/Acer-Swift-Go-Laptop/dp/B012345678',
      title: 'Amazon.in: Acer Swift Go 14 Laptop',
      hostname: 'amazon.in'
    },
    interactive: {
      buttons: [
        // Candidate with weak text overlap (e.g. price, laptop title)
        { id: 'element-acer-card', text: 'Acer Swift Go 14 (₹47,990) - Buy Now', tag: 'button' },
        { id: 'element-cart', text: 'Add to Cart', tag: 'button' }
      ],
      links: [
        { id: 'element-search', text: 'Back to Amazon search results for Acer laptops', href: 'https://www.amazon.in/s?k=acer' }
      ]
    }
  });

  globalThis.chrome = {
    runtime: {
      sendMessage: async (msg) => {
        if (msg.type === 'GET_PAGE_SNAPSHOT') {
          return { success: true, data: productPageWithWeakMatch };
        }
        if (msg.type === 'EXECUTE_ACTION') {
          executorCallCount++;
          return { success: true };
        }
        return { success: true };
      }
    }
  };

  const controller = new AgentController();
  const result = await controller.startTask('find and click a "Delete Account" button');

  assert(
    result.status === TaskStatus.ERROR && result.error.includes('Button not found on the current page'),
    'TEST 16C1 - Weak match on Amazon Acer laptop product card is safely rejected',
    `Expected error with Button not found, got: ${result.error}`
  );

  assert(
    executorCallCount === 0,
    'TEST 16C2 - Never clicked unrelated product button based on weak text match',
    `Executor call count: ${executorCallCount}`
  );
}

console.log(`\n========================================`);
console.log(`TOTAL TEST RESULTS: ${passed} passed, ${failed} failed.`);
console.log(`========================================`);

if (failed > 0) {
  process.exit(1);
}
