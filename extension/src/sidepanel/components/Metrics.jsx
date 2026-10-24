import React from 'react';

/**
 * Execution Metrics Component
 * Displays truthful per-task duration, DOM steps, AI calls,
 * active model name, fallback status, and actual Gemini token metrics.
 */
export default function Metrics({
  time = '0.0s',
  actions = '1',
  mode = 'Deterministic',
  status = 'Verified',
  tokens = null,
  aiCalls = 0,
  taskMetrics = null,
  fallbackInfo = null
}) {
  const effectiveCalls = typeof taskMetrics?.llmCallCount === 'number' 
    ? taskMetrics.llmCallCount 
    : (typeof aiCalls === 'number' ? aiCalls : 0);

  const isUsageAvailable = effectiveCalls === 0 
    ? true 
    : (taskMetrics ? taskMetrics.usageAvailable !== false : (tokens ? tokens.usageAvailable !== false : true));

  // Fallback telemetry
  const fallbackOccurred = Boolean(
    taskMetrics?.fallbackOccurred ||
    fallbackInfo?.fallbackOccurred ||
    fallbackInfo?.occurred
  );
  const successfulModel = taskMetrics?.successfulModel || fallbackInfo?.successfulModel || null;
  const primaryModel = taskMetrics?.primaryModel || fallbackInfo?.primaryModel || null;
  const fallbackReason = taskMetrics?.fallbackReason || fallbackInfo?.fallbackReason || null;

  // Token calculations
  let inputTokensDisplay = '0';
  let outputTokensDisplay = '0';
  let totalTokensDisplay = '0';
  let thinkingTokensDisplay = null;

  if (effectiveCalls === 0) {
    // Pure deterministic task - strictly 0 calls, 0 tokens
    inputTokensDisplay = '0';
    outputTokensDisplay = '0';
    totalTokensDisplay = '0';
    thinkingTokensDisplay = null;
  } else if (!isUsageAvailable) {
    // Provider omitted usage metadata - truthful "Unavailable"
    inputTokensDisplay = 'Unavailable';
    outputTokensDisplay = 'Unavailable';
    totalTokensDisplay = 'Unavailable';
  } else {
    // Truthful provider-reported usage
    const inTokens = taskMetrics?.inputTokens ?? tokens?.prompt ?? 0;
    const outTokens = taskMetrics?.outputTokens ?? tokens?.completion ?? 0;
    const totTokens = taskMetrics?.totalTokens ?? tokens?.total ?? (inTokens + outTokens);
    
    inputTokensDisplay = typeof inTokens === 'number' ? inTokens.toLocaleString() : String(inTokens || '0');
    outputTokensDisplay = typeof outTokens === 'number' ? outTokens.toLocaleString() : String(outTokens || '0');
    totalTokensDisplay = typeof totTokens === 'number' ? totTokens.toLocaleString() : String(totTokens || '0');

    const thinkingVal = taskMetrics?.thinkingTokens ?? tokens?.thinking;
    if (typeof thinkingVal === 'number' && thinkingVal > 0) {
      thinkingTokensDisplay = thinkingVal.toLocaleString();
    }
  }

  const isDeterministic = effectiveCalls === 0;

  return (
    <div className="metrics-card">
      <div className="metrics-header">
        <span className="metrics-title">Task Execution Metrics</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {successfulModel && (
            <span
              style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '4px',
                background: 'rgba(56, 189, 248, 0.1)',
                color: 'var(--accent-primary, #38bdf8)',
                border: '1px solid rgba(56, 189, 248, 0.2)'
              }}
            >
              {successfulModel}
            </span>
          )}
          <span className="metrics-badge">{mode}</span>
        </div>
      </div>

      {/* Fallback Notice Banner */}
      {fallbackOccurred && (
        <div
          style={{
            marginBottom: 8,
            padding: '6px 8px',
            background: 'rgba(234, 179, 8, 0.1)',
            border: '1px solid rgba(234, 179, 8, 0.3)',
            borderRadius: '4px',
            fontSize: '11px',
            color: '#eab308',
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          <span>⚡</span>
          <span>
            <strong>Model fallback used:</strong> {successfulModel || 'fallback model'}
            {primaryModel ? ` (primary ${primaryModel} failed)` : ''}
          </span>
        </div>
      )}

      {/* Top Level Summary Grid */}
      <div className="metrics-grid">
        <div className="metric-box">
          <span className="metric-value">{time}</span>
          <span className="metric-label">Total Duration</span>
        </div>
        <div className="metric-box">
          <span className="metric-value">{actions}</span>
          <span className="metric-label">DOM Steps</span>
        </div>
        <div className="metric-box">
          <span 
            className="metric-value"
            style={{ color: effectiveCalls > 0 ? 'var(--accent-secondary, #a855f7)' : 'var(--accent-primary)' }}
          >
            {effectiveCalls}
          </span>
          <span className="metric-label">AI Calls</span>
        </div>
        <div className="metric-box">
          <span 
            className="metric-value"
            style={{ 
              color: isDeterministic 
                ? 'var(--status-success)' 
                : !isUsageAvailable 
                ? 'var(--text-muted)' 
                : 'var(--accent-primary)',
              fontSize: totalTokensDisplay === 'Unavailable' ? '11.5px' : '13px'
            }}
          >
            {totalTokensDisplay === 'Unavailable' ? 'Unavailable' : `${totalTokensDisplay} tok`}
          </span>
          <span className="metric-label">{isDeterministic ? '0 AI Tokens (Local)' : 'Total AI Tokens'}</span>
        </div>
      </div>

      {/* Structured AI Token Usage Breakdown */}
      <div 
        style={{
          marginTop: 10,
          padding: '8px 10px',
          background: 'var(--bg-subtle, rgba(255, 255, 255, 0.03))',
          border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))',
          borderRadius: 'var(--radius-sm, 6px)',
          fontSize: '11px'
        }}
      >
        <div 
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            marginBottom: 6,
            color: 'var(--text-secondary)',
            fontSize: '10.5px',
            fontWeight: 600
          }}
        >
          <span>AI PROVIDER TOKEN TELEMETRY</span>
          <span style={{ fontSize: '10px', color: isDeterministic ? 'var(--status-success)' : 'var(--text-muted)' }}>
            {isDeterministic ? 'Deterministic (0 LLM Cost)' : isUsageAvailable ? 'Actual Usage' : 'Metadata Omitted'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: thinkingTokensDisplay ? 'repeat(4, 1fr)' : 'repeat(3, 1fr)', gap: 6, textAlign: 'center' }}>
          <div style={{ padding: '4px', background: 'var(--bg-card)', borderRadius: 4, border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Input</div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>{inputTokensDisplay}</div>
          </div>

          <div style={{ padding: '4px', background: 'var(--bg-card)', borderRadius: 4, border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Output</div>
            <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginTop: 2 }}>{outputTokensDisplay}</div>
          </div>

          <div style={{ padding: '4px', background: 'var(--bg-card)', borderRadius: 4, border: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Total</div>
            <div style={{ fontWeight: 600, color: effectiveCalls > 0 ? 'var(--accent-primary)' : 'var(--status-success)', marginTop: 2 }}>
              {totalTokensDisplay}
            </div>
          </div>

          {thinkingTokensDisplay && (
            <div style={{ padding: '4px', background: 'var(--bg-card)', borderRadius: 4, border: '1px solid var(--border-subtle)' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Thinking</div>
              <div style={{ fontWeight: 600, color: 'var(--accent-secondary, #a855f7)', marginTop: 2 }}>{thinkingTokensDisplay}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
