import React from 'react';

export default function VoiceButton({
  isListening,
  onToggleVoice,
  onCancelUtterance,
  transcription = '',
  isProcessing = false,
  error = ''
}) {
  return (
    <div className="voice-hero-container">
      <div className="voice-button-wrapper">
        {/* Animated Ripple Rings */}
        <div className={`voice-ripple ${isListening ? 'listening' : ''}`} aria-hidden="true"></div>
        {isListening && (
          <div
            className="voice-ripple listening"
            style={{ animationDelay: '0.6s' }}
            aria-hidden="true"
          ></div>
        )}

        <button
          className={`voice-btn ${isListening ? 'listening' : ''} ${isProcessing ? 'processing' : ''}`}
          onClick={onToggleVoice}
          aria-label={isListening ? 'Stop listening' : 'Start hands-free voice command'}
          aria-pressed={isListening}
          title={isListening ? 'Stop hands-free listening' : 'Start speaking command'}
        >
          {isProcessing ? (
            // Processing spinner / gear icon
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="spin-icon">
              <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
            </svg>
          ) : isListening ? (
            // Stop / square icon when listening
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
            </svg>
          ) : (
            // Microphone SVG
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          )}
          <span className="voice-btn-caption">
            {isProcessing ? 'Submitting' : isListening ? 'Listening' : 'Speak'}
          </span>
        </button>
      </div>

      {/* Real-time Interim Transcription Preview while listening */}
      {isListening && (
        <>
          {/* Animated 5-bar audio equalizer */}
          {!isProcessing ? (
            <div className="waveform-container" aria-hidden="true">
              <span className="wave-bar"></span>
              <span className="wave-bar"></span>
              <span className="wave-bar"></span>
              <span className="wave-bar"></span>
              <span className="wave-bar"></span>
            </div>
          ) : (
            <div className="voice-processing-badge">
              <span>Executing via Agent</span>
            </div>
          )}

          <p className="transcription-preview">
            "{transcription || 'Listening for your instructions...'}"
          </p>

          {/* Cancel current unsubmitted utterance */}
          {transcription && onCancelUtterance && !isProcessing && (
            <button
              type="button"
              className="voice-cancel-utterance-btn"
              onClick={onCancelUtterance}
              title="Cancel this command without executing"
              aria-label="Cancel current utterance"
            >
              ✕ Cancel command
            </button>
          )}
        </>
      )}

      {/* Graceful Voice / Permission Error Notice */}
      {!isListening && error && (
        <p
          className="voice-error-text"
          style={{
            marginTop: 10,
            fontSize: '11px',
            color: 'var(--status-error)',
            textAlign: 'center',
            maxWidth: 260,
            lineHeight: 1.35
          }}
          role="alert"
        >
          {error}
        </p>
      )}
    </div>
  );
}
