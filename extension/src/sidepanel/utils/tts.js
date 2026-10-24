/**
 * Voice Browser Agent - Text-to-Speech (TTS) Utility
 * 
 * Provides spoken agent responses using the browser's built-in Web Speech API (speechSynthesis).
 * 
 * Guarantees:
 * - Speaks final verified task results, summaries, and friendly error explanations.
 * - Filters raw JSON, technical action logs, token metrics, and markdown formatting before speaking.
 * - Selects appropriate English voices when available.
 * - Prevents duplicate speech when React rerenders or task events repeat.
 * - Provides mute/unmute and stop-speaking controls.
 * - Handles unsupported browser environments and speech errors gracefully without false claims.
 */

/**
 * Checks whether the browser environment supports the Web Speech Synthesis API.
 * @returns {boolean}
 */
export function isSpeechSynthesisSupported() {
  if (typeof window === 'undefined') return false;
  return Boolean(window.speechSynthesis && typeof window.SpeechSynthesisUtterance !== 'undefined');
}

/**
 * Strips markdown symbols, raw JSON, token numbers, and technical noise
 * to produce clean, natural spoken sentences.
 * 
 * @param {string|Object} rawInput
 * @returns {string} Sanitized text suitable for speech synthesis
 */
export function cleanTextForSpeech(rawInput) {
  if (!rawInput) return '';

  let text = '';
  if (typeof rawInput === 'object') {
    if (rawInput.answer) {
      text = String(rawInput.answer);
    } else if (rawInput.spokenText) {
      text = String(rawInput.spokenText);
    } else if (rawInput.title && rawInput.meta) {
      text = `${rawInput.title}. ${rawInput.meta}`;
    } else if (rawInput.title) {
      text = String(rawInput.title);
    } else {
      return '';
    }
  } else {
    text = String(rawInput);
  }

  // 1. Strip raw JSON blocks or curly brace structures
  text = text.replace(/\{[\s\S]*?\}/g, '');

  // 2. Strip code blocks and inline code
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. Convert markdown links [text](url) to just text
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // 4. Strip markdown headings (# Header -> Header)
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 5. Strip markdown bold / italic formatting (**text**, *text*, __text__)
  text = text.replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1');

  // 6. Convert bullet lists and numbered lists into continuous sentences
  text = text.replace(/^\s*[-*•]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');

  // 7. Strip URLs (http:// or https://...)
  text = text.replace(/https?:\/\/\S+/gi, '');

  // 8. Collapse repeated whitespace and newlines
  text = text.replace(/\s+/g, ' ').trim();

  // 9. Avoid speaking token metrics or action IDs if accidentally passed
  text = text.replace(/\b(tokens?|element-\d+|action timeline|latency)\b/gi, '');

  return text.trim();
}

/**
 * Creates and encapsulates a Text-To-Speech controller instance.
 * 
 * @param {Object} [options]
 * @returns {Object} TTS controller
 */
export function createTTSController(options = {}) {
  let isMuted = Boolean(options.muted);
  let currentUtterance = null;
  let speaking = false;
  let lastSpokenText = '';
  let speechError = null;

  /**
   * Selects the best available English voice.
   * @param {string} [preferredLang='en-US']
   * @returns {SpeechSynthesisVoice|null}
   */
  function resolveVoice(preferredLang = 'en-US') {
    if (!isSpeechSynthesisSupported()) return null;
    try {
      const voices = window.speechSynthesis.getVoices() || [];
      if (!voices.length) return null;

      // 1. Exact match on preferred language
      const exact = voices.find((v) => v.lang === preferredLang || v.lang.replace('_', '-') === preferredLang);
      if (exact) return exact;

      // 2. Match any English voice with natural / Google in name
      const naturalEn = voices.find((v) => v.lang.startsWith('en') && /natural|google|enhanced|samantha/i.test(v.name));
      if (naturalEn) return naturalEn;

      // 3. Any English voice
      const anyEn = voices.find((v) => v.lang.startsWith('en'));
      if (anyEn) return anyEn;

      // 4. Default voice
      return voices.find((v) => v.default) || voices[0] || null;
    } catch {
      return null;
    }
  }

  return {
    /**
     * Speaks text aloud using SpeechSynthesis.
     * 
     * @param {string|Object} textToSpeak
     * @param {Object} [opts]
     * @param {string} [opts.lang='en-US']
     * @param {number} [opts.rate=1.0]
     * @param {number} [opts.pitch=1.0]
     * @param {Function} [opts.onStart]
     * @param {Function} [opts.onEnd]
     * @param {Function} [opts.onError]
     * @returns {boolean} Whether speech was initiated
     */
    speak(textToSpeak, opts = {}) {
      speechError = null;

      if (!isSpeechSynthesisSupported()) {
        const err = new Error('Speech synthesis is not supported in this browser.');
        speechError = err.message;
        if (opts.onError) opts.onError(err.message);
        return false;
      }

      const cleanText = cleanTextForSpeech(textToSpeak);
      if (!cleanText) {
        if (opts.onEnd) opts.onEnd();
        return false;
      }

      // Avoid duplicate consecutive speech for the exact same sentence
      if (speaking && lastSpokenText === cleanText) {
        return false;
      }

      // If muted, notify start and end without audio output
      if (isMuted) {
        lastSpokenText = cleanText;
        if (opts.onStart) opts.onStart();
        setTimeout(() => {
          if (opts.onEnd) opts.onEnd();
        }, 50);
        return true;
      }

      try {
        // Cancel any active utterance before starting a new one
        window.speechSynthesis.cancel();

        const utterance = new window.SpeechSynthesisUtterance(cleanText);
        utterance.lang = opts.lang || 'en-US';
        utterance.rate = opts.rate || 1.0;
        utterance.pitch = opts.pitch || 1.0;

        const voice = resolveVoice(opts.lang || 'en-US');
        if (voice) {
          utterance.voice = voice;
        }

        utterance.onstart = () => {
          speaking = true;
          lastSpokenText = cleanText;
          if (opts.onStart) opts.onStart();
        };

        utterance.onend = () => {
          speaking = false;
          currentUtterance = null;
          if (opts.onEnd) opts.onEnd();
        };

        utterance.onerror = (event) => {
          speaking = false;
          currentUtterance = null;
          // Ignore cancelled or interrupted events from explicit stops
          if (event?.error === 'canceled' || event?.error === 'interrupted') {
            if (opts.onEnd) opts.onEnd();
            return;
          }
          const msg = event?.error ? `Speech error: ${event.error}` : 'Speech synthesis failed.';
          speechError = msg;
          if (opts.onError) opts.onError(msg);
        };

        currentUtterance = utterance;
        window.speechSynthesis.speak(utterance);
        return true;
      } catch (err) {
        speaking = false;
        currentUtterance = null;
        speechError = err.message;
        if (opts.onError) opts.onError(err.message);
        return false;
      }
    },

    /**
     * Immediately stops ongoing speech synthesis.
     */
    stop() {
      speaking = false;
      currentUtterance = null;
      if (isSpeechSynthesisSupported()) {
        try {
          window.speechSynthesis.cancel();
        } catch {
          // Ignore
        }
      }
    },

    /**
     * Mutes or unmutes speech output.
     * @param {boolean} muted
     */
    setMuted(muted) {
      isMuted = Boolean(muted);
      if (isMuted && speaking) {
        this.stop();
      }
    },

    /**
     * Returns whether TTS is currently muted.
     * @returns {boolean}
     */
    isMuted() {
      return isMuted;
    },

    /**
     * Returns whether speech synthesis is actively playing audio.
     * @returns {boolean}
     */
    isSpeaking() {
      return speaking;
    },

    /**
     * Returns the last spoken clean text.
     * @returns {string}
     */
    getLastSpokenText() {
      return lastSpokenText;
    },

    /**
     * Returns the last recorded speech error, if any.
     * @returns {string|null}
     */
    getSpeechError() {
      return speechError;
    }
  };
}

// Export singleton instance for sidepanel usage
export const ttsController = createTTSController();
