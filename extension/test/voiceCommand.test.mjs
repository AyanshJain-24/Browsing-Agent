/**
 * Automated Verification Suite for Hands-Free Voice Command Execution
 * 
 * Verifies all 9 scenarios:
 * 1. Say a short command such as "Scroll down" -> auto-submits after silence.
 * 2. Say a longer instruction (10–15+ words) -> entire transcript retained.
 * 3. Pause briefly in the middle of a sentence -> does not cause premature submission.
 * 4. Speak two separate commands without clicking the mic again -> each submitted exactly once.
 * 5. Recognition session ends unexpectedly -> listening resumes safely without losing words.
 * 6. Cancel an utterance -> verify it is not executed.
 * 7. Deny microphone permission -> displays friendly error and halts cleanly.
 * 8. Sensitive actions still require approval / are rejected before execution.
 * 9. Verification of allowlist and typed input execution.
 */

import {
  createSpeechRecognizer,
  mapSpeechError
} from '../src/sidepanel/utils/speechRecognition.js';
import { planNextAction, isSensitiveAction } from '../src/agent/planner.js';
import { AgentController, ALLOWED_ACTIONS } from '../src/agent/agentController.js';
import { TaskState } from '../src/agent/taskState.js';

// Mock SpeechRecognition constructor for deterministic testing in Node.js
class MockSpeechRecognition {
  static instances = [];
  static shouldFail = false;

  constructor() {
    this.lang = 'en-IN';
    this.continuous = false;
    this.interimResults = false;
    this.maxAlternatives = 1;
    this.onstart = null;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.active = false;
    this._lastResultCount = 0;
    MockSpeechRecognition.instances.push(this);
  }

  start() {
    if (MockSpeechRecognition.shouldFail) {
      throw new Error('Permission denied');
    }
    this.active = true;
    setTimeout(() => {
      if (this.onstart) this.onstart();
    }, 10);
  }

  stop() {
    this.active = false;
    setTimeout(() => {
      if (this.onend) this.onend();
    }, 10);
  }

  abort() {
    this.active = false;
    setTimeout(() => {
      if (this.onend) this.onend();
    }, 10);
  }

  emitResult(resultsArray, resultIndex = 0) {
    this._lastResultCount = resultsArray.length;
    const event = {
      resultIndex,
      results: resultsArray.map((item) => {
        const itemObj = [{ transcript: item.transcript }];
        itemObj.isFinal = Boolean(item.isFinal);
        return itemObj;
      })
    };
    if (this.onresult) this.onresult(event);
  }

  emitError(errCode) {
    if (this.onerror) {
      this.onerror({ error: errCode });
    }
  }

  emitEnd() {
    this.active = false;
    if (this.onend) {
      this.onend();
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
let failed = 0;

function assert(condition, testName, message) {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passed++;
  } else {
    console.error(`FAIL: ${testName} - ${message}`);
    failed++;
  }
}

console.log('--- RUNNING HANDS-FREE VOICE COMMAND REGRESSION SUITE ---');

async function runTests() {
  // ==========================================================================
  // SCENARIO 1: Short command ("Scroll down") auto-submits after silence
  // ==========================================================================
  {
    MockSpeechRecognition.instances = [];
    let submittedCommand = null;

    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 60,
      lang: 'en-IN'
    });

    recognizer.start({
      onUtteranceFinalized: (text) => {
        submittedCommand = text;
      }
    });

    await sleep(20);
    const mock = MockSpeechRecognition.instances[0];
    assert(mock.continuous === true, 'TEST 1A - Continuous mode enabled', 'Expected continuous = true');
    assert(mock.interimResults === true, 'TEST 1B - Interim results enabled', 'Expected interimResults = true');

    // Emit short command: "Scroll down"
    mock.emitResult([
      { transcript: 'Scroll', isFinal: false }
    ]);
    mock.emitResult([
      { transcript: 'Scroll down', isFinal: true }
    ]);

    assert(submittedCommand === null, 'TEST 1C - Command not submitted before silence threshold', 'Premature submission');

    // Wait for silence threshold (60ms) to elapse
    await sleep(90);

    assert(
      submittedCommand === 'Scroll down',
      'TEST 1D - Short command auto-submits after silence',
      `Expected "Scroll down", got "${submittedCommand}"`
    );

    recognizer.stop();
  }

