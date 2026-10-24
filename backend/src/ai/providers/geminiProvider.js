/**
 * Voice Browser Agent - Google Gemini AI Provider with Intelligent Fallback Chain
 * 
 * Supports configured primary and fallback Gemini models (e.g. gemini-3.8-flash,
 * gemini-3.7-flash, gemini-3.6-flash, gemini-3.5-flash-lite).
 * 
 * Capabilities:
 * 1. Configurable model chain via GEMINI_PRIMARY_MODEL and GEMINI_FALLBACK_MODELS
 * 2. Failure classification (429 rate limit, 503 unavailable, 504 timeout, 400 bad request, 401/403 credentials)
 * 3. Circuit breaker & temporary cooldown for overloaded models
 * 4. Strict per-attempt AbortSignal timeout management
 * 5. Immediate rejection of non-retryable errors (400, 401, 403) without pointless model cycling
 * 6. Truthful attempt telemetry and provider-reported token metrics
 */

import { BaseAIProvider, ProviderError } from './providerInterface.js';

export class GeminiProvider extends BaseAIProvider {
  // Shared circuit breaker cooldown registry: Map<modelName, { until: number, reason: string }>
  static cooldowns = new Map();

  constructor(config = {}) {
    super(config);
    this.name = 'gemini';
    this.apiKey = config.apiKey !== undefined ? config.apiKey : (process.env.GEMINI_API_KEY || '');
    this.primaryModel = config.primaryModel || process.env.GEMINI_PRIMARY_MODEL || config.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash';
    
    // Parse fallback models list
    if (Array.isArray(config.fallbackModels)) {
      this.fallbackModels = config.fallbackModels;
    } else if (process.env.GEMINI_FALLBACK_MODELS) {
      this.fallbackModels = process.env.GEMINI_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      this.fallbackModels = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
    }

    this.model = this.primaryModel;
    this.timeoutMs = config.timeoutMs || parseInt(process.env.AI_REQUEST_TIMEOUT_MS || process.env.REQUEST_TIMEOUT_MS || '8000', 10);
    this.maxAttempts = config.maxAttempts || parseInt(process.env.AI_MAX_MODEL_ATTEMPTS || '3', 10);
    this.fetchFn = config.fetchFn || globalThis.fetch;
  }

  getResolvedApiKey() {
    return this.config.apiKey !== undefined ? this.config.apiKey : (process.env.GEMINI_API_KEY || this.apiKey || '');
  }

  checkConfiguration() {
    const key = this.getResolvedApiKey();
    if (!key || key === 'your_gemini_api_key_here') {
      return {
        configured: false,
        reason: 'GEMINI_API_KEY is missing or contains placeholder. Please set a valid API key in backend/.env'
      };
    }
    return { configured: true };
  }

