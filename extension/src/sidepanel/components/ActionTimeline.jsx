import React from 'react';

export default function ActionTimeline({ actions = [] }) {
  if (!actions || actions.length === 0) {
    return (
      <div className="timeline-card" aria-label="Browser action timeline">
        <div className="timeline-title">Browser Action Timeline</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '12px', padding: '6px 0' }}>
          No action steps recorded yet.
        </div>
      </div>
    );
  }
  const renderIcon = (state) => {
    switch (state) {
      case 'completed':
        return '✓';
      case 'active':
        return '●';
      case 'failed':
        return '✕';
      case 'pending':
      default:
        return '○';
    }
  };

  return (
    <div className="timeline-card" aria-label="Browser action timeline">
      <div className="timeline-title">Browser Action Timeline</div>
      <div className="timeline-list">
        {actions.map((item, index) => (
          <div key={item.id || index} className="timeline-item">
            <div className="timeline-stem" aria-hidden="true"></div>
            <div
              className={`timeline-node ${item.state}`}
              aria-label={`Step ${index + 1}: ${item.state}`}
            >
              {renderIcon(item.state)}
            </div>
            <div className="timeline-content">
              <span className={`timeline-label ${item.state}`}>
                {item.label}
              </span>
              {item.meta && (
                <span className="timeline-meta">{item.meta}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
