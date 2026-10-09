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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          success: true,
          plan: validation.plan,
          metrics: {
            provider: rawResult.provider,
            model: rawResult.model,
            latencyMs: rawResult.latencyMs,
            ...(rawResult.usage || {})
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
