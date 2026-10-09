import React from 'react';
import Metrics from './Metrics.jsx';

export default function TaskCompleted({
  onNewTask,
  title = 'Task completed',
  description = 'Browser task completed and verified.',
  resultSummary = null,
  duration = '1.2s',
  actionCount = '1'
}) {
  return (
    <div className="completed-card">
      <div className="completed-check-icon" aria-hidden="true">
        ✓
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 className="completed-title">{title}</h2>
        <p className="completed-desc">{description}</p>
      </div>

      {resultSummary && (
        <div className="completed-result-box">
          <div className="result-box-header">Action Result</div>
          <div className="result-item-title">{resultSummary.title}</div>
          {resultSummary.meta && <div className="result-item-details">{resultSummary.meta}</div>}
        </div>
      )}

      <div style={{ width: '100%' }}>
        <Metrics time={duration} actions={String(actionCount)} mode="Deterministic" status="Verified" />
      </div>

      <div style={{ display: 'flex', width: '100%', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          className="btn-primary"
          style={{ flex: 1 }}
          onClick={onNewTask}
        >
          Start New Task
        </button>
      </div>
    </div>
  );
}
