import React from 'react';

export default function AIStatusPill({
  status = 'Observing page',
  label = 'Deterministic Planner'
}) {
  const isCompleted = status.toLowerCase().includes('completed');
  const isError = status.toLowerCase().includes('error') || status.toLowerCase().includes('failed');

  return (
    <div className="ai-status-pill" role="status" aria-live="polite">
      <div className="ai-status-left">
        {isCompleted ? (
          <span style={{ color: 'var(--status-success)', fontSize: '13px' }}>✓</span>
        ) : isError ? (
          <span style={{ color: 'var(--status-error)', fontSize: '13px' }}>✕</span>
        ) : (
          <span className="status-dot-active" aria-hidden="true"></span>
        )}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span className="ai-status-label">{label}</span>
          <span className="ai-status-text">{status}</span>
        </div>
      </div>
      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Safe sandbox</span>
    </div>
  );
}
