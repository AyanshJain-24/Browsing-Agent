import React from 'react';

export default function Metrics({
  time = '0.0s',
  actions = '1',
  mode = 'Deterministic',
  status = 'Verified',
  tokens = null,
  aiCalls = 0
}) {
  const hasAITokens = tokens && typeof tokens.total === 'number' && tokens.total > 0;

  return (
    <div className="metrics-card">
      <div className="metrics-header">
        <span className="metrics-title">Execution Metrics</span>
        <span className="metrics-badge">{mode}</span>
      </div>

      <div className="metrics-grid">
        <div className="metric-box">
          <span className="metric-value">{time}</span>
          <span className="metric-label">Duration</span>
        </div>
        <div className="metric-box">
          <span className="metric-value">{actions}</span>
          <span className="metric-label">DOM Steps</span>
        </div>
        <div className="metric-box">
          <span className="metric-value" style={{ color: 'var(--accent-primary)', fontSize: '13px' }}>{mode}</span>
          <span className="metric-label">Planner</span>
        </div>
        <div className="metric-box">
          <span className="metric-value" style={{ color: hasAITokens ? 'var(--accent-secondary)' : 'var(--status-success)', fontSize: '13px' }}>
            {hasAITokens ? `${tokens.total} tok` : '0 tok (Local)'}
          </span>
          <span className="metric-label">{hasAITokens ? `${aiCalls} AI Call(s)` : status}</span>
        </div>
      </div>
    </div>
  );
}
