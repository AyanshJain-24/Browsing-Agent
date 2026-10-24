/**
 * Voice Browser Agent - Task State Management
 * 
 * Manages the lifecycle, step-by-step progress, action history,
 * AI telemetry, and safety limits for agent tasks.
 */

export const TaskStatus = {
  IDLE: 'IDLE',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  UNDERSTANDING: 'UNDERSTANDING',
  OBSERVING: 'OBSERVING',
  PLANNING: 'PLANNING',
  AI_PLANNING: 'AI_PLANNING',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  WAITING_FOR_NAVIGATION: 'WAITING_FOR_NAVIGATION',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  UNABLE_TO_VERIFY: 'UNABLE_TO_VERIFY',
  COMPLETED: 'COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT',
  COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT: 'COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT',
  ERROR: 'ERROR',
  FAILED: 'ERROR',
  STOPPED: 'STOPPED',
  CANCELLED: 'STOPPED'
};

export class TaskState {
  /**
   * @param {string} goal - Original user command / task goal
   * @param {Object} [options] - Configuration and limits
   */
  constructor(goal, options = {}) {
    this.taskId = options.taskId || `task-${Date.now()}`;
    this.goal = String(goal || '').trim();
    this.status = TaskStatus.IDLE;
    this.statusMessage = 'Initialized task';
    
    this.currentStep = 0;
    this.totalSteps = 1; // Dynamically updated by planner
    this.actions = [];
    this.remainingSteps = [];
    
    this.startTime = Date.now();
    this.endTime = null;
    this.duration = '0s';
    
    this.error = null;
    this.result = null;
    this.clarificationQuestion = null;

    // Multi-step & tab tracking
    this.targetTabId = options.targetTabId !== undefined ? options.targetTabId : null;
    this.currentUrl = options.currentUrl || '';
    this.latestObservationTimestamp = null;
    this.lastAction = null;
    this.lastOutcome = null;

    // Checkpoint & Event Telemetry
    this.checkpoints = [];
    this.events = [];
    this.timings = {
      planningMs: 0,
      modelMs: 0,
      observationMs: 0,
      executionMs: 0,
      verificationMs: 0,
      searchMs: 0,
      totalMs: 0
    };
    this.retryCount = 0;

    // Truthful AI Telemetry metrics
    this.plannerMode = options.plannerMode || 'Deterministic';
    this.aiCallsCount = 0;
    this.fallbackOccurred = false;
    this.successfulModel = null;
    this.primaryModel = null;
    this.fallbackReason = null;
    this.tokensUsed = {
      prompt: 0,
      completion: 0,
      total: 0,
      thinking: undefined,
      usageAvailable: true
    };
    this.taskMetrics = {
      taskId: this.taskId,
      llmCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      thinkingTokens: undefined,
      usageAvailable: true,
      durationMs: 0,
      fallbackOccurred: false,
      successfulModel: null,
      primaryModel: null,
      fallbackReason: null
    };

    // Safety limits (configurable with research defaults)
    this.maxActions = options.maxActions || 15;
    this.maxDurationMs = options.maxDurationMs || 120000; // Up to 120 seconds
    this.deadline = this.startTime + this.maxDurationMs;
    this.maxAICalls = options.maxAICalls || 8; // Safety cap on AI calls per task

    this.addEvent('task_created', { goal: this.goal, targetTabId: this.targetTabId });
  }

  /**
   * Records a structured telemetry event.
   * @param {string} eventType
   * @param {Object} [details]
   * @param {number|null} [durationMs]
   */
  addEvent(eventType, details = {}, durationMs = null) {
    const event = {
      eventId: `evt-${Date.now()}-${this.events.length + 1}`,
      taskId: this.taskId,
      timestamp: Date.now(),
      eventType,
      durationMs: durationMs !== null ? durationMs : undefined,
      status: this.status,
      details: { ...details }
    };
    this.events.push(event);
    return event;
  }

  /**
   * Records execution timing for performance tracking.
   * @param {string} category - 'planningMs'|'modelMs'|'observationMs'|'executionMs'|'verificationMs'|'searchMs'
   * @param {number} ms
   */
  recordTiming(category, ms) {
    if (typeof ms === 'number' && ms >= 0 && this.timings[category] !== undefined) {
      this.timings[category] += ms;
    }
  }

  /**
   * Creates a verified checkpoint for safe task continuation.
   * @param {Object} action
   * @param {Object} snapshot
   * @param {Object} verification
   */
  createCheckpoint(action, snapshot, verification) {
    const cp = {
      step: this.currentStep,
      action: action ? { ...action } : null,
      url: snapshot?.page?.url || this.currentUrl,
      title: snapshot?.page?.title || '',
      observationTimestamp: this.latestObservationTimestamp || Date.now(),
      verifiedReason: verification?.reason || 'Verified',
      timestamp: Date.now()
    };
    this.checkpoints.push(cp);
    this.addEvent('checkpoint_created', { step: cp.step, url: cp.url });
    return cp;
  }

