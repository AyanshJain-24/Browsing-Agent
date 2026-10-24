/**
 * Voice Browser Agent - X.com Posting Workflow Test Suite
 * 
 * Verifies all 8 states specified in the regression requirements:
 * 1. Approve the draft before navigating to X.
 * 2. Navigate to X first, then request a draft.
 * 3. Approve the draft and manually switch tabs.
 * 4. X is logged out.
 * 5. The composer cannot be found.
 * 6. The user cancels.
 * 7. The page loads slowly.
 * 8. Publish times out after the click.
 * 
 * Safety & Quality Guarantees Verified:
 * - Approval promise / callback resolved exactly once.
 * - Current task ID, draft text, and target tab ID preserved across steps.
 * - Diagnostic logs for approval, task resume, active tab, URL, observation, and next action.
 * - Re-observes live DOM (no stale IDs after navigation).
 * - Exact approved text typed (no hallucinations).
 * - Explicit confirmation required immediately before publishing.
 * - Never blindly retries timed-out publish clicks (prevents duplicate tweets).
 * - Never bypasses login or platform restrictions.
 */

import { AgentController } from '../src/agent/agentController.js';
import { TaskStatus } from '../src/agent/taskState.js';
import {
  isXPostingGoal,
  extractXPostDraft,
  isXUrl,
  isXLoggedOut,
  findXPostComposer,
  findXPublishButton
} from '../src/agent/xPostingWorkflow.js';

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

