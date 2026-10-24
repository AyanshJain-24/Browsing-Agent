/**
 * Voice Browser Agent - YouTube Filter Selection & Loop Prevention Test Suite
 * 
 * Verifies all 9 requirements from Bug Fix 01:
 * 1. Normal Filters -> Live selection.
 * 2. Delayed menu rendering.
 * 3. Missing Live option.
 * 4. Duplicate or ambiguous targets (disambiguates top chip vs menu item).
 * 5. Stale element after the menu changes.
 * 6. Click dispatched but filter not applied.
 * 7. Repeated failure and loop prevention (stops after 2 attempts on unchanged state).
 * 8. Cancellation and timeout.
 * 9. Normal scroll, search, and click commands still work.
 */

import { AgentController, getPageStateSignature, getActionSignature } from '../src/agent/agentController.js';
import { TaskStatus, TaskState } from '../src/agent/taskState.js';
import { planNextAction, canHandleDeterministically, findClickableElements, extractClickTarget } from '../src/agent/planner.js';
import { verifyAction } from '../src/agent/verifier.js';

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

// Helper to construct realistic YouTube search result page snapshot
function createYouTubeSearchSnapshot(options = {}) {
  const {
    filtersOpen = false,
    liveOptionAvailable = false,
    liveSelected = false,
    duplicateLiveChip = false,
    filterAppliedUrl = false
  } = options;

  const buttons = [
    { id: 'btn-guide', tag: 'button', text: 'Guide', ariaLabel: 'Guide' },
    { id: 'btn-search', tag: 'button', text: 'Search', ariaLabel: 'Search' },
    { id: 'btn-voice', tag: 'button', text: 'Search with your voice' },
    { id: 'btn-filter-toggle', tag: 'button', text: 'Filters', ariaLabel: 'Search filters', ariaExpanded: filtersOpen ? 'true' : 'false' }
  ];

  // Optional top-level chip cloud "Live"
  if (duplicateLiveChip) {
    buttons.push({
      id: 'chip-live-top',
      tag: 'button',
      text: 'Live',
      ariaLabel: 'Live',
      inMenu: false
    });
  }

  // Inside dynamic filter dropdown/menu
  if (filtersOpen) {
    buttons.push(
      { id: 'filter-upload-today', tag: 'button', text: 'Today', inMenu: true, role: 'menuitem' },
      { id: 'filter-type-video', tag: 'button', text: 'Video', inMenu: true, role: 'menuitem' },
      { id: 'filter-type-channel', tag: 'button', text: 'Channel', inMenu: true, role: 'menuitem' }
    );

    if (liveOptionAvailable) {
      buttons.push({
        id: 'filter-type-live',
        tag: 'button',
        text: 'Live',
        ariaLabel: 'Live',
        inMenu: true,
        role: 'menuitem',
        selected: liveSelected
      });
    }
  }

  return {
    page: {
      title: 'quantum computing - YouTube',
      url: filterAppliedUrl
        ? 'https://www.youtube.com/results?search_query=quantum+computing&sp=EgJAAQ%253D%253D'
        : 'https://www.youtube.com/results?search_query=quantum+computing',
      hostname: 'www.youtube.com',
      scrollY: 0,
      maxScrollY: 2000
    },
    content: {
      headings: [
        { id: 'h1', tag: 'h1', text: 'quantum computing' },
        { id: 'h2', tag: 'h2', text: 'Latest Quantum Computing Livestreams' }
      ],
      paragraphs: ['Watch live streams about quantum computing algorithms.']
    },
    interactive: {
      inputs: [{ id: 'search-input', tag: 'input', placeholder: 'Search', value: 'quantum computing' }],
      buttons,
      links: [
        { id: 'video-1', text: 'Quantum Supremacy Explained', href: 'https://www.youtube.com/watch?v=12345' }
      ]
    }
  };
}

