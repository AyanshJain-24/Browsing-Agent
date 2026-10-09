/**
 * Voice Browser Agent - Web Speech Recognition Utility
 * 
 * Provides an isolated, privacy-preserving Speech-to-Text input layer
 * using the browser's native SpeechRecognition / webkitSpeechRecognition API.
 * 
 * Supports Hands-Free Voice Execution:
 * - Continuous listening (`continuous = true`, `interimResults = true`)
 * - Multi-segment utterance accumulation (no word drop / no duplication)
 * - Automatic silence detection with configurable threshold (default 2.5s)
 * - Resilient session recovery on unexpected Chrome `onend` events
 * - Circuit breaker to prevent infinite restart loops
 * - Utterance cancellation without terminating listening
 * - Zero raw audio storage or transmission (strictly local browser speech recognition)
 */

/**
 * Checks whether the browser environment supports SpeechRecognition.
 * @returns {boolean}
 */
export function isSpeechRecognitionSupported() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * Safely resolves the SpeechRecognition constructor if available.
 * @returns {Function|null}
 */
export function getSpeechRecognitionConstructor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * Explicitly requests microphone permissions from the browser before starting recognition.
 * Immediately frees media tracks so audio capture is not held unnecessarily.
 * 
 * @returns {Promise<{ granted: boolean, error?: string }>}
 */
export async function requestMicrophonePermission() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    // If getUserMedia is not directly accessible, proceed to let SpeechRecognition handle it
    return { granted: true };
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Stop tracks immediately — we only wanted to verify/prompt permission.
    stream.getTracks().forEach((track) => track.stop());
    return { granted: true };
  } catch (err) {
    const isDenied =
      err.name === 'NotAllowedError' ||
      err.name === 'PermissionDeniedError' ||
      err.message?.includes('denied');

    return {
      granted: false,
      error: isDenied ? 'Microphone permission denied.' : 'Microphone access failed.'
    };
  }
}

/**
 * Maps W3C Web Speech API error codes to clear, friendly user messages.
 * @param {string} errorCode
 * @returns {string} Friendly error description
 */
export function mapSpeechError(errorCode) {
  switch (errorCode) {
    case 'not-allowed':
    case 'permission-denied':
      return 'Microphone permission denied.';
    case 'no-speech':
      return 'Could not hear speech. Try again.';
    case 'audio-capture':
      return 'Microphone capture error. Check audio input.';
    case 'network':
      return 'Network error during speech recognition.';
    case 'service-not-allowed':
      return 'Speech recognition unavailable.';
    case 'aborted':
      return 'Listening cancelled.';
    case 'language-not-supported':
      return 'Language not supported in this browser.';
    default:
      return `Speech recognition error (${errorCode || 'unknown'}).`;
  }
}

/**
 * Creates and encapsulates an enhanced SpeechRecognition controller instance
 * configured for hands-free voice command execution.
 * 
 * @param {Object} [options]
 * @param {Function} [options.SpeechRecognitionConstructor] - Custom constructor for test mocking
 * @returns {Object} Speech Recognizer controller
 */
