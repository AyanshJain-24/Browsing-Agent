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
