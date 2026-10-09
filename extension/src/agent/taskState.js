/**
 * Voice Browser Agent - Task State Management
 * 
 * Manages the lifecycle, step-by-step progress, action history,
 * AI telemetry, and safety limits for agent tasks.
 */

export const TaskStatus = {
  IDLE: 'IDLE',
  UNDERSTANDING: 'UNDERSTANDING',
  OBSERVING: 'OBSERVING',
  PLANNING: 'PLANNING',
  AI_PLANNING: 'AI_PLANNING',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
  STOPPED: 'STOPPED'
};

export class TaskState {
  /**
   * @param {string} goal - Original user command / task goal
   * @param {Object} [options] - Configuration and limits
   */
  constructor(goal, options = {}) {
    this.taskId = `task-${Date.now()}`;
    this.goal = String(goal || '').trim();
    this.status = TaskStatus.IDLE;
    this.statusMessage = 'Initialized task';
    
    this.currentStep = 0;
    this.totalSteps = 1; // Dynamically updated by planner
    this.actions = [];
    
    this.startTime = Date.now();
    this.endTime = null;
    this.duration = '0s';
    
    this.error = null;
    this.result = null;
    this.clarificationQuestion = null;

    // Truthful AI Telemetry metrics
    this.plannerMode = options.plannerMode || 'Deterministic';
    this.aiCallsCount = 0;
    this.tokensUsed = {
      prompt: 0,
      completion: 0,
      total: 0
    };

    // Safety limits
    this.maxActions = options.maxActions || 15;
    this.maxDurationMs = options.maxDurationMs || 60000; // 60 seconds
    this.maxAICalls = options.maxAICalls || 5; // Safety cap on AI calls per task
  }

  /**
   * Transitions task status with a human-readable status description.
   * @param {string} newStatus - Value from TaskStatus
   * @param {string} [message] - Status description
   */
  transition(newStatus, message = '') {
    this.status = newStatus;
    if (message) {
      this.statusMessage = message;
    }
    this._updateDuration();
  }

  /**
   * Records truthful token usage and AI call counts.
   * @param {Object} metrics
   */
  recordAICall(metrics = {}) {
    this.aiCallsCount += 1;
    this.plannerMode = metrics.model ? `AI (${metrics.model})` : 'AI Hybrid';
    if (metrics.promptTokens) this.tokensUsed.prompt += metrics.promptTokens;
    if (metrics.completionTokens) this.tokensUsed.completion += metrics.completionTokens;
    if (metrics.totalTokens) this.tokensUsed.total += metrics.totalTokens;
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
    const actionRecord = {
      id: this.currentStep,
      step: this.currentStep,
      label: label || `Step ${this.currentStep}: ${action.action}`,
      action,
      state: 'active',
      meta: 'Executing...',
      timestamp: Date.now()
    };
    this.actions.push(actionRecord);
    this._updateDuration();
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
    this._updateDuration();
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
    this._updateDuration();
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
  }

  /**
   * Sets task into approval required mode for sensitive actions.
   * @param {string} reason
   */
  requireApproval(reason) {
    this.status = TaskStatus.WAITING_FOR_APPROVAL;
    this.statusMessage = reason || 'Awaiting user approval for sensitive operation.';
    this._updateDuration();
  }

  /**
   * Completes the task with a successful outcome.
   * @param {Object} [resultData] - Summary of what was achieved
   */
  complete(resultData = null) {
    this.endTime = Date.now();
    this.status = TaskStatus.COMPLETED;
    this.statusMessage = 'Task completed successfully';
    this.result = resultData || {
      title: this.goal,
      meta: `Completed in ${this.actions.length} step(s)`
    };
    this._updateDuration();
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
  }

  /**
   * Explicitly stops the task upon user request.
   */
  stop() {
    this.endTime = Date.now();
    this.status = TaskStatus.STOPPED;
    this.statusMessage = 'Task stopped by user';
    
    const lastAction = this.actions[this.actions.length - 1];
    if (lastAction && lastAction.state === 'active') {
      lastAction.state = 'failed';
      lastAction.meta = 'Stopped';
    }
    
    this._updateDuration();
  }

  /**
   * Checks whether the task has reached a terminal or paused state.
   * @returns {boolean}
   */
  isTerminal() {
    return (
      this.status === TaskStatus.COMPLETED ||
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
    if (elapsedMs > this.maxDurationMs) {
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
  }

  /**
   * Computes integer completion percentage (0 - 100) for UI progress bars.
   * @returns {number}
   */
  getProgressPercent() {
    if (this.status === TaskStatus.COMPLETED) return 100;
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
      duration: this.duration,
      error: this.error,
      result: this.result,
      clarificationQuestion: this.clarificationQuestion,
      plannerMode: this.plannerMode,
      aiCallsCount: this.aiCallsCount,
      tokensUsed: { ...this.tokensUsed },
      isTerminal: this.isTerminal()
    };
  }
}
