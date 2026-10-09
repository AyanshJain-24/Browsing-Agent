import React from 'react';

const DEFAULT_ACTIONS = [
  { id: 1, label: 'Opened Amazon', state: 'completed', meta: '0.4s • Tab #104' },
  { id: 2, label: 'Searched "laptop under ₹50,000"', state: 'completed', meta: '1.2s • Form submitted' },
  { id: 3, label: 'Applied price & rating filter', state: 'completed', meta: '0.9s • 16GB RAM + 4★' },
  { id: 4, label: 'Comparing top 4 search results', state: 'active', meta: 'Analyzing customer reviews' },
  { id: 5, label: 'Select best value option', state: 'pending', meta: 'Waiting for comparison' }
];

export default function ActionTimeline({ actions = DEFAULT_ACTIONS }) {
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
