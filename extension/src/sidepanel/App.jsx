import React, { useState, useEffect, useRef } from 'react';
import Header from './components/Header.jsx';
import PageContext from './components/PageContext.jsx';
import EmptyState from './components/EmptyState.jsx';
import VoiceButton from './components/VoiceButton.jsx';
import CommandInput from './components/CommandInput.jsx';
import AIStatusPill from './components/AIStatusPill.jsx';
import TaskProgress from './components/TaskProgress.jsx';
import ActionTimeline from './components/ActionTimeline.jsx';
import ApprovalModal from './components/ApprovalModal.jsx';
import HumanTakeover from './components/HumanTakeover.jsx';
import TaskCompleted from './components/TaskCompleted.jsx';
import Metrics from './components/Metrics.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import DevStateSwitcher from './components/DevStateSwitcher.jsx';
import ConversationView from './components/ConversationView.jsx';
import {
  createSpeechRecognizer,
  isSpeechRecognitionSupported,
  requestMicrophonePermission
} from './utils/speechRecognition.js';
import { ttsController, isSpeechSynthesisSupported } from './utils/tts.js';
import { agentController } from '../agent/agentController.js';
import { TaskStatus } from '../agent/taskState.js';
import { aiClient } from '../agent/aiClient.js';
import { RESTRICTED_PAGE_MESSAGE, openWebsiteAndObserve } from './utils/chromeMessaging.js';

