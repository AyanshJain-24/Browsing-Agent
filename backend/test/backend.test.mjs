/**
 * Comprehensive Automated Test Suite for Voice Browser Agent Backend
 * 
 * Verifies:
 * 1. Compact observation generation and privacy masking (passwords)
 * 2. Prompt building with untrusted boundaries and anti-injection instructions
 * 3. Strict response validation against allowlist (click, type, select, scroll, pressKey, navigate)
 * 4. Rejection of unknown actions, malformed JSON, and dangerous URL protocols
 * 5. Provider abstraction: MockAIProvider, GeminiProvider, and OpenAICompatibleProvider
 * 6. Missing credentials detection and truthful error codes
 * 7. End-to-end HTTP routing for GET /api/models and POST /api/plan
 * 8. Error handling: rate limits, timeouts, payload limits
 */

import http from 'http';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

import { compactObservation, buildUserPrompt, SYSTEM_PROMPT } from '../src/ai/promptBuilder.js';
import { validateAIPlanResponse, extractCleanJson, ALLOWED_ACTIONS } from '../src/ai/responseValidator.js';
import { MockAIProvider } from '../src/ai/providers/mockProvider.js';
import { GeminiProvider } from '../src/ai/providers/geminiProvider.js';
import { OpenAICompatibleProvider } from '../src/ai/providers/openAiCompatibleProvider.js';
import { createAIRouter } from '../src/ai/aiRouter.js';
import express from 'express';

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

console.log('--- RUNNING BACKEND & AI PLANNING COMPONENT TESTS ---');

// ============================================================================
// PART 1: PROMPT BUILDER & OBSERVATION COMPACTING
// ============================================================================

{
  const rawObservation = {
    page: { title: 'Test Page', url: 'https://example.com', scrollY: 0, maxScrollY: 1000 },
    interactive: {
      inputs: [
        { id: 'element-1', tag: 'input', type: 'text', label: 'Username', value: 'john_doe' },
        { id: 'element-2', tag: 'input', type: 'password', label: 'Password', value: 'SuperSecret123!' },
        { id: 'element-3', tag: 'input', type: 'hidden', label: 'csrf_token', value: 'hidden_val' },
        { id: 'element-4', tag: 'input', type: 'text', disabled: true, label: 'Disabled Input' }
      ],
      buttons: [
        { id: 'element-10', text: 'Submit Form' },
        { id: 'element-11', text: 'Cancel', disabled: true }
      ],
      links: [
        { id: 'element-20', text: 'Documentation', href: 'https://docs.example.com' },
        { id: 'element-21', text: ' ' } // Empty text should be filtered
      ]
    },
    content: {
      headings: [{ id: 'element-30', tag: 'h1', text: 'Welcome to Example' }],
      paragraphs: ['A short sample paragraph about web automation.']
    }
  };

  const compacted = compactObservation(rawObservation);

  assert(
    compacted.interactive.inputs.length === 2,
    'TEST 1A - Compacted inputs filter disabled and hidden fields',
    `Expected 2 inputs, got ${compacted.interactive.inputs.length}`
  );

  const pwdInput = compacted.interactive.inputs.find((i) => i.id === 'element-2');
  assert(
    pwdInput && pwdInput.currentValue === '[MASKED]',
    'TEST 1B - Password field is strictly masked as [MASKED]',
    `Expected [MASKED], got ${pwdInput?.currentValue}`
  );

  assert(
    compacted.interactive.buttons.length === 1 && compacted.interactive.buttons[0].id === 'element-10',
    'TEST 1C - Disabled buttons filtered from compact representation',
    `Buttons: ${JSON.stringify(compacted.interactive.buttons)}`
  );

  const userPrompt = buildUserPrompt({
    goal: 'Click on Documentation',
    observation: rawObservation,
    history: [{ label: 'Navigated to example.com' }],
    lastFailure: { action: { action: 'click', elementId: 'element-99' }, reason: 'Element not found' }
  });

  assert(
    userPrompt.includes('<<<UNTRUSTED_PAGE_OBSERVATION>>>') &&
    userPrompt.includes('<<<END_UNTRUSTED_PAGE_OBSERVATION>>>'),
    'TEST 1D - User prompt isolates observation within security boundary',
    'Security boundary delimiters missing'
  );

  assert(
    userPrompt.includes('ATTENTION - PREVIOUS ACTION ATTEMPT FAILED') &&
    userPrompt.includes('PREVIOUS EXECUTED ACTIONS'),
    'TEST 1E - User prompt includes failure retry context and execution history',
    'Retry context missing'
  );
}