  /**
   * Checks whether a model is currently in temporary cooldown due to recent overload/failure.
   * @param {string} modelName
   * @returns {boolean}
   */
  isModelCoolingDown(modelName) {
    const entry = GeminiProvider.cooldowns.get(modelName);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      GeminiProvider.cooldowns.delete(modelName);
      return false;
    }
    return true;
  }

  /**
   * Sets a temporary cooldown period for a failing model.
   * @param {string} modelName
   * @param {number} [durationMs=30000]
   * @param {string} [reason='Overloaded']
   */
  setCooldown(modelName, durationMs = 30000, reason = 'Overloaded') {
    GeminiProvider.cooldowns.set(modelName, {
      until: Date.now() + durationMs,
      reason
    });
  }

  /**
   * Clears the cooldown for a model upon successful response.
   * @param {string} modelName
   */
  clearCooldown(modelName) {
    GeminiProvider.cooldowns.delete(modelName);
  }

  /**
   * Resets all model cooldowns (useful for tests).
   */
  static resetAllCooldowns() {
    GeminiProvider.cooldowns.clear();
  }

  /**
   * Builds the candidate model chain.
   * @param {string} [requestedModel]
   * @returns {string[]}
   */
  getModelChain(requestedModel) {
    if (requestedModel) {
      return [requestedModel];
    }
    const chain = [this.primaryModel, ...this.fallbackModels];
    return Array.from(new Set(chain.filter(Boolean)));
  }

  /**
   * Dispatches a single HTTP request to Gemini API for a specific model.
   * Classifies network, timeout, client, and server errors.
   */
  async callSingleModel({ modelName, systemPrompt, userPrompt, options = {}, timeoutMs }) {
    const apiKey = this.getResolvedApiKey();
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

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
      response = await this.fetchFn(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestPayload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        const timeoutErr = new ProviderError(`Model '${modelName}' request timed out after ${timeoutMs}ms`, {
          code: 'TIMEOUT',
          status: 504,
          retryable: true
        });
        timeoutErr.latencyMs = elapsed;
        throw timeoutErr;
      }
      const netErr = new ProviderError(`Network error communicating with model '${modelName}': ${err.message}`, {
        code: 'NETWORK_ERROR',
        status: 502,
        retryable: true
      });
      netErr.latencyMs = elapsed;
      throw netErr;
    }

    const latencyMs = Date.now() - startTime;

    if (!response.ok) {
      let errBody = null;
      try {
        errBody = await response.json();
      } catch {
        // Ignored
      }

      const errMsg = errBody?.error?.message || `HTTP ${response.status} ${response.statusText || ''}`.trim();
      const status = response.status;
      const retryAfterHeader = response.headers?.get ? response.headers.get('retry-after') : null;
      const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
      const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : null;

      // 1. HTTP 400: Bad request or unsupported parameters (NON-RETRYABLE on fallback models)
      if (status === 400) {
        const err = new ProviderError(`Gemini invalid request error (400) for '${modelName}': ${errMsg}`, {
          code: 'INVALID_REQUEST',
          status: 400,
          retryable: false
        });
        err.latencyMs = latencyMs;
        throw err;
      }

      // 2. HTTP 401 or 403: Invalid credentials or project permissions (NON-RETRYABLE on fallback models)
      if (status === 401 || status === 403 || errMsg.toLowerCase().includes('api key') || errMsg.toLowerCase().includes('permission_denied')) {
        const err = new ProviderError(`Gemini authentication / permission error (${status}) for '${modelName}': ${errMsg}`, {
          code: 'INVALID_CREDENTIALS',
          status: status,
          retryable: false
        });
        err.latencyMs = latencyMs;
        throw err;
      }

      // 3. HTTP 404: Model not found or unavailable
      if (status === 404) {
        const isExplicitModel = Boolean(options.model);
        const err = new ProviderError(`Gemini model '${modelName}' not found or endpoint unavailable (404): ${errMsg}`, {
          code: 'MODEL_NOT_FOUND',
          status: 404,
          retryable: !isExplicitModel
        });
        err.latencyMs = latencyMs;
        throw err;
      }

      // 4. HTTP 429: Rate limit or capacity exhaustion (RETRYABLE via fallback model)
      if (status === 429) {
        const isProjectWideQuota = errMsg.toLowerCase().includes('quota exceeded for project');
        const err = new ProviderError(`Gemini rate limit or quota exceeded (429) for '${modelName}': ${errMsg}`, {
          code: isProjectWideQuota ? 'PROJECT_QUOTA_EXHAUSTED' : 'RATE_LIMIT',
          status: 429,
          retryable: !isProjectWideQuota
        });
        err.latencyMs = latencyMs;
        err.retryAfterMs = retryAfterMs;
        throw err;
      }

      // 5. HTTP 503: Service temporarily unavailable / overloaded (RETRYABLE via fallback model)
      if (status === 503) {
        const err = new ProviderError(`Gemini service temporarily unavailable (503) for '${modelName}': ${errMsg}`, {
          code: 'SERVICE_UNAVAILABLE',
          status: 503,
          retryable: true
        });
        err.latencyMs = latencyMs;
        throw err;
      }

      // 6. HTTP 504: Gateway timeout
      if (status === 504) {
        const err = new ProviderError(`Gemini gateway timeout (504) for '${modelName}': ${errMsg}`, {
          code: 'TIMEOUT',
          status: 504,
          retryable: true
        });
        err.latencyMs = latencyMs;
        throw err;
      }

      // 7. General server error
      const err = new ProviderError(`Gemini API error (${status}) for '${modelName}': ${errMsg}`, {
        code: 'API_ERROR',
        status,
        retryable: status >= 500
      });
      err.latencyMs = latencyMs;
      throw err;
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];

    if (!candidate || !candidate.content?.parts?.[0]?.text) {
      const emptyErr = new ProviderError(`Gemini model '${modelName}' returned an empty completion or candidate was blocked`, {
        code: 'EMPTY_RESPONSE',
        status: 502,
        retryable: true
      });
      emptyErr.latencyMs = latencyMs;
      throw emptyErr;
    }

    const rawText = candidate.content.parts[0].text;
    const usageMetadata = data.usageMetadata;
    const hasUsage = Boolean(usageMetadata && typeof usageMetadata.totalTokenCount === 'number');

    let thinkingTokens = undefined;
    if (usageMetadata) {
      if (typeof usageMetadata.thinkingTokenCount === 'number') {
        thinkingTokens = usageMetadata.thinkingTokenCount;
      } else if (typeof usageMetadata.thoughtsTokenCount === 'number') {
        thinkingTokens = usageMetadata.thoughtsTokenCount;
      } else if (Array.isArray(usageMetadata.candidatesTokensDetails)) {
        const thinkingItem = usageMetadata.candidatesTokensDetails.find(
          (d) => d && (d.modality === 'THINKING' || d.type === 'THINKING')
        );
        if (thinkingItem && typeof thinkingItem.tokenCount === 'number') {
          thinkingTokens = thinkingItem.tokenCount;
        }
      }
    }

    const usage = hasUsage ? {
      promptTokens: usageMetadata.promptTokenCount ?? 0,
      completionTokens: usageMetadata.candidatesTokenCount ?? 0,
      totalTokens: usageMetadata.totalTokenCount ?? 0,
      ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
      usageAvailable: true
    } : {
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageAvailable: false
    };

    return {
      rawText,
      usage,
      latencyMs,
      model: modelName
    };
  }

  /**
   * Generates a structured JSON plan, attempting configured fallback models if
   * primary models encounter transient rate limit, timeout, or server overload errors.
   */
  async generatePlan({ systemPrompt, userPrompt, observation, options = {} }) {
    const activeTaskId = options.taskId || `task-${Date.now()}`;
    const configCheck = this.checkConfiguration();
    if (!configCheck.configured) {
      throw new ProviderError(configCheck.reason, {
        code: 'MISSING_CREDENTIALS',
        status: 401,
        retryable: false
      });
    }

    const candidateChain = this.getModelChain(options.model);
    const timeout = options.timeoutMs || this.timeoutMs;
    const maxAttempts = Math.min(candidateChain.length, options.maxAttempts || this.maxAttempts);
    const totalBudgetMs = options.totalBudgetMs || 24000;

    // Prioritize models that are NOT currently in cooldown
    const nonCoolingCandidates = candidateChain.filter((m) => !this.isModelCoolingDown(m));
    const orderedCandidates = nonCoolingCandidates.length > 0
      ? nonCoolingCandidates
      : candidateChain; // Fallback: try best candidate even if cooldown active if all are cooling

    const modelsToAttempt = orderedCandidates.slice(0, maxAttempts);
    const attempts = [];
    let lastError = null;
    const overallStartTime = Date.now();

    for (let i = 0; i < modelsToAttempt.length; i++) {
      const candidateModel = modelsToAttempt[i];
      const attemptStart = Date.now();
      const elapsedSoFar = attemptStart - overallStartTime;
      const remainingBudget = totalBudgetMs - elapsedSoFar;

      // Ensure we don't start a futile attempt if remaining budget is almost expired
      if (remainingBudget < 2500) {
        console.warn(`[GEMINI_PROVIDER] [${activeTaskId}] Remaining budget (${remainingBudget}ms) is insufficient to start attempt ${i + 1} with '${candidateModel}'. Halting fallback chain.`);
        break;
      }

      const attemptTimeout = Math.min(timeout, remainingBudget);
      console.log(`[GEMINI_PROVIDER] [${activeTaskId}] Attempt ${i + 1}/${modelsToAttempt.length}: '${candidateModel}', attemptTimeout=${attemptTimeout}ms (budget remaining: ${remainingBudget}ms)`);

      const attemptRecord = {
        model: candidateModel,
        attemptIndex: i + 1,
        startTime: attemptStart,
        latencyMs: 0,
        success: false,
        error: null,
        code: null,
        status: null,
        usage: null
      };

      try {
        const result = await this.callSingleModel({
          modelName: candidateModel,
          systemPrompt,
          userPrompt,
          options,
          timeoutMs: attemptTimeout
        });

        attemptRecord.success = true;
        attemptRecord.latencyMs = result.latencyMs;
        attemptRecord.usage = result.usage;
        attempts.push(attemptRecord);

        // Clear cooldown upon success
        this.clearCooldown(candidateModel);

        const totalLatencyMs = Date.now() - overallStartTime;
        const fallbackOccurred = attempts.length > 1;

        console.log(`[GEMINI_PROVIDER] [${activeTaskId}] SUCCESS via '${candidateModel}' in ${result.latencyMs}ms (total elapsed: ${totalLatencyMs}ms). Fallback occurred: ${fallbackOccurred}. Tokens: prompt=${result.usage?.promptTokens ?? 'N/A'}, comp=${result.usage?.completionTokens ?? 'N/A'}, total=${result.usage?.totalTokens ?? 'N/A'}`);

        return {
          rawText: result.rawText,
          usage: result.usage,
          latencyMs: totalLatencyMs,
          model: candidateModel,
          provider: 'gemini',
          primaryModel: this.primaryModel,
          successfulModel: candidateModel,
          fallbackOccurred,
          fallbackReason: fallbackOccurred ? (attempts[0]?.error || 'Primary model failed') : null,
          attempts
        };
      } catch (err) {
        const elapsed = Date.now() - attemptStart;
        attemptRecord.latencyMs = elapsed;
        attemptRecord.error = err.message;
        attemptRecord.code = err.code || 'PROVIDER_ERROR';
        attemptRecord.status = err.status || 500;
        attempts.push(attemptRecord);
        lastError = err;

        console.warn(`[GEMINI_PROVIDER] [${activeTaskId}] Attempt ${i + 1} FAILED via '${candidateModel}' in ${elapsed}ms: [${err.code || 'ERROR'} ${err.status || 500}] ${err.message}`);

        // Apply temporary cooldown for rate limit, service overload, or timeouts
        if (err.status === 429 || err.status === 503 || err.code === 'TIMEOUT' || err.status === 504) {
          this.setCooldown(candidateModel, 30000, err.message);
          console.warn(`[GEMINI_PROVIDER] Model '${candidateModel}' placed in circuit-breaker cooldown for 30s. Reason: ${err.message}`);
        } else if (err.status === 404) {
          // Model unavailable - longer cooldown
          this.setCooldown(candidateModel, 120000, 'Model not found');
          console.warn(`[GEMINI_PROVIDER] Model '${candidateModel}' placed in circuit-breaker cooldown for 120s (404 Not Found).`);
        }

        // If error is NON-RETRYABLE (e.g. 400 bad request, 401 invalid key, project quota exhausted),
        // DO NOT retry across other models!
        if (err.retryable === false) {
          err.attempts = attempts;
          throw err;
        }

        // If we still have candidate models remaining, do short jittered wait if retry-after requested
        const hasNextCandidate = i + 1 < modelsToAttempt.length;
        if (hasNextCandidate && err.retryAfterMs) {
          const boundedDelay = Math.min(err.retryAfterMs, 1000);
          await new Promise((res) => setTimeout(res, boundedDelay));
        }
      }
    }

    // All configured model attempts failed
    const errorDetails = attempts.map((a) => `${a.model} (${a.error || a.code})`).join('; ');
    const finalErr = new ProviderError(
      `AI planning service is temporarily unavailable across all configured models: ${errorDetails}`,
      {
        code: 'AI_SERVICE_UNAVAILABLE',
        status: 503,
        retryable: true,
        attempts
      }
    );
    throw finalErr;
  }
}