export default function App() {
  // Primary frontend task state machine: IDLE | EXECUTING | WAITING_FOR_APPROVAL | NEEDS_CLARIFICATION | COMPLETED | ERROR
  const [appState, setAppState] = useState('IDLE');
  
  // Independent Voice Session State Machine: STOPPED | LISTENING | PROCESSING | SPEAKING
  const [voiceSessionState, setVoiceSessionState] = useState('STOPPED');
  const [messages, setMessages] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [ttsError, setTtsError] = useState('');
  
  // Active task details
  const [taskTitle, setTaskTitle] = useState('Scroll down');
  const [taskProgress, setTaskProgress] = useState(15);
  const [aiStatus, setAiStatus] = useState('Observing webpage...');
  const [taskActions, setTaskActions] = useState([]);
  const [taskDuration, setTaskDuration] = useState('0.0s');
  const [taskResult, setTaskResult] = useState(null);
  const [taskError, setTaskError] = useState('');
  const [clarificationQuestion, setClarificationQuestion] = useState('');
  const [fallbackInfo, setFallbackInfo] = useState(null);
  const [approvalInfo, setApprovalInfo] = useState(null);

  // AI Telemetry & Reasoning state
  const [plannerMode, setPlannerMode] = useState('Deterministic');
  const [tokensUsed, setTokensUsed] = useState({ prompt: 0, completion: 0, total: 0, thinking: undefined, usageAvailable: true });
  const [taskMetrics, setTaskMetrics] = useState(null);
  const [aiCallsCount, setAiCallsCount] = useState(0);
  const [queuedVoiceCommand, setQueuedVoiceCommand] = useState('');
  const [isCurrentPageRestricted, setIsCurrentPageRestricted] = useState(false);
  const [restrictedUrl, setRestrictedUrl] = useState('');
  
  // Command & Speech Recognition state
  const [commandText, setCommandText] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [handsFree, setHandsFree] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [currentUtterance, setCurrentUtterance] = useState('');
  const [isVoiceProcessing, setIsVoiceProcessing] = useState(false);
  const [voiceError, setVoiceError] = useState('');
  
  // Settings modal & user options
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({
    voiceResponses: true,
    autoApproveLowRisk: true,
    showTimeline: true,
    soundEffects: true,
    darkMode: false,
    language: 'en-IN',
    silenceThreshold: 2.5,
    plannerMode: 'hybrid',
    backendUrl: 'http://localhost:3001'
  });

  // Automated demo timer reference
  const demoTimerRef = useRef(null);

  // Speech Recognizer instance reference
  const speechRecognizerRef = useRef(null);

  // Apply dark/light theme to root element
  useEffect(() => {
    if (settings.darkMode) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }, [settings.darkMode]);

  // Synchronize backendUrl into aiClient
  useEffect(() => {
    if (settings.backendUrl) {
      aiClient.setBackendUrl(settings.backendUrl);
    }
  }, [settings.backendUrl]);

  // Synchronize settings changes into speech recognizer instance
  useEffect(() => {
    if (speechRecognizerRef.current) {
      speechRecognizerRef.current.setSilenceDuration((settings.silenceThreshold || 2.5) * 1000);
      speechRecognizerRef.current.setLanguage(settings.language || 'en-IN');
    }
  }, [settings.silenceThreshold, settings.language]);

  // Cleanup speech recognition, agent controller, TTS, and demo timers on unmount
  useEffect(() => {
    return () => {
      agentController.stopTask();
      ttsController.stop();
      if (speechRecognizerRef.current) {
        speechRecognizerRef.current.abort();
      }
      if (demoTimerRef.current) {
        clearTimeout(demoTimerRef.current);
      }
    };
  }, []);

  const updateSetting = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Speaks assistant response aloud via Web Speech API (TTS)
   * while guarding against feedback loops.
   */
  const handleSpeakText = (text, onFinished) => {
    if (!settings.voiceResponses) {
      if (onFinished) onFinished();
      return;
    }

    if (!isSpeechSynthesisSupported()) {
      setVoiceError('Speech synthesis is not supported in this browser.');
      if (handsFree) {
        setVoiceSessionState('LISTENING');
      } else {
        setVoiceSessionState('STOPPED');
      }
      if (onFinished) onFinished();
      return;
    }

    setVoiceSessionState('SPEAKING');
    speechRecognizerRef.current?.setTemporarilyMuted(true);

    const initiated = ttsController.speak(text, {
      lang: settings.language || 'en-US',
      onStart: () => {
        setVoiceSessionState('SPEAKING');
      },
      onEnd: () => {
        speechRecognizerRef.current?.setTemporarilyMuted(false);
        if (handsFree) {
          setVoiceSessionState('LISTENING');
        } else {
          setVoiceSessionState('STOPPED');
        }
        if (onFinished) onFinished();
      },
      onError: (err) => {
        setTtsError(err);
        speechRecognizerRef.current?.setTemporarilyMuted(false);
        if (handsFree) {
          setVoiceSessionState('LISTENING');
        } else {
          setVoiceSessionState('STOPPED');
        }
        if (onFinished) onFinished();
      }
    });

    if (!initiated) {
      speechRecognizerRef.current?.setTemporarilyMuted(false);
      if (handsFree) {
        setVoiceSessionState('LISTENING');
      } else {
        setVoiceSessionState('STOPPED');
      }
      if (onFinished) onFinished();
    }
  };

  /**
   * Stops ongoing assistant speech playback.
   */
  const handleStopSpeaking = () => {
    ttsController.stop();
    speechRecognizerRef.current?.setTemporarilyMuted(false);
    if (handsFree) {
      setVoiceSessionState('LISTENING');
    } else {
      setVoiceSessionState('STOPPED');
    }
  };

  /**
   * Toggles speech audio mute state.
   */
  const handleToggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    ttsController.setMuted(nextMuted);
  };

  /**
   * Replays spoken message from chat bubble.
   */
  const handleReplaySpeech = (text) => {
    handleSpeakText(text);
  };

  /**
   * Intentionally stops the entire voice session.
   */
  const handleStopVoiceSession = () => {
    if (speechRecognizerRef.current) {
      speechRecognizerRef.current.stop();
    }
    ttsController.stop();
    speechRecognizerRef.current?.setTemporarilyMuted(false);
    setIsListening(false);
    setHandsFree(false);
    setVoiceSessionState('STOPPED');
    setInterimTranscript('');
    setCurrentUtterance('');
    setIsVoiceProcessing(false);
    if (appState === 'LISTENING') setAppState('IDLE');
  };

  /**
   * Real Hands-Free Speech Recognition Toggle Handler
   * Starts or stops continuous microphone speech-to-text.
   */
  const handleToggleVoice = async () => {
    setVoiceError('');

    // If currently listening, stop recognition immediately
    if (isListening || voiceSessionState !== 'STOPPED') {
      handleStopVoiceSession();
      return;
    }

    // 1. Feature detection: check if Web Speech API is supported
    if (!isSpeechRecognitionSupported()) {
      setVoiceError('Speech recognition is not supported in this browser.');
      return;
    }

    // 2. Request / verify microphone permission
    const perm = await requestMicrophonePermission();
    if (!perm.granted) {
      setVoiceError(perm.error || 'Microphone permission denied.');
      return;
    }

    // 3. Prepare recognizer instance
    if (!speechRecognizerRef.current) {
      speechRecognizerRef.current = createSpeechRecognizer({
        silenceDurationMs: (settings.silenceThreshold || 2.5) * 1000,
        lang: settings.language || 'en-IN'
      });
    }

    // 4. Update UI to listening state
    setHandsFree(true);
    setIsListening(true);
    setVoiceSessionState('LISTENING');
    setInterimTranscript('');
    setCurrentUtterance('');
    setIsVoiceProcessing(false);
    if (appState === 'IDLE') setAppState('LISTENING');

    // 5. Start hands-free speech recognition session
    speechRecognizerRef.current.start({
      lang: settings.language || 'en-IN',
      silenceDurationMs: (settings.silenceThreshold || 2.5) * 1000,
      onStart: () => {
        setIsListening(true);
        setVoiceSessionState('LISTENING');
        setVoiceError('');
      },
      onInterimResult: (partialText, fullText) => {
        setInterimTranscript(partialText);
        setCurrentUtterance(fullText);
        setCommandText(fullText);
      },
      onFinalResult: (finalText, fullText) => {
        setCurrentUtterance(fullText);
        setCommandText(fullText);
      },
      onUtteranceFinalized: async (finalUtterance) => {
        const trimmed = String(finalUtterance || '').trim();
        if (!trimmed) return;

        // Step 1: Put the complete transcript into the existing command input
        setCommandText(trimmed);
        setCurrentUtterance(trimmed);
        setInterimTranscript('');
        setIsVoiceProcessing(true);
        setVoiceSessionState('PROCESSING');

        // Step 2: Clear utterance in recognizer so next speech segment starts fresh
        if (speechRecognizerRef.current) {
          speechRecognizerRef.current.clearUtterance();
        }

        // Step 3: Auto-submit to agentController (seamless two-way conversation)
        setTimeout(async () => {
          setIsVoiceProcessing(false);
          await handleStartTask(trimmed);
        }, 200);
      },
      onUtteranceCancelled: () => {
        setCurrentUtterance('');
        setInterimTranscript('');
        setCommandText('');
        setIsVoiceProcessing(false);
      },
      onError: (errMessage, isFatal) => {
        if (errMessage !== 'Listening cancelled.') {
          setVoiceError(errMessage);
        }
        if (isFatal) {
          setIsListening(false);
          setHandsFree(false);
          setVoiceSessionState('STOPPED');
          if (appState === 'LISTENING') setAppState('IDLE');
          setCurrentUtterance('');
          setInterimTranscript('');
        }
      },
      onEnd: ({ intentional } = {}) => {
        if (intentional) {
          setIsListening(false);
          setHandsFree(false);
          setVoiceSessionState('STOPPED');
          if (appState === 'LISTENING') setAppState('IDLE');
          setCurrentUtterance('');
          setInterimTranscript('');
        }
      },
      onRestart: () => {
        // Recognition session safely resumed
      }
    });
  };

  /**
   * Cancels the current unsubmitted utterance without stopping listening.
   */
  const handleCancelUtterance = () => {
    if (speechRecognizerRef.current) {
      speechRecognizerRef.current.cancelCurrentUtterance();
    }
    setCurrentUtterance('');
    setInterimTranscript('');
    setCommandText('');
    setIsVoiceProcessing(false);
  };

  /**
   * Primary Task Execution Entry Point
   * Receives task from typed command, suggestion chip, or hands-free voice auto-submission.
   * Dispatches task to hybrid agent controller loop.
   */
  const handleStartTask = async (query) => {
    const trimmedQuery = String(query || '').trim();
    if (!trimmedQuery) return;

    // Guard: Prevent running observer, executor, or AI planner against restricted pages
    if (isCurrentPageRestricted) {
      const restMsg = RESTRICTED_PAGE_MESSAGE;
      setTaskError(restMsg);
      setAppState('ERROR');
      handleSpeakText(restMsg);
      return;
    }

    // Append user message into conversation history
    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      text: trimmedQuery,
      time: new Date().toLocaleTimeString()
    };
    const updatedHistory = [...messages, userMsg];
    setMessages(updatedHistory);

    // If hands-free is NOT active, stop the one-shot voice input
    if (!handsFree && isListening && speechRecognizerRef.current) {
      speechRecognizerRef.current.stop();
      setIsListening(false);
      setVoiceSessionState('STOPPED');
    } else if (handsFree) {
      setVoiceSessionState('PROCESSING');
    }

    setTaskTitle(trimmedQuery);
    setTaskError('');
    setTaskActions([]);
    setTaskResult(null);
    setApprovalInfo(null);
    setTaskDuration('0.0s');
    setClarificationQuestion('');
    setPlannerMode(settings.plannerMode === 'deterministic' ? 'Deterministic' : 'AI Hybrid');
    setTokensUsed({ prompt: 0, completion: 0, total: 0, thinking: undefined, usageAvailable: true });
    setTaskMetrics(null);
    setFallbackInfo(null);
    setQueuedVoiceCommand('');
    setAiCallsCount(0);
    setTaskProgress(15);
    setAppState('EXECUTING');
    setAiStatus('Understanding task & observing page...');

    // Clear the input only after the transcript has been safely accepted
    setCommandText('');
    setCurrentUtterance('');
    setInterimTranscript('');

    try {
      await agentController.startTask(trimmedQuery, {
        plannerMode: settings.plannerMode || 'hybrid',
        enableAI: settings.plannerMode !== 'deterministic',
        conversationHistory: updatedHistory,
        onUpdate: (snapshot) => {
          setTaskProgress(snapshot.progress);
          setTaskActions(snapshot.actions || []);
          setTaskDuration(snapshot.duration || '0.0s');
          if (snapshot.plannerMode) setPlannerMode(snapshot.plannerMode);
          if (snapshot.tokensUsed) setTokensUsed(snapshot.tokensUsed);
          if (snapshot.taskMetrics) setTaskMetrics(snapshot.taskMetrics);
          if (snapshot.fallbackInfo) setFallbackInfo(snapshot.fallbackInfo);
          if (typeof snapshot.aiCallsCount === 'number') setAiCallsCount(snapshot.aiCallsCount);
          if (snapshot.clarificationQuestion) setClarificationQuestion(snapshot.clarificationQuestion);

          switch (snapshot.status) {
            case TaskStatus.UNDERSTANDING:
              setAiStatus(snapshot.statusMessage || 'Understanding task...');
              setAppState('EXECUTING');
              break;
            case TaskStatus.OBSERVING:
              setAiStatus(snapshot.statusMessage || 'Observing webpage elements...');
              setAppState('EXECUTING');
              break;
            case TaskStatus.PLANNING:
              setAiStatus(snapshot.statusMessage || 'Planning next action (Deterministic)...');
              setAppState('EXECUTING');
              break;
            case TaskStatus.AI_PLANNING:
              setAiStatus(snapshot.statusMessage || 'AI analyzing goal and page elements...');
              setAppState('EXECUTING');
              break;
            case TaskStatus.EXECUTING:
              setAiStatus(snapshot.statusMessage || 'Executing browser action...');
              setAppState('EXECUTING');
              break;
            case TaskStatus.VERIFYING:
              setAiStatus(snapshot.statusMessage || 'Verifying action outcome...');
              setAppState('EXECUTING');
              break;
            case TaskStatus.WAITING_FOR_APPROVAL: {
              setAiStatus('Awaiting user confirmation');
              setAppState('WAITING_FOR_APPROVAL');

              const activeUrl = agentController.activeTabInfo?.url || restrictedUrl || 'Active page';
              let hostname = 'Active page';
              try {
                if (activeUrl && activeUrl.startsWith('http')) {
                  hostname = new URL(activeUrl).hostname;
                } else if (activeUrl) {
                  hostname = activeUrl;
                }
              } catch {}

              const pendingAction = agentController.pendingApprovalAction || agentController.activeXWorkflow?.pendingApprovalAction;
              const actionLabel = pendingAction?.targetText || pendingAction?.action || trimmedQuery;
              const isXAction = Boolean(agentController.activeXWorkflow || pendingAction?.platform === 'x.com');
              const details = isXAction && pendingAction?.draftText ? [
                { label: 'Platform', value: 'X (formerly Twitter)' },
                { label: 'Post Content', value: pendingAction.draftText },
                { label: 'Safety Policy', value: pendingAction.step === 'publish_confirmation' ? 'Final confirmation required immediately before publishing' : 'Consequential post action requires approval' }
              ] : [
                { label: 'Website', value: hostname },
                { label: 'Action', value: actionLabel },
                { label: 'Safety Policy', value: 'Consequential action requires explicit confirmation' }
              ];

              setApprovalInfo({
                website: isXAction ? 'x.com' : hostname,
                actionTitle: isXAction ? (pendingAction?.step === 'publish_confirmation' ? 'Publish to X' : 'Create Post on X') : actionLabel,
                details
              });

              const spokenPrompt = isXAction && pendingAction?.draftText
                ? `Please confirm: ready to post "${pendingAction.draftText}" to X.`
                : 'This sensitive action requires your confirmation.';
              handleSpeakText(spokenPrompt);
              break;
            }
            case TaskStatus.NEEDS_CLARIFICATION: {
              setAiStatus('Needs clarification');
              const q = snapshot.clarificationQuestion || 'Please clarify your instruction.';
              setClarificationQuestion(q);
              setAppState('NEEDS_CLARIFICATION');
              handleSpeakText(q);
              break;
            }
            case TaskStatus.COMPLETED:
            case TaskStatus.COMPLETED_WAITING_FOR_ACKNOWLEDGEMENT: {
              setAiStatus('Task completed');
              setTaskResult(snapshot.result);
              setAppState('COMPLETED');

              const spoken = snapshot.result?.spokenText ||
                (snapshot.result?.answer ? snapshot.result.answer.slice(0, 150) : '') ||
                (snapshot.result?.title ? `${snapshot.result.title}.` : `Finished checking ${trimmedQuery}.`);

              const displayText = snapshot.result?.answer ||
                snapshot.result?.spokenText ||
                (snapshot.result?.title ? `${snapshot.result.title}. ${snapshot.result.meta || ''}` : `Completed ${trimmedQuery}`);

              setMessages((prev) => {
                const alreadyExists = prev.some((m) => m.taskId === snapshot.taskId && m.role === 'assistant');
                if (alreadyExists) return prev;
                return [
                  ...prev,
                  {
                    id: `asst-${snapshot.taskId || Date.now()}`,
                    role: 'assistant',
                    text: displayText,
                    spokenText: spoken,
                    title: snapshot.result?.title,
                    meta: snapshot.result?.meta,
                    sources: snapshot.result?.sources || [],
                    time: new Date().toLocaleTimeString(),
                    taskId: snapshot.taskId,
                    result: snapshot.result
                  }
                ];
              });

              handleSpeakText(spoken);
              break;
            }
            case TaskStatus.ERROR: {
              setAiStatus('Execution error');
              const errExplanation = snapshot.error || 'Task execution failed.';
              setTaskError(errExplanation);
              setAppState('ERROR');

              setMessages((prev) => {
                const alreadyExists = prev.some((m) => m.taskId === snapshot.taskId && m.role === 'assistant');
                if (alreadyExists) return prev;
                return [
                  ...prev,
                  {
                    id: `asst-err-${snapshot.taskId || Date.now()}`,
                    role: 'assistant',
                    text: errExplanation,
                    time: new Date().toLocaleTimeString(),
                    taskId: snapshot.taskId,
                    isError: true
                  }
                ];
              });

              handleSpeakText(errExplanation);
              break;
            }
            case TaskStatus.STOPPED:
              setAiStatus('Task stopped');
              setAppState('IDLE');
              break;
            default:
              break;
          }
        }
      });
    } catch (err) {
      setCommandText(trimmedQuery);
      const caughtErr = err.message || 'Task execution failed.';
      setTaskError(caughtErr);
      setAppState('ERROR');
      handleSpeakText(caughtErr);
    }
  };

  /**
   * Explicit user acknowledgement of completed task via "OK, Done".
   * Dismisses the completed card and restores IDLE ready state.
   * If a hands-free utterance was queued while reviewing, prepares it.
   */
  const handleAcknowledgeDone = () => {
    setAppState('IDLE');
    setAiStatus('Ready');
    // Clear completed task results and reset metrics so the next task starts fresh without stale metrics
    setTaskResult(null);
    setTaskActions([]);
    setTaskDuration('0.0s');
    setAiCallsCount(0);
    setTokensUsed({ prompt: 0, completion: 0, total: 0, thinking: undefined, usageAvailable: true });
    setTaskMetrics(null);

    if (queuedVoiceCommand) {
      const nextCmd = queuedVoiceCommand;
      setQueuedVoiceCommand('');
      setCommandText(nextCmd);
      setCurrentUtterance(nextCmd);
    }
  };

  /**
   * Automatically refreshes and synchronizes restricted/accessible page context.
   */
  const handlePageChange = (ctx) => {
    const isRestricted = Boolean(ctx?.isRestricted);
    setIsCurrentPageRestricted(isRestricted);
    setRestrictedUrl(ctx?.url || '');
    if (!isRestricted && appState === 'ERROR' && (taskError.includes('restricts extensions') || taskError.includes('restricted browser pages') || taskError.includes('restricted'))) {
      setTaskError('');
      setAppState('IDLE');
    }
    // Automatically notify agentController of tab/navigation changes (resumes pending X.com workflows)
    if (ctx && ctx.url) {
      agentController.handleTabUpdate(ctx);
    }
  };

  const handleStopTask = () => {
    agentController.stopTask();
    setAppState('IDLE');
    setCurrentUtterance('');
    setAiStatus('Task stopped');
  };

  // Approval handlers
  const handleApproveAction = async () => {
    setAppState('EXECUTING');
    setAiStatus('Processing approved action...');
    try {
      const snap = await agentController.approvePendingAction();
      if (snap) {
        if (snap.status === TaskStatus.COMPLETED) {
          setAppState('COMPLETED');
          setTaskResult(snap.result);
          setAiStatus('Task completed');
        } else if (snap.status === TaskStatus.WAITING_FOR_APPROVAL) {
          setAppState('WAITING_FOR_APPROVAL');
          setAiStatus('Awaiting final confirmation');
        } else if (snap.status === TaskStatus.ERROR) {
          setAppState('ERROR');
          setTaskError(snap.error || 'Failed to execute approved action');
        } else if (snap.status === TaskStatus.STOPPED) {
          setAppState('IDLE');
          setAiStatus('Task stopped');
        }
      }
    } catch (err) {
      setAppState('ERROR');
      setTaskError(`Approval error: ${err.message}`);
    }
  };

  const handleCancelApproval = () => {
    agentController.cancelPendingAction();
    setAppState('IDLE');
    setAiStatus('Action cancelled');
  };

  // Auto-play demo flow for hackathon presentation / evaluation
  const handleRunDemoFlow = () => {
    if (isListening && speechRecognizerRef.current) {
      speechRecognizerRef.current.stop();
      setIsListening(false);
      setHandsFree(false);
    }
    if (demoTimerRef.current) clearTimeout(demoTimerRef.current);
    
    setAppState('LISTENING');
    setCurrentUtterance('Searching for best rated laptop under ₹50,000 with 16GB RAM');

    demoTimerRef.current = setTimeout(() => {
      setAppState('THINKING');
      setAiStatus('Analyzing DOM elements & Amazon search bar');

      demoTimerRef.current = setTimeout(() => {
        setAppState('EXECUTING');
        setTaskProgress(50);
        setAiStatus('Comparing search results');

        demoTimerRef.current = setTimeout(() => {
          setAppState('WAITING_FOR_APPROVAL');

          demoTimerRef.current = setTimeout(() => {
            setAppState('COMPLETED');
            setAiStatus('Task completed successfully');
          }, 3500);
        }, 2500);
      }, 1800);
    }, 2000);
  };

  return (
    <div className="app-container">
      {/* Dev State Switcher bar for rapid UI inspection */}
      <DevStateSwitcher
        currentState={appState}
        onSelectState={(state) => {
          if (isListening && speechRecognizerRef.current) {
            speechRecognizerRef.current.stop();
            setIsListening(false);
            setHandsFree(false);
          }
          agentController.stopTask();
          if (demoTimerRef.current) clearTimeout(demoTimerRef.current);
          setAppState(state);
          if (state === 'LISTENING') setCurrentUtterance('Looking for best laptop under ₹50,000...');
          if (state === 'THINKING') setAiStatus('Planning next action (Deterministic)');
          if (state === 'EXECUTING') setAiStatus('Executing browser actions');
          if (state === 'COMPLETED') setAiStatus('Task completed');
        }}
        onRunDemoFlow={handleRunDemoFlow}
      />

      {/* Main Header */}
      <Header
        onOpenSettings={() => setIsSettingsOpen(true)}
        isConnected={appState !== 'ERROR'}
      />

      {/* Browser Page Context */}
      <PageContext onPageChange={handlePageChange} />

      {/* Main Dynamic Workspace */}
      <main className="main-content">
        {/* Two-Way Conversational Voice View */}
        {(messages.length > 0 || voiceSessionState !== 'STOPPED') && (
          <ConversationView
            voiceState={voiceSessionState}
            messages={messages}
            currentUtterance={currentUtterance}
            interimTranscript={interimTranscript}
            isMuted={isMuted}
            onToggleMute={handleToggleMute}
            onStopSpeaking={handleStopSpeaking}
            onToggleVoice={handleToggleVoice}
            onReplaySpeech={handleReplaySpeech}
            onClearHistory={() => setMessages([])}
          />
        )}

        {/* State 1: IDLE (When conversation is empty and voice session stopped) */}
        {appState === 'IDLE' && messages.length === 0 && voiceSessionState === 'STOPPED' && (
          <>
            <EmptyState onSelectSuggestion={handleStartTask} />
            <VoiceButton
              isListening={isListening}
              onToggleVoice={handleToggleVoice}
              onCancelUtterance={handleCancelUtterance}
              transcription={currentUtterance || interimTranscript}
              isProcessing={isVoiceProcessing}
              error={voiceError}
            />
          </>
        )}

        {/* State 3: THINKING */}
        {appState === 'THINKING' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
            <AIStatusPill status={aiStatus} label="Deterministic Planner" />
            <div className="task-progress-card">
              <div className="task-card-header">
                <span className="task-tag">Analyzing</span>
              </div>
              <div className="task-goal">{taskTitle}</div>
              <div className="progress-track">
                <div className="progress-fill" style={{ width: '20%' }}></div>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}>
              <div className="pulse-dot" style={{ width: 12, height: 12 }}></div>
            </div>
          </div>
        )}

        {/* State 4: EXECUTING (Live Agent Execution) */}
        {appState === 'EXECUTING' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <AIStatusPill status={aiStatus} label={plannerMode.startsWith('AI') ? 'AI Planning Layer' : 'Deterministic Planner'} />
            <TaskProgress
              taskTitle={taskTitle}
              progress={taskProgress}
              onStopTask={handleStopTask}
            />
            {settings.showTimeline && <ActionTimeline actions={taskActions.length > 0 ? taskActions : undefined} />}
            <Metrics
              time={taskDuration}
              actions={String(taskActions.length)}
              mode={plannerMode}
              status={aiStatus}
              tokens={tokensUsed}
              aiCalls={aiCallsCount}
              taskMetrics={taskMetrics}
              fallbackInfo={fallbackInfo}
            />
          </div>
        )}

        {/* State 5: WAITING_FOR_APPROVAL */}
        {appState === 'WAITING_FOR_APPROVAL' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <AIStatusPill status="Awaiting user confirmation" label="Safety Check" />
            <TaskProgress
              taskTitle={taskTitle}
              progress={80}
              onStopTask={handleStopTask}
            />
            {settings.showTimeline && <ActionTimeline actions={taskActions} />}
            <ApprovalModal
              isOpen={true}
              onApprove={handleApproveAction}
              onCancel={handleCancelApproval}
              website={approvalInfo?.website || 'Active page'}
              actionTitle={approvalInfo?.actionTitle || 'Action requires approval'}
              details={approvalInfo?.details || []}
            />
          </div>
        )}

        {/* State 6: HUMAN_TAKEOVER */}
        {appState === 'HUMAN_TAKEOVER' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <AIStatusPill status="Paused for manual input" label="Human Takeover" />
            <HumanTakeover
              onResumeAgent={() => {
                setAppState('EXECUTING');
                setAiStatus('Resuming automated browsing');
              }}
            />
            <TaskProgress
              taskTitle={taskTitle}
              progress={55}
              onStopTask={handleStopTask}
            />
            {settings.showTimeline && <ActionTimeline actions={taskActions} />}
          </div>
        )}

        {/* State 6.5: NEEDS_CLARIFICATION */}
        {appState === 'NEEDS_CLARIFICATION' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
            <AIStatusPill status="Clarification required" label={plannerMode.startsWith('AI') ? 'AI Planning Layer' : 'Deterministic Planner'} />
            <div className="completed-card" style={{ borderColor: 'var(--accent-primary)' }}>
              <div
                className="completed-check-icon"
                style={{ background: 'var(--accent-glow)', color: 'var(--accent-primary)', fontSize: '18px' }}
              >
                ?
              </div>
              <h2 className="completed-title">Clarification Needed</h2>
              <p className="completed-desc">
                {clarificationQuestion || 'The agent needs more details to safely proceed with this task.'}
              </p>
              <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setAppState('IDLE')}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    setCommandText('');
                    setAppState('IDLE');
                  }}
                >
                  Provide Info
                </button>
              </div>
            </div>
            {settings.showTimeline && taskActions.length > 0 && (
              <ActionTimeline actions={taskActions} />
            )}
          </div>
        )}

        {/* State 7: COMPLETED (Verified Result) */}
        {appState === 'COMPLETED' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <AIStatusPill status="Task completed" label={plannerMode.startsWith('AI') ? 'AI Planning Layer' : 'Deterministic Planner'} />
            <TaskCompleted
              onDone={handleAcknowledgeDone}
              onNewTask={handleAcknowledgeDone}
              title="Task completed"
              description={`Successfully executed and verified: "${taskTitle}"`}
              resultSummary={taskResult}
              duration={taskDuration}
              actionCount={taskActions.length}
              actions={taskActions}
              plannerMode={plannerMode}
              tokens={tokensUsed}
              aiCalls={aiCallsCount}
              taskMetrics={taskMetrics}
              fallbackInfo={fallbackInfo}
              queuedUtterance={queuedVoiceCommand}
              onClearQueued={() => setQueuedVoiceCommand('')}
            />
            {settings.showTimeline && taskActions.length > 0 && (
              <ActionTimeline actions={taskActions} />
            )}
          </div>
        )}

        {/* State 8: ERROR (Action Failure or Unsupported Command) */}
        {appState === 'ERROR' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 10 }}>
            <AIStatusPill status="Execution error" label="Deterministic Planner" />
            <div className="completed-card" style={{ borderColor: 'var(--status-error)' }}>
              <div
                className="completed-check-icon"
                style={{ background: 'var(--status-error-bg)', color: 'var(--status-error)' }}
              >
                ✕
              </div>
              <h2 className="completed-title">Execution stopped</h2>
              <p className="completed-desc">
                {taskError || 'The command could not be completed.'}
              </p>
              <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 8 }}>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ flex: 1 }}
                  onClick={() => setAppState('IDLE')}
                >
                  Dismiss
                </button>
                {(isCurrentPageRestricted || taskError.includes('restricts extensions') || taskError.includes('restricted')) ? (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ flex: 1 }}
                    onClick={async () => {
                      setAppState('IDLE');
                      setTaskError('');
                      await openWebsiteAndObserve('https://www.wikipedia.org');
                    }}
                  >
                    Open a Website
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    style={{ flex: 1 }}
                    onClick={() => handleStartTask(taskTitle)}
                  >
                    Retry Task
                  </button>
                )}
              </div>
            </div>
            {settings.showTimeline && taskActions.length > 0 && (
              <ActionTimeline actions={taskActions} />
            )}
          </div>
        )}
      </main>

      {/* Bottom Command Bar with controlled text, hands-free voice indicator, and deterministic submission */}
      <CommandInput
        value={commandText}
        onChange={setCommandText}
        onSubmitCommand={handleStartTask}
        onToggleVoice={handleToggleVoice}
        onCancelUtterance={handleCancelUtterance}
        isListening={isListening || voiceSessionState !== 'STOPPED'}
        handsFree={handsFree}
        transcriptionPreview={currentUtterance || interimTranscript}
        isProcessing={isVoiceProcessing || voiceSessionState === 'PROCESSING'}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdateSetting={updateSetting}
      />
    </div>
  );
}