  /**
   * Transitions task status with a human-readable status description.
   * @param {string} newStatus - Value from TaskStatus
   * @param {string} [message] - Status description
   */
  transition(newStatus, message = '') {
    const prevStatus = this.status;
    this.status = newStatus;
    if (message) {
      this.statusMessage = message;
    }
    this._updateDuration();
    this.addEvent('status_transition', { from: prevStatus, to: newStatus, message });
  }

  /**
   * Records truthful token usage and AI call counts.
   * @param {Object} metrics
   */
  recordAICall(metrics = {}) {
    this.aiCallsCount += (metrics.attempts?.length || 1);
    const activeModel = metrics.successfulModel || metrics.model;
    this.plannerMode = activeModel ? `AI (${activeModel})` : 'AI Hybrid';

    if (metrics.fallbackOccurred || metrics.taskMetrics?.fallbackOccurred) {
      this.fallbackOccurred = true;
      this.fallbackReason = metrics.fallbackReason || metrics.taskMetrics?.fallbackReason;
    }
    if (metrics.successfulModel || metrics.taskMetrics?.successfulModel) {
      this.successfulModel = metrics.successfulModel || metrics.taskMetrics?.successfulModel;
    }
    if (metrics.primaryModel || metrics.taskMetrics?.primaryModel) {
      this.primaryModel = metrics.primaryModel || metrics.taskMetrics?.primaryModel;
    }

    if (metrics.taskMetrics) {
      this.taskMetrics = {
        ...metrics.taskMetrics,
        durationMs: Date.now() - this.startTime
      };
      this.tokensUsed.prompt = this.taskMetrics.inputTokens ?? 0;
      this.tokensUsed.completion = this.taskMetrics.outputTokens ?? 0;
      this.tokensUsed.total = this.taskMetrics.totalTokens ?? 0;
      this.tokensUsed.thinking = this.taskMetrics.thinkingTokens;
      this.tokensUsed.usageAvailable = this.taskMetrics.usageAvailable !== false;
    } else {
      if (typeof metrics.promptTokens === 'number') this.tokensUsed.prompt += metrics.promptTokens;
      if (typeof metrics.completionTokens === 'number') this.tokensUsed.completion += metrics.completionTokens;
      if (typeof metrics.totalTokens === 'number') this.tokensUsed.total += metrics.totalTokens;
      if (typeof metrics.thinkingTokens === 'number') {
        this.tokensUsed.thinking = (this.tokensUsed.thinking || 0) + metrics.thinkingTokens;
      }
      if (metrics.usageAvailable === false || metrics.totalTokens === null) {
        this.tokensUsed.usageAvailable = false;
        this.tokensUsed.prompt = null;
        this.tokensUsed.completion = null;
        this.tokensUsed.total = null;
      }

      const isAvail = this.tokensUsed.usageAvailable !== false;
      this.taskMetrics = {
        taskId: this.taskId,
        llmCallCount: this.aiCallsCount,
        inputTokens: isAvail ? this.tokensUsed.prompt : null,
        outputTokens: isAvail ? this.tokensUsed.completion : null,
        totalTokens: isAvail ? this.tokensUsed.total : null,
        ...(this.tokensUsed.thinking !== undefined ? { thinkingTokens: this.tokensUsed.thinking } : {}),
        usageAvailable: isAvail,
        durationMs: Date.now() - this.startTime,
        fallbackOccurred: Boolean(this.fallbackOccurred),
        successfulModel: this.successfulModel,
        primaryModel: this.primaryModel,
        fallbackReason: this.fallbackReason
      };
    }
    this._updateDuration();
  }

  /**
   * Records the start of a planned action step in the timeline.
   * @param {string} label - Friendly step title
   * @param {Object} action - Action command object
   * @returns {Object} Action record
   */
  recordStepStart(label, action) {
    this.currentStep += 1;
    this.lastAction = action ? { ...action } : null;
    const actionRecord = {
      id: this.currentStep,
      step: this.currentStep,
      label: label || `Step ${this.currentStep}: ${action?.action || 'action'}`,
      action,
      state: 'active',
      meta: 'Executing...',
      timestamp: Date.now()
    };
    this.actions.push(actionRecord);
    this._updateDuration();
    this.addEvent('action_started', { step: this.currentStep, action: action?.action, label });
    return actionRecord;
  }

