/**
 * Voice Browser Agent - OpenAI-Compatible AI Provider
 * 
 * Supports DeepSeek, Qwen, Groq, Ollama, OpenAI, and OpenRouter
 * using standard chat completions endpoint with response_format={ type: "json_object" }.
 */

import { BaseAIProvider, ProviderError } from './providerInterface.js';

export class OpenAICompatibleProvider extends BaseAIProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'openai_compatible';
    this.apiKey = config.apiKey !== undefined ? config.apiKey : (process.env.OPENAI_API_KEY || '');
    this.baseUrl = (config.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = config.model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    this.timeoutMs = config.timeoutMs || parseInt(process.env.REQUEST_TIMEOUT_MS || '25000', 10);
  }

  getResolvedApiKey() {
    return this.config.apiKey !== undefined ? this.config.apiKey : (process.env.OPENAI_API_KEY || this.apiKey || '');
  }

  checkConfiguration() {
    const key = this.getResolvedApiKey();
    // If targeting local Ollama, API key may not be required
    const isLocal = this.baseUrl.includes('localhost') || this.baseUrl.includes('127.0.0.1');
    if (!isLocal && (!key || key.includes('your_'))) {
      return {
        configured: false,
        reason: 'OPENAI_API_KEY is missing or contains placeholder. Please set OPENAI_API_KEY in backend/.env'
      };
    }
    return { configured: true };
  }

  async generatePlan({ systemPrompt, userPrompt, options = {} }) {
    const configCheck = this.checkConfiguration();
    if (!configCheck.configured) {
      throw new ProviderError(configCheck.reason, {
        code: 'MISSING_CREDENTIALS',
        status: 401,
        retryable: false
      });
    }

    const modelName = options.model || this.model;
    const timeout = options.timeoutMs || this.timeoutMs;
    const endpoint = `${this.baseUrl}/chat/completions`;

    const requestPayload = {
      model: modelName,
      temperature: options.temperature !== undefined ? options.temperature : 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    };

    const startTime = Date.now();
    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(timeout)
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ProviderError(`Provider request timed out after ${timeout}ms`, {
          code: 'TIMEOUT',
          status: 504,
          retryable: true
        });
      }
      throw new ProviderError(`Network error communicating with AI provider: ${err.message}`, {
        code: 'NETWORK_ERROR',
        status: 502,
        retryable: true
      });
    }

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody;
      try {
        errBody = await response.json();
      } catch {
        errBody = null;
      }

      const errMsg = errBody?.error?.message || `Provider API returned HTTP ${response.status}`;

      if (response.status === 429) {
        throw new ProviderError(`Provider rate limit exceeded: ${errMsg}`, {
          code: 'RATE_LIMIT',
          status: 429,
          retryable: true
        });
      }

      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(`Authentication failed: Invalid API credentials.`, {
          code: 'INVALID_CREDENTIALS',
          status: 401,
          retryable: false
        });
      }

      throw new ProviderError(`Provider API error (${response.status}): ${errMsg}`, {
        code: 'API_ERROR',
        status: response.status,
        retryable: response.status >= 500
      });
    }

    const data = await response.json();
    const message = data.choices?.[0]?.message;

    if (!message || !message.content) {
      throw new ProviderError('Provider returned an empty completion', {
        code: 'EMPTY_RESPONSE',
        status: 502,
        retryable: false
      });
    }

    const usage = data.usage;
    const hasUsage = Boolean(usage && typeof usage.total_tokens === 'number');
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens;

    return {
      rawText: message.content,
      usage: hasUsage ? {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
        ...(typeof reasoningTokens === 'number' ? { thinkingTokens: reasoningTokens } : {}),
        usageAvailable: true
      } : {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        usageAvailable: false
      },
      latencyMs,
      model: modelName,
      provider: this.name
    };
  }
}