  // ==========================================================================
  // SCENARIO 2: Long instruction (10–15+ words) retains entire transcript
  // ==========================================================================
  {
    MockSpeechRecognition.instances = [];
    let finalUtterance = null;
    let interimSeen = [];

    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 70
    });

    recognizer.start({
      onInterimResult: (interim, full) => {
        interimSeen.push(full);
      },
      onUtteranceFinalized: (text) => {
        finalUtterance = text;
      }
    });

    await sleep(20);
    const mock = MockSpeechRecognition.instances[0];

    // Emit 15-word utterance in two segments
    mock.emitResult([
      { transcript: 'Find the highest rated wireless headphones', isFinal: true },
      { transcript: 'under five thousand', isFinal: false }
    ]);

    mock.emitResult([
      { transcript: 'Find the highest rated wireless headphones', isFinal: true },
      { transcript: 'under five thousand rupees and add them to cart', isFinal: true }
    ]);

    await sleep(100);

    const expected = 'Find the highest rated wireless headphones under five thousand rupees and add them to cart';
    assert(
      finalUtterance === expected,
      'TEST 2 - Long instruction (15 words) retained completely without truncation',
      `Expected "${expected}", got "${finalUtterance}"`
    );

    recognizer.stop();
  }

  // ==========================================================================
  // SCENARIO 3: Pause briefly in middle of sentence -> no premature submit
  // ==========================================================================
  {
    MockSpeechRecognition.instances = [];
    let finalUtterance = null;

    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 120
    });

    recognizer.start({
      onUtteranceFinalized: (text) => {
        finalUtterance = text;
      }
    });

    await sleep(20);
    const mock = MockSpeechRecognition.instances[0];

    // Part 1: "Scroll down"
    mock.emitResult([{ transcript: 'Scroll down', isFinal: true }]);

    // Pause for 60ms (< 120ms threshold)
    await sleep(60);
    assert(finalUtterance === null, 'TEST 3A - Normal pause did not trigger premature submission', 'Prematurely submitted');

    // Part 2: User resumes speaking before timer expires!
    mock.emitResult([
      { transcript: 'Scroll down', isFinal: true },
      { transcript: 'and click Next page', isFinal: true }
    ]);

    // Now wait for full silence threshold
    await sleep(150);

    assert(
      finalUtterance === 'Scroll down and click Next page',
      'TEST 3B - Full combined sentence submitted after speech completion',
      `Expected "Scroll down and click Next page", got "${finalUtterance}"`
    );

    recognizer.stop();
  }

  // ==========================================================================
  // SCENARIO 4: Two separate commands without clicking the mic again
  // ==========================================================================
  {
    MockSpeechRecognition.instances = [];
    const submittedList = [];

    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 60
    });

    recognizer.start({
      onUtteranceFinalized: (text) => {
        submittedList.push(text);
        recognizer.clearUtterance(); // Clear buffer for next command
      }
    });

    await sleep(20);
    const mock = MockSpeechRecognition.instances[0];

    // Command 1
    mock.emitResult([{ transcript: 'Scroll down', isFinal: true }]);
    await sleep(90);

    assert(
      submittedList.length === 1 && submittedList[0] === 'Scroll down',
      'TEST 4A - First command submitted exactly once',
      `Expected ["Scroll down"], got ${JSON.stringify(submittedList)}`
    );

    // Command 2 in same session without clicking mic
    mock.emitResult([
      { transcript: 'Scroll down', isFinal: true }, // Index 0 (old)
      { transcript: 'Scroll up', isFinal: true }    // Index 1 (new)
    ]);
    await sleep(90);

    assert(
      submittedList.length === 2 && submittedList[1] === 'Scroll up',
      'TEST 4B - Second command submitted exactly once without duplicating command 1',
      `Expected ["Scroll down", "Scroll up"], got ${JSON.stringify(submittedList)}`
    );

    recognizer.stop();
  }

  // ==========================================================================
  // SCENARIO 5: Session ends unexpectedly -> resumes safely & retains words
  // ==========================================================================
  {
    MockSpeechRecognition.instances = [];
    let submittedText = null;
    let restartCount = 0;

    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 300
    });

    recognizer.start({
      onRestart: () => {
        restartCount++;
      },
      onUtteranceFinalized: (text) => {
        submittedText = text;
      }
    });

    await sleep(20);
    const session1 = MockSpeechRecognition.instances[0];

    // User spoke "Click on the"
    session1.emitResult([{ transcript: 'Click on the', isFinal: true }]);

    // Chrome abruptly ends session 1!
    session1.emitEnd();

    // Give recognizer 280ms to perform safe auto-restart
    await sleep(300);

    assert(restartCount >= 1, 'TEST 5A - Recognizer detected unexpected onend and triggered restart', `Restarts: ${restartCount}`);
    assert(MockSpeechRecognition.instances.length >= 2, 'TEST 5B - New SpeechRecognition instance created', 'No new instance');

    const session2 = MockSpeechRecognition.instances[1];

    // In session 2, user continues speaking "About Wikipedia link"
    session2.emitResult([{ transcript: 'About Wikipedia link', isFinal: true }]);

    await sleep(350);

    assert(
      submittedText === 'Click on the About Wikipedia link',
      'TEST 5C - Retained words across session restart and finalized unified utterance',
      `Expected "Click on the About Wikipedia link", got "${submittedText}"`
    );

    recognizer.stop();
  }

  // ==========================================================================
  // SCENARIO 6: Cancel utterance -> verify it is not executed
  // ==========================================================================
  {
    MockSpeechRecognition.instances = [];
    let submittedText = null;
    let cancelled = false;

    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 80
    });

    recognizer.start({
      onUtteranceFinalized: (text) => {
        submittedText = text;
      },
      onUtteranceCancelled: () => {
        cancelled = true;
      }
    });

    await sleep(20);
    const mock = MockSpeechRecognition.instances[0];

    // User says sensitive / unwanted command
    mock.emitResult([{ transcript: 'Delete all files', isFinal: true }]);

    // User clicks Cancel
    recognizer.cancelCurrentUtterance();

    // Wait beyond silence duration
    await sleep(120);

    assert(cancelled === true, 'TEST 6A - Cancellation event emitted', 'Cancelled was false');
    assert(submittedText === null, 'TEST 6B - Cancelled utterance was NOT executed', `Got "${submittedText}"`);
    assert(recognizer.isHandsFree() === true, 'TEST 6C - Hands-free listening remains active after cancellation', 'Hands-free stopped');

    recognizer.stop();
  }

  // ==========================================================================
  // SCENARIO 7: Deny microphone permission -> displays friendly error
  // ==========================================================================
  {
    MockSpeechRecognition.instances = [];
    let receivedError = '';
    let isFatal = false;

    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 60
    });

    recognizer.start({
      onError: (msg, fatal) => {
        receivedError = msg;
        isFatal = fatal;
      }
    });

    await sleep(20);
    const mock = MockSpeechRecognition.instances[0];

    // Emit permission denied
    mock.emitError('not-allowed');

    assert(
      receivedError === 'Microphone permission denied.',
      'TEST 7A - Mapped friendly permission error correctly',
      `Expected "Microphone permission denied.", got "${receivedError}"`
    );
    assert(isFatal === true, 'TEST 7B - Permission denial marked as fatal', 'isFatal was false');
    assert(recognizer.isHandsFree() === false, 'TEST 7C - Hands-free halted without infinite restart loop', 'Hands-free still active');
  }

  // ==========================================================================
  // SCENARIO 8: Sensitive action validation through Phase 5 planner
  // ==========================================================================
  {
    // Verify that hands-free commands submit to planner and detect sensitive keywords
    const flightCommand = 'Book flight from Mumbai to Delhi on Indigo';
    const paymentCommand = 'Pay credit card bill with UPI';
    const deleteCommand = 'Delete user account and all personal data';

    assert(isSensitiveAction(flightCommand), 'TEST 8A - Sensitive flight booking detected', flightCommand);
    assert(isSensitiveAction(paymentCommand), 'TEST 8B - Sensitive payment action detected', paymentCommand);
    assert(isSensitiveAction(deleteCommand), 'TEST 8C - Sensitive deletion action detected', deleteCommand);

    const taskState = new TaskState(flightCommand);
    const mockSnapshot = { page: { url: 'https://example.com' }, interactive: {}, content: {} };
    const plan = planNextAction(flightCommand, mockSnapshot, taskState);

    assert(
      plan.status === 'ERROR' && plan.requiresApproval === true && plan.error.includes('Refusing sensitive action'),
      'TEST 8D - Planner stops sensitive voice command before executor call',
      `Got status: ${plan.status}, error: ${plan.error}`
    );
  }

  // ==========================================================================
  // SCENARIO 9: Safe allowlist & empty transcript prevention
  // ==========================================================================
  {
    // Test that empty / whitespace transcripts are never submitted
    let emptySubmitted = false;
    const recognizer = createSpeechRecognizer({
      SpeechRecognitionConstructor: MockSpeechRecognition,
      silenceDurationMs: 40
    });

    recognizer.start({
      onUtteranceFinalized: () => {
        emptySubmitted = true;
      }
    });

    await sleep(20);
    const mock = MockSpeechRecognition.instances[MockSpeechRecognition.instances.length - 1];

    mock.emitResult([{ transcript: '    ', isFinal: true }]);
    await sleep(80);

    assert(emptySubmitted === false, 'TEST 9A - Whitespace-only utterance rejected from submission', 'Whitespace submitted');

    // Test allowed actions
    assert(ALLOWED_ACTIONS.has('click'), 'TEST 9B - "click" action in allowlist', 'click missing');
    assert(ALLOWED_ACTIONS.has('scroll'), 'TEST 9C - "scroll" action in allowlist', 'scroll missing');
    assert(!ALLOWED_ACTIONS.has('eval'), 'TEST 9D - Arbitrary eval excluded from allowlist', 'eval found');

    recognizer.stop();
  }

  console.log('========================================');
  console.log(`VOICE REGRESSION SUITE: ${passed} passed, ${failed} failed.`);
  console.log('========================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
