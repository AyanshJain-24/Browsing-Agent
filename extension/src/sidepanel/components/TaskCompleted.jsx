import React from 'react';
import Metrics from './Metrics.jsx';

/**
 * Task Completed View
 * Displays persistent verified result, completed action summary,
 * clickable researched sources, task metrics, and an explicit "OK, Done" acknowledgement button.
 */
export default function TaskCompleted({
  onDone,
  onNewTask,
  title = 'Task completed',
  description = 'Browser task completed and verified.',
  resultSummary = null,
  duration = '1.2s',
  actionCount = '1',
  actions = [],
  mode = 'Deterministic',
  plannerMode = undefined,
  tokens = null,
  aiCalls = 0,
  taskMetrics = null,
  fallbackInfo = null,
  queuedUtterance = '',
  onClearQueued = null
}) {
  const handleAcknowledge = onDone || onNewTask;
  const effectiveMode = plannerMode || mode;

  // Extract structured result fields
  const resultTitle = typeof resultSummary === 'string'
    ? resultSummary
    : resultSummary?.title || resultSummary?.heading || null;
  const resultAnswer = typeof resultSummary === 'object'
    ? resultSummary?.answer
    : null;
  const resultMeta = typeof resultSummary === 'object'
    ? resultSummary?.meta
    : null;
  const sources = Array.isArray(resultSummary?.sources)
    ? resultSummary.sources
    : [];

  return (
    <div className="completed-card">
      <div className="completed-check-icon" aria-hidden="true">
        ✓
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <h2 className="completed-title">{title}</h2>
        <p className="completed-desc">{description}</p>
      </div>

      {/* Verified Final Result Box */}
      {(resultTitle || resultAnswer || resultMeta) && (
        <div className="completed-result-box">
          <div className="result-box-header">
            {resultAnswer ? 'Final Answer & Summary' : 'Action Result'}
          </div>
          {resultTitle && (
            <div className="result-item-title" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
              {resultTitle}
            </div>
          )}
          {resultAnswer && (
            <div
              className="result-item-answer"
              style={{
                marginTop: 6,
                fontSize: '12px',
                lineHeight: 1.5,
                color: 'var(--text-primary)',
                whiteSpace: 'pre-wrap',
                background: 'var(--bg-subtle, rgba(255, 255, 255, 0.04))',
                padding: '8px 10px',
                borderRadius: 'var(--radius-sm, 6px)',
                border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))'
              }}
            >
              {resultAnswer}
            </div>
          )}
          {resultSummary?.rationale && (
            <div className="result-item-rationale" style={{ marginTop: 6, fontSize: '11px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              💡 <strong>Recommendation Rationale:</strong> {resultSummary.rationale}
            </div>
          )}
          {resultSummary?.limitations && (
            <div className="result-item-limitations" style={{ marginTop: 6, fontSize: '11px', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.08)', padding: '5px 8px', borderRadius: 4, border: '1px solid rgba(245, 158, 11, 0.2)' }}>
              ⚠️ <strong>Freshness Notice:</strong> {resultSummary.limitations}
            </div>
          )}
          {resultMeta && (
            <div className="result-item-details" style={{ marginTop: 6, fontSize: '11px', color: 'var(--text-secondary)' }}>
              {resultMeta}
            </div>
          )}
        </div>
      )}

      {/* Researched Web Sources (Clickable Citations) */}
      {sources && sources.length > 0 && (
        <div style={{ width: '100%', marginTop: 4 }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span>🌐 Researched Sources ({sources.length})</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 130, overflowY: 'auto' }}>
            {sources.map((src, idx) => (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '5px 8px',
                  background: 'var(--bg-subtle, rgba(255, 255, 255, 0.03))',
                  borderRadius: 'var(--radius-sm, 4px)',
                  fontSize: '11px',
                  border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', maxWidth: '75%' }}>
                  <a
                    href={src.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--accent-primary, #38bdf8)',
                      textDecoration: 'none',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: 500
                    }}
                    title={src.url}
                  >
                    🔗 {src.title || src.url}
                  </a>
                  {src.date && (
                    <span style={{ fontSize: '10px', color: 'var(--text-secondary)', flexShrink: 0 }}>
                      ({src.date})
                    </span>
                  )}
                </div>
                <span
                  style={{
                    fontSize: '10px',
                    color: src.status === 'extracted' ? 'var(--status-success)' : 'var(--text-muted)'
                  }}
                >
                  {src.status === 'extracted' ? '✓ Extracted' : (src.error ? '⚠️ Inaccessible' : 'Visited')}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Completed Actions Summary */}
      {actions && actions.length > 0 && (
        <div style={{ width: '100%', marginTop: 2 }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
            Completed Actions ({actions.length})
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 110, overflowY: 'auto' }}>
            {actions.map((act, idx) => (
              <div
                key={act.id || idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '4px 8px',
                  background: 'var(--bg-subtle, rgba(255, 255, 255, 0.03))',
                  borderRadius: 'var(--radius-sm, 4px)',
                  fontSize: '11px',
                  border: '1px solid var(--border-subtle, rgba(255, 255, 255, 0.08))'
                }}
              >
                <span style={{ color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '75%' }}>
                  ✓ {act.label || act.action?.action || `Step ${idx + 1}`}
                </span>
                <span style={{ fontSize: '10px', color: 'var(--status-success)' }}>
                  {act.meta || 'Verified'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Truthful Task Execution Metrics */}
      <div style={{ width: '100%' }}>
        <Metrics
          time={duration}
          actions={String(actionCount)}
          mode={effectiveMode}
          status="Verified"
          tokens={tokens}
          aiCalls={aiCalls}
          taskMetrics={taskMetrics}
          fallbackInfo={fallbackInfo}
        />
      </div>

      {/* Visible Queued Utterance Notice when Hands-Free is active */}
      {queuedUtterance && (
        <div
          style={{
            width: '100%',
            padding: '6px 10px',
            background: 'rgba(56, 189, 248, 0.08)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: 'var(--radius-sm, 6px)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 6
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflow: 'hidden' }}>
            <span aria-hidden="true">🎤</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              <strong>Queued instruction:</strong> "{queuedUtterance}" (will load upon clicking OK, Done)
            </span>
          </div>
          {onClearQueued && (
            <button
              type="button"
              onClick={onClearQueued}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent-primary, #38bdf8)',
                cursor: 'pointer',
                fontSize: '11px',
                padding: '2px 4px',
                fontWeight: 600,
                flexShrink: 0
              }}
              title="Clear queued command"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Explicit User Acknowledgement Button */}
      <div style={{ display: 'flex', width: '100%', gap: 8, marginTop: 4 }}>
        <button
          type="button"
          className="btn-primary"
          id="btn-ok-done"
          style={{ flex: 1 }}
          onClick={handleAcknowledge}
        >
          OK, Done
        </button>
      </div>
    </div>
  );
}
