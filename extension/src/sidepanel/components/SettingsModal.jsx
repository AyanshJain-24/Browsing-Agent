import React from 'react';

export default function SettingsModal({
  isOpen,
  onClose,
  settings,
  onUpdateSetting
}) {
  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
    >
      <div className="settings-modal-card">
        <div className="settings-header">
          <h2 id="settings-dialog-title" className="settings-title">
            Settings & Preferences
          </h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </div>

        {/* Group: Voice & Hands-Free Interaction */}
        <div className="settings-group">
          <span className="settings-group-title">Voice & Audio</span>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Silence threshold</span>
              <span className="setting-desc">Wait time before auto-executing voice instruction</span>
            </div>
            <select
              className="setting-select"
              value={settings.silenceThreshold !== undefined ? settings.silenceThreshold : 2.5}
              onChange={(e) => onUpdateSetting('silenceThreshold', parseFloat(e.target.value))}
              aria-label="Silence threshold in seconds"
            >
              <option value={1.5}>1.5s (Fast)</option>
              <option value={2.0}>2.0s</option>
              <option value={2.5}>2.5s (Default)</option>
              <option value={3.0}>3.0s (Relaxed)</option>
              <option value={4.0}>4.0s (Slow)</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Speech language</span>
              <span className="setting-desc">Dialect for speech recognition</span>
            </div>
            <select
              className="setting-select"
              value={settings.language || 'en-IN'}
              onChange={(e) => onUpdateSetting('language', e.target.value)}
              aria-label="Speech recognition language"
            >
              <option value="en-IN">English (India) - en-IN</option>
              <option value="en-US">English (US) - en-US</option>
              <option value="en-GB">English (UK) - en-GB</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Voice responses</span>
              <span className="setting-desc">Read agent status updates aloud</span>
            </div>
            <div
              className={`toggle-switch ${settings.voiceResponses ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.voiceResponses}
              tabIndex={0}
              onClick={() => onUpdateSetting('voiceResponses', !settings.voiceResponses)}
              onKeyDown={(e) => e.key === 'Enter' && onUpdateSetting('voiceResponses', !settings.voiceResponses)}
            >
              <div className="toggle-thumb"></div>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Sound effects</span>
              <span className="setting-desc">Chimes on step completions</span>
            </div>
            <div
              className={`toggle-switch ${settings.soundEffects ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.soundEffects}
              tabIndex={0}
              onClick={() => onUpdateSetting('soundEffects', !settings.soundEffects)}
              onKeyDown={(e) => e.key === 'Enter' && onUpdateSetting('soundEffects', !settings.soundEffects)}
            >
              <div className="toggle-thumb"></div>
            </div>
          </div>
        </div>

        {/* Group: AI Planning & Reasoning */}
        <div className="settings-group">
          <span className="settings-group-title">AI Planning & Reasoning</span>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Planner Mode</span>
              <span className="setting-desc">Deterministic-first hybrid saves tokens</span>
            </div>
            <select
              className="setting-select"
              value={settings.plannerMode || 'hybrid'}
              onChange={(e) => onUpdateSetting('plannerMode', e.target.value)}
              aria-label="Agent Planner Mode"
            >
              <option value="hybrid">Hybrid (Deterministic + AI)</option>
              <option value="deterministic">Deterministic Only (No AI)</option>
              <option value="ai_only">AI Only (Always use LLM)</option>
            </select>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">AI Backend URL</span>
              <span className="setting-desc">Local Node/Express reasoning service</span>
            </div>
            <input
              type="text"
              className="setting-select"
              style={{ width: '130px', textAlign: 'left', padding: '4px 8px' }}
              value={settings.backendUrl || 'http://localhost:3001'}
              onChange={(e) => onUpdateSetting('backendUrl', e.target.value)}
              placeholder="http://localhost:3001"
              aria-label="AI Backend URL"
            />
          </div>
        </div>

        {/* Group: Agent & Automation */}
        <div className="settings-group">
          <span className="settings-group-title">Agent Automation</span>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Auto-approve low-risk</span>
              <span className="setting-desc">Skip approval for non-submitting actions</span>
            </div>
            <div
              className={`toggle-switch ${settings.autoApproveLowRisk ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.autoApproveLowRisk}
              tabIndex={0}
              onClick={() => onUpdateSetting('autoApproveLowRisk', !settings.autoApproveLowRisk)}
              onKeyDown={(e) => e.key === 'Enter' && onUpdateSetting('autoApproveLowRisk', !settings.autoApproveLowRisk)}
            >
              <div className="toggle-thumb"></div>
            </div>
          </div>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Show action timeline</span>
              <span className="setting-desc">Render live DOM execution steps</span>
            </div>
            <div
              className={`toggle-switch ${settings.showTimeline ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.showTimeline}
              tabIndex={0}
              onClick={() => onUpdateSetting('showTimeline', !settings.showTimeline)}
              onKeyDown={(e) => e.key === 'Enter' && onUpdateSetting('showTimeline', !settings.showTimeline)}
            >
              <div className="toggle-thumb"></div>
            </div>
          </div>
        </div>

        {/* Group: Appearance */}
        <div className="settings-group">
          <span className="settings-group-title">Appearance</span>

          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Dark Mode</span>
              <span className="setting-desc">Toggle sleek dark side panel theme</span>
            </div>
            <div
              className={`toggle-switch ${settings.darkMode ? 'on' : ''}`}
              role="switch"
              aria-checked={settings.darkMode}
              tabIndex={0}
              onClick={() => onUpdateSetting('darkMode', !settings.darkMode)}
              onKeyDown={(e) => e.key === 'Enter' && onUpdateSetting('darkMode', !settings.darkMode)}
            >
              <div className="toggle-thumb"></div>
            </div>
          </div>
        </div>

        {/* Group: About */}
        <div className="settings-group">
          <span className="settings-group-title">About</span>
          <div className="setting-row">
            <div className="setting-info">
              <span className="setting-name">Voice Browser Agent</span>
              <span className="setting-desc">Manifest V3 • Hackathon Edition</span>
            </div>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>v1.0.0</span>
          </div>
        </div>

        <button
          type="button"
          className="btn-secondary"
          onClick={onClose}
          style={{ marginTop: 8 }}
        >
          Done
        </button>
      </div>
    </div>
  );
}
