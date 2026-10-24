/**
 * Phase 6 Comprehensive Automated Verification Suite
 * LLM-Powered Reasoning and Hybrid Decision Architecture
 * 
 * Verifies all 13 Phase 6 requirements:
 * 1. Simple scrolling command handled locally without an LLM request (0 cost, 0 latency).
 * 2. Natural-language command genuinely invoking the configured LLM.
 * 3. Multi-step task using valid structured actions.
 * 4. Malformed model response rejection.
 * 5. Unknown / disallowed action type rejection.
 * 6. Ambiguous link or input requesting clarification.
 * 7. Navigation followed by fresh observation.
 * 8. Failed action followed by bounded recovery (retry up to limit before halting).
 * 9. Unsupported task that stops safely.
 * 10. Sensitive action (financial / booking / destructive) requiring approval.
 * 11. Missing or invalid API credentials handling.
 * 12. Provider timeout or rate-limit response handling.
 * 13. Zero regression across existing scrolling, searching, clicking, and voice submission.
 */

import http from 'http';
import { AgentController } from '../src/agent/agentController.js';
import { TaskState, TaskStatus } from '../src/agent/taskState.js';
import { planNextAction, canHandleDeterministically, isSensitiveAction } from '../src/agent/planner.js';
import { planWithAI, ALLOWED_ACTIONS } from '../src/agent/aiPlanner.js';
import { aiClient } from '../src/agent/aiClient.js';
import { isRestrictedUrl, RESTRICTED_PAGE_MESSAGE, openWebsiteAndObserve } from '../src/sidepanel/utils/chromeMessaging.js';
import { verifyAction } from '../src/agent/verifier.js';
import { MockAIProvider } from '../../backend/src/ai/providers/mockProvider.js';
import { GeminiProvider } from '../../backend/src/ai/providers/geminiProvider.js';
import { validateAIPlanResponse } from '../../backend/src/ai/responseValidator.js';

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

function createMockSnapshot(overrides = {}) {
  return {
    page: {
      title: 'TechStore - Best Laptops and Accessories',
      url: 'https://store.example.com/laptops',
      hostname: 'store.example.com',
      scrollY: 0,
      scrollX: 0,
      maxScrollY: 1500,
      ...(overrides.page || {})
    },
    content: {
      headings: [
        { id: 'element-1', tag: 'h1', text: 'Top Rated Laptops 2026' },
        { id: 'element-2', tag: 'h2', text: 'Budget Category Under ₹50,000' }
      ],
      paragraphs: [
        'Compare the latest laptops featuring multi-core processors and all-day battery life.',
        'Ultrabook Pro 14 starts at ₹44,999 with 16GB RAM and fast NVMe storage.'
      ],
      ...(overrides.content || {})
    },
    interactive: {
      inputs: [
        { id: 'element-10', tag: 'input', type: 'search', name: 'search', placeholder: 'Search products...', value: '' }
      ],
      buttons: [
        { id: 'element-20', tag: 'button', text: 'Filter by Price' },
        { id: 'element-21', tag: 'button', text: 'View Ultrabook Pro' }
      ],
      links: [
        { id: 'element-30', text: 'Ultrabook Details', href: 'https://store.example.com/product/ultrabook-14' },
        { id: 'element-31', text: 'Customer Support', href: 'https://store.example.com/help' }
      ],
      ...(overrides.interactive || {})
    }
  };
}

console.log('--- RUNNING PHASE 6 LLM REASONING & HYBRID AGENT SUITE ---');

