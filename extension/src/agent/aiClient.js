/**
 * Voice Browser Agent - AI Client Utility
 * 
 * Bridges the Chrome Extension agent controller with the secure Node/Express backend.
 * Keeps provider secrets server-side while tracking real tokens, latency, and call metrics.
 */

const DEFAULT_BACKEND_URL = 'http://localhost:3001';

export class AIClient {
  constructor(options = {}) {
    this.backendUrl = options.backendUrl || DEFAULT_BACKEND_URL;
    this.timeoutMs = options.timeoutMs || 30000;
    this.sessionMetrics = {
      callsCount: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      lastLatencyMs: 0,
      provider: null,
      model: null
    };
  }

  setBackendUrl(url) {
    this.backendUrl = (url || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
  }

  resetMetrics() {
    this.sessionMetrics = {
      callsCount: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
      lastLatencyMs: 0,
      provider: null,
      model: null
    };
  }

  getMetrics() {
    return { ...this.sessionMetrics };
  }

  /**
   * Checks backend health and active model configuration.
   * @returns {Promise<{ ok: boolean, data?: Object, error?: string }>}
   */
  async checkHealth() {
    try {
      const res = await fetch(`${this.backendUrl}/api/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) {
        return { ok: false, error: `Backend returned status ${res.status}` };
      }
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return {
        ok: false,
        error: `Cannot connect to AI planning backend at ${this.backendUrl}. Make sure 'npm run dev:backend' is running.`
      };
    }
  }

  /**
   * Fetches aggregated token metrics for a specific taskId.
   * @param {string} taskId
   * @returns {Promise<Object|null>}
   */
  async getTaskMetrics(taskId) {
    if (!taskId) return null;
    try {
      const res = await fetch(`${this.backendUrl}/api/tasks/${encodeURIComponent(taskId)}/metrics`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data?.metrics || null;
    } catch {
      return null;
    }
  }

  /**
   * Sends user goal, live page observation, and execution history to backend for AI planning.
   * 
   * @param {Object} params
   * @param {string} params.goal - User instruction
   * @param {Object} params.observation - DOM snapshot from observer.js
   * @param {Array} [params.history] - Previously executed actions in current task
   * @param {Object} [params.lastFailure] - Details of previous action failure if retrying
   * @param {string} [params.provider] - Optional provider override ('gemini', 'openai_compatible', 'mock')
   * @returns {Promise<{
   *   success: boolean,
   *   plan?: Object,
   *   metrics?: Object,
   * @param {string} [params.taskId] - Task ID for per-task token metrics accounting
   * @returns {Promise<{
   *   success: boolean,
   *   plan?: Object,
   *   metrics?: Object,
   *   taskMetrics?: Object,
   * @param {Array} [params.conversationHistory] - Recent conversation turns
   * @param {string} [params.taskId] - Task ID for per-task token metrics accounting
   * @returns {Promise<{
   *   success: boolean,
   *   plan?: Object,
   *   metrics?: Object,
   *   taskMetrics?: Object,
   *   error?: string,
   *   code?: string
   * }>}
   */
  async requestPlan({ goal, observation, history = [], conversationHistory = [], lastFailure = null, provider = undefined, taskId = undefined, signal = undefined, timeoutMs = undefined }) {
    if (signal?.aborted) {
      return {
        success: false,
        error: 'Task was cancelled.',
        code: 'CANCELLED',
        retryable: false
      };
    }

    const endpoint = `${this.backendUrl}/api/plan`;
    const payload = {
      goal,
      observation,
      history,
      ...(Array.isArray(conversationHistory) && conversationHistory.length > 0 ? { conversationHistory } : {}),
      lastFailure,
      ...(taskId ? { taskId } : {}),
      ...(provider ? { provider } : {})
    };

    const effectiveTimeout = timeoutMs || this.timeoutMs;
    const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
    let requestSignal = timeoutSignal;
    if (signal) {
      requestSignal = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }

    const startTime = Date.now();
    console.log(`[AI_CLIENT] [${taskId || 'no-task'}] Sending POST /api/plan (timeout: ${effectiveTimeout}ms, goal: "${goal.slice(0, 60)}...")`);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: requestSignal
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data || data.success === false) {
        const errMsg = data?.error || `Backend planning service returned HTTP ${response.status}`;
        const errCode = data?.code || `HTTP_${response.status}`;
        console.error(`[AI_CLIENT] [${taskId || 'no-task'}] Backend returned HTTP ${response.status} (${errCode}): ${errMsg}`);

        return {
          success: false,
          error: errMsg,
          code: errCode,
          retryable: Boolean(data?.retryable)
        };
      }

      // Record truthful telemetry metrics
      const latencyMs = data.metrics?.latencyMs || (Date.now() - startTime);
      this.sessionMetrics.callsCount += 1;
      this.sessionMetrics.lastLatencyMs = latencyMs;
      this.sessionMetrics.provider = data.metrics?.provider || this.sessionMetrics.provider;
      this.sessionMetrics.model = data.metrics?.model || this.sessionMetrics.model;
      this.sessionMetrics.totalPromptTokens += (data.metrics?.promptTokens || 0);
      this.sessionMetrics.totalCompletionTokens += (data.metrics?.completionTokens || 0);
      this.sessionMetrics.totalTokens += (data.metrics?.totalTokens || 0);

      console.log(`[AI_CLIENT] [${taskId || 'no-task'}] Plan received in ${latencyMs}ms. Model: ${data.metrics?.model}, fallback: ${Boolean(data.metrics?.fallbackOccurred)}, totalTokens: ${data.metrics?.totalTokens ?? 'N/A'}`);

      return {
        success: true,
        plan: data.plan,
        taskMetrics: data.metrics?.taskMetrics || data.taskMetrics,
        metrics: {
          ...data.metrics,
          sessionCallsCount: this.sessionMetrics.callsCount,
          sessionTotalTokens: this.sessionMetrics.totalTokens
        }
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      if (signal?.aborted) {
        return {
          success: false,
          error: 'Task was cancelled by user.',
          code: 'CANCELLED',
          retryable: false
        };
      }

      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        console.error(`[AI_CLIENT] [${taskId || 'no-task'}] Frontend request timed out after ${elapsed}ms (limit: ${effectiveTimeout}ms)`);
        return {
          success: false,
          error: `AI reasoning request timed out after ${Math.round(effectiveTimeout / 1000)}s.`,
          code: 'TIMEOUT',
          retryable: true
        };
      }

      console.error(`[AI_CLIENT] [${taskId || 'no-task'}] Connection error after ${elapsed}ms: ${err.message}`);

      // Network / connection refused error
      return {
        success: false,
        error: `Cannot connect to AI planning backend at ${this.backendUrl}. Please ensure the backend server is running with 'npm run dev'. (${err.message})`,
        code: 'BACKEND_OFFLINE',
        retryable: false
      };
    }
  }
}

// Singleton client instance
export const aiClient = new AIClient();
