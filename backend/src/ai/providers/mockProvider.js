/**
 * Voice Browser Agent - Mock AI Provider
 * 
 * Provides deterministic, zero-network responses for unit tests, offline development,
 * and test harness verification of error cases (rate limit, timeout, malformed output,
 * intelligent model fallback).
 */

import { BaseAIProvider, ProviderError } from './providerInterface.js';

export class MockAIProvider extends BaseAIProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'mock';
    this.configuredResponses = [];
    this.defaultHandler = null;
    this.simulateLatencyMs = config.simulateLatencyMs || 20;
    this.forcedError = config.forcedError || null;
    this.customUsage = config.usage !== undefined ? config.usage : undefined;
    this.fallbackScenario = config.fallbackScenario || null;
    this.primaryModel = config.primaryModel || 'mock-primary';
    this.fallbackModels = config.fallbackModels || ['mock-fallback-1', 'mock-fallback-2'];
  }

  setCustomUsage(usage) {
    this.customUsage = usage;
  }

  setForcedError(errorObj) {
    this.forcedError = errorObj;
  }

  setFallbackScenario(scenario) {
    this.fallbackScenario = scenario;
  }

  queueResponse(response) {
    this.configuredResponses.push(response);
  }

  setDefaultHandler(handlerFn) {
    this.defaultHandler = handlerFn;
  }

  reset() {
    this.configuredResponses = [];
    this.defaultHandler = null;
    this.forcedError = null;
    this.fallbackScenario = null;
  }

  async generatePlan({ systemPrompt, userPrompt, observation, options = {} }) {
    if (this.simulateLatencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulateLatencyMs));
    }

    if (this.forcedError) {
      const err = this.forcedError;
      throw new ProviderError(err.message || 'Mock provider error', {
        code: err.code || 'MOCK_ERROR',
        status: err.status || 500,
        retryable: err.retryable || false,
        attempts: err.attempts || [
          {
            model: this.primaryModel,
            latencyMs: this.simulateLatencyMs,
            success: false,
            error: err.message || 'Mock provider error',
            code: err.code || 'MOCK_ERROR',
            status: err.status || 500
          }
        ]
      });
    }

    let responseContent;

    if (this.configuredResponses.length > 0) {
      responseContent = this.configuredResponses.shift();
    } else if (this.defaultHandler) {
      responseContent = this.defaultHandler({ userPrompt, observation, options });
    } else {
      // Sensible default mock planning response
      responseContent = {
        status: 'DONE',
        explanation: 'Mock plan completed',
        result: { title: 'Mock completed' }
      };
    }

    const rawText = typeof responseContent === 'string'
      ? responseContent
      : JSON.stringify(responseContent);

    const usage = this.customUsage !== undefined
      ? this.customUsage
      : {
          promptTokens: 42,
          completionTokens: 28,
          totalTokens: 70,
          usageAvailable: true
        };

    if (this.fallbackScenario) {
      const successfulModel = this.fallbackScenario.successfulModel || this.fallbackModels[0] || 'mock-fallback-1';
      const attempts = this.fallbackScenario.attempts || [
        {
          model: this.primaryModel,
          attemptIndex: 1,
          latencyMs: 15,
          success: false,
          error: this.fallbackScenario.primaryError || 'Rate limit 429',
          code: this.fallbackScenario.primaryCode || 'RATE_LIMIT',
          status: this.fallbackScenario.primaryStatus || 429,
          usage: null
        },
        {
          model: successfulModel,
          attemptIndex: 2,
          latencyMs: this.simulateLatencyMs,
          success: true,
          error: null,
          code: null,
          status: 200,
          usage
        }
      ];

      return {
        rawText,
        usage,
        latencyMs: this.simulateLatencyMs + 15,
        model: successfulModel,
        provider: 'mock',
        primaryModel: this.primaryModel,
        successfulModel,
        fallbackOccurred: true,
        fallbackReason: this.fallbackScenario.reason || 'Primary model overloaded',
        attempts
      };
    }

    return {
      rawText,
      usage,
      latencyMs: this.simulateLatencyMs,
      model: 'mock-model-v1',
      provider: 'mock',
      primaryModel: this.primaryModel,
      successfulModel: 'mock-model-v1',
      fallbackOccurred: false,
      fallbackReason: null,
      attempts: [
        {
          model: 'mock-model-v1',
          attemptIndex: 1,
          latencyMs: this.simulateLatencyMs,
          success: true,
          usage
        }
      ]
    };
  }
}