export function createSpeechRecognizer(options = {}) {
  const SpeechConstructor = options.SpeechRecognitionConstructor || getSpeechRecognitionConstructor();
  
  let recognition = null;
  let active = false;
  let handsFreeActive = false;
  let manualStop = false;
  let isStarting = false;
  
  let silenceTimer = null;
  let silenceDurationMs = options.silenceDurationMs || 2500;
  let lang = options.lang || 'en-IN';
  
  // Utterance tracking
  let priorFinalText = '';
  let sessionFinalText = '';
  let sessionInterimText = '';
  let utteranceStartIndex = 0;
  let lastSubmittedText = '';
  let isSubmitting = false;

  // Restart resilience tracking
  let consecutiveRestarts = 0;
  let lastRestartTimestamp = 0;
  const MAX_RESTARTS_IN_WINDOW = 4;
  const RESTART_WINDOW_MS = 10000;

  // Active callbacks map
  let callbacks = {};

  /**
   * Computes the complete combined text for the current active utterance.
   */
  function getFullTranscript() {
    const combinedFinal = (priorFinalText ? `${priorFinalText} ${sessionFinalText}` : sessionFinalText).trim();
    let full = combinedFinal;
    if (sessionInterimText) {
      full = combinedFinal ? `${combinedFinal} ${sessionInterimText}` : sessionInterimText;
    }
    return {
      finalText: combinedFinal,
      interimText: sessionInterimText.trim(),
      fullText: full.trim()
    };
  }

  /**
   * Resets the configurable silence timer whenever new speech is detected.
   */
  function resetSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    const { fullText } = getFullTranscript();
    if (fullText && fullText.length > 0 && !isSubmitting) {
      silenceTimer = setTimeout(() => {
        finalizeUtterance();
      }, silenceDurationMs);
    }
  }

  /**
   * Finalizes the accumulated utterance after the silence threshold has elapsed.
   */
  function finalizeUtterance() {
    if (isSubmitting) return;

    const current = getFullTranscript();
    const clean = current.fullText.trim();
    
    // Do not submit empty or whitespace-only transcript
    if (!clean) return;

    // Prevent duplicate submissions of the exact same utterance
    if (clean === lastSubmittedText) {
      return;
    }

    isSubmitting = true;
    lastSubmittedText = clean;

    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    if (callbacks.onUtteranceFinalized) {
      callbacks.onUtteranceFinalized(clean);
    }
  }

  /**
   * Starts a single Web Speech recognition session.
   */
  function startSession() {
    if (!SpeechConstructor) {
      if (callbacks.onError) callbacks.onError('Speech recognition is not supported in this browser.', true);
      return;
    }

    if (isStarting) return;
    isStarting = true;

    // Clean up existing recognition instance if any
    if (recognition) {
      try {
        recognition.onstart = null;
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        recognition.abort();
      } catch {
        // Ignore cleanup error
      }
      recognition = null;
    }

    try {
      recognition = new SpeechConstructor();
      recognition.lang = lang;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition._lastResultCount = 0;
      utteranceStartIndex = 0;
      sessionFinalText = '';
      sessionInterimText = '';

      recognition.onstart = () => {
        active = true;
        isStarting = false;
        consecutiveRestarts = 0; // Reset restart circuit breaker on successful session start
        if (callbacks.onStart) callbacks.onStart();
        // If we preserved text from an interrupted session, resume silence countdown
        if (priorFinalText) {
          resetSilenceTimer();
        }
      };

      recognition.onresult = (event) => {
        if (!event || !event.results) return;
        recognition._lastResultCount = event.results.length;

        let newFinal = '';
        let newInterim = '';

        for (let i = utteranceStartIndex; i < event.results.length; ++i) {
          const result = event.results[i];
          if (!result || !result[0]) continue;
          const text = (result[0].transcript || '').trim();
          if (!text) continue;

          if (result.isFinal) {
            newFinal += (newFinal ? ' ' : '') + text;
          } else {
            newInterim += (newInterim ? ' ' : '') + text;
          }
        }

        sessionFinalText = newFinal;
        sessionInterimText = newInterim;

        const current = getFullTranscript();

        if (callbacks.onInterimResult) {
          callbacks.onInterimResult(current.interimText, current.fullText);
        }

        if (sessionFinalText && callbacks.onFinalResult) {
          callbacks.onFinalResult(current.finalText, current.fullText);
        }

        // Reset silence timer on ANY speech event (interim or final)
        resetSilenceTimer();
      };

      recognition.onerror = (event) => {
        const errCode = event?.error || 'unknown';

        // Ignore aborted error if user clicked stop button manually
        if (errCode === 'aborted' && manualStop) {
          return;
        }

        // Fatal errors: permission denied, mic hardware issues, service disallowed
        const isFatal =
          errCode === 'not-allowed' ||
          errCode === 'permission-denied' ||
          errCode === 'service-not-allowed' ||
          errCode === 'audio-capture';

        if (isFatal) {
          handsFreeActive = false;
          manualStop = true;
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
        }

        const friendlyMsg = mapSpeechError(errCode);
        if (callbacks.onError) callbacks.onError(friendlyMsg, isFatal);
      };

      recognition.onend = () => {
        active = false;
        isStarting = false;

        // Intentional stop: do not restart
        if (manualStop || !handsFreeActive) {
          if (callbacks.onEnd) callbacks.onEnd({ intentional: true });
          return;
        }

        // Unexpected onend while hands-free is enabled:
        // Do NOT trigger an immediate premature submission!
        if (silenceTimer) {
          clearTimeout(silenceTimer);
          silenceTimer = null;
        }

        // Retain any finalized segments from this session across the restart
        if (sessionFinalText) {
          priorFinalText = (priorFinalText ? `${priorFinalText} ${sessionFinalText}` : sessionFinalText).trim();
          sessionFinalText = '';
        }
        sessionInterimText = '';

        // Circuit breaker: detect rapid restart failures to prevent infinite loops
        const now = Date.now();
        if (now - lastRestartTimestamp < RESTART_WINDOW_MS) {
          consecutiveRestarts++;
        } else {
          consecutiveRestarts = 1;
        }
        lastRestartTimestamp = now;

        if (consecutiveRestarts > MAX_RESTARTS_IN_WINDOW) {
          handsFreeActive = false;
          manualStop = true;
          if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
          }
          if (callbacks.onError) {
            callbacks.onError('Microphone session stopped repeatedly. Hands-free listening paused.', true);
          }
          if (callbacks.onEnd) callbacks.onEnd({ intentional: false });
          return;
        }

        if (callbacks.onRestart) callbacks.onRestart();

        // Safely restart after short recovery delay
        setTimeout(() => {
          if (handsFreeActive && !manualStop) {
            startSession();
          }
        }, 250);
      };

      recognition.start();
    } catch (err) {
      active = false;
      isStarting = false;
      if (callbacks.onError) callbacks.onError(err.message || 'Failed to start speech recognition.', true);
    }
  }

  return {
    /**
     * Starts hands-free continuous speech recognition.
     */
    start(opts = {}) {
      callbacks = { ...opts };
      if (opts.lang) lang = opts.lang;
      if (opts.silenceDurationMs) silenceDurationMs = opts.silenceDurationMs;

      manualStop = false;
      handsFreeActive = true;
      priorFinalText = '';
      sessionFinalText = '';
      sessionInterimText = '';
      lastSubmittedText = '';
      isSubmitting = false;

      startSession();
    },

    /**
     * Intentionally stops speech recognition and exits hands-free mode.
     */
    stop() {
      manualStop = true;
      handsFreeActive = false;
      isStarting = false;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      if (recognition && active) {
        try {
          recognition.stop();
        } catch {
          // Ignore
        }
      }
      active = false;
    },

    /**
     * Aborts speech recognition immediately.
     */
    abort() {
      manualStop = true;
      handsFreeActive = false;
      isStarting = false;
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      if (recognition && active) {
        try {
          recognition.abort();
        } catch {
          // Ignore
        }
      }
      active = false;
    },

    /**
     * Cancels the current unsubmitted utterance without stopping hands-free listening.
     */
    cancelCurrentUtterance() {
      priorFinalText = '';
      sessionFinalText = '';
      sessionInterimText = '';
      if (recognition && recognition._lastResultCount !== undefined) {
        utteranceStartIndex = recognition._lastResultCount;
      } else {
        utteranceStartIndex = 0;
      }
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      isSubmitting = false;
      lastSubmittedText = '';

      if (callbacks.onUtteranceCancelled) {
        callbacks.onUtteranceCancelled();
      }
    },

    /**
     * Clears the current utterance after a successful submission so next speech starts fresh.
     */
    clearUtterance() {
      priorFinalText = '';
      sessionFinalText = '';
      sessionInterimText = '';
      if (recognition && recognition._lastResultCount !== undefined) {
        utteranceStartIndex = recognition._lastResultCount;
      } else {
        utteranceStartIndex = 0;
      }
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      isSubmitting = false;
    },

    /**
     * Dynamically updates the silence threshold duration.
     * @param {number} ms
     */
    setSilenceDuration(ms) {
      if (typeof ms === 'number' && ms > 0) {
        silenceDurationMs = ms;
      }
    },

    /**
     * Dynamically updates recognition language.
     * @param {string} newLang
     */
    setLanguage(newLang) {
      if (newLang && typeof newLang === 'string') {
        lang = newLang;
        if (active && recognition) {
          recognition.lang = newLang;
        }
      }
    },

    /**
     * Returns whether recognition is actively capturing audio.
     * @returns {boolean}
     */
    isListening() {
      return active;
    },

    /**
     * Returns whether hands-free mode is enabled.
     * @returns {boolean}
     */
    isHandsFree() {
      return handsFreeActive;
    },

    /**
     * Returns the current transcript breakdown.
     * @returns {{ finalText: string, interimText: string, fullText: string }}
     */
    getTranscript() {
      return getFullTranscript();
    }
  };
}
