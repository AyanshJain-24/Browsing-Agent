import React, { useState } from 'react';

export default function CommandInput({
  value,
  onChange,
  onSubmitCommand,
  onToggleVoice,
  onCancelUtterance,
  isListening,
  handsFree,
  transcriptionPreview = '',
  isProcessing = false,
  placeholder = 'Tell me what to do...'
}) {
  const [internalValue, setInternalValue] = useState('');

  // Support both controlled mode (via App.jsx) and standalone uncontrolled mode
  const currentValue = value !== undefined ? value : internalValue;

  const handleChange = (e) => {
    const nextVal = e.target.value;
    if (onChange) {
      onChange(nextVal);
    } else {
      setInternalValue(nextVal);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    const trimmed = currentValue.trim();
    if (!trimmed) return;
    onSubmitCommand(trimmed);
    if (!onChange) {
      setInternalValue('');
    }
  };

  return (
    <div className="bottom-command-bar">
      {/* Hands-Free Voice Status Banner (Active whenever microphone is listening) */}
      {isListening && (
        <div className="hands-free-status-banner" role="status" aria-live="polite">
          <div className="hands-free-pill">
            <span className={`hands-free-pulse-dot ${isProcessing ? 'processing' : ''}`} aria-hidden="true"></span>
            <span className="hands-free-label">
              {isProcessing ? 'Submitting to Agent...' : 'Hands-Free Listening'}
            </span>
          </div>

          <div className="hands-free-preview-text">
            {isProcessing ? (
              <span className="processing-text">Executing: "{transcriptionPreview || currentValue}"</span>
            ) : transcriptionPreview ? (
              <span className="transcription-text">"{transcriptionPreview}"</span>
            ) : (
              <span className="listening-placeholder">Listening for your command...</span>
            )}
          </div>

          <div className="hands-free-btn-group">
            {transcriptionPreview && !isProcessing && onCancelUtterance && (
              <button
                type="button"
                className="hands-free-cancel-btn"
                onClick={onCancelUtterance}
                title="Cancel this command"
                aria-label="Cancel current utterance"
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              className="hands-free-stop-btn"
              onClick={onToggleVoice}
              title="Stop listening"
              aria-label="Stop hands-free microphone"
            >
              Stop Mic
            </button>
          </div>
        </div>
      )}

      <form className="command-input-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="command-input"
          placeholder={isListening ? 'Listening... or type command' : placeholder}
          value={currentValue}
          onChange={handleChange}
          aria-label="Browser agent command input"
        />

        <div className="command-actions">
          <button
            type="button"
            className={`mic-toggle-btn ${isListening ? 'active' : ''}`}
            onClick={onToggleVoice}
            title={isListening ? 'Stop hands-free listening' : 'Start hands-free voice command'}
            aria-label={isListening ? 'Stop hands-free listening' : 'Start hands-free voice command'}
            aria-pressed={isListening}
          >
            {isListening ? (
              // Active listening red square/stop icon or animated mic
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            )}
          </button>

          <button
            type="submit"
            className="send-btn"
            disabled={!currentValue.trim()}
            title="Execute command"
            aria-label="Execute command"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 12 14-7-7 14V12H5z" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