// ============================================================================
// PART 2: RESPONSE VALIDATOR & ACTION ALLOWLIST
// ============================================================================

{
  // Valid action plan
  const validActionJson = JSON.stringify({
    status: 'ACTION',
    explanation: 'Click on the login button',
    action: {
      action: 'click',
      elementId: 'element-10'
    },
    isLastStep: false
  });

  const res1 = validateAIPlanResponse(validActionJson);
  assert(
    res1.valid && res1.plan.status === 'ACTION' && res1.plan.action.elementId === 'element-10',
    'TEST 2A - Valid click action plan accepted',
    `Got error: ${res1.error}`
  );

  // Markdown-wrapped JSON (common from LLMs)
  const markdownWrapped = `Here is the next step:\n\`\`\`json\n${validActionJson}\n\`\`\``;
  const res2 = validateAIPlanResponse(markdownWrapped);
  assert(
    res2.valid && res2.plan.action.action === 'click',
    'TEST 2B - Markdown code block wrapper correctly stripped',
    `Got error: ${res2.error}`
  );

  // Dangerous / unknown action type
  const dangerousJson = JSON.stringify({
    status: 'ACTION',
    action: {
      action: 'executescript',
      code: 'alert(1)'
    }
  });
  const res3 = validateAIPlanResponse(dangerousJson);
  assert(
    res3.valid === false && res3.error.includes('allowlist'),
    'TEST 2C - Dangerous action "executescript" rejected by allowlist',
    `Expected allowlist error, got: ${JSON.stringify(res3)}`
  );

  // Malformed JSON
  const malformedJson = '{ status: "ACTION", action: { unclosed';
  const res4 = validateAIPlanResponse(malformedJson);
  assert(
    res4.valid === false && res4.error.includes('not valid JSON'),
    'TEST 2D - Malformed JSON rejected with clear error',
    `Expected invalid JSON error, got: ${res4.error}`
  );

  // Disallowed navigation protocol
  const badNavJson = JSON.stringify({
    status: 'ACTION',
    action: {
      action: 'navigate',
      url: 'javascript:document.cookie'
    }
  });
  const res5 = validateAIPlanResponse(badNavJson);
  assert(
    res5.valid === false && res5.error.includes('Disallowed URL protocol'),
    'TEST 2E - Disallowed javascript: navigation protocol rejected',
    `Expected protocol error, got: ${res5.error}`
  );

  // Status WAITING_FOR_APPROVAL
  const approvalJson = JSON.stringify({
    status: 'WAITING_FOR_APPROVAL',
    explanation: 'Confirming flight booking of ₹4,999'
  });
  const res6 = validateAIPlanResponse(approvalJson);
  assert(
    res6.valid && res6.plan.status === 'WAITING_FOR_APPROVAL' && res6.plan.requiresApproval === true,
    'TEST 2F - Status WAITING_FOR_APPROVAL mapped correctly',
    `Got: ${JSON.stringify(res6)}`
  );

  // Status NEEDS_CLARIFICATION
  const clarifyJson = JSON.stringify({
    status: 'NEEDS_CLARIFICATION',
    clarificationQuestion: 'Did you mean Product A or Product B?'
  });
  const res7 = validateAIPlanResponse(clarifyJson);
  assert(
    res7.valid && res7.plan.status === 'NEEDS_CLARIFICATION' && res7.plan.clarificationQuestion.includes('Product A'),
    'TEST 2G - Status NEEDS_CLARIFICATION mapped correctly',
    `Got: ${JSON.stringify(res7)}`
  );
}

// ============================================================================
// PART 3: PROVIDER IMPLEMENTATIONS & ERROR CASES
// ============================================================================

