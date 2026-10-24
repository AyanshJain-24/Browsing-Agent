/**
 * Voice Browser Agent - AI Provider Interface
 * 
 * Defines the contract that all model providers (Gemini, OpenAI-compatible, DeepSeek, Qwen, Mock)
 * must implement to ensure seamless plug-and-play provider switching without altering agent logic.
 */

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {Object} [options]
   * @param {string} [options.code] - e.g. 'RATE_LIMIT', 'TIMEOUT', 'INVALID_CREDENTIALS', 'PROVIDER_UNAVAILABLE'
   * @param {number} [options.status] - HTTP status code
   * @param {boolean} [options.retryable] - Whether caller may retry
   * @param {Array} [options.attempts] - Call history across model attempts
   */
  constructor(message, { code = 'PROVIDER_ERROR', status = 500, retryable = false, attempts = [] } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.attempts = attempts;
  }
}

export class BaseAIProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
  }

  /**
   * Generates a structured JSON plan from the AI model.
   * 
   * @param {Object} params
   * @param {string} params.systemPrompt - Instructions and output schema rules
   * @param {string} params.userPrompt - Formatted user goal and task context
   * @param {Object} [params.observation] - Compact page observation
   * @param {Object} [params.options] - Optional overrides (temperature, timeoutMs, etc.)
   * @returns {Promise<{
   *   rawText: string,
   *   usage: { promptTokens?: number, completionTokens?: number, totalTokens?: number },
   *   latencyMs: number,
   *   model: string,
   *   provider: string
   * }>}
   */
  async generatePlan(params) {
    throw new Error('generatePlan() must be implemented by subclass');
  }

  /**
   * Checks if the provider is properly configured (e.g. API key present).
   * @returns {{ configured: boolean, reason?: string }}
   */
  checkConfiguration() {
    return { configured: true };
  }
}
