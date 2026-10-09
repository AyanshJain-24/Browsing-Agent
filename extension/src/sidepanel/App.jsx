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
import {
  createSpeechRecognizer,
  isSpeechRecognitionSupported,
  requestMicrophonePermission
} from './utils/speechRecognition.js';
import { agentController } from '../agent/agentController.js';
import { TaskStatus } from '../agent/taskState.js';
import { aiClient } from '../agent/aiClient.js';

export default function App() {
  // Primary frontend state machine
  const [appState, setAppState] = useState('IDLE');
  
  // Active task details
  const [taskTitle, setTaskTitle] = useState('Scroll down');
  const [taskProgress, setTaskProgress] = useState(15);
  const [aiStatus, setAiStatus] = useState('Observing webpage...');
  const [taskActions, setTaskActions] = useState([]);
  const [taskDuration, setTaskDuration] = useState('0.0s');
  const [taskResult, setTaskResult] = useState(null);
  const [taskError, setTaskError] = useState('');
  const [clarificationQuestion, setClarificationQuestion] = useState('');

  // AI Telemetry & Reasoning state
  const [plannerMode, setPlannerMode] = useState('Deterministic');
  const [tokensUsed, setTokensUsed] = useState({ prompt: 0, completion: 0, total: 0 });
  const [aiCallsCount, setAiCallsCount] = useState(0);
  
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

  // Cleanup speech recognition, agent controller, and demo timers on unmount
  useEffect(() => {
    return () => {
      agentController.stopTask();
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
   * Real Hands-Free Speech Recognition Toggle Handler
   * Starts or stops continuous microphone speech-to-text.
   * In hands-free mode, spoken instructions automatically execute
   * after the silence threshold without clicking Send.
   */
  const handleToggleVoice = async () => {
    setVoiceError('');

    // If currently listening, stop recognition immediately
    if (isListening) {
      if (speechRecognizerRef.current) {
        speechRecognizerRef.current.stop();
      }
      setIsListening(false);
      setHandsFree(false);
      setInterimTranscript('');
      setCurrentUtterance('');
      setIsVoiceProcessing(false);
      if (appState === 'LISTENING') setAppState('IDLE');
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
        // Step 1: Put the complete transcript into the existing command input
        setCommandText(finalUtterance);
        setCurrentUtterance(finalUtterance);
        setInterimTranscript('');
        setIsVoiceProcessing(true);

        // Step 2: Clear utterance in recognizer so next speech segment starts fresh
        if (speechRecognizerRef.current) {
          speechRecognizerRef.current.clearUtterance();
        }

        // Step 3: Short Processing indicator, then auto-submit to agentController
        setTimeout(async () => {
          setIsVoiceProcessing(false);
          await handleStartTask(finalUtterance);
        }, 300);
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
          if (appState === 'LISTENING') setAppState('IDLE');
          setCurrentUtterance('');
          setInterimTranscript('');
        }
      },
      onEnd: ({ intentional } = {}) => {
        if (intentional) {
          setIsListening(false);
          setHandsFree(false);
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

    // If hands-free is NOT active, stop the one-shot voice input
    if (!handsFree && isListening && speechRecognizerRef.current) {
      speechRecognizerRef.current.stop();
      setIsListening(false);
    }

    setTaskTitle(trimmedQuery);
    setTaskError('');
    setTaskActions([]);
    setTaskResult(null);
    setTaskDuration('0.0s');
    setClarificationQuestion('');
    setPlannerMode(settings.plannerMode === 'deterministic' ? 'Deterministic' : 'AI Hybrid');
    setTokensUsed({ prompt: 0, completion: 0, total: 0 });
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
        onUpdate: (snapshot) => {
          setTaskProgress(snapshot.progress);
          setTaskActions(snapshot.actions || []);
          setTaskDuration(snapshot.duration || '0.0s');
          if (snapshot.plannerMode) setPlannerMode(snapshot.plannerMode);
          if (snapshot.tokensUsed) setTokensUsed(snapshot.tokensUsed);
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
            case TaskStatus.WAITING_FOR_APPROVAL:
              setAiStatus('Awaiting user confirmation');
              setAppState('WAITING_FOR_APPROVAL');
              break;
            case TaskStatus.NEEDS_CLARIFICATION:
              setAiStatus('Needs clarification');
              setClarificationQuestion(snapshot.clarificationQuestion || 'Please clarify your instruction.');
              setAppState('NEEDS_CLARIFICATION');
              break;
            case TaskStatus.COMPLETED:
              setAiStatus('Task completed');
              setTaskResult(snapshot.result);
              setAppState('COMPLETED');
              break;
            case TaskStatus.ERROR:
              setAiStatus('Execution error');
              setTaskError(snapshot.error || 'Task execution failed.');
              setAppState('ERROR');
              break;
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
      // If task submission fails, preserve query in command input for user review/edit
      setCommandText(trimmedQuery);
      setTaskError(err.message || 'Task execution failed.');
      setAppState('ERROR');
    }
  };

  const handleStopTask = () => {
    agentController.stopTask();
    setAppState('IDLE');
    setCurrentUtterance('');
    setAiStatus('Task stopped');
  };

  // Approval handlers
  const handleApproveAction = () => {
    setAppState('EXECUTING');
    setTaskProgress(85);
    setAiStatus('Finalizing transaction steps');
    setTimeout(() => {
      setAppState('COMPLETED');
      setAiStatus('Task completed');
    }, 1500);
  };

  const handleCancelApproval = () => {
    setAppState('IDLE');
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
      <PageContext />

      {/* Main Dynamic Workspace */}
      <main className="main-content">
        {/* State 1: IDLE */}
        {appState === 'IDLE' && (
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

        {/* State 2: LISTENING */}
        {appState === 'LISTENING' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginTop: 30 }}>
            <AIStatusPill
              status={isVoiceProcessing ? 'Submitting instruction...' : 'Hands-Free: Speak a command...'}
              label="Voice Input"
            />
            <div style={{ marginTop: 24 }}>
              <VoiceButton
                isListening={true}
                onToggleVoice={handleToggleVoice}
                onCancelUtterance={handleCancelUtterance}
                transcription={currentUtterance || interimTranscript || 'Listening for your command...'}
                isProcessing={isVoiceProcessing}
                error={voiceError}
              />
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 20 }}>
              Auto-submits after pause • Speak your next instruction anytime
            </p>
          </div>
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
            {settings.showTimeline && <ActionTimeline />}
            <ApprovalModal
              isOpen={true}
              onApprove={handleApproveAction}
              onCancel={handleCancelApproval}
              website="active page"
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
            {settings.showTimeline && <ActionTimeline />}
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
              onNewTask={() => {
                setAppState('IDLE');
                setCommandText('');
                setCurrentUtterance('');
              }}
              title="Task completed"
              description={`Successfully executed and verified: "${taskTitle}"`}
              resultSummary={taskResult}
              duration={taskDuration}
              actionCount={taskActions.length}
            />
            <Metrics
              time={taskDuration}
              actions={String(taskActions.length)}
              mode={plannerMode}
              status="Verified"
              tokens={tokensUsed}
              aiCalls={aiCallsCount}
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
                <button
                  type="button"
                  className="btn-primary"
                  style={{ flex: 1 }}
                  onClick={() => handleStartTask(taskTitle)}
                >
                  Retry Task
                </button>
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
        isListening={isListening}
        handsFree={handsFree}
        transcriptionPreview={currentUtterance || interimTranscript}
        isProcessing={isVoiceProcessing}
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