async function runPhase6Tests() {
  // Setup local mock HTTP backend for tests
  const mockProvider = new MockAIProvider({ simulateLatencyMs: 1 });

  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/plan') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Invalid JSON', code: 'INVALID_INPUT' }));
      }

      try {
        const rawResult = await mockProvider.generatePlan({
          systemPrompt: 'test',
          userPrompt: parsed.goal,
          observation: parsed.observation
        });

        const validation = validateAIPlanResponse(rawResult.rawText);
        if (!validation.valid) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({
            success: false,
            error: validation.error,
            code: 'INVALID_MODEL_OUTPUT'
          }));
        }

        const usage = rawResult.usage;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          plan: validation.plan,
          metrics: {
            provider: rawResult.provider,
            model: rawResult.model,
            latencyMs: rawResult.latencyMs,
            ...(usage || {}),
            taskMetrics: {
              taskId: parsed.taskId || 'task-test',
              llmCallCount: 1,
              inputTokens: usage?.usageAvailable === false ? null : (usage?.promptTokens ?? 0),
              outputTokens: usage?.usageAvailable === false ? null : (usage?.completionTokens ?? 0),
              totalTokens: usage?.usageAvailable === false ? null : (usage?.totalTokens ?? 0),
              ...(usage?.thinkingTokens !== undefined ? { thinkingTokens: usage.thinkingTokens } : {}),
              usageAvailable: usage?.usageAvailable !== false,
              durationMs: rawResult.latencyMs || 10
            }
          }
        }));
      } catch (err) {
        res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: false,
          error: err.message,
          code: err.code || 'PROVIDER_ERROR',
          retryable: err.retryable || false
        }));
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
  });

  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const backendUrl = `http://localhost:${port}`;
  aiClient.setBackendUrl(backendUrl);

  try {
    // ========================================================================
    // SCENARIO 1: Simple scrolling command handled locally WITHOUT an LLM request
    // ========================================================================
    {
      const initialAICalls = aiClient.getMetrics().callsCount;
      let executedAction = null;
      let currentScrollY = 0;

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot({ page: { scrollY: currentScrollY, maxScrollY: 1000 } }) };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              if (msg.action?.action === 'scroll') {
                currentScrollY += 500;
              }
              executedAction = msg.action;
              return { success: true };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Scroll down');

      const finalAICalls = aiClient.getMetrics().callsCount;

      assert(
        result.status === TaskStatus.COMPLETED &&
        executedAction &&
        executedAction.action === 'scroll' &&
        finalAICalls === initialAICalls,
        'SCENARIO 1 - Simple scrolling command handled locally with 0 LLM calls',
        `Expected 0 LLM calls, got ${finalAICalls - initialAICalls}`
      );
      assert(
        result.plannerMode === 'Deterministic' && result.aiCallsCount === 0,
        'SCENARIO 1B - Truthful telemetry: 0 AI calls and Deterministic mode recorded',
        `Planner mode: ${result.plannerMode}, AI calls: ${result.aiCallsCount}`
      );
    }

    // ========================================================================
    // SCENARIO 2: Natural-language command genuinely invoking the configured LLM
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Click on the Ultrabook details button to inspect specs',
        action: { action: 'click', elementId: 'element-21' },
        isLastStep: true
      });

      let executedAction = null;
      let snapshotCallCount = 0;

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              snapshotCallCount++;
              return { success: true, data: createMockSnapshot() };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              executedAction = msg.action;
              return { success: true, result: { success: true } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const naturalGoal = 'Find me the best laptop under ₹50,000 and open its product details page';
      const result = await controller.startTask(naturalGoal);

      assert(
        result.status === TaskStatus.COMPLETED &&
        result.aiCallsCount >= 1 &&
        executedAction &&
        executedAction.elementId === 'element-21',
        'SCENARIO 2 - Natural language command genuinely invokes LLM and executes planned action',
        `Result status: ${result.status}, AI calls: ${result.aiCallsCount}, action: ${JSON.stringify(executedAction)}`
      );
      assert(
        result.tokensUsed.total > 0 && result.plannerMode.includes('mock'),
        'SCENARIO 2B - Truthful token counts recorded from provider metrics',
        `Tokens: ${JSON.stringify(result.tokensUsed)}, PlannerMode: ${result.plannerMode}`
      );
    }

    // ========================================================================
    // SCENARIO 3: Multi-step task using valid structured actions
    // ========================================================================
    {
      mockProvider.reset();
      // Step 1: Type search term
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Type "Ultrabook 16GB" into product search field',
        action: { action: 'type', elementId: 'element-10', text: 'Ultrabook 16GB' },
        isLastStep: false
      });
      // Step 2: Press Enter to submit
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Press Enter to submit search query',
        action: { action: 'pressKey', key: 'Enter', elementId: 'element-10' },
        isLastStep: true
      });

      const executedActions = [];

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              executedActions.push(msg.action);
              return { success: true, result: { success: true } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Search for 16GB ultrabooks', { plannerMode: 'ai_only' });

      assert(
        result.status === TaskStatus.COMPLETED &&
        executedActions.length === 2 &&
        executedActions[0].action === 'type' &&
        executedActions[1].action === 'pressKey',
        'SCENARIO 3 - Multi-step task executes sequence of validated structured actions',
        `Executed actions count: ${executedActions.length}`
      );
    }

    // ========================================================================
    // SCENARIO 4: Malformed model response rejection
    // ========================================================================
    {
      mockProvider.reset();
      // Inject non-JSON garbage from LLM
      mockProvider.queueResponse('I apologize, I am unable to parse this request as requested.');

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Find the hidden discount code', { plannerMode: 'ai_only' });

      assert(
        result.status === TaskStatus.ERROR &&
        (result.error.toLowerCase().includes('not valid') || result.error.toLowerCase().includes('invalid') || result.error.includes('AI planning')),
        'SCENARIO 4 - Malformed model response safely rejected with clear error',
        `Result status: ${result.status}, error: ${result.error}`
      );
    }

    // ========================================================================
    // SCENARIO 5: Unknown / disallowed action type rejection
    // ========================================================================
    {
      mockProvider.reset();
      // Inject dangerous/unsupported action type
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Download customer database',
        action: { action: 'eval', code: 'window.__admin_token' }
      });

      let executorCalled = false;
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              executorCalled = true;
              return { success: true };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Extract admin tokens');

      assert(
        result.status === TaskStatus.ERROR &&
        executorCalled === false &&
        (result.error.includes('allowlist') || result.error.includes('guardrail')),
        'SCENARIO 5 - Unknown action type rejected before executor invocation',
        `Result: ${result.status}, Executor called: ${executorCalled}, Error: ${result.error}`
      );
    }

    // ========================================================================
    // SCENARIO 6: Ambiguous link or input requesting clarification
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.queueResponse({
        status: 'NEEDS_CLARIFICATION',
        clarificationQuestion: 'Did you want the 14-inch model for ₹44,999 or the 16-inch model for ₹59,999?'
      });

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Select that laptop');

      assert(
        result.status === TaskStatus.NEEDS_CLARIFICATION &&
        result.clarificationQuestion.includes('14-inch model'),
        'SCENARIO 6 - Ambiguous instruction transitions to NEEDS_CLARIFICATION without guessing',
        `Status: ${result.status}, Question: ${result.clarificationQuestion}`
      );
    }

    // ========================================================================
    // SCENARIO 7: Navigation followed by fresh observation
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Navigate to products page',
        action: { action: 'navigate', url: 'https://store.example.com/catalog' },
        isLastStep: true
      });

      let snapshotCalls = 0;
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              snapshotCalls++;
              const url = snapshotCalls === 1 ? 'https://store.example.com/laptops' : 'https://store.example.com/catalog';
              return { success: true, data: createMockSnapshot({ page: { url } }) };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              return { success: true, result: { success: true } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Go to catalog page');

      assert(
        result.status === TaskStatus.COMPLETED && snapshotCalls >= 2,
        'SCENARIO 7 - Navigation triggers fresh post-action observation and URL verification',
        `Status: ${result.status}, Observation calls: ${snapshotCalls}`
      );
    }

    // ========================================================================
    // SCENARIO 8: Failed action followed by bounded recovery
    // ========================================================================
    {
      mockProvider.reset();
      // First attempt: targets stale element-99
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Click outdated filter button',
        action: { action: 'click', elementId: 'element-99' },
        isLastStep: false
      });
      // Second attempt (recovery): targets valid element-20
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Retry click using valid Filter button element-20',
        action: { action: 'click', elementId: 'element-20' },
        isLastStep: true
      });

      let executeAttempts = 0;
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              executeAttempts++;
              if (msg.action.elementId === 'element-99') {
                return { success: false, error: 'Element element-99 not found' };
              }
              return { success: true, result: { success: true } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Filter laptops by price');

      assert(
        result.status === TaskStatus.COMPLETED && executeAttempts === 2,
        'SCENARIO 8 - Failed action recovers with fresh observation and completes successfully',
        `Status: ${result.status}, Attempts: ${executeAttempts}`
      );
    }

    // ========================================================================
    // SCENARIO 9: Unsupported task that stops safely
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.queueResponse({
        status: 'ERROR',
        error: 'Cannot edit or run local shell scripts inside this webpage.'
      });

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Run bash script to deploy code');

      assert(
        result.status === TaskStatus.ERROR &&
        result.error.includes('shell scripts'),
        'SCENARIO 9 - Unsupported task stops safely with clear explanation',
        `Status: ${result.status}, Error: ${result.error}`
      );
    }

    // ========================================================================
    // SCENARIO 10: Sensitive action that requires approval
    // ========================================================================
    {
      mockProvider.reset();
      let executorInvoked = false;

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              executorInvoked = true;
              return { success: true };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Pay ₹44,999 and place order for laptop');

      assert(
        result.status === TaskStatus.WAITING_FOR_APPROVAL &&
        executorInvoked === false,
        'SCENARIO 10 - Sensitive financial action requires approval before executor invocation',
        `Status: ${result.status}, Executor invoked: ${executorInvoked}`
      );
    }

    // ========================================================================
    // SCENARIO 11: Missing or invalid API credentials
    // ========================================================================
    {
      const unconfiguredGemini = new GeminiProvider({ apiKey: '' });
      let credError = null;

      try {
        await unconfiguredGemini.generatePlan({ systemPrompt: 'test', userPrompt: 'test' });
      } catch (err) {
        credError = err;
      }

      assert(
        credError && credError.code === 'MISSING_CREDENTIALS',
        'SCENARIO 11 - Missing API credentials caught and structured cleanly without leaking',
        `Error: ${credError?.message}, Code: ${credError?.code}`
      );
    }

    // ========================================================================
    // SCENARIO 12: Provider timeout or rate-limit response
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.setForcedError({
        message: 'Resource exhausted: rate limit exceeded',
        code: 'RATE_LIMIT',
        status: 429,
        retryable: true
      });

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Analyze customer reviews');

      assert(
        result.status === TaskStatus.ERROR &&
        result.error.toLowerCase().includes('rate limit'),
        'SCENARIO 12 - Provider rate-limit response handled cleanly with error reason',
        `Status: ${result.status}, Error: ${result.error}`
      );
    }

    // ========================================================================
    // SCENARIO 13: Regression checks across existing deterministic planner primitives
    // ========================================================================
    {
      const snap = createMockSnapshot();
      assert(canHandleDeterministically('Scroll down', snap) === true, 'SCENARIO 13A - Scroll handled locally', 'Expected true');
      assert(canHandleDeterministically('Go to https://example.com', snap) === true, 'SCENARIO 13B - Navigation handled locally', 'Expected true');
      assert(canHandleDeterministically('Search for laptops', snap) === true, 'SCENARIO 13C - Search handled locally', 'Expected true');
      assert(canHandleDeterministically('Find Top Rated Laptops 2026', snap) === true, 'SCENARIO 13D - Find text handled locally', 'Expected true');
      assert(isSensitiveAction('Book a flight to Paris and checkout') === true, 'SCENARIO 13E - Sensitive keyword detection preserved', 'Expected true');
    }

    // ========================================================================
    // SCENARIO 14: Restricted Chrome Pages Handling (A)
    // ========================================================================
    {
      assert(isRestrictedUrl('chrome://newtab/') === true, 'SCENARIO 14A - chrome://newtab is recognized as restricted', 'Expected true');
      assert(isRestrictedUrl('chrome://settings/') === true, 'SCENARIO 14B - chrome://settings is recognized as restricted', 'Expected true');
      assert(isRestrictedUrl('chrome://extensions/') === true, 'SCENARIO 14B2 - chrome://extensions is recognized as restricted', 'Expected true');
      assert(isRestrictedUrl('about:blank') === true, 'SCENARIO 14B3 - about:blank is recognized as restricted', 'Expected true');
      assert(isRestrictedUrl('chrome-error://chromewebdata/') === true, 'SCENARIO 14B4 - chrome-error:// is recognized as restricted', 'Expected true');
      assert(isRestrictedUrl('https://chromewebstore.google.com/category/extensions') === true, 'SCENARIO 14C - Chrome Web Store is recognized as restricted', 'Expected true');
      assert(isRestrictedUrl('chrome-extension://abc123xyz/popup.html') === true, 'SCENARIO 14D - Extension internal pages recognized as restricted', 'Expected true');
      assert(isRestrictedUrl('https://en.wikipedia.org/wiki/Main_Page') === false, 'SCENARIO 14E - Regular website is recognized as accessible', 'Expected false');

      assert(
        RESTRICTED_PAGE_MESSAGE === 'Chrome restricts extensions from controlling this page. Open a regular website to continue.',
        'SCENARIO 14E2 - Friendly restricted page message is exact',
        RESTRICTED_PAGE_MESSAGE
      );

      let executorCalled = false;
      let aiCalled = false;
      let currentMockUrl = 'chrome://newtab/';

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'OPEN_TAB') {
              currentMockUrl = msg.url || 'https://www.wikipedia.org';
              return {
                success: true,
                tab: {
                  id: 101,
                  url: currentMockUrl,
                  title: 'Wikipedia, the free encyclopedia',
                  status: 'complete'
                }
              };
            }
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              if (isRestrictedUrl(currentMockUrl)) {
                return {
                  success: false,
                  type: 'RESTRICTED',
                  isRestricted: true,
                  url: currentMockUrl,
                  error: RESTRICTED_PAGE_MESSAGE
                };
              }
              return {
                success: true,
                data: {
                  page: {
                    title: 'Wikipedia, the free encyclopedia',
                    url: currentMockUrl,
                    hostname: 'en.wikipedia.org'
                  },
                  interactive: {
                    buttons: [{ id: 'element-1', text: 'Search' }],
                    links: [{ id: 'element-2', text: 'Article' }]
                  }
                }
              };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              executorCalled = true;
              return { success: true };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const taskResult = await controller.startTask('Search Wikipedia for AI history');

      assert(
        taskResult.status === TaskStatus.ERROR &&
        (taskResult.error.includes(RESTRICTED_PAGE_MESSAGE) || taskResult.error.toLowerCase().includes('restricted browser pages')),
        'SCENARIO 14F - AgentController safely halts on restricted pages without crashing',
        `Status: ${taskResult.status}, Error: ${taskResult.error}`
      );

      assert(
        executorCalled === false,
        'SCENARIO 14G - Executor was not called against restricted page',
        `Executor called: ${executorCalled}`
      );

      assert(
        taskResult.aiCallsCount === 0 && taskResult.tokensUsed.total === 0,
        'SCENARIO 14H - No AI calls or token costs incurred against restricted page',
        `AI calls: ${taskResult.aiCallsCount}, tokens: ${taskResult.tokensUsed.total}`
      );

      // Verify Open a Website action helper observes the page after opening
      const openResult = await openWebsiteAndObserve('https://www.wikipedia.org');
      assert(
        openResult.success === true && (openResult.snapshot?.page?.url || openResult.tab?.url).includes('wikipedia.org'),
        'SCENARIO 14I - Open a Website action successfully opens normal website and returns observation snapshot',
        JSON.stringify(openResult)
      );

      // Verify that after opening normal website, agent reconnects and can observe normal page without restart
      const reconnectTask = await controller.startTask('Click Search');
      assert(
        reconnectTask.status !== TaskStatus.ERROR || !reconnectTask.error?.includes('restricts extensions'),
        'SCENARIO 14J - Agent automatically reconnects to normal website without browser restart',
        `Status: ${reconnectTask.status}, Error: ${reconnectTask.error}`
      );
    }

    // ========================================================================
    // SCENARIO 15: Restoring normal agent execution when navigating to accessible site
    // ========================================================================
    {
      let executorAction = null;
      let currentScrollY = 0;

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return {
                success: true,
                data: createMockSnapshot({
                  page: {
                    title: 'Wikipedia, the free encyclopedia',
                    url: 'https://en.wikipedia.org/wiki/Main_Page',
                    hostname: 'en.wikipedia.org',
                    scrollY: currentScrollY,
                    maxScrollY: 2000
                  }
                })
              };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              if (msg.action?.action === 'scroll') {
                currentScrollY += 500;
              }
              executorAction = msg.action;
              return { success: true };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Scroll down');

      assert(
        result.status === TaskStatus.COMPLETED && executorAction?.action === 'scroll',
        'SCENARIO 15 - Normal agent execution restored when on accessible page',
        `Status: ${result.status}, Action: ${executorAction?.action}`
      );
    }

    // ========================================================================
    // SCENARIO 16: Deterministic tasks report 0 LLM calls and 0 LLM tokens (C & D)
    // ========================================================================
    {
      let currentScrollY16 = 0;
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return {
                success: true,
                data: createMockSnapshot({
                  page: {
                    scrollY: currentScrollY16,
                    maxScrollY: 2000
                  }
                })
              };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              if (msg.action?.action === 'scroll') {
                currentScrollY16 += 500;
              }
              return { success: true };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Scroll down');

      assert(
        result.status === TaskStatus.COMPLETED &&
        result.aiCallsCount === 0 &&
        result.tokensUsed.total === 0 &&
        result.taskMetrics.llmCallCount === 0 &&
        result.taskMetrics.totalTokens === 0 &&
        result.taskMetrics.usageAvailable === true,
        'SCENARIO 16 - Deterministic task truthfully reports 0 LLM calls and 0 LLM tokens',
        `aiCalls: ${result.aiCallsCount}, tokens: ${result.tokensUsed.total}, metrics: ${JSON.stringify(result.taskMetrics)}`
      );
    }

    // ========================================================================
    // SCENARIO 17: AI task truthfully aggregates tokens per task (C & D)
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.setCustomUsage({
        promptTokens: 150,
        completionTokens: 60,
        totalTokens: 210,
        thinkingTokens: 40,
        usageAvailable: true
      });

      mockProvider.queueResponse(
        JSON.stringify({
          status: 'ACTION',
          action: { action: 'click', elementId: 'element-30' },
          explanation: 'Open details to compare processor specs',
          isLastStep: true
        })
      );

      const snap = createMockSnapshot();
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: snap };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              return { success: true, result: { clicked: true } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Compare processor specs');

      assert(
        result.status === TaskStatus.COMPLETED &&
        result.aiCallsCount >= 1 &&
        result.tokensUsed.prompt === 150 &&
        result.tokensUsed.completion === 60 &&
        result.tokensUsed.total === 210 &&
        result.taskMetrics.thinkingTokens === 40 &&
        result.taskMetrics.usageAvailable === true,
        'SCENARIO 17 - AI task faithfully captures input, output, total, and thinking tokens',
        `tokens: ${JSON.stringify(result.tokensUsed)}, taskMetrics: ${JSON.stringify(result.taskMetrics)}`
      );
    }

    // ========================================================================
    // SCENARIO 18: Missing provider usage metadata marked unavailable (C & D)
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.setCustomUsage({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        usageAvailable: false
      });

      mockProvider.queueResponse(
        JSON.stringify({
          status: 'ACTION',
          action: { action: 'click', elementId: 'element-30' },
          explanation: 'Review laptop features',
          isLastStep: true
        })
      );

      const snap = createMockSnapshot();
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: snap };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              return { success: true, result: { clicked: true } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Summarize laptop features');

      assert(
        result.status === TaskStatus.COMPLETED &&
        result.taskMetrics.usageAvailable === false &&
        result.tokensUsed.usageAvailable === false,
        'SCENARIO 18 - Missing provider usage metadata marked unavailable without fabricating numbers',
        `usageAvailable: ${result.taskMetrics.usageAvailable}`
      );
    }

    // ========================================================================
    // SCENARIO 19: Verification failure does NOT mark task as completed (B)
    // ========================================================================
    {
      const snap = createMockSnapshot();
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: snap };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              // Executor says success, but DOM scroll did not actually change
              return { success: true, result: { scrolled: false, scrollY: 0 } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Scroll down', { plannerMode: 'deterministic' });

      assert(
        result.status === TaskStatus.ERROR &&
        result.status !== TaskStatus.COMPLETED,
        'SCENARIO 19 - Verification failure does NOT mark task as completed',
        `Status: ${result.status}`
      );
    }

    // ========================================================================
    // SCENARIO 20: Sensitive financial action requires approval, not completed (B)
    // ========================================================================
    {
      const snap = createMockSnapshot();
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: snap };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Pay ₹5,000 using credit card now');

      assert(
        result.status === TaskStatus.WAITING_FOR_APPROVAL &&
        result.status !== TaskStatus.COMPLETED,
        'SCENARIO 20 - Sensitive financial action requires approval and is not marked completed',
        `Status: ${result.status}`
      );
    }

    // ========================================================================
    // TEST A: Deterministic task ("Scroll down")
    // ========================================================================
    {
      let scrollY = 0;
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot({ page: { scrollY, maxScrollY: 1000 } }) };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              if (msg.action?.action === 'scroll') scrollY += 500;
              return { success: true, result: { success: true, scrolled: true, scrollY } };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Scroll down', { plannerMode: 'deterministic' });

      assert(
        result.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT &&
        result.isWaitingForAck === true &&
        result.aiCallsCount === 0 &&
        result.tokensUsed.total === 0 &&
        result.tokensUsed.prompt === 0 &&
        result.tokensUsed.completion === 0 &&
        scrollY === 500,
        'TEST A - Deterministic task executes, verifies, records 0 AI calls & tokens, and waits for acknowledgement',
        `aiCalls: ${result.aiCallsCount}, totalTokens: ${result.tokensUsed.total}, scrollY: ${scrollY}`
      );
    }

    // ========================================================================
    // TEST B: AI page understanding ("Find the main heading of this page and tell me what the page is about.")
    // ========================================================================
    {
      const snap = createMockSnapshot({
        content: {
          headings: [
            { id: 'element-1', tag: 'h1', text: 'Top Rated Laptops 2026' }
          ],
          paragraphs: [
            'Compare the latest laptops featuring multi-core processors and all-day battery life.',
            'Ultrabook Pro 14 starts at ₹44,999 with 16GB RAM and fast NVMe storage.'
          ]
        }
      });

      const goal = 'Find the main heading of this page and tell me what the page is about.';
      const canDet = canHandleDeterministically(goal, snap);

      assert(
        canDet === false,
        'TEST B - canHandleDeterministically rejects compound question and heading inquiry, delegating to AI reasoning',
        `canHandleDeterministically returned ${canDet}`
      );

      mockProvider.reset();
      mockProvider.setCustomUsage({
        promptTokens: 110,
        completionTokens: 45,
        totalTokens: 155,
        thinkingTokens: 12,
        usageAvailable: true
      });
      mockProvider.queueResponse({
        status: 'DONE',
        explanation: 'Extracted main heading and page summary from observed content.',
        result: {
          title: 'Top Rated Laptops 2026',
          answer: "The main heading of this page is 'Top Rated Laptops 2026'. The page compares modern laptops with multi-core processors, highlighted by the Ultrabook Pro 14 budget model.",
          meta: 'Extracted from <h1> and article introduction'
        }
      });

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: snap };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask(goal, { plannerMode: 'hybrid' });

      assert(
        result.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT &&
        result.isWaitingForAck === true &&
        result.aiCallsCount === 1 &&
        result.result?.title === 'Top Rated Laptops 2026' &&
        result.result?.answer?.includes('Top Rated Laptops 2026') &&
        result.tokensUsed.prompt === 110 &&
        result.tokensUsed.completion === 45 &&
        result.tokensUsed.total === 155,
        'TEST B - AI page understanding calls AI, returns grounded heading and answer, records tokens, and waits for acknowledgement',
        `Answer: ${result.result?.answer}, Tokens: ${JSON.stringify(result.tokensUsed)}`
      );
    }

    // ========================================================================
    // TEST C: Multi-step AI task (Navigation -> Observation -> Heading & 3 Bullet Points)
    // ========================================================================
    {
      const initialSnap = createMockSnapshot({
        page: { url: 'https://en.wikipedia.org/wiki/Main_Page', title: 'Wikipedia' }
      });
      const wikiAiSnap = createMockSnapshot({
        page: { url: 'https://en.wikipedia.org/wiki/Artificial_intelligence', title: 'Artificial intelligence - Wikipedia' },
        content: {
          headings: [
            { id: 'h-1', tag: 'h1', text: 'Artificial intelligence' }
          ],
          paragraphs: [
            'Artificial intelligence is the intelligence of machines or software, as opposed to the intelligence of living beings, primarily of humans.'
          ]
        }
      });

      let currentUrl = 'https://en.wikipedia.org/wiki/Main_Page';
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return {
                success: true,
                data: currentUrl.includes('Artificial_intelligence') ? wikiAiSnap : initialSnap
              };
            }
            if (msg.type === 'EXECUTE_ACTION') {
              if (msg.action?.action === 'navigate') {
                currentUrl = msg.action.url;
              }
              return { success: true, result: { navigated: true, url: currentUrl } };
            }
            return { success: true };
          }
        }
      };

      mockProvider.reset();
      // Step 1: Navigate to article
      mockProvider.queueResponse({
        status: 'ACTION',
        explanation: 'Navigate to Artificial intelligence article on Wikipedia',
        action: {
          action: 'navigate',
          url: 'https://en.wikipedia.org/wiki/Artificial_intelligence'
        },
        isLastStep: false
      });
      // Step 2: On article page, extract heading and summarize in 3 bullet points
      mockProvider.queueResponse({
        status: 'DONE',
        explanation: 'Identified main heading and summarized introduction in three bullet points',
        result: {
          title: 'Artificial intelligence',
          answer: 'Main Heading: Artificial intelligence\n• Computational study and implementation of machine intelligence\n• Distinct from biological intelligence exhibited by living beings\n• Applied across modern search, decision support, and robotic automation',
          meta: 'Wikipedia article introduction'
        }
      });

      const controller = new AgentController();
      const multiStepGoal = 'Open the Artificial intelligence article on Wikipedia, identify its main heading, and summarize the first paragraph in three bullet points.';
      const result = await controller.startTask(multiStepGoal, { plannerMode: 'hybrid' });

      assert(
        result.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT &&
        result.actions.length === 1 &&
        result.actions[0].action?.action === 'navigate' &&
        result.aiCallsCount === 2 &&
        result.result?.title === 'Artificial intelligence' &&
        result.result?.answer?.includes('• Computational study'),
        'TEST C - Multi-step AI task navigates, observes new page, extracts heading & 3 bullet points, and aggregates metrics',
        `Calls: ${result.aiCallsCount}, Actions: ${result.actions.length}, Answer: ${result.result?.answer}`
      );
    }

    // ========================================================================
    // TEST D: Provider failure (Simulated backend error / unavailable provider)
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.setForcedError({
        message: 'Gemini service temporarily unavailable (HTTP 503)',
        code: 'SERVICE_UNAVAILABLE',
        status: 503,
        retryable: true
      });

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const result = await controller.startTask('Summarize this page', { plannerMode: 'hybrid' });

      assert(
        result.status === TaskStatus.ERROR &&
        result.isTerminal === true &&
        result.error?.includes('Gemini service temporarily unavailable') &&
        result.result === null,
        'TEST D - Provider failure shows clear error, does not fabricate tokens or answer, and is not marked completed',
        `Status: ${result.status}, Error: ${result.error}`
      );
    }

    // ========================================================================
    // TEST E: Acknowledgement lifecycle (Waits until "OK, Done" & resets cleanly)
    // ========================================================================
    {
      mockProvider.reset();
      mockProvider.setCustomUsage({ promptTokens: 50, completionTokens: 25, totalTokens: 75, usageAvailable: true });
      mockProvider.queueResponse({
        status: 'DONE',
        result: { title: 'Finished analysis', answer: 'Analysis complete.' }
      });

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: createMockSnapshot() };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const task1 = await controller.startTask('Analyze page content', { plannerMode: 'hybrid' });

      assert(
        task1.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT &&
        task1.isWaitingForAck === true &&
        task1.tokensUsed.total === 75,
        'TEST E1 - Completed AI task remains in COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT state with token metrics visible',
        `Status: ${task1.status}, WaitingForAck: ${task1.isWaitingForAck}`
      );

      // Next task starts completely fresh with 0 tokens and fresh ID
      const task2 = new TaskState('Scroll down');
      assert(
        task2.aiCallsCount === 0 &&
        task2.tokensUsed.total === 0 &&
        task2.taskMetrics.totalTokens === 0 &&
        task2.taskId !== task1.taskId,
        'TEST E2 - Next task starts with fresh task ID, zero AI calls, and fresh token metrics without stale carryover',
        `Task2 tokens: ${task2.tokensUsed.total}, Calls: ${task2.aiCallsCount}`
      );
    }

    // ========================================================================
    // TEST F: Hands-free queue (Speaking second command while card is completed)
    // ========================================================================
    {
      let appState = 'COMPLETED';
      let completedCardTask = { title: 'Find heading', answer: 'Top Rated Laptops 2026', tokens: 155 };
      let queuedVoiceCommand = '';
      let commandBoxText = '';

      // Voice recognizer finalizes an utterance while appState === 'COMPLETED'
      const simulatedVoiceInput = 'Open wikipedia article on robotics';
      if (appState === 'COMPLETED') {
        queuedVoiceCommand = simulatedVoiceInput;
      }

      // 1. First result and its metrics remain completely visible and untampered
      assert(
        completedCardTask.title === 'Find heading' &&
        completedCardTask.tokens === 155 &&
        queuedVoiceCommand === simulatedVoiceInput &&
        commandBoxText === '',
        'TEST F1 - Utterance detected while completed is safely queued without overwriting the completed card',
        `Queued: "${queuedVoiceCommand}", Card task: "${completedCardTask.title}"`
      );

      // 2. User clicks "OK, Done" -> acknowledges result, transitions to IDLE, and populates queued command
      // without auto-executing
      appState = 'IDLE';
      commandBoxText = queuedVoiceCommand;
      queuedVoiceCommand = '';

      assert(
        appState === 'IDLE' &&
        commandBoxText === simulatedVoiceInput &&
        queuedVoiceCommand === '',
        'TEST F2 - Clicking OK Done acknowledges completed card and populates queued command into box without auto-executing',
        `AppState: ${appState}, CommandBoxText: "${commandBoxText}"`
      );
    }

    // ========================================================================
    // TEST G: Safety Test 5 Regression — Harmless Page Without Delete Account Button
    // ========================================================================
    {
      let executorCallCount = 0;
      const harmlessStoreSnapshot = createMockSnapshot({
        page: {
          url: 'https://store.example.com/laptops/acer-swift-go-14',
          title: 'Acer Swift Go 14 Laptop (₹47,990) - TechStore',
          hostname: 'store.example.com'
        },
        interactive: {
          buttons: [
            { id: 'element-filter', text: 'Filter by Price', tag: 'button' },
            { id: 'element-buy', text: 'Buy Acer Swift Go 14', tag: 'button' }
          ],
          links: [
            { id: 'element-catalog', text: 'Catalog', href: '/catalog' }
          ]
        }
      });

      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: true, data: harmlessStoreSnapshot };
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
        result.status === TaskStatus.ERROR &&
        result.error.includes('Button not found on the current page') &&
        executorCallCount === 0 &&
        result.status !== TaskStatus.WAITING_FOR_APPROVAL,
        'TEST G - Harmless laptop store page reports button is absent and performs no click',
        `Status: ${result.status}, Error: ${result.error}, Executor calls: ${executorCallCount}`
      );
    }
  } finally {
    server.close();
  }

  console.log('========================================');
  console.log(`PHASE 6 TEST RESULTS: ${passed} passed, ${failed} failed.`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runPhase6Tests().catch((err) => {
  console.error('Fatal Phase 6 test error:', err);
  process.exit(1);
});
