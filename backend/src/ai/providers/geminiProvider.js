/**
 * Voice Browser Agent - Google Gemini AI Provider
 * 
 * Supports Gemini 2.0 Flash and Gemini 1.5 Flash via native REST API
 * with responseMimeType="application/json" for deterministic JSON output.
 */

import { BaseAIProvider, ProviderError } from './providerInterface.js';

export class GeminiProvider extends BaseAIProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'gemini';
    this.apiKey = config.apiKey || process.env.GEMINI_API_KEY || '';
    this.model = config.model || process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    this.timeoutMs = config.timeoutMs || parseInt(process.env.REQUEST_TIMEOUT_MS || '25000', 10);
  }

  checkConfiguration() {
    if (!this.apiKey || this.apiKey === 'your_gemini_api_key_here') {
      return {
        configured: false,
        reason: 'GEMINI_API_KEY is missing or contains placeholder. Please set a valid API key in backend/.env'
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
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    const requestPayload = {
      contents: [
        {
          role: 'user',
          parts: [{ text: userPrompt }]
        }
      ],
      systemInstruction: {
        parts: [{ text: systemPrompt }]
      },
      generationConfig: {
        temperature: options.temperature !== undefined ? options.temperature : 0.1,
        responseMimeType: 'application/json'
      }
    };

    const startTime = Date.now();
    let response;

    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(timeout)
      });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ProviderError(`Gemini request timed out after ${timeout}ms`, {
          code: 'TIMEOUT',
          status: 504,
          retryable: true
        });
      }
      throw new ProviderError(`Network error communicating with Gemini API: ${err.message}`, {
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

      const errMsg = errBody?.error?.message || `Gemini API returned HTTP ${response.status}`;

      if (response.status === 429) {
        throw new ProviderError(`Gemini rate limit exceeded: ${errMsg}`, {
          code: 'RATE_LIMIT',
          status: 429,
          retryable: true
        });
      }

      if (response.status === 401 || response.status === 403 || errMsg.toLowerCase().includes('api key')) {
        throw new ProviderError(`Gemini authentication error: Invalid API key or unauthorized.`, {
          code: 'INVALID_CREDENTIALS',
          status: 401,
          retryable: false
        });
      }

      throw new ProviderError(`Gemini API error (${response.status}): ${errMsg}`, {
        code: 'API_ERROR',
        status: response.status,
        retryable: response.status >= 500
      });
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];

    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      throw new ProviderError('Gemini API returned an empty completion or candidate was blocked', {
        code: 'EMPTY_RESPONSE',
        status: 502,
        retryable: false
      });
    }

    const rawText = candidate.content.parts[0].text;
    const usageMetadata = data.usageMetadata || {};

    return {
      rawText,
      usage: {
        promptTokens: usageMetadata.promptTokenCount ?? 0,
        completionTokens: usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: usageMetadata.totalTokenCount ?? 0
      },
      latencyMs,
      model: modelName,
      provider: 'gemini'
    };
  }
}
