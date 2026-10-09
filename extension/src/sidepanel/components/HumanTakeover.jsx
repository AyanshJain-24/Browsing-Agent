import React from 'react';

export default function HumanTakeover({ onResumeAgent }) {
  return (
    <div className="takeover-card" role="alert">
      <div className="takeover-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--status-warning)' }}>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
        <span className="takeover-title">Your input is needed</span>
      </div>

      <p className="takeover-description">
        The agent paused: A security check (CAPTCHA / 2FA login) was encountered in your tab. Please complete it manually in Chrome.
      </p>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
        <button
          type="button"
          className="btn-primary"
          onClick={onResumeAgent}
          style={{ padding: '6px 14px', fontSize: '11.5px' }}
        >
          Resume agent ▶
        </button>
      </div>
    </div>
  );
}
