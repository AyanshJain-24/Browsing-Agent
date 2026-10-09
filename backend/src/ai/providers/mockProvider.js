/**
 * Voice Browser Agent - Mock AI Provider
 * 
 * Provides deterministic, zero-network responses for unit tests, offline development,
 * and test harness verification of error cases (rate limit, timeout, malformed output).
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
  }

  setForcedError(errorObj) {
    this.forcedError = errorObj;
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
        retryable: err.retryable || false
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

    return {
      rawText,
      usage: {
        promptTokens: 42,
        completionTokens: 28,
        totalTokens: 70
      },
      latencyMs: this.simulateLatencyMs,
      model: 'mock-model-v1',
      provider: 'mock'
    };
  }
}
