import React, { useState } from 'react';
import { executeAction } from '../utils/chromeMessaging.js';

const STATES = [
  { key: 'IDLE', label: 'Idle' },
  { key: 'LISTENING', label: 'Listening' },
  { key: 'THINKING', label: 'Thinking' },
  { key: 'EXECUTING', label: 'Executing' },
  { key: 'WAITING_FOR_APPROVAL', label: 'Approval' },
  { key: 'HUMAN_TAKEOVER', label: 'Takeover' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'ERROR', label: 'Error' }
];

export default function DevStateSwitcher({ currentState, onSelectState, onRunDemoFlow }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showTestMenu, setShowTestMenu] = useState(false);
  const [testResult, setTestResult] = useState('');

  // Development helper to run real executor actions directly from the side panel
  const handleTestScroll = async (direction) => {
    setTestResult(`Scrolling ${direction}...`);
    const res = await executeAction({
      action: 'scroll',
      direction,
      amount: 500
    });
    setTestResult(res.success ? `✓ Scrolled ${direction}` : `✕ ${res.error || 'Failed'}`);
    setTimeout(() => setTestResult(''), 3000);
  };

  const handleTestInvalidId = async () => {
    setTestResult('Testing invalid ID...');
    const res = await executeAction({
      action: 'click',
      elementId: 'element-9999'
    });
    setTestResult(res.success ? '✓ Clicked' : `Expected failure: ${res.error || 'Failed'}`);
    setTimeout(() => setTestResult(''), 4000);
  };

  if (collapsed) {
    return (
      <div style={{ position: 'fixed', top: 6, right: 6, zIndex: 100 }}>
        <button
          onClick={() => setCollapsed(false)}
          className="dev-badge"
          style={{ cursor: 'pointer', border: '1px solid var(--border-color)', boxShadow: 'var(--shadow-sm)' }}
          title="Show Dev Preview Controls"
        >
          Dev: {currentState} ⚙️
        </button>
      </div>
    );
  }

  return (
    <div className="dev-banner" aria-label="Developer Preview Controls">
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span className="dev-badge">Dev</span>
        <button
          onClick={onRunDemoFlow}
          className="dev-pill"
          style={{ background: 'var(--accent-light)', color: 'var(--accent-primary)', fontWeight: 600 }}
          title="Play automated agent demo flow"
        >
          ▶ Flow
        </button>
        <button
          onClick={() => setShowTestMenu(!showTestMenu)}
          className="dev-pill"
          style={{ background: showTestMenu ? 'var(--accent-primary)' : 'var(--bg-primary)', color: showTestMenu ? '#fff' : 'inherit' }}
          title="Toggle Phase 4 Live Action Tests"
        >
          ⚡ Actions
        </button>
      </div>

      <div className="dev-pills">
        {STATES.map((s) => (
          <button
            key={s.key}
            className={`dev-pill ${currentState === s.key ? 'active' : ''}`}
            onClick={() => onSelectState(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <button
        onClick={() => setCollapsed(true)}
        style={{ fontSize: '11px', color: 'var(--text-muted)', padding: '0 4px' }}
        title="Minimize dev bar"
      >
        ✕
      </button>

      {/* Popover for live Phase 4 action tests */}
      {showTestMenu && (
        <div
          style={{
            position: 'absolute',
            top: 36,
            left: 10,
            right: 10,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-md)',
            padding: '8px 10px',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: '11px'
          }}
        >
          <div style={{ fontWeight: 600, display: 'flex', justifyContent: 'space-between' }}>
            <span>Live Action Tests (Side Panel ➔ Page)</span>
            <button onClick={() => setShowTestMenu(false)} style={{ color: 'var(--text-muted)' }}>✕</button>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              onClick={() => handleTestScroll('down')}
              className="btn-secondary"
              style={{ padding: '3px 8px', fontSize: '10.5px' }}
            >
              Scroll Down 500px
            </button>
            <button
              onClick={() => handleTestScroll('up')}
              className="btn-secondary"
              style={{ padding: '3px 8px', fontSize: '10.5px' }}
            >
              Scroll Up 500px
            </button>
            <button
              onClick={handleTestInvalidId}
              className="btn-secondary"
              style={{ padding: '3px 8px', fontSize: '10.5px' }}
            >
              Test Invalid ID
            </button>
          </div>
          {testResult && (
            <div style={{ fontSize: '10px', color: testResult.startsWith('✓') ? 'var(--status-success)' : 'var(--status-error)', fontWeight: 500 }}>
              {testResult}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