{
  // Test MockAIProvider
  const mockProvider = new MockAIProvider({ simulateLatencyMs: 5 });
  mockProvider.queueResponse({
    status: 'ACTION',
    explanation: 'Scroll down to see more laptops',
    action: { action: 'scroll', direction: 'down', amount: 500 }
  });

  const mockRes = await mockProvider.generatePlan({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: 'Find more laptops'
  });

  assert(
    mockRes.provider === 'mock' && mockRes.usage.totalTokens === 70,
    'TEST 3A - MockAIProvider generates plan with truthful token usage metrics',
    `Got: ${JSON.stringify(mockRes)}`
  );

  // Test GeminiProvider missing credentials guard
  const geminiProvider = new GeminiProvider({ apiKey: '' });
  let geminiCredError = null;
  try {
    await geminiProvider.generatePlan({ systemPrompt: '', userPrompt: '' });
  } catch (err) {
    geminiCredError = err;
  }
  assert(
    geminiCredError && geminiCredError.code === 'MISSING_CREDENTIALS',
    'TEST 3B - GeminiProvider detects missing API credentials cleanly',
    `Expected MISSING_CREDENTIALS, got: ${geminiCredError?.code}`
  );

  // Test OpenAICompatibleProvider missing credentials guard
  const openaiProvider = new OpenAICompatibleProvider({ apiKey: '', baseUrl: 'https://api.openai.com/v1' });
  let openaiCredError = null;
  try {
    await openaiProvider.generatePlan({ systemPrompt: '', userPrompt: '' });
  } catch (err) {
    openaiCredError = err;
  }
  assert(
    openaiCredError && openaiCredError.code === 'MISSING_CREDENTIALS',
    'TEST 3C - OpenAICompatibleProvider detects missing credentials cleanly',
    `Expected MISSING_CREDENTIALS, got: ${openaiCredError?.code}`
  );
}

// ============================================================================
// PART 4: EXPRESS HTTP ENDPOINT INTEGRATION
// ============================================================================

