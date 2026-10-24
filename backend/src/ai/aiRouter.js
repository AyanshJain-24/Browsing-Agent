/**
 * Voice Browser Agent - AI Router with Intelligent Model Fallback
 * 
 * Express Router managing AI planning requests, model provider orchestration,
 * input validation, security boundaries, failure classification, and truthful telemetry.
 */

import { Router } from 'express';
import { GeminiProvider } from './providers/geminiProvider.js';
import { OpenAICompatibleProvider } from './providers/openAiCompatibleProvider.js';
import { MockAIProvider } from './providers/mockProvider.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './promptBuilder.js';
import { validateAIPlanResponse } from './responseValidator.js';
import { ProviderError } from './providers/providerInterface.js';

export function createAIRouter(options = {}) {
  const router = Router();

  // Initialize providers
  const providers = {
    gemini: options.geminiProvider || new GeminiProvider(),
    openai_compatible: options.openAiProvider || new OpenAICompatibleProvider(),
    mock: options.mockProvider || new MockAIProvider()
  };

  /**
   * Resolves the active AI provider based on environment or request override.
   * @param {string} [requestedProvider]
   * @returns {import('./providers/providerInterface.js').BaseAIProvider}
   */
  function resolveProvider(requestedProvider) {
    const providerKey = (requestedProvider || process.env.AI_PROVIDER || 'gemini').toLowerCase().trim();
    if (providers[providerKey]) {
      return providers[providerKey];
    }
    // Fallback to gemini if unrecognized
    return providers.gemini;
  }

  // ==========================================================================
  // GET /api/models - Lists available providers and configuration status
  // ==========================================================================
  router.get('/models', (req, res) => {
    const activeProvider = resolveProvider();
    const activeConfig = activeProvider.checkConfiguration();
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '');
    const isPlaceholder = process.env.GEMINI_API_KEY === 'your_gemini_api_key_here';

    const geminiCooldowns = Array.from(GeminiProvider.cooldowns.entries()).map(([model, entry]) => ({
      model,
      active: Date.now() < entry.until,
      remainingMs: Math.max(0, entry.until - Date.now()),
      reason: entry.reason
    })).filter((c) => c.active);

    res.json({
      success: true,
      activeProvider: activeProvider.name,
      isConfigured: activeConfig.configured,
      model: activeProvider.model || activeProvider.name,
      geminiConfig: {
        primaryModel: providers.gemini.primaryModel,
        fallbackModels: providers.gemini.fallbackModels,
        maxAttempts: providers.gemini.maxAttempts,
        timeoutMs: providers.gemini.timeoutMs,
        activeCooldowns: geminiCooldowns
      },
      diagnostic: {
        resolvedEnvPath: process.env.RESOLVED_ENV_PATH || 'backend/.env',
        geminiKeyExists: hasGeminiKey,
        isPlaceholder,
        providerConfigured: activeConfig.configured
      },
      supportedProviders: [
        {
          id: 'gemini',
          name: 'Google Gemini (Intelligent Fallback Chain)',
          configured: providers.gemini.checkConfiguration().configured,
          primaryModel: providers.gemini.primaryModel,
          fallbackModels: providers.gemini.fallbackModels,
          model: providers.gemini.model,
          description: 'Sub-second latency, native JSON structured output schema, automated fallback across models.'
        },
        {
          id: 'openai_compatible',
          name: 'OpenAI-Compatible (DeepSeek, Qwen, Groq, Ollama)',
          configured: providers.openai_compatible.checkConfiguration().configured,
          model: providers.openai_compatible.model,
          description: 'Universal compatibility with DeepSeek, Qwen, OpenRouter, Groq, or local Ollama.'
        },
        {
          id: 'mock',
          name: 'Mock Provider (Testing & Offline)',
          configured: true,
          model: 'mock-model-v1',
          description: 'Deterministic test simulator for error injection and offline development.'
        }
      ]
    });
  });

  // ==========================================================================
  // GET /api/search - Search API Provider Abstraction
  // ==========================================================================
  router.get('/search', (req, res) => {
    const hasSearchKey = Boolean(process.env.SEARCH_API_KEY && process.env.SEARCH_API_KEY.trim() !== '');
    const provider = process.env.SEARCH_PROVIDER || (hasSearchKey ? 'google_custom' : 'browser_search_page');

    res.json({
      success: true,
      configured: hasSearchKey,
      provider,
      description: hasSearchKey
        ? `Configured search provider (${provider})`
        : 'No external Search API configured. Agent will use real browser search page navigation and observe rendered results.'
    });
  });

  // ==========================================================================
  // GET /api/diagnostic - Safe diagnostic reporting .env status without secrets
  // ==========================================================================
  router.get('/diagnostic', (req, res) => {
    const activeProvider = resolveProvider();
    const activeConfig = activeProvider.checkConfiguration();
    const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== '');
    const isPlaceholder = process.env.GEMINI_API_KEY === 'your_gemini_api_key_here';

    res.json({
      success: true,
      resolvedEnvPath: process.env.RESOLVED_ENV_PATH || 'backend/.env',
      activeProvider: activeProvider.name,
      geminiKeyExists: hasGeminiKey,
      isPlaceholder,
      isConfigured: activeConfig.configured
    });
  });

  // ==========================================================================
  // In-memory per-task metrics store (isolated per taskId)
  // ==========================================================================
  const taskMetricsStore = new Map();

  function getOrCreateTaskMetrics(taskId) {
    if (!taskMetricsStore.has(taskId)) {
      taskMetricsStore.set(taskId, {
        taskId,
        llmCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        thinkingTokens: undefined,
        usageAvailable: true,
        durationMs: 0,
        fallbackOccurred: false,
        primaryModel: null,
        successfulModel: null,
        fallbackReason: null,
        calls: [],
        createdAt: Date.now()
      });
    }
    return taskMetricsStore.get(taskId);
  }

  // ==========================================================================
  // GET /api/tasks/:taskId/metrics - Returns aggregated token usage for a task
  // ==========================================================================
  router.get('/tasks/:taskId/metrics', (req, res) => {
    const { taskId } = req.params;
    const taskRecord = taskMetricsStore.get(taskId);

    if (!taskRecord) {
      // Deterministic-only or not-yet-called tasks have 0 LLM calls and 0 tokens
      return res.json({
        success: true,
        metrics: {
          taskId,
          llmCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          usageAvailable: true,
          durationMs: 0,
          fallbackOccurred: false,
          successfulModel: null,
          calls: []
        }
      });
    }

    res.json({
      success: true,
      metrics: {
        taskId,
        llmCallCount: taskRecord.llmCallCount,
        inputTokens: taskRecord.usageAvailable ? taskRecord.inputTokens : null,
        outputTokens: taskRecord.usageAvailable ? taskRecord.outputTokens : null,
        totalTokens: taskRecord.usageAvailable ? taskRecord.totalTokens : null,
        ...(taskRecord.thinkingTokens !== undefined ? { thinkingTokens: taskRecord.thinkingTokens } : {}),
        usageAvailable: taskRecord.usageAvailable,
        durationMs: taskRecord.durationMs,
        fallbackOccurred: Boolean(taskRecord.fallbackOccurred),
        primaryModel: taskRecord.primaryModel,
        successfulModel: taskRecord.successfulModel,
        fallbackReason: taskRecord.fallbackReason,
        calls: taskRecord.calls || []
      }
    });
  });

  // ==========================================================================
  // POST /api/plan - Primary AI reasoning and planning endpoint
  // ==========================================================================
  router.post('/plan', async (req, res) => {
    const startTime = Date.now();
    const {
      goal,
      observation,
      history,
      conversationHistory,
      lastFailure,
      provider: providerOverride,
      options: clientOptions,
      taskId
    } = req.body || {};

    const activeTaskId = taskId || `task-${Date.now()}`;
    const goalSnippet = typeof goal === 'string' ? (goal.length > 70 ? `${goal.slice(0, 70)}...` : goal) : '<missing>';
    console.log(`[AI_ROUTER] [${activeTaskId}] Received POST /api/plan (provider: ${providerOverride || 'default'}, goal: "${goalSnippet}")`);

    // 1. Input validation
    if (!goal || typeof goal !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "goal" parameter. Must be a non-empty string.',
        code: 'INVALID_INPUT'
      });
    }

    if (goal.length > 2000) {
      return res.status(400).json({
        success: false,
        error: 'Goal string exceeds maximum allowed length of 2000 characters.',
        code: 'PAYLOAD_TOO_LARGE'
      });
    }

    if (!observation || typeof observation !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "observation" parameter. Page observation object is required.',
        code: 'INVALID_INPUT'
      });
    }

    // 2. Resolve provider
    const provider = resolveProvider(providerOverride);

    // 3. Build prompts
    let systemPrompt = SYSTEM_PROMPT;
    let userPrompt;
    try {
      userPrompt = buildUserPrompt({
        goal,
        observation,
        history: Array.isArray(history) ? history : [],
        conversationHistory: Array.isArray(conversationHistory) ? conversationHistory : [],
        lastFailure: lastFailure || null
      });
    } catch (promptErr) {
      return res.status(400).json({
        success: false,
        error: `Could not build observation prompt: ${promptErr.message}`,
        code: 'PROMPT_ERROR'
      });
    }

    // 4. Invoke provider with fallback chain
    let rawResult;
    try {
      rawResult = await provider.generatePlan({
        systemPrompt,
        userPrompt,
        observation,
        options: {
          ...(clientOptions || {}),
          taskId: activeTaskId
        }
      });
    } catch (err) {
      const isProviderErr = err instanceof ProviderError;
      const status = isProviderErr ? err.status : 500;
      const code = isProviderErr ? err.code : 'PROVIDER_ERROR';

      // Accurately record attempted provider calls even on failure
      const attempts = err.attempts || [];
      if (attempts.length > 0) {
        const taskRecord = getOrCreateTaskMetrics(activeTaskId);
        taskRecord.llmCallCount += attempts.length;
        taskRecord.calls = (taskRecord.calls || []).concat(attempts);
        taskRecord.durationMs += (Date.now() - startTime);

        // Aggregate any actual usage reported during failed attempts
        for (const att of attempts) {
          if (att.usage && att.usage.usageAvailable !== false && typeof att.usage.totalTokens === 'number') {
            taskRecord.inputTokens += (att.usage.promptTokens ?? 0);
            taskRecord.outputTokens += (att.usage.completionTokens ?? 0);
            taskRecord.totalTokens += (att.usage.totalTokens ?? 0);
          }
        }
      }

      console.error(`[AI_ROUTER] [${activeTaskId}] Request failed after ${Date.now() - startTime}ms - HTTP ${status} (${code}): ${err.message}`);

      return res.status(status).json({
        success: false,
        error: err.message,
        code,
        retryable: isProviderErr ? err.retryable : false,
        attempts: err.attempts || [],
        latencyMs: Date.now() - startTime
      });
    }

    // 5. Real token accounting across actual provider calls
    const usage = rawResult.usage;
    const attempts = Array.isArray(rawResult.attempts) ? rawResult.attempts : [];
    const callsMade = attempts.length > 0 ? attempts.length : 1;
    const taskRecord = getOrCreateTaskMetrics(activeTaskId);

    taskRecord.llmCallCount += callsMade;
    taskRecord.durationMs += (rawResult.latencyMs || (Date.now() - startTime));
    taskRecord.calls = (taskRecord.calls || []).concat(attempts);

    if (rawResult.fallbackOccurred) {
      taskRecord.fallbackOccurred = true;
      taskRecord.fallbackReason = rawResult.fallbackReason;
    }
    taskRecord.primaryModel = rawResult.primaryModel || taskRecord.primaryModel;
    taskRecord.successfulModel = rawResult.successfulModel || rawResult.model;

    // Aggregate tokens across actual calls: never invent tokens
    if (!usage || usage.usageAvailable === false) {
      taskRecord.usageAvailable = false;
      taskRecord.inputTokens = null;
      taskRecord.outputTokens = null;
      taskRecord.totalTokens = null;
    } else if (taskRecord.usageAvailable) {
      let callPromptTokens = 0;
      let callCompletionTokens = 0;
      let callTotalTokens = 0;
      let hasDetailedAttemptUsage = false;

      for (const att of attempts) {
        if (att.usage && att.usage.usageAvailable !== false && typeof att.usage.totalTokens === 'number') {
          callPromptTokens += (att.usage.promptTokens ?? 0);
          callCompletionTokens += (att.usage.completionTokens ?? 0);
          callTotalTokens += (att.usage.totalTokens ?? 0);
          hasDetailedAttemptUsage = true;
        }
      }

      if (hasDetailedAttemptUsage) {
        taskRecord.inputTokens += callPromptTokens;
        taskRecord.outputTokens += callCompletionTokens;
        taskRecord.totalTokens += callTotalTokens;
      } else {
        taskRecord.inputTokens += (usage.promptTokens ?? 0);
        taskRecord.outputTokens += (usage.completionTokens ?? 0);
        taskRecord.totalTokens += (usage.totalTokens ?? 0);
      }

      if (typeof usage.thinkingTokens === 'number') {
        taskRecord.thinkingTokens = (taskRecord.thinkingTokens || 0) + usage.thinkingTokens;
      }
    }

    const structuredTaskMetrics = {
      taskId: activeTaskId,
      llmCallCount: taskRecord.llmCallCount,
      inputTokens: taskRecord.usageAvailable ? taskRecord.inputTokens : null,
      outputTokens: taskRecord.usageAvailable ? taskRecord.outputTokens : null,
      totalTokens: taskRecord.usageAvailable ? taskRecord.totalTokens : null,
      ...(taskRecord.thinkingTokens !== undefined ? { thinkingTokens: taskRecord.thinkingTokens } : {}),
      usageAvailable: taskRecord.usageAvailable,
      durationMs: taskRecord.durationMs,
      fallbackOccurred: Boolean(taskRecord.fallbackOccurred),
      primaryModel: taskRecord.primaryModel,
      successfulModel: taskRecord.successfulModel,
      fallbackReason: taskRecord.fallbackReason,
      calls: taskRecord.calls
    };

    // 6. Validate model response
    let validation = validateAIPlanResponse(rawResult.rawText);

    // If a fallback model returns malformed output (or recovery explicitly requested), allow at most one recovery attempt within configured budget
    if (!validation.valid && (clientOptions?.allowRecovery === true || (rawResult.fallbackOccurred && clientOptions?.allowRecovery !== false))) {
      try {
        const recoveryResult = await provider.generatePlan({
          systemPrompt,
          userPrompt: `${userPrompt}\n\nIMPORTANT RECOVERY NOTE: Your previous response was invalid JSON (${validation.error}). Output strictly valid JSON conforming to schema.`,
          observation,
          options: { ...(clientOptions || {}), allowRecovery: false }
        });
        const recoveryValidation = validateAIPlanResponse(recoveryResult.rawText);
        if (recoveryValidation.valid) {
          validation = recoveryValidation;
          rawResult = recoveryResult;
          // Record recovery call metrics
          taskRecord.llmCallCount += 1;
          if (recoveryResult.usage?.usageAvailable && taskRecord.usageAvailable) {
            taskRecord.inputTokens += (recoveryResult.usage.promptTokens ?? 0);
            taskRecord.outputTokens += (recoveryResult.usage.completionTokens ?? 0);
            taskRecord.totalTokens += (recoveryResult.usage.totalTokens ?? 0);
          }
        }
      } catch {
        // Fall through to normal validation failure reporting
      }
    }

    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        error: `AI model returned invalid plan: ${validation.error}`,
        code: 'INVALID_MODEL_OUTPUT',
        rawText: validation.rawText,
        metrics: {
          provider: rawResult.provider,
          model: rawResult.model,
          primaryModel: rawResult.primaryModel,
          successfulModel: rawResult.successfulModel || rawResult.model,
          fallbackOccurred: Boolean(rawResult.fallbackOccurred),
          fallbackReason: rawResult.fallbackReason || null,
          attempts,
          latencyMs: rawResult.latencyMs,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          totalTokens: usage?.totalTokens ?? 0,
          ...(usage?.thinkingTokens !== undefined ? { thinkingTokens: usage.thinkingTokens } : {}),
          usageAvailable: usage?.usageAvailable ?? false,
          taskMetrics: structuredTaskMetrics
        }
      });
    }

    console.log(`[AI_ROUTER] [${activeTaskId}] SUCCESS in ${Date.now() - startTime}ms via model='${rawResult.model}'. Fallback: ${Boolean(rawResult.fallbackOccurred)}. Tokens: ${usage?.totalTokens ?? 'N/A'}`);

    // 7. Return verified, structured plan with truthful telemetry
    return res.json({
      success: true,
      plan: validation.plan,
      metrics: {
        provider: rawResult.provider,
        model: rawResult.model,
        primaryModel: rawResult.primaryModel,
        successfulModel: rawResult.successfulModel || rawResult.model,
        fallbackOccurred: Boolean(rawResult.fallbackOccurred),
        fallbackReason: rawResult.fallbackReason || null,
        attempts,
        latencyMs: rawResult.latencyMs,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        ...(usage?.thinkingTokens !== undefined ? { thinkingTokens: usage.thinkingTokens } : {}),
        usageAvailable: usage?.usageAvailable ?? false,
        taskMetrics: structuredTaskMetrics
      }
    });
  });

  return router;
}