  /**
   * Marks the current active action step as verified and completed.
   * @param {string} meta - Verification outcome details
   */
  recordStepSuccess(meta = '') {
    const lastAction = this.actions[this.actions.length - 1];
    if (lastAction) {
      lastAction.state = 'completed';
      lastAction.meta = meta || 'Verified';
    }
    this.lastOutcome = { success: true, meta: meta || 'Verified' };
    this._updateDuration();
    this.addEvent('action_completed', { step: this.currentStep, meta });
  }

  /**
   * Marks the current active action step as failed.
   * @param {string} error - Failure reason
   * @param {string} [meta] - Verification details
   */
  recordStepFailure(error, meta = '') {
    const lastAction = this.actions[this.actions.length - 1];
    if (lastAction) {
      lastAction.state = 'failed';
      lastAction.meta = meta || 'Verification failed';
      lastAction.error = error;
    }
    this.lastOutcome = { success: false, error, meta };
    this._updateDuration();
    this.addEvent('action_failed', { step: this.currentStep, error, meta });
  }

  /**
   * Sets task into clarification mode when user command is ambiguous.
   * @param {string} question
   */
  requireClarification(question) {
    this.endTime = Date.now();
    this.status = TaskStatus.NEEDS_CLARIFICATION;
    this.clarificationQuestion = question || 'Please clarify your instruction.';
    this.statusMessage = this.clarificationQuestion;
    this._updateDuration();
    this.addEvent('clarification_required', { question: this.clarificationQuestion });
  }

  /**
   * Sets task into approval required mode for sensitive actions.
   * @param {string} reason
   */
  requireApproval(reason) {
    this.status = TaskStatus.WAITING_FOR_APPROVAL;
    this.statusMessage = reason || 'Awaiting user approval for sensitive operation.';
    this._updateDuration();
    this.addEvent('approval_required', { reason: this.statusMessage });
  }

  /**
   * Completes the task with a successful outcome.
   * Sets status to COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT until user acknowledges.
   * @param {Object} [resultData] - Summary of what was achieved
   */
  complete(resultData = null) {
    if (this.status === TaskStatus.COMPLETED || this.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT) {
      return; // Prevent duplicate completion events
    }
    this.endTime = Date.now();
    this.status = TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT;
    this.statusMessage = 'Task completed successfully';
    this.result = resultData || {
      title: this.goal,
      meta: `Completed in ${this.actions.length} step(s)`
    };
    this._updateDuration();
    this.addEvent('task_completed', { result: this.result });
  }

  /**
   * Marks task as partially completed when some steps succeeded but subsequent steps failed.
   * Preserves completed work and clearly communicates what remains.
   * @param {Object} resultData
   * @param {string} [reason]
   */
  partiallyComplete(resultData = null, reason = '') {
    this.endTime = Date.now();
    this.status = TaskStatus.PARTIALLY_COMPLETED;
    this.statusMessage = reason || 'Task partially completed.';
    this.result = resultData || {
      title: this.goal,
      meta: reason || `Partially completed ${this.actions.filter(a => a.state === 'completed').length} step(s)`
    };
    this._updateDuration();
    this.addEvent('task_partially_completed', { reason, result: this.result });
  }

  /**
   * Marks task as unable to verify when action dispatched but outcome could not be reliably established.
   * @param {Object} resultData
   * @param {string} [reason]
   */
  unableToVerify(resultData = null, reason = '') {
    this.endTime = Date.now();
    this.status = TaskStatus.UNABLE_TO_VERIFY;
    this.statusMessage = reason || 'Could not verify whether action succeeded.';
    this.result = resultData || {
      title: this.goal,
      meta: reason || 'Unable to verify outcome from page state'
    };
    this._updateDuration();
    this.addEvent('task_unable_to_verify', { reason });
  }

  /**
   * Fails the task with a clear explanation.
   * @param {string} errorMessage - Friendly error reason
   */
  fail(errorMessage) {
    this.endTime = Date.now();
    this.status = TaskStatus.ERROR;
    this.error = errorMessage || 'Task execution failed';
    this.statusMessage = this.error;
    
    // Mark current active action as failed if still pending
    const lastAction = this.actions[this.actions.length - 1];
    if (lastAction && lastAction.state === 'active') {
      lastAction.state = 'failed';
      lastAction.error = this.error;
      lastAction.meta = 'Failed';
    }
    
    this._updateDuration();
    this.addEvent('task_failed', { error: this.error });
  }

  /**
   * Explicitly cancels / stops the task upon user request.
   * @param {string} [reason]
   */
  cancel(reason = 'Task cancelled by user') {
    this.stop(reason);
  }