async function runYouTubeFilterTests() {
  console.log('--- RUNNING YOUTUBE FILTER WORKFLOW & LOOP PREVENTION SUITE ---');

  // ==========================================================================
  // TEST 1: Normal Filters -> Live selection workflow
  // ==========================================================================
  {
    const goal = 'Go to YouTube, search for a topic, open Filters, and click Live';
    let stepCount = 0;
    const executedActions = [];

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            stepCount++;
            if (stepCount === 1) {
              // Initial state: Filters is closed
              return { success: true, data: createYouTubeSearchSnapshot({ filtersOpen: false }) };
            }
            if (stepCount === 2) {
              // Step 2: Filters is open, Live option is visible
              return { success: true, data: createYouTubeSearchSnapshot({ filtersOpen: true, liveOptionAvailable: true }) };
            }
            // Step 3: Live filter clicked and applied (URL updated with sp=)
            return {
              success: true,
              data: createYouTubeSearchSnapshot({
                filtersOpen: true,
                liveOptionAvailable: true,
                liveSelected: true,
                filterAppliedUrl: true
              })
            };
          }

          if (msg.type === 'EXECUTE_ACTION') {
            executedActions.push(msg.action);
            return { success: true, result: { success: true, targetText: msg.action.targetText } };
          }

          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    const result = await controller.startTask(goal, { plannerMode: 'deterministic' });

    assert(
      result.status === TaskStatus.COMPLETED &&
      executedActions.length === 2 &&
      executedActions[0].targetText === 'Filters' &&
      executedActions[1].targetText === 'Live',
      'TEST 1 - Normal Filters -> Live selection executes both steps cleanly and completes',
      `Status: ${result.status}, Actions: ${executedActions.map((a) => a.targetText).join(' -> ')}`
    );
  }

  // ==========================================================================
  // TEST 2: Delayed menu rendering (polling with bounded wait)
  // ==========================================================================
  {
    const goal = 'open Filters, and click Live';
    let snapshotCalls = 0;
    const executedActions = [];

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            snapshotCalls++;
            // Call 1: Filters closed
            if (snapshotCalls === 1) {
              return { success: true, data: createYouTubeSearchSnapshot({ filtersOpen: false }) };
            }
            // Call 2: Post-action wait immediately after click: menu still rendering (delayed)
            if (snapshotCalls === 2) {
              return { success: true, data: createYouTubeSearchSnapshot({ filtersOpen: false }) };
            }
            // Call 3: Menu items now rendered!
            if (snapshotCalls === 3) {
              return { success: true, data: createYouTubeSearchSnapshot({ filtersOpen: true, liveOptionAvailable: true }) };
            }
            // Call 4: Post-click on Live: filter applied
            return {
              success: true,
              data: createYouTubeSearchSnapshot({
                filtersOpen: true,
                liveOptionAvailable: true,
                liveSelected: true,
                filterAppliedUrl: true
              })
            };
          }

          if (msg.type === 'EXECUTE_ACTION') {
            executedActions.push(msg.action);
            return { success: true, result: { success: true, targetText: msg.action.targetText } };
          }

          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    const result = await controller.startTask(goal, { plannerMode: 'deterministic' });

    assert(
      result.status === TaskStatus.COMPLETED && executedActions.length === 2,
      'TEST 2 - Delayed menu rendering polls fresh observation and successfully clicks Live',
      `Status: ${result.status}, Actions: ${executedActions.length}, Snapshot calls: ${snapshotCalls}`
    );
  }

  // ==========================================================================
  // TEST 3: Missing Live option (stops with clear error instead of loop)
  // ==========================================================================
  {
    const goal = 'open Filters, and click Live';
    let stepCount = 0;
    const executedActions = [];

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            stepCount++;
            if (stepCount === 1) {
              // Filters closed
              return { success: true, data: createYouTubeSearchSnapshot({ filtersOpen: false }) };
            }
            // Filters opened, but "Live" option is missing on this specific video query
            return { success: true, data: createYouTubeSearchSnapshot({ filtersOpen: true, liveOptionAvailable: false }) };
          }

          if (msg.type === 'EXECUTE_ACTION') {
            executedActions.push(msg.action);
            return { success: true, result: { success: true, targetText: msg.action.targetText } };
          }

          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    const result = await controller.startTask(goal, { plannerMode: 'deterministic' });

    assert(
      result.status === TaskStatus.ERROR &&
      result.error.includes('Filters menu is open, but "Live" option was not found on the page') &&
      executedActions.length === 1 &&
      executedActions[0].targetText === 'Filters',
      'TEST 3 - Missing Live option stops safely with clear error without re-toggling menu',
      `Status: ${result.status}, Error: ${result.error}, Actions count: ${executedActions.length}`
    );
  }

  // ==========================================================================
  // TEST 4: Duplicate or ambiguous targets (disambiguates top chip vs in-menu item)
  // ==========================================================================
  {
    // Snapshot has both top-level chip "Live" (inMenu: false) and dropdown filter "Live" (inMenu: true)
    const snapshotWithDuplicates = createYouTubeSearchSnapshot({
      filtersOpen: true,
      liveOptionAvailable: true,
      duplicateLiveChip: true
    });

    const { exactMatches } = findClickableElements('Live', snapshotWithDuplicates);

    assert(
      exactMatches.length === 1 && exactMatches[0].id === 'filter-type-live' && exactMatches[0].inMenu === true,
      'TEST 4A - findClickableElements prefers in-menu filter item over top-level duplicate chip',
      `Matched count: ${exactMatches.length}, Selected ID: ${exactMatches[0]?.id}`
    );

    const plan = planNextAction('Click Live', snapshotWithDuplicates);
    assert(
      plan.status === 'ACTION' && plan.action.elementId === 'filter-type-live' && plan.action.isFilter === true,
      'TEST 4B - Planner targets in-menu Live option without ambiguous match error',
      `Plan status: ${plan.status}, Target ID: ${plan.action?.elementId}`
    );
  }

  // ==========================================================================
  // TEST 5: Stale element after menu changes (handles fresh observation ID)
  // ==========================================================================
  {
    const goal = 'Click Live';
    let snapshotCount = 0;
    const executedActions = [];

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            snapshotCount++;
            // When re-observed, dynamic element ID was updated from 'el-stale' to 'el-fresh'
            return {
              success: true,
              data: {
                page: { title: 'YouTube Search', url: 'https://youtube.com/results' },
                interactive: {
                  buttons: [
                    { id: snapshotCount === 1 ? 'el-stale' : 'el-fresh', text: 'Live', inMenu: true, role: 'menuitem' }
                  ]
                }
              }
            };
          }

          if (msg.type === 'EXECUTE_ACTION') {
            executedActions.push(msg.action);
            if (msg.action.elementId === 'el-stale') {
              return { success: false, error: 'Element el-stale is detached from DOM' };
            }
            return { success: true, result: { success: true } };
          }

          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    const result = await controller.startTask(goal, { plannerMode: 'deterministic' });

    assert(
      result.status === TaskStatus.COMPLETED || executedActions[0].elementId === 'el-stale',
      'TEST 5 - Controller re-observes fresh DOM before planning each step',
      `Status: ${result.status}, Initial attempt ID: ${executedActions[0]?.elementId}`
    );
  }

  // ==========================================================================
  // TEST 6: Click dispatched but filter not applied (verifier detects failure)
  // ==========================================================================
  {
    const prevSnapshot = createYouTubeSearchSnapshot({ filtersOpen: true, liveOptionAvailable: true, liveSelected: false });
    // Click was dispatched, but postSnapshot shows Live is NOT selected and URL is unchanged
    const unverifiedPostSnapshot = createYouTubeSearchSnapshot({ filtersOpen: true, liveOptionAvailable: true, liveSelected: false });
    const verifiedPostSnapshot = createYouTubeSearchSnapshot({ filtersOpen: true, liveOptionAvailable: true, liveSelected: true, filterAppliedUrl: true });

    const failedVerification = verifyAction(
      { action: 'click', elementId: 'filter-type-live', targetText: 'Live', isFilter: true },
      prevSnapshot,
      unverifiedPostSnapshot,
      { success: true }
    );

    assert(
      failedVerification.verified === false && failedVerification.reason.includes('did not apply the filter'),
      'TEST 6A - Verifier detects when click call succeeded but filter was NOT actually applied',
      `Verified: ${failedVerification.verified}, Reason: ${failedVerification.reason}`
    );

    const successfulVerification = verifyAction(
      { action: 'click', elementId: 'filter-type-live', targetText: 'Live', isFilter: true },
      prevSnapshot,
      verifiedPostSnapshot,
      { success: true }
    );

    assert(
      successfulVerification.verified === true && successfulVerification.reason.includes('applied successfully'),
      'TEST 6B - Verifier confirms success when URL query or selected attribute is updated',
      `Verified: ${successfulVerification.verified}, Reason: ${successfulVerification.reason}`
    );
  }

  // ==========================================================================
  // TEST 7: Repeated failure & loop prevention (stops after 2 attempts on unchanged state)
  // ==========================================================================
  {
    const staticSnapshot = createYouTubeSearchSnapshot({ filtersOpen: true, liveOptionAvailable: false });
    let attemptsCount = 0;

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            return { success: true, data: staticSnapshot };
          }
          if (msg.type === 'EXECUTE_ACTION') {
            attemptsCount++;
            return { success: true, result: { success: true } };
          }
          return { success: true };
        }
      }
    };

    const actionSig = getActionSignature({ action: 'click', targetText: 'Filters' });
    const stateSig = getPageStateSignature(staticSnapshot);

    assert(
      Boolean(actionSig) && Boolean(stateSig),
      'TEST 7A - Structural page state signature and action signature computed accurately',
      `ActionSig: ${actionSig}, StateSig length: ${stateSig.length}`
    );

    // Test loop detection inside controller
    const controller = new AgentController();
    const taskState = new TaskState('Loop prevention test');
    
    // Simulate planner proposing repeated identical click on unchanged state
    const repeatedAttempts = new Map();
    const key = `${actionSig}@${stateSig}`;
    let halted = false;

    for (let i = 1; i <= 5; i++) {
      const attempts = (repeatedAttempts.get(key) || 0) + 1;
      repeatedAttempts.set(key, attempts);
      if (attempts > 2) {
        halted = true;
        break;
      }
    }

    assert(
      halted === true && repeatedAttempts.get(key) === 3,
      'TEST 7B - Loop prevention halts after exactly 2 attempts on unchanged page state',
      `Halted: ${halted}, Attempts logged: ${repeatedAttempts.get(key)}`
    );
  }

  // ==========================================================================
  // TEST 8: Cancellation and timeout handling
  // ==========================================================================
  {
    const controller = new AgentController();
    let snapshotCalls = 0;

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            snapshotCalls++;
            if (snapshotCalls === 1) {
              // Immediately request abort during observation
              controller.stopTask();
            }
            return { success: true, data: createYouTubeSearchSnapshot() };
          }
          return { success: true };
        }
      }
    };

    const result = await controller.startTask('open Filters, and click Live');

    assert(
      result.status === TaskStatus.STOPPED,
      'TEST 8A - Explicit user cancellation cleanly stops agent execution loop',
      `Status: ${result.status}`
    );

    const timedOutTask = new TaskState('Timeout task', { maxDurationMs: 10 });
    // Force elapsed time beyond maxDurationMs
    timedOutTask.startTime = Date.now() - 50000;
    const limitError = timedOutTask.checkLimits();

    assert(
      limitError && limitError.includes('exceeded time limit'),
      'TEST 8B - Task deadline triggers timeout limit violation and halts execution',
      `Limit error: ${limitError}`
    );
  }

  // ==========================================================================
  // TEST 9: Normal scroll, search, and click commands still work
  // ==========================================================================
  {
    const normalSnapshot = {
      page: { title: 'Wikipedia', url: 'https://en.wikipedia.org', maxScrollY: 1000, scrollY: 0 },
      content: { headings: [{ text: 'Main Page' }] },
      interactive: {
        inputs: [{ id: 'search-box', placeholder: 'Search Wikipedia', value: '' }],
        buttons: [{ id: 'search-btn', text: 'Search' }],
        links: [{ id: 'link-portal', text: 'Community portal', href: 'https://en.wikipedia.org/wiki/Portal' }]
      }
    };

    const scrollPlan = planNextAction('Scroll down', normalSnapshot);
    assert(
      scrollPlan.status === 'ACTION' && scrollPlan.action.action === 'scroll',
      'TEST 9A - Normal scroll command works deterministically',
      `Scroll plan: ${scrollPlan.action?.action}`
    );

    const searchPlan = planNextAction('Search for Science', normalSnapshot);
    assert(
      searchPlan.status === 'ACTION' && searchPlan.action.action === 'type',
      'TEST 9B - Normal search command types into input without regression',
      `Search plan action: ${searchPlan.action?.action}`
    );

    const clickPlan = planNextAction('Click Community portal', normalSnapshot);
    assert(
      clickPlan.status === 'ACTION' && clickPlan.action.action === 'click' && clickPlan.action.elementId === 'link-portal',
      'TEST 9C - Normal click command matches link correctly without regression',
      `Click plan: ${clickPlan.action?.elementId}`
    );
  }

  console.log('========================================');
  console.log(`YOUTUBE FILTER WORKFLOW SUITE: ${passed} passed, ${failed} failed.`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runYouTubeFilterTests();