async function runHttpTests() {
  const mockProvider = new MockAIProvider({ simulateLatencyMs: 5 });
  const app = express();
  app.use(express.json());
  app.use('/api', createAIRouter({ mockProvider }));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. GET /api/models
    const modelsRes = await fetch(`${baseUrl}/api/models`);
    const modelsData = await modelsRes.json();
    assert(
      modelsRes.ok && modelsData.success && Array.isArray(modelsData.supportedProviders),
      'TEST 4A - GET /api/models returns provider metadata safely',
      `Got: ${JSON.stringify(modelsData)}`
    );

    // 2. POST /api/plan - Missing goal returns 400
    const badReqRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observation: {} })
    });
    const badReqData = await badReqRes.json();
    assert(
      badReqRes.status === 400 && badReqData.code === 'INVALID_INPUT',
      'TEST 4B - POST /api/plan validates required "goal" parameter',
      `Got: ${JSON.stringify(badReqData)}`
    );

    // 3. POST /api/plan - Valid request with mock provider
    mockProvider.queueResponse({
      status: 'ACTION',
      explanation: 'Click search bar',
      action: { action: 'click', elementId: 'element-15' }
    });

    const planReqRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'Click the search bar',
        observation: { page: { title: 'Test' }, interactive: {} },
        provider: 'mock'
      })
    });
    const planReqData = await planReqRes.json();

    assert(
      planReqRes.ok &&
      planReqData.success === true &&
      planReqData.plan.action.elementId === 'element-15' &&
      planReqData.metrics.provider === 'mock',
      'TEST 4C - POST /api/plan executes end-to-end plan generation and returns metrics',
      `Got: ${JSON.stringify(planReqData)}`
    );

    // 4. POST /api/plan - Model outputs invalid JSON (422 Unprocessable)
    mockProvider.queueResponse('Sorry, as an AI language model I cannot click things.');
    const invalidOutputRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'Click here',
        observation: { page: {} },
        provider: 'mock'
      })
    });
    const invalidOutputData = await invalidOutputRes.json();

    assert(
      invalidOutputRes.status === 422 && invalidOutputData.code === 'INVALID_MODEL_OUTPUT',
      'TEST 4D - Malformed model output returns 422 with structured INVALID_MODEL_OUTPUT',
      `Got status ${invalidOutputRes.status}: ${JSON.stringify(invalidOutputData)}`
    );

    // 5. POST /api/plan - Provider error simulation (Rate limit 429)
    mockProvider.setForcedError({
      message: 'Rate limit exceeded: 15 RPM',
      code: 'RATE_LIMIT',
      status: 429,
      retryable: true
    });

    const rateLimitRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        goal: 'Search products',
        observation: { page: {} },
        provider: 'mock'
      })
    });
    const rateLimitData = await rateLimitRes.json();

    assert(
      rateLimitRes.status === 429 && rateLimitData.code === 'RATE_LIMIT' && rateLimitData.retryable === true,
      'TEST 4E - Provider rate limit returned cleanly with HTTP 429 and retryable=true',
      `Got: ${JSON.stringify(rateLimitData)}`
    );

    // 6. POST /api/plan - Task Metrics Aggregation across multiple AI calls
    mockProvider.setForcedError(null);
    const testTaskId = `task-agg-${Date.now()}`;
    mockProvider.queueResponse({ status: 'ACTION', action: { action: 'scroll', direction: 'down' } });
    const call1Res = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Step 1', observation: { page: {} }, provider: 'mock', taskId: testTaskId })
    });
    const call1Data = await call1Res.json();

    mockProvider.queueResponse({ status: 'DONE', explanation: 'Step 2 done', result: { title: 'Finished' } });
    const call2Res = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Step 2', observation: { page: {} }, provider: 'mock', taskId: testTaskId })
    });
    const call2Data = await call2Res.json();

    const taskMetrics = call2Data.metrics?.taskMetrics;
    assert(
      taskMetrics &&
      taskMetrics.taskId === testTaskId &&
      taskMetrics.llmCallCount === 2 &&
      taskMetrics.inputTokens === 84 &&
      taskMetrics.outputTokens === 56 &&
      taskMetrics.totalTokens === 140,
      'TEST 4F - Per-task metrics properly aggregate token usage across multiple calls',
      `Got: ${JSON.stringify(taskMetrics)}`
    );

    // 7. GET /api/tasks/:taskId/metrics for a deterministic/uncalled task
    const detTaskRes = await fetch(`${baseUrl}/api/tasks/task-deterministic-99/metrics`);
    const detTaskData = await detTaskRes.json();
    assert(
      detTaskRes.ok &&
      detTaskData.metrics?.llmCallCount === 0 &&
      detTaskData.metrics?.totalTokens === 0 &&
      detTaskData.metrics?.usageAvailable === true,
      'TEST 4G - Deterministic / uncalled tasks report 0 LLM calls and 0 LLM tokens',
      `Got: ${JSON.stringify(detTaskData)}`
    );

    // 8. Provider with missing usage metadata marks usageAvailable: false without fabricating numbers
    mockProvider.setCustomUsage(null);
    const missingUsageTaskId = `task-missing-usage-${Date.now()}`;
    mockProvider.queueResponse({ status: 'DONE', result: { title: 'No usage test' } });
    const missingUsageRes = await fetch(`${baseUrl}/api/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'No usage', observation: { page: {} }, provider: 'mock', taskId: missingUsageTaskId })
    });
    const missingUsageData = await missingUsageRes.json();
    mockProvider.setCustomUsage(undefined);

    assert(
      missingUsageData.metrics?.usageAvailable === false &&
      missingUsageData.metrics?.taskMetrics?.usageAvailable === false &&
      missingUsageData.metrics?.taskMetrics?.totalTokens === null,
      'TEST 4H - Missing usage metadata cleanly marks usageAvailable: false without fabricating tokens',
      `Got: ${JSON.stringify(missingUsageData.metrics)}`
    );

    // ========================================================================
    // PART 5: PHASE 7.5 INTELLIGENT GEMINI MODEL FALLBACK SUITE (7 TESTS)
    // ========================================================================
    console.log('--- RUNNING PHASE 7.5 INTELLIGENT GEMINI MODEL FALLBACK TESTS ---');

    GeminiProvider.resetAllCooldowns();

    // FALLBACK TEST 1: Primary succeeds -> only one model is called
    {
      const callsMade = [];
      const testFetch = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsMade.push(model);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'DONE', explanation: 'Success from primary' }) }] } }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 25, totalTokenCount: 75 }
          })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash', 'gemini-3.6-flash'],
        fetchFn: testFetch
      });

      const res = await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'user' });
      assert(
        callsMade.length === 1 && callsMade[0] === 'gemini-3.8-flash',
        'FALLBACK TEST 1A - Primary succeeds: only one model is called',
        `Calls made: ${JSON.stringify(callsMade)}`
      );
      assert(
        res.fallbackOccurred === false && res.successfulModel === 'gemini-3.8-flash' && res.usage.totalTokens === 75,
        'FALLBACK TEST 1B - Single model metrics truthful',
        `Result: ${JSON.stringify(res)}`
      );
    }

    // FALLBACK TEST 2: Primary returns 429 -> eligible fallback is attempted within time budget
    {
      GeminiProvider.resetAllCooldowns();
      const callsMade = [];
      const testFetch = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsMade.push(model);
        if (model === 'gemini-3.8-flash') {
          return {
            ok: false,
            status: 429,
            headers: new Map(),
            json: async () => ({ error: { message: 'Resource exhausted: rate limit exceeded' } })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'DONE', explanation: 'Success from fallback' }) }] } }],
            usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 30, totalTokenCount: 85 }
          })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash', 'gemini-3.6-flash'],
        fetchFn: testFetch
      });

      const res = await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'user' });
      assert(
        callsMade.length === 2 && callsMade[0] === 'gemini-3.8-flash' && callsMade[1] === 'gemini-3.7-flash',
        'FALLBACK TEST 2A - Primary returns 429: eligible fallback is attempted within budget',
        `Calls made: ${JSON.stringify(callsMade)}`
      );
      assert(
        res.fallbackOccurred === true && res.successfulModel === 'gemini-3.7-flash' && res.attempts.length === 2,
        'FALLBACK TEST 2B - Fallback occurred flag and successful model recorded',
        `Result: ${JSON.stringify(res)}`
      );
    }

    // FALLBACK TEST 3: Primary times out -> fallback attempted without waiting indefinitely
    {
      GeminiProvider.resetAllCooldowns();
      const callsMade = [];
      const testFetch = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsMade.push(model);
        if (model === 'gemini-3.8-flash') {
          const abortErr = new Error('The operation was aborted due to timeout');
          abortErr.name = 'TimeoutError';
          throw abortErr;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'DONE', explanation: 'Fallback after timeout' }) }] } }],
            usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 20, totalTokenCount: 80 }
          })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash'],
        timeoutMs: 100,
        fetchFn: testFetch
      });

      const res = await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'user' });
      assert(
        callsMade.length === 2 && res.attempts[0].code === 'TIMEOUT' && res.successfulModel === 'gemini-3.7-flash',
        'FALLBACK TEST 3 - Primary times out: fallback is attempted without waiting indefinitely',
        `Result: ${JSON.stringify(res)}`
      );
    }

    // FALLBACK TEST 4: Primary returns 400 -> do NOT retry every model for invalid request
    {
      GeminiProvider.resetAllCooldowns();
      const callsMade = [];
      const testFetch = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsMade.push(model);
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: 'Invalid argument: bad parameter' } })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
        fetchFn: testFetch
      });

      let caughtErr = null;
      try {
        await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'user' });
      } catch (err) {
        caughtErr = err;
      }

      assert(
        caughtErr && caughtErr.status === 400 && caughtErr.code === 'INVALID_REQUEST' && callsMade.length === 1,
        'FALLBACK TEST 4 - Primary returns 400: do not retry every model for the same invalid request',
        `Caught: ${caughtErr?.code}, calls: ${JSON.stringify(callsMade)}`
      );
    }

    // FALLBACK TEST 5: All models fail -> clear error without fake success
    {
      GeminiProvider.resetAllCooldowns();
      const callsMade = [];
      const testFetch = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsMade.push(model);
        return {
          ok: false,
          status: 503,
          json: async () => ({ error: { message: 'Service unavailable' } })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash', 'gemini-3.6-flash'],
        fetchFn: testFetch
      });

      let caughtErr = null;
      try {
        await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'user' });
      } catch (err) {
        caughtErr = err;
      }

      assert(
        caughtErr &&
        caughtErr.code === 'AI_SERVICE_UNAVAILABLE' &&
        caughtErr.status === 503 &&
        callsMade.length === 3 &&
        caughtErr.attempts.length === 3,
        'FALLBACK TEST 5 - All models fail: show a clear error without fake success',
        `Caught: ${caughtErr?.code}, attempts: ${caughtErr?.attempts?.length}`
      );
    }

    // FALLBACK TEST 6: Repeated failures -> cooldown prevents repeatedly selecting known-unavailable model
    {
      GeminiProvider.resetAllCooldowns();
      // First call: primary model gemini-3.8-flash fails with 503, fallback gemini-3.7-flash succeeds
      const callsFirstRun = [];
      const fetchRun1 = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsFirstRun.push(model);
        if (model === 'gemini-3.8-flash') {
          return { ok: false, status: 503, json: async () => ({ error: { message: 'Overloaded' } }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'DONE', explanation: 'Run 1 fallback' }) }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 }
          })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.8-flash',
        fallbackModels: ['gemini-3.7-flash'],
        fetchFn: fetchRun1
      });

      await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'user' });
      assert(
        provider.isModelCoolingDown('gemini-3.8-flash') === true,
        'FALLBACK TEST 6A - Failed model is placed in temporary cooldown',
        'Cooldown not set for gemini-3.8-flash'
      );

      // Second call immediately after: gemini-3.8-flash should be skipped due to active cooldown!
      const callsSecondRun = [];
      const fetchRun2 = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsSecondRun.push(model);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'DONE', explanation: 'Run 2 direct' }) }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10, totalTokenCount: 20 }
          })
        };
      };

      provider.fetchFn = fetchRun2;
      const res2 = await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'user' });

      assert(
        callsSecondRun.length === 1 && callsSecondRun[0] === 'gemini-3.7-flash',
        'FALLBACK TEST 6B - Cooldown prevents repeatedly selecting known-unavailable model',
        `Calls in run 2: ${JSON.stringify(callsSecondRun)}`
      );
      GeminiProvider.resetAllCooldowns();
    }

    // FALLBACK TEST 7: Token metrics -> actual usage across calls aggregated without double-counting
    {
      const taskId = `fallback-token-task-${Date.now()}`;
      mockProvider.reset();
      mockProvider.setFallbackScenario({
        primaryError: 'Rate limit 429',
        successfulModel: 'gemini-3.7-flash',
        reason: 'Primary model overloaded'
      });
      mockProvider.setCustomUsage({
        promptTokens: 120,
        completionTokens: 80,
        totalTokens: 200,
        usageAvailable: true
      });

      const response = await fetch(`${baseUrl}/api/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: 'Research quantum computing',
          observation: { page: {} },
          provider: 'mock',
          taskId
        })
      });
      const data = await response.json();

      const taskMetrics = data.metrics?.taskMetrics;
      assert(
        taskMetrics &&
        taskMetrics.fallbackOccurred === true &&
        taskMetrics.successfulModel === 'gemini-3.7-flash' &&
        taskMetrics.llmCallCount === 2 &&
        taskMetrics.totalTokens === 200 &&
        taskMetrics.inputTokens === 120 &&
        taskMetrics.outputTokens === 80,
        'FALLBACK TEST 7 - Token metrics: actual usage across calls aggregated without double-counting',
        `Got: ${JSON.stringify(taskMetrics)}`
      );
      mockProvider.reset();
    }

    // FALLBACK TEST 8: Simulated timeout places model in cooldown and succeeds via fallback
    {
      GeminiProvider.resetAllCooldowns();
      const callsMade = [];
      const fetchWithTimeout = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsMade.push(model);
        if (model === 'gemini-3.6-flash') {
          const timeoutErr = new Error('The operation was aborted due to timeout');
          timeoutErr.name = 'TimeoutError';
          throw timeoutErr;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'DONE', explanation: 'Recovered after timeout' }) }] } }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 20, totalTokenCount: 70 }
          })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.6-flash',
        fallbackModels: ['gemini-3.5-flash-lite'],
        fetchFn: fetchWithTimeout
      });

      const res = await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'summarize' });
      assert(
        res && res.model === 'gemini-3.5-flash-lite' && res.fallbackOccurred === true,
        'FALLBACK TEST 8A - Simulated timeout triggers fallback to next eligible model',
        `Result model: ${res.model}`
      );
      assert(
        provider.isModelCoolingDown('gemini-3.6-flash') === true,
        'FALLBACK TEST 8B - Timed-out model placed in circuit-breaker cooldown',
        'Cooldown was not set for timed out model'
      );
      GeminiProvider.resetAllCooldowns();
    }

    // FALLBACK TEST 9: Simulated 429 rate-limit places model in cooldown
    {
      GeminiProvider.resetAllCooldowns();
      const callsMade = [];
      const fetchWith429 = async (url) => {
        const model = decodeURIComponent(url.split('/models/')[1].split(':')[0]);
        callsMade.push(model);
        if (model === 'gemini-3.6-flash') {
          return {
            ok: false,
            status: 429,
            json: async () => ({ error: { message: 'Resource has been exhausted (rate limit)' } })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ status: 'DONE', explanation: 'Success on fallback' }) }] } }],
            usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 15, totalTokenCount: 55 }
          })
        };
      };

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.6-flash',
        fallbackModels: ['gemini-3.5-flash-lite'],
        fetchFn: fetchWith429
      });

      const res = await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'summarize' });
      assert(
        res.model === 'gemini-3.5-flash-lite' && provider.isModelCoolingDown('gemini-3.6-flash'),
        'FALLBACK TEST 9 - Simulated 429 rate limit triggers fallback and places model in cooldown',
        `Result: ${JSON.stringify(res)}`
      );
      GeminiProvider.resetAllCooldowns();
    }

    // FALLBACK TEST 10: All models fail scenario returns clear 503 error without fake success
    {
      GeminiProvider.resetAllCooldowns();
      const fetchAllFail = async () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: { message: 'Service overloaded' } })
      });

      const provider = new GeminiProvider({
        apiKey: 'test_key',
        primaryModel: 'gemini-3.6-flash',
        fallbackModels: ['gemini-3.5-flash-lite'],
        fetchFn: fetchAllFail
      });

      let caughtErr = null;
      try {
        await provider.generatePlan({ systemPrompt: 'sys', userPrompt: 'summarize' });
      } catch (e) {
        caughtErr = e;
      }

      assert(
        caughtErr && caughtErr.status === 503 && caughtErr.code === 'AI_SERVICE_UNAVAILABLE',
        'FALLBACK TEST 10 - All models fail scenario returns clear 503 error without fake success',
        `Caught: ${caughtErr?.message}`
      );
      GeminiProvider.resetAllCooldowns();
    }

    // REAL GEMINI TEST: Page-summary request on Wikipedia Artificial Intelligence observation
    {
      const hasKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '' && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here');
      if (hasKey) {
        const geminiProvider = new GeminiProvider();
        const wikiObservation = {
          page: {
            title: 'Artificial intelligence - Wikipedia',
            url: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
            hostname: 'en.wikipedia.org'
          },
          content: {
            headings: [
              { tag: 'h1', text: 'Artificial intelligence' },
              { tag: 'h2', text: 'Definitions and scope' },
              { tag: 'h2', text: 'History of AI' },
              { tag: 'h2', text: 'Applications' }
            ],
            paragraphs: [
              'Artificial intelligence (AI) is the intelligence of machines or software, as opposed to the intelligence of living beings, primarily of humans.',
              'AI applications include advanced web search engines (e.g., Google Search), recommendation systems, understanding human speech, self-driving cars, and generative tools.',
              'Alan Turing was the first to conduct substantial research into machine intelligence in the 1950s.'
            ]
          },
          interactive: {
            inputs: [{ id: 'search-1', placeholder: 'Search Wikipedia' }],
            buttons: [{ id: 'btn-1', text: 'Search' }],
            links: [{ id: 'link-1', text: 'Main page', href: 'https://en.wikipedia.org' }]
          }
        };

        const planResult = await geminiProvider.generatePlan({
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: buildUserPrompt({
            goal: 'summarize this page for me',
            observation: wikiObservation
          }),
          observation: wikiObservation
        });

        const validation = validateAIPlanResponse(planResult.rawText);
        assert(
          validation.valid && validation.plan.status === 'DONE' && validation.plan.result &&
          (validation.plan.result.title?.toLowerCase().includes('artificial intelligence') || validation.plan.result.answer?.toLowerCase().includes('intelligence')),
          'REAL GEMINI TEST - Page summary on Wikipedia AI page succeeds with grounded answer and valid JSON',
          `Plan: ${JSON.stringify(validation.plan)}`
        );
        assert(
          planResult.usage && typeof planResult.usage.totalTokens === 'number' && planResult.usage.totalTokens > 0,
          'REAL GEMINI TEST - Provider reports truthful token metrics without fabrication',
          `Tokens: ${JSON.stringify(planResult.usage)}`
        );
      } else {
        console.log('SKIP: Real Gemini API test skipped (no live key present)');
      }
    }
  } finally {
    server.close();
  }

  console.log('========================================');
  console.log(`BACKEND TEST RESULTS: ${passed} passed, ${failed} failed.`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runHttpTests().catch((err) => {
  console.error('Fatal backend test error:', err);
  process.exit(1);
});
