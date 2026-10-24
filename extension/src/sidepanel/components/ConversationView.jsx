import React, { useEffect, useRef } from 'react';

/**
 * Voice Browser Agent - Conversational Voice Assistant View
 * 
 * Displays the two-way voice conversation feed, real-time voice session status,
 * spoken responses, audio controls (mute/unmute, stop speaking), and follow-up prompts.
 */
export default function ConversationView({
  voiceState = 'STOPPED', // 'STOPPED' | 'LISTENING' | 'PROCESSING' | 'SPEAKING'
  messages = [],
  currentUtterance = '',
  interimTranscript = '',
  isMuted = false,
  onToggleMute,
  onStopSpeaking,
  onToggleVoice,
  onReplaySpeech,
  onClearHistory
}) {
  const scrollRef = useRef(null);

  // Auto-scroll to the latest message as the conversation develops
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentUtterance, interimTranscript, voiceState]);

  const isVoiceActive = voiceState !== 'STOPPED';

  const getStatusBadge = () => {
    switch (voiceState) {
      case 'LISTENING':
        return (
          <div className="voice-status-pill listening">
            <span className="pulse-dot listening-dot"></span>
            <span className="voice-status-label">Listening for speech...</span>
          </div>
        );
      case 'PROCESSING':
        return (
          <div className="voice-status-pill processing">
            <span className="pulse-dot processing-dot"></span>
            <span className="voice-status-label">Processing instruction...</span>
          </div>
        );
      case 'SPEAKING':
        return (
          <div className="voice-status-pill speaking">
            <span className="speaking-wave-icon">🔊</span>
            <span className="voice-status-label">Assistant speaking...</span>
          </div>
        );
      case 'STOPPED':
      default:
        return (
          <div className="voice-status-pill stopped">
            <span className="stopped-dot">○</span>
            <span className="voice-status-label">Voice session stopped</span>
          </div>
        );
    }
  };

  return (
    <div className="conversation-container">
      {/* Voice Session Status & Action Controls Header */}
      <div className="conversation-header">
        <div className="status-group">
          {getStatusBadge()}
        </div>

        <div className="conversation-controls">
          {/* Stop Speaking button when TTS is playing */}
          {voiceState === 'SPEAKING' && (
            <button
              type="button"
              className="ctrl-btn stop-speaking-btn"
              onClick={onStopSpeaking}
              title="Stop speaking aloud"
            >
              ⏹ Stop Speech
            </button>
          )}

          {/* Mute/Unmute Audio Toggle */}
          <button
            type="button"
            className={`ctrl-btn mute-btn ${isMuted ? 'is-muted' : ''}`}
            onClick={onToggleMute}
            title={isMuted ? 'Unmute assistant speech' : 'Mute assistant speech'}
          >
            {isMuted ? '🔇 Unmuted' : '🔊 Mute'}
          </button>

          {/* Microphone Start/Stop Control */}
          <button
            type="button"
            className={`ctrl-btn mic-toggle-btn ${isVoiceActive ? 'btn-stop-mic' : 'btn-start-mic'}`}
            onClick={onToggleVoice}
            title={isVoiceActive ? 'End voice session and stop microphone' : 'Start voice session'}
          >
            {isVoiceActive ? '⏹ Stop Mic' : '🎙️ Start Mic'}
          </button>
        </div>
      </div>

      {/* Main Conversation Feed */}
      <div className="conversation-feed" ref={scrollRef}>
        {messages.length === 0 && !currentUtterance && !interimTranscript && (
          <div className="conversation-empty-state">
            <div className="empty-chat-icon">💬</div>
            <p className="empty-chat-title">Voice Conversation Ready</p>
            <p className="empty-chat-subtitle">
              Click <strong>"Start Mic"</strong> and say:
            </p>
            <div className="sample-prompts">
              <span className="sample-chip">"Search quantum computing"</span>
              <span className="sample-chip">"Summarize this page"</span>
              <span className="sample-chip">"Find best laptops under 50,000"</span>
            </div>
          </div>
        )}

        {/* Chronological Chat Messages */}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`chat-bubble-row ${msg.role === 'user' ? 'user-row' : 'assistant-row'}`}
          >
            {msg.role === 'assistant' && (
              <div className="avatar-icon assistant-avatar">🤖</div>
            )}

            <div className={`chat-bubble ${msg.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`}>
              {msg.title && (
                <div className="bubble-title">{msg.title}</div>
              )}

              <div className="bubble-text">{msg.text}</div>

              {/* Clickable Research Source Links */}
              {Array.isArray(msg.result?.sources || msg.sources) && (msg.result?.sources || msg.sources).length > 0 && (
                <div style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--border-subtle, rgba(255,255,255,0.08))', display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontSize: '10px', fontWeight: 600, color: 'var(--text-secondary)' }}>Sources:</span>
                  {(msg.result?.sources || msg.sources).map((src, i) => (
                    <a
                      key={i}
                      href={src.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        color: 'var(--accent-primary, #38bdf8)',
                        textDecoration: 'none',
                        fontSize: '11px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}
                      title={src.url}
                    >
                      🔗 {src.title || src.url} {src.date ? <span style={{ opacity: 0.8, fontSize: '10px' }}>({src.date})</span> : ''}
                    </a>
                  ))}
                </div>
              )}

              {msg.meta && (
                <div className="bubble-meta">{msg.meta}</div>
              )}

              <div className="bubble-footer">
                <span className="bubble-time">{msg.time || ''}</span>
                {msg.role === 'assistant' && (msg.spokenText || msg.text) && (
                  <button
                    type="button"
                    className="replay-speech-btn"
                    onClick={() => onReplaySpeech && onReplaySpeech(msg.spokenText || msg.text)}
                    title="Play speech again"
                  >
                    🔊 Listen
                  </button>
                )}
              </div>
            </div>

            {msg.role === 'user' && (
              <div className="avatar-icon user-avatar">👤</div>
            )}
          </div>
        ))}

        {/* Live Interim / In-flight Speech Bubble */}
        {(currentUtterance || interimTranscript) && (
          <div className="chat-bubble-row user-row interim-row">
            <div className="chat-bubble user-bubble interim-bubble">
              <div className="interim-text">
                {currentUtterance || interimTranscript}
                <span className="blinking-cursor">|</span>
              </div>
              <div className="bubble-footer">
                <span className="bubble-time">Listening...</span>
              </div>
            </div>
            <div className="avatar-icon user-avatar listening-avatar">🎙️</div>
          </div>
        )}

        {/* Waiting for Follow-up Indicator */}
        {voiceState === 'LISTENING' && !currentUtterance && !interimTranscript && messages.length > 0 && (
          <div className="waiting-followup-pill">
            <span className="followup-dot"></span>
            <span>Listening for follow-up question or command...</span>
          </div>
        )}
      </div>
    </div>
  );
}