  /**
   * Explicitly stops the task upon user request.
   * @param {string} [reason]
   */
  stop(reason = 'Task stopped by user') {
    this.endTime = Date.now();
    this.status = TaskStatus.STOPPED;
    this.statusMessage = reason;
    
    const lastAction = this.actions[this.actions.length - 1];
    if (lastAction && lastAction.state === 'active') {
      lastAction.state = 'failed';
      lastAction.meta = 'Cancelled';
    }
    
    this._updateDuration();
    this.addEvent('task_cancelled', { reason });
  }

  /**
   * Checks whether the task is cancelled / stopped.
   * @returns {boolean}
   */
  isCancelled() {
    return this.status === TaskStatus.STOPPED;
  }

  /**
   * Checks whether the task has reached a terminal or paused state.
   * @returns {boolean}
   */
  isTerminal() {
    return (
      this.status === TaskStatus.COMPLETED ||
      this.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT ||
      this.status === TaskStatus.PARTIALLY_COMPLETED ||
      this.status === TaskStatus.UNABLE_TO_VERIFY ||
      this.status === TaskStatus.ERROR ||
      this.status === TaskStatus.STOPPED ||
      this.status === TaskStatus.NEEDS_CLARIFICATION ||
      this.status === TaskStatus.WAITING_FOR_APPROVAL
    );
  }

  /**
   * Checks safety constraints (max actions, max elapsed time, max AI calls).
   * @returns {string|null} Error string if limit violated, null if safe
   */
  checkLimits() {
    const elapsedMs = Date.now() - this.startTime;
    if (elapsedMs > this.maxDurationMs || Date.now() > this.deadline) {
      return `Task exceeded time limit of ${Math.round(this.maxDurationMs / 1000)} seconds.`;
    }

    if (this.actions.length >= this.maxActions) {
      return `Task exceeded safety limit of ${this.maxActions} actions.`;
    }

    if (this.aiCallsCount >= this.maxAICalls) {
      return `Task reached safety limit of ${this.maxAICalls} AI planning calls.`;
    }

    return null;
  }

  /**
   * Computes human-readable elapsed duration.
   * @private
   */
  _updateDuration() {
    const end = this.endTime || Date.now();
    const sec = ((end - this.startTime) / 1000).toFixed(1);
    this.duration = `${sec}s`;
    this.timings.totalMs = end - this.startTime;
  }

  /**
   * Computes integer completion percentage (0 - 100) for UI progress bars.
   * @returns {number}
   */
  getProgressPercent() {
    if (this.status === TaskStatus.COMPLETED || this.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT) return 100;
    if (this.status === TaskStatus.PARTIALLY_COMPLETED) return 75;
    if (this.status === TaskStatus.ERROR || this.status === TaskStatus.STOPPED) {
      return Math.min(100, Math.round((this.currentStep / Math.max(1, this.totalSteps)) * 100));
    }
    const completedCount = this.actions.filter((a) => a.state === 'completed').length;
    return Math.min(95, Math.max(15, Math.round((completedCount / Math.max(1, this.totalSteps)) * 100)));
  }

  /**
   * Serializes current task state into a plain object suitable for React state.
   * @returns {Object}
   */
  toSnapshot() {
    this._updateDuration();
    return {
      taskId: this.taskId,
      goal: this.goal,
      status: this.status,
      statusMessage: this.statusMessage,
      currentStep: this.currentStep,
      totalSteps: this.totalSteps,
      progress: this.getProgressPercent(),
      actions: [...this.actions],
      remainingSteps: [...this.remainingSteps],
      duration: this.duration,
      error: this.error,
      result: this.result,
      clarificationQuestion: this.clarificationQuestion,
      plannerMode: this.plannerMode,
      aiCallsCount: this.aiCallsCount,
      tokensUsed: {
        ...this.tokensUsed,
        totalTokens: this.tokensUsed.total
      },
      taskMetrics: {
        ...this.taskMetrics,
        durationMs: (this.endTime || Date.now()) - this.startTime
      },
      fallbackInfo: {
        fallbackOccurred: Boolean(this.taskMetrics?.fallbackOccurred || this.fallbackOccurred),
        successfulModel: this.taskMetrics?.successfulModel || this.successfulModel,
        primaryModel: this.taskMetrics?.primaryModel || this.primaryModel,
        fallbackReason: this.taskMetrics?.fallbackReason || this.fallbackReason
      },
      targetTabId: this.targetTabId,
      currentUrl: this.currentUrl,
      checkpoints: [...this.checkpoints],
      events: [...this.events],
      timings: { ...this.timings },
      isTerminal: this.isTerminal(),
      isCancelled: this.isCancelled(),
      isCompleted: this.status === TaskStatus.COMPLETED || this.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT,
      isWaitingForAck: this.status === TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT
    };
  }
}