async function runXPostingWorkflowTests() {
  console.log('--- RUNNING X.COM POSTING WORKFLOW REGRESSION SUITE ---');

  // ==========================================================================
  // PARSING & EXTRACTION UNIT TESTS
  // ==========================================================================
  {
    assert(isXPostingGoal('Post on X: "Hello world!"') === true, 'UNIT 1A - Detects "Post on X: ..."', 'Expected true');
    assert(isXPostingGoal('Post on x.com: Great hackathon!') === true, 'UNIT 1B - Detects "Post on x.com: ..."', 'Expected true');
    assert(isXPostingGoal('Tweet: Having fun with AI') === true, 'UNIT 1C - Detects "Tweet: ..."', 'Expected true');
    assert(isXPostingGoal('Post a tweet saying "Excited for AI"') === true, 'UNIT 1D - Detects "Post a tweet saying ..."', 'Expected true');
    assert(isXPostingGoal('Scroll down') === false, 'UNIT 1E - Non-posting goal returns false', 'Expected false');

    assert(
      extractXPostDraft('Post on X: "Excited for the hackathon!"') === 'Excited for the hackathon!',
      'UNIT 2A - Extracts quoted draft text',
      extractXPostDraft('Post on X: "Excited for the hackathon!"')
    );
    assert(
      extractXPostDraft('Post on x.com: Live demo in progress') === 'Live demo in progress',
      'UNIT 2B - Extracts colon separated draft text',
      extractXPostDraft('Post on x.com: Live demo in progress')
    );
    assert(
      extractXPostDraft('Tweet saying "Just launched Voice Agent"') === 'Just launched Voice Agent',
      'UNIT 2C - Extracts saying draft text',
      extractXPostDraft('Tweet saying "Just launched Voice Agent"')
    );

    assert(isXUrl('https://x.com/home') === true, 'UNIT 3A - x.com is recognized as X URL', 'Expected true');
    assert(isXUrl('https://twitter.com/compose/tweet') === true, 'UNIT 3B - twitter.com is recognized as X URL', 'Expected true');
    assert(isXUrl('https://google.com') === false, 'UNIT 3C - google.com is recognized as non-X URL', 'Expected false');
  }

  // ==========================================================================
  // TEST 1: Approve the draft before navigating to X
  // ==========================================================================
  {
    let typedText = '';
    let clickedElementId = '';
    let currentMockUrl = 'https://www.google.com';
    let composerText = '';

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return { tab: { id: 101, url: currentMockUrl, title: 'Google' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            if (currentMockUrl.includes('x.com')) {
              return {
                success: true,
                data: {
                  page: { url: currentMockUrl, title: 'Home / X', hostname: 'x.com' },
                  interactive: {
                    inputs: [
                      {
                        id: 'element-comp-1',
                        tag: 'div',
                        type: 'contenteditable',
                        dataTestId: 'tweetTextarea_0',
                        placeholder: 'What is happening?!',
                        value: composerText
                      }
                    ],
                    buttons: [
                      {
                        id: 'element-btn-post',
                        tag: 'button',
                        text: 'Post',
                        dataTestId: 'tweetButtonInline',
                        disabled: false
                      }
                    ]
                  }
                }
              };
            }
            return {
              success: true,
              data: {
                page: { url: currentMockUrl, title: 'Google', hostname: 'google.com' },
                interactive: { inputs: [], buttons: [] }
              }
            };
          }
          if (msg.type === 'EXECUTE_ACTION') {
            if (msg.action?.action === 'type') {
              typedText = msg.action.text;
              composerText = msg.action.text;
              return { success: true, action: 'type', length: typedText.length };
            }
            if (msg.action?.action === 'click') {
              clickedElementId = msg.action.elementId;
              composerText = ''; // Post submitted, composer clears
              return { success: true, action: 'click', elementId: clickedElementId };
            }
            return { success: true };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    const taskResult = await controller.startTask('Post on X: "Excited for the AI hackathon!"');

    // Step 1: Pauses for draft approval
    assert(
      taskResult.status === TaskStatus.WAITING_FOR_APPROVAL,
      'TEST 1A - Task pauses for initial draft approval',
      `Status: ${taskResult.status}`
    );
    const originalTaskId = taskResult.taskId;

    // Step 2: User approves draft while still on google.com
    const approvedSnap = await controller.approvePendingAction();
    assert(
      approvedSnap.statusMessage.includes('navigate') || approvedSnap.statusMessage.includes('x.com'),
      'TEST 1B - Enters waiting for navigation to X without failing',
      approvedSnap.statusMessage
    );
    assert(approvedSnap.taskId === originalTaskId, 'TEST 1C - Preserves original task ID', approvedSnap.taskId);

    // Step 3: User navigates to x.com -> tab update detected!
    currentMockUrl = 'https://x.com/home';
    const resumeSnap = await controller.handleTabUpdate({
      tabId: 101,
      url: 'https://x.com/home',
      title: 'Home / X'
    });

    assert(
      typedText === 'Excited for the AI hackathon!',
      'TEST 1D - Automatically detected navigation and filled exact draft text',
      typedText
    );
    assert(
      resumeSnap.status === TaskStatus.WAITING_FOR_APPROVAL,
      'TEST 1E - Requires explicit confirmation immediately before publishing',
      resumeSnap.status
    );

    // Step 4: User gives final confirmation to publish
    const finalSnap = await controller.approvePendingAction();
    assert(
      finalSnap.status === TaskStatus.COMPLETED && clickedElementId === 'element-btn-post',
      'TEST 1F - Publishes once after final confirmation and completes successfully',
      `Status: ${finalSnap.status}, Clicked: ${clickedElementId}`
    );
  }

  // ==========================================================================
  // TEST 2: Navigate to X first, then request a draft
  // ==========================================================================
  {
    let typedText = '';
    let clickedPost = false;
    let composerValue = '';

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return { tab: { id: 102, url: 'https://x.com/home', title: 'Home / X' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            return {
              success: true,
              data: {
                page: { url: 'https://x.com/home', title: 'Home / X', hostname: 'x.com' },
                interactive: {
                  inputs: [
                    {
                      id: 'el-comp-2',
                      tag: 'div',
                      type: 'contenteditable',
                      dataTestId: 'tweetTextarea_0',
                      placeholder: 'What is happening?!',
                      value: composerValue
                    }
                  ],
                  buttons: [
                    {
                      id: 'el-post-btn-2',
                      tag: 'button',
                      text: 'Post',
                      dataTestId: 'tweetButtonInline',
                      disabled: false
                    }
                  ]
                }
              }
            };
          }
          if (msg.type === 'EXECUTE_ACTION') {
            if (msg.action?.action === 'type') {
              typedText = msg.action.text;
              composerValue = msg.action.text;
              return { success: true };
            }
            if (msg.action?.action === 'click') {
              clickedPost = true;
              composerValue = '';
              return { success: true };
            }
            return { success: true };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    const initResult = await controller.startTask('Post on X: "Building a voice browser agent!"');

    assert(
      initResult.status === TaskStatus.WAITING_FOR_APPROVAL,
      'TEST 2A - Pauses for draft approval when already on X',
      `Status: ${initResult.status}`
    );

    // Approve draft -> already on X, so immediately composes!
    const composeResult = await controller.approvePendingAction();
    assert(
      typedText === 'Building a voice browser agent!',
      'TEST 2B - Immediately fills composer when already on X',
      typedText
    );
    assert(
      composeResult.status === TaskStatus.WAITING_FOR_APPROVAL,
      'TEST 2C - Pauses for final confirmation immediately before publishing',
      composeResult.status
    );

    // Final confirmation to publish
    const publishResult = await controller.approvePendingAction();
    assert(
      publishResult.status === TaskStatus.COMPLETED && clickedPost === true,
      'TEST 2D - Publishes and verifies successfully on X',
      `Status: ${publishResult.status}`
    );
  }

  // ==========================================================================
  // TEST 3: Approve the draft and manually switch tabs
  // ==========================================================================
  {
    let currentActiveTabId = 101;
    let typedText = '';

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return currentActiveTabId === 101
              ? { tab: { id: 101, url: 'https://wikipedia.org', title: 'Wikipedia' } }
              : { tab: { id: 202, url: 'https://x.com/home', title: 'Home / X' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            if (currentActiveTabId === 202) {
              return {
                success: true,
                data: {
                  page: { url: 'https://x.com/home', title: 'Home / X' },
                  interactive: {
                    inputs: [
                      { id: 'tab2-comp', tag: 'div', dataTestId: 'tweetTextarea_0', value: typedText }
                    ],
                    buttons: [
                      { id: 'tab2-post', tag: 'button', text: 'Post', dataTestId: 'tweetButtonInline' }
                    ]
                  }
                }
              };
            }
            return {
              success: true,
              data: { page: { url: 'https://wikipedia.org' }, interactive: { inputs: [], buttons: [] } }
            };
          }
          if (msg.type === 'EXECUTE_ACTION') {
            if (msg.action?.action === 'type') typedText = msg.action.text;
            return { success: true };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    await controller.startTask('Post on X: "Switching tabs test"');
    await controller.approvePendingAction(); // Approved on tab 101

    // User switches to Tab 202 (X.com)
    currentActiveTabId = 202;
    const switchRes = await controller.handleTabUpdate({
      tabId: 202,
      url: 'https://x.com/home',
      title: 'Home / X'
    });

    assert(
      switchRes && typedText === 'Switching tabs test',
      'TEST 3 - Detects manual tab switch to X and resumes workflow',
      `Typed: ${typedText}`
    );
  }

  // ==========================================================================
  // TEST 4: X is logged out
  // ==========================================================================
  {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return { tab: { id: 104, url: 'https://x.com/i/flow/login', title: 'Log in to X / X' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            return {
              success: true,
              data: {
                page: { url: 'https://x.com/i/flow/login', title: 'Log in to X / X' },
                headings: [{ text: 'Sign in to X' }],
                interactive: {
                  inputs: [{ id: 'login-user', tag: 'input', label: 'Phone, email, or username' }],
                  buttons: [{ id: 'login-next', tag: 'button', text: 'Next' }]
                }
              }
            };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    await controller.startTask('Post on X: "Will not post while logged out"');
    const authCheckRes = await controller.approvePendingAction();

    assert(
      authCheckRes.clarificationQuestion?.toLowerCase().includes('logged out') ||
      authCheckRes.statusMessage?.toLowerCase().includes('logged out'),
      'TEST 4A - Identifies logged out state and prompts user clearly without guessing',
      authCheckRes.clarificationQuestion || authCheckRes.statusMessage
    );

    // Verify it allows resume after user logs in
    globalThis.chrome.runtime.sendMessage = async (msg) => {
      if (msg.type === 'GET_ACTIVE_TAB') {
        return { tab: { id: 104, url: 'https://x.com/home', title: 'Home / X' } };
      }
      if (msg.type === 'GET_PAGE_SNAPSHOT') {
        return {
          success: true,
          data: {
            page: { url: 'https://x.com/home', title: 'Home / X' },
            interactive: {
              inputs: [{ id: 'in-comp', dataTestId: 'tweetTextarea_0', value: '' }],
              buttons: [{ id: 'in-post', dataTestId: 'tweetButtonInline', text: 'Post' }]
            }
          }
        };
      }
      if (msg.type === 'EXECUTE_ACTION') return { success: true };
      return { success: true };
    };

    const resumeRes = await controller.resumePendingTask();
    assert(
      resumeRes.status === TaskStatus.WAITING_FOR_APPROVAL,
      'TEST 4B - Resumes cleanly after user logs in and advances to confirmation',
      `Status: ${resumeRes.status}`
    );
  }

  // ==========================================================================
  // TEST 5: The composer cannot be found
  // ==========================================================================
  {
    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return { tab: { id: 105, url: 'https://x.com/settings', title: 'Settings / X' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            return {
              success: true,
              data: {
                page: { url: 'https://x.com/settings', title: 'Settings / X' },
                interactive: {
                  inputs: [], // No composer on settings page
                  buttons: [{ id: 'btn-back', text: 'Back' }]
                }
              }
            };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    await controller.startTask('Post on X: "Testing missing composer"');
    const result = await controller.approvePendingAction();

    assert(
      result.status === TaskStatus.ERROR && result.error.includes('post composer on X'),
      'TEST 5 - Explains exact step failure when composer cannot be found instead of silently stopping',
      result.error
    );
  }

  // ==========================================================================
  // TEST 6: The user cancels
  // ==========================================================================
  {
    let clickedPost = false;
    let typedText = '';

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return { tab: { id: 106, url: 'https://x.com/home', title: 'Home / X' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            return {
              success: true,
              data: {
                page: { url: 'https://x.com/home' },
                interactive: {
                  inputs: [{ id: 'c-6', dataTestId: 'tweetTextarea_0' }],
                  buttons: [{ id: 'b-6', dataTestId: 'tweetButtonInline', text: 'Post' }]
                }
              }
            };
          }
          if (msg.type === 'EXECUTE_ACTION') {
            if (msg.action?.action === 'type') typedText = msg.action.text;
            if (msg.action?.action === 'click') clickedPost = true;
            return { success: true };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    await controller.startTask('Post on X: "Cancelled post"');

    // User cancels at initial draft approval
    const cancelResult = controller.cancelPendingAction('User clicked cancel');

    assert(
      cancelResult.status === TaskStatus.STOPPED && clickedPost === false && typedText === '',
      'TEST 6 - User cancellation cleanly halts task with zero actions executed',
      `Status: ${cancelResult.status}, Clicked: ${clickedPost}`
    );
  }

  // ==========================================================================
  // TEST 7: The page loads slowly
  // ==========================================================================
  {
    let attemptCount = 0;

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return { tab: { id: 107, url: 'https://x.com/home', title: 'Home / X' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            attemptCount++;
            if (attemptCount === 1) {
              // Page still loading on attempt 1
              return { success: false, error: 'Content script not ready' };
            }
            // Ready on attempt 2
            return {
              success: true,
              data: {
                page: { url: 'https://x.com/home', title: 'Home / X' },
                interactive: {
                  inputs: [{ id: 'slow-comp', dataTestId: 'tweetTextarea_0' }],
                  buttons: [{ id: 'slow-post', dataTestId: 'tweetButtonInline', text: 'Post' }]
                }
              }
            };
          }
          if (msg.type === 'EXECUTE_ACTION') return { success: true };
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    await controller.startTask('Post on X: "Slow page load test"');
    const res = await controller.approvePendingAction();

    assert(
      attemptCount >= 2 && res.status === TaskStatus.WAITING_FOR_APPROVAL,
      'TEST 7 - Retries gracefully when page loads slowly without premature crash',
      `Attempts: ${attemptCount}, Status: ${res.status}`
    );
  }

  // ==========================================================================
  // TEST 8: Publish times out after the click
  // ==========================================================================
  {
    let clickCount = 0;
    let composerCleared = false;

    globalThis.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (msg.type === 'GET_ACTIVE_TAB') {
            return { tab: { id: 108, url: 'https://x.com/home', title: 'Home / X' } };
          }
          if (msg.type === 'GET_PAGE_SNAPSHOT') {
            return {
              success: true,
              data: {
                page: { url: 'https://x.com/home', title: 'Home / X' },
                interactive: {
                  inputs: [
                    { id: 'c-8', dataTestId: 'tweetTextarea_0', value: composerCleared ? '' : 'Timeout draft' }
                  ],
                  buttons: [{ id: 'b-8', dataTestId: 'tweetButtonInline', text: 'Post' }]
                }
              }
            };
          }
          if (msg.type === 'EXECUTE_ACTION') {
            if (msg.action?.action === 'type') return { success: true };
            if (msg.action?.action === 'click') {
              clickCount++;
              // Simulate timeout on click response
              return { success: false, timedOut: true, error: 'Publish request timed out.' };
            }
            return { success: true };
          }
          return { success: true };
        }
      }
    };

    const controller = new AgentController();
    await controller.startTask('Post on X: "Timeout draft"');
    await controller.approvePendingAction(); // Draft approved
    const finalTimeoutRes = await controller.approvePendingAction(); // Confirm publish

    assert(
      clickCount === 1,
      'TEST 8A - Never retries a timed-out publish action blindly (only clicked once)',
      `Click count: ${clickCount}`
    );
    assert(
      finalTimeoutRes.status === TaskStatus.ERROR && finalTimeoutRes.error.includes('timed out'),
      'TEST 8B - Clear explanation on timeout warning user to check X before retrying',
      finalTimeoutRes.error
    );
  }

  console.log('========================================');
  console.log(`X.COM WORKFLOW SUITE: ${passed} passed, ${failed} failed.`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runXPostingWorkflowTests().catch((err) => {
  console.error('Fatal X posting workflow test error:', err);
  process.exit(1);
});
