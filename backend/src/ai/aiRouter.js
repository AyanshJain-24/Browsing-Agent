/**
 * Voice Browser Agent - AI Router
 * 
 * Express Router managing AI planning requests, model provider orchestration,
 * input validation, security boundaries, and telemetry metrics.
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

    res.json({
      success: true,
      activeProvider: activeProvider.name,
      isConfigured: activeConfig.configured,
      model: activeProvider.model || activeProvider.name,
      supportedProviders: [
        {
          id: 'gemini',
          name: 'Google Gemini (2.0 Flash / 1.5 Flash)',
          configured: providers.gemini.checkConfiguration().configured,
          model: providers.gemini.model,
          description: 'Sub-second latency, native JSON structured output schema, generous tier.'
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
  // POST /api/plan - Primary AI reasoning and planning endpoint
  // ==========================================================================
  router.post('/plan', async (req, res) => {
    const startTime = Date.now();
    const { goal, observation, history, lastFailure, provider: providerOverride, options: clientOptions } = req.body || {};

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
        lastFailure: lastFailure || null
      });
    } catch (promptErr) {
      return res.status(400).json({
        success: false,
        error: `Could not build observation prompt: ${promptErr.message}`,
        code: 'PROMPT_ERROR'
      });
    }

    // 4. Invoke provider
    let rawResult;
    try {
      rawResult = await provider.generatePlan({
        systemPrompt,
        userPrompt,
        observation,
        options: clientOptions || {}
      });
    } catch (err) {
      const isProviderErr = err instanceof ProviderError;
      const status = isProviderErr ? err.status : 500;
      const code = isProviderErr ? err.code : 'PROVIDER_ERROR';

      return res.status(status).json({
        success: false,
        error: err.message,
        code,
        retryable: isProviderErr ? err.retryable : false,
        latencyMs: Date.now() - startTime
      });
    }

    // 5. Validate model response
    const validation = validateAIPlanResponse(rawResult.rawText);

    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        error: `AI model returned invalid plan: ${validation.error}`,
        code: 'INVALID_MODEL_OUTPUT',
        rawText: validation.rawText,
        metrics: {
          provider: rawResult.provider,
          model: rawResult.model,
          latencyMs: rawResult.latencyMs,
          ...(rawResult.usage || {})
        }
      });
    }

    // 6. Return verified, structured plan
    return res.json({
      success: true,
      plan: validation.plan,
      metrics: {
        provider: rawResult.provider,
        model: rawResult.model,
        latencyMs: rawResult.latencyMs,
        promptTokens: rawResult.usage?.promptTokens ?? 0,
        completionTokens: rawResult.usage?.completionTokens ?? 0,
        totalTokens: rawResult.usage?.totalTokens ?? 0
      }
    });
  });

  return router;
}
