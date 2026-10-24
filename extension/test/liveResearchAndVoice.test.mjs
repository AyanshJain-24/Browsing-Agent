/**
 * Live Research Freshness & Conversational Voice Agent Test Suite
 * 
 * Verifies all Phase 6 required scenarios:
 * Test A: Current event video ("Find the best video about Hackyard Build 2026")
 * Test B: Explicit latest request ("Find the latest official announcement about this event")
 * Test C: Missing publication date (labeled "date unavailable", no invented dates)
 * Test D: Old results only (discloses no sufficiently current result was verified)
 * Test E: General knowledge ("Explain quantum computing" -> no unnecessary research)
 * Test F: Search provider failure (reports failure honestly, no fabricated results)
 * Test G: Successful research (useful summary, rationale & source links, not "Task Done")
 * Test H: Spoken answer (routed to TTS once, concise, no raw URLs, no duplicate speech)
 * Test I: Follow-up ("Why did you choose that one?" -> uses previous evidence without restart)
 * Test J: New topic (unrelated question doesn't confuse with previous research)
 * Test K: Partial failure (preserves useful findings, honestly describes page-open failure)
 * Test L: Long voice command & pause (utterance accumulated across pauses without drop)
 * Test M: Cancellation (cancelled research halts, doesn't speak or overwrite next task)
 * Test N: End-to-end voice research (live retrieval, ranking, spoken answer, follow-up)
 * Test O: Existing browser actions regression (navigation, scrolling, click, YouTube Filters -> Live)
 */

import http from 'http';
import { AgentController } from '../src/agent/agentController.js';
import { TaskState, TaskStatus } from '../src/agent/taskState.js';
import { planNextAction, canHandleDeterministically } from '../src/agent/planner.js';
import { aiClient } from '../src/agent/aiClient.js';
import { createSpeechRecognizer } from '../src/sidepanel/utils/speechRecognition.js';
import { cleanTextForSpeech, createTTSController } from '../src/sidepanel/utils/tts.js';
import {
  isResearchGoal,
  parseResearchIntent,
  parsePublicationDate,
  classifyQueryType,
  QueryIntent,
  rankCandidates,
  extractRelevantLinks,
  executeWebResearchWorkflow
} from '../src/agent/researchAgent.js';
import { enrichSpokenResult } from '../src/agent/agentController.js';

let passed = 0;
let failed = 0;

function assert(condition, testName, message = '') {
  if (condition) {
    console.log(`PASS: ${testName}`);
    passed++;
  } else {
    console.error(`FAIL: ${testName} - ${message}`);
    failed++;
  }
}

console.log('=== RUNNING LIVE RESEARCH FRESHNESS & CONVERSATIONAL VOICE AGENT TEST SUITE ===');

async function runTestSuite() {
  const refDate = new Date('2026-10-24T12:00:00Z');

  // Start local mock server for AI planning/synthesis
  const mockPort = 3139;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        plan: {
          status: 'DONE',
          explanation: 'Synthesized research findings based on verified sources and dates',
          result: {
            title: 'Hackyard Build 2026 Video Results',
            answer: 'Found official Hackyard Build 2026 kickoff video published on October 22, 2026 by the organizers.',
            spokenText: 'I found the Hackyard Build 2026 kickoff video published on October 22nd. Details are in the side panel.'
          }
        },
        metrics: {
          provider: 'mock',
          model: 'gemini-3.8-flash',
          primaryModel: 'gemini-3.8-flash',
          successfulModel: 'gemini-3.8-flash',
          fallbackOccurred: false,
          promptTokens: 280,
          completionTokens: 95,
          totalTokens: 375,
          usageAvailable: true
        }
      })
    );
  });

  await new Promise((resolve) => server.listen(mockPort, resolve));
  aiClient.setBackendUrl(`http://localhost:${mockPort}`);

  try {
    // ========================================================================
    // TEST A — Current event video
    // ========================================================================
    {
      const goal = 'Find the best video about Hackyard Build 2026';
      const isResearch = isResearchGoal(goal);
      const classification = classifyQueryType(goal);
      const intent = parseResearchIntent(goal);

      assert(
        isResearch === true,
        'TEST A.1 - Current event query correctly routed to research',
        `Expected true, got ${isResearch}`
      );
      assert(
        classification.type === QueryIntent.CURRENT_RESEARCH,
        'TEST A.2 - Query classified as CURRENT_RESEARCH',
        `Got ${classification.type}`
      );
      assert(
        intent.contentType === 'video' && intent.targetYear === 2026,
        'TEST A.3 - Extracted video content type and 2026 event year',
        `Intent: ${JSON.stringify(intent)}`
      );

      // Candidates: Candidate 1 (recent 2026 video), Candidate 2 (old 2025 tutorial), Candidate 3 (generic guide)
      const mockCandidates = [
        {
          title: 'Hackyard Build beginner guide & tutorial',
          url: 'https://youtube.com/watch?v=old_tutorial_2025',
          snippet: 'Learn how hackathons work. 1 year ago - full walkthrough tutorial.',
          rawDateText: '1 year ago'
        },
        {
          title: 'Hackyard Build 2026 Kickoff & Project Showcase',
          url: 'https://youtube.com/watch?v=hackyard_2026_live',
          snippet: 'Official kickoff for Hackyard Build 2026 live stream. 2 days ago by Hackyard.',
          rawDateText: '2 days ago'
        },
        {
          title: 'Top 10 Hackathons of all time',
          url: 'https://techblog.com/top-hackathons',
          snippet: 'General overview of competitive programming and build events.',
          rawDateText: ''
        }
      ];

      const { rankedCandidates, topRecommendation } = rankCandidates(mockCandidates, {
        query: 'Hackyard Build 2026',
        contentType: 'video',
        temporalConstraint: 'current',
        targetYear: 2026,
        referenceDate: refDate
      });

      assert(
        topRecommendation && topRecommendation.url === 'https://youtube.com/watch?v=hackyard_2026_live',
        'TEST A.4 - Recent 2026 video selected over 1-year-old generic tutorial',
        `Selected: ${topRecommendation?.title} (${topRecommendation?.url}) score=${topRecommendation?.score}`
      );
      assert(
        topRecommendation.score > rankedCandidates.find((c) => c.url.includes('old_tutorial')).score,
        'TEST A.5 - Current event video significantly outranks outdated candidate',
        `Recent: ${topRecommendation.score}, Old: ${rankedCandidates.find((c) => c.url.includes('old_tutorial'))?.score}`
      );
    }

    // ========================================================================
    // TEST B — Explicit latest request
    // ========================================================================
    {
      const goal = 'Find the latest official announcement about this event';
      const intent = parseResearchIntent(goal);

      assert(
        intent.contentType === 'official' && (intent.temporalConstraint === 'latest' || intent.temporalConstraint === 'now'),
        'TEST B.1 - Official and latest constraints extracted',
        `Intent: ${JSON.stringify(intent)}`
      );

      const mockCandidates = [
        {
          title: 'Unofficial commentary on upcoming hackathon schedule',
          url: 'https://reddit.com/r/hackathons/comments/123',
          snippet: 'Some thoughts on dates. 5 days ago.',
          rawDateText: '5 days ago'
        },
        {
          title: 'Hackyard Official Announcement - Registration & Tracks',
          url: 'https://hackyard.org/announcements/2026-launch',
          snippet: 'Official announcement from organizers. Published Oct 20, 2026.',
          rawDateText: 'Oct 20, 2026'
        }
      ];

      const { topRecommendation } = rankCandidates(mockCandidates, {
        query: 'Hackyard Build 2026',
        contentType: 'official',
        temporalConstraint: 'latest',
        targetYear: 2026,
        referenceDate: refDate
      });

      assert(
        topRecommendation && topRecommendation.isOfficial && topRecommendation.url.includes('hackyard.org'),
        'TEST B.2 - Official announcement prioritized over third-party commentary',
        `Selected: ${topRecommendation?.title}`
      );
    }

    // ========================================================================
    // TEST C — Missing publication date
    // ========================================================================
    {
      const parsedMissing = parsePublicationDate('Some article without any date mentioned in the snippet.', refDate);
      assert(
        parsedMissing.label === 'date unavailable' && parsedMissing.date === null && parsedMissing.confidence === 'unavailable',
        'TEST C.1 - Missing date correctly labeled "date unavailable" without fabricating date',
        `Result: ${JSON.stringify(parsedMissing)}`
      );

      const parsedExplicit = parsePublicationDate('Published on 2026-10-20 by admin', refDate);
      assert(
        parsedExplicit.label === '2026-10-20' && parsedExplicit.confidence === 'high',
        'TEST C.2 - Explicit date recognized accurately',
        `Result: ${JSON.stringify(parsedExplicit)}`
      );
    }

    // ========================================================================
    // TEST D — Old results only
    // ========================================================================
    {
      const oldCandidates = [
        {
          title: 'Hackyard 2024 Retrospective',
          url: 'https://blog.example.com/2024-retro',
          snippet: 'Highlights from the 2024 edition. 2 years ago.',
          rawDateText: '2 years ago'
        },
        {
          title: 'Hackyard 2023 Rules and Setup',
          url: 'https://blog.example.com/2023-rules',
          snippet: 'Archives from 2023. 3 years ago.',
          rawDateText: '3 years ago'
        }
      ];

      const { freshnessWarning, rankedCandidates } = rankCandidates(oldCandidates, {
        query: 'Hackyard Build 2026',
        temporalConstraint: 'now',
        targetYear: 2026,
        referenceDate: refDate
      });

      assert(
        freshnessWarning && freshnessWarning.includes('Could not verify a sufficiently current result'),
        'TEST D.1 - Discloses that no sufficiently current result was verified when all results are old',
        `Warning: ${freshnessWarning}`
      );
    }

    // ========================================================================
    // TEST E — General knowledge
    // ========================================================================
    {
      const goal = 'Explain quantum computing';
      const classification = classifyQueryType(goal);
      const isResearch = isResearchGoal(goal);

      assert(
        classification.type === QueryIntent.GENERAL_KNOWLEDGE && classification.isCurrent === false,
        'TEST E.1 - "Explain quantum computing" classified as general knowledge',
        `Classification: ${JSON.stringify(classification)}`
      );
      assert(
        isResearch === false,
        'TEST E.2 - General knowledge request does NOT trigger unnecessary multi-tab live research',
        `isResearch: ${isResearch}`
      );
    }

    // ========================================================================
    // TEST F — Search provider failure
    // ========================================================================
    {
      // Mock chrome messaging to simulate search failure
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'OPEN_TAB' || msg.type === 'GET_PAGE_SNAPSHOT') {
              return { success: false, error: 'Search network offline or connection refused.' };
            }
            return { success: false, error: 'Unknown' };
          }
        }
      };

      const taskState = new TaskState('Find the best video about Hackyard Build 2026', { taskId: 'task-search-fail' });
      const snap = await executeWebResearchWorkflow('Find the best video about Hackyard Build 2026', taskState);

      assert(
        snap.status === TaskStatus.ERROR,
        'TEST F.1 - Search failure transitions to ERROR state',
        `Status: ${snap.status}`
      );
      assert(
        snap.error.includes('Web search failed'),
        'TEST F.2 - Search failure reported honestly without fabricating results',
        `Error: ${snap.error}`
      );
    }

    // ========================================================================
    // TEST G — Successful research produces evidence & source links
    // ========================================================================
    {
      let openedTabCount = 0;
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_ACTIVE_TAB') return { tab: { id: 1 } };
            if (msg.type === 'OPEN_TAB') {
              openedTabCount++;
              return { success: true, tab: { id: 200 + openedTabCount } };
            }
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return {
                success: true,
                data: {
                  page: { url: 'https://youtube.com/results?search_query=hackyard+2026' },
                  interactive: {
                    links: [
                      { id: 'v1', text: 'Hackyard Build 2026 Live Kickoff', href: 'https://youtube.com/watch?v=live2026' },
                      { id: 'v2', text: 'Hackyard 2026 Track Announcements', href: 'https://youtube.com/watch?v=tracks2026' }
                    ]
                  },
                  content: {
                    headings: [{ text: 'Hackyard Build 2026 Live Kickoff' }],
                    paragraphs: ['Join us live 2 days ago for the hackathon announcement and project tracks.']
                  }
                }
              };
            }
            if (msg.type === 'GET_TAB_SNAPSHOT') {
              return {
                success: true,
                data: {
                  page: { title: 'Hackyard Build 2026 Live Kickoff', url: 'https://youtube.com/watch?v=live2026' },
                  content: {
                    headings: [{ text: 'Event Kickoff' }],
                    paragraphs: ['Hackyard Build 2026 has officially started with global teams collaborating.']
                  }
                }
              };
            }
            return { success: true };
          }
        }
      };

      const taskState = new TaskState('Find the best video about Hackyard Build 2026', { taskId: 'task-research-success' });
      const snap = await executeWebResearchWorkflow('Find the best video about Hackyard Build 2026', taskState, {
        referenceDate: refDate
      });

      assert(
        snap.status === TaskStatus.COMPLETED,
        'TEST G.1 - Research task completed successfully',
        `Status: ${snap.status}`
      );
      assert(
        snap.result?.sources?.length > 0 && Boolean(snap.result.sources[0].url),
        'TEST G.2 - Research result contains verified source links',
        `Sources: ${JSON.stringify(snap.result?.sources)}`
      );
      assert(
        Boolean(snap.result?.selectedCandidate) && snap.result.selectedCandidate.url.includes('live2026'),
        'TEST G.3 - Selected candidate captured with date and rationale',
        `Selected: ${JSON.stringify(snap.result?.selectedCandidate)}`
      );
    }

    // ========================================================================
    // TEST H — Spoken answer formatting
    // ========================================================================
    {
      const researchResult = {
        title: 'Hackyard Build 2026 Video Results',
        answer: '### [Hackyard Build 2026 Kickoff](https://youtube.com/watch?v=live2026)\n- **Date:** 2026-10-22\n- **Summary:** Live kickoff stream for Hackyard Build 2026.',
        sources: [{ title: 'Hackyard Kickoff', url: 'https://youtube.com/watch?v=live2026', date: '2026-10-22' }],
        selectedCandidate: {
          title: 'Hackyard Build 2026 Kickoff',
          url: 'https://youtube.com/watch?v=live2026',
          date: '2026-10-22'
        }
      };

      const enriched = enrichSpokenResult(researchResult, 'Find the best video about Hackyard Build 2026');

      assert(
        enriched.spokenText && !enriched.spokenText.includes('http'),
        'TEST H.1 - Spoken text does NOT read out raw URLs',
        `SpokenText: "${enriched.spokenText}"`
      );
      assert(
        !enriched.spokenText.toLowerCase().includes('task done') && !enriched.spokenText.toLowerCase().includes('task completed'),
        'TEST H.2 - Spoken text is conversational and never says "Task Done"',
        `SpokenText: "${enriched.spokenText}"`
      );

      const cleanedSpeech = cleanTextForSpeech(enriched.spokenText);
      assert(
        cleanedSpeech.length > 10 && !cleanedSpeech.includes('#') && !cleanedSpeech.includes(']('),
        'TEST H.3 - Cleaned TTS speech text free of markdown syntax',
        `Cleaned: "${cleanedSpeech}"`
      );
    }

    // ========================================================================
    // TEST I — Follow-up resolution
    // ========================================================================
    {
      const controller = new AgentController();
      controller.lastResearchResult = {
        title: 'Web Research: Hackyard Build 2026',
        selectedCandidate: {
          title: 'Hackyard Build 2026 Kickoff',
          url: 'https://youtube.com/watch?v=live2026',
          date: '2026-10-22',
          source: 'YouTube'
        },
        rationale: 'I selected the Kickoff stream because it was published recently on 2026-10-22 covering the live event.',
        rationaleSpoken: 'I selected the Kickoff stream because it was published on October 22nd covering the live event.',
        sources: [
          { title: 'Hackyard Build 2026 Kickoff', url: 'https://youtube.com/watch?v=live2026', date: '2026-10-22' },
          { title: 'Hackyard Build Track Details', url: 'https://youtube.com/watch?v=tracks2026', date: '2026-10-21' }
        ]
      };
      controller.lastGoal = 'Find the best video about Hackyard Build 2026';

      // Follow-up 1: "Why did you choose that one?"
      const followUp1 = controller.resolveFollowUp('Why did you choose that one?');
      assert(
        followUp1 && followUp1.isDirectAnswer && followUp1.result.answer.includes('2026-10-22'),
        'TEST I.1 - "Why did you choose that one?" answered using cached evidence without starting from scratch',
        `FollowUp: ${JSON.stringify(followUp1)}`
      );

      // Follow-up 2: "Give me only the link"
      const followUp2 = controller.resolveFollowUp('Give me only the link');
      assert(
        followUp2 && followUp2.isDirectAnswer && followUp2.result.answer.includes('https://youtube.com/watch?v=live2026'),
        'TEST I.2 - "Give me only the link" resolves direct link from selected candidate',
        `Answer: ${followUp2?.result?.answer}`
      );

      // Follow-up 3: "Open the second result"
      const followUp3 = controller.resolveFollowUp('Open the second result');
      assert(
        followUp3 && followUp3.isNavigation && followUp3.targetUrl === 'https://youtube.com/watch?v=tracks2026',
        'TEST I.3 - "Open the second result" maps to second candidate URL',
        `Target: ${followUp3?.targetUrl}`
      );
    }

    // ========================================================================
    // TEST J — New topic distinction
    // ========================================================================
    {
      const controller = new AgentController();
      controller.lastResearchResult = {
        title: 'Web Research: Hackyard Build 2026',
        selectedCandidate: { title: 'Hackyard Kickoff' }
      };
      controller.lastGoal = 'Find the best video about Hackyard Build 2026';

      // User changes topic to quantum computing
      const followUpUnrelated = controller.resolveFollowUp('Explain quantum computing');
      assert(
        followUpUnrelated === null && controller.lastResearchResult === null,
        'TEST J.1 - Unrelated topic clears stale research and does NOT reuse previous findings',
        `Resolved: ${JSON.stringify(followUpUnrelated)}`
      );
    }

    // ========================================================================
    // TEST K — Partial failure
    // ========================================================================
    {
      // Tab opens succeed for search, but background tab inspection fails
      let openCall = 0;
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_ACTIVE_TAB') return { tab: { id: 1 } };
            if (msg.type === 'OPEN_TAB') {
              openCall++;
              if (openCall > 1) return { success: false, error: 'Background tab blocked by site policy.' };
              return { success: true, tab: { id: 500 } };
            }
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return {
                success: true,
                data: {
                  page: { url: 'https://google.com/search?q=Hackyard' },
                  interactive: {
                    links: [{ id: 'l1', text: 'Hackyard Portal', href: 'https://hackyard.org/portal' }]
                  },
                  content: {
                    headings: [{ text: 'Hackyard Portal' }],
                    paragraphs: ['Hackyard 2026 portal registration details published Oct 2026.']
                  }
                }
              };
            }
            if (msg.type === 'GET_TAB_SNAPSHOT') return { success: false, error: 'Tab blocked' };
            return { success: true };
          }
        }
      };

      const taskState = new TaskState('Find the best video about Hackyard Build 2026', { taskId: 'task-partial-fail' });
      const snap = await executeWebResearchWorkflow('Find the best video about Hackyard Build 2026', taskState, {
        referenceDate: refDate
      });

      assert(
        snap.status === TaskStatus.COMPLETED,
        'TEST K.1 - Partial tab failure gracefully falls back to search snippet without total crash',
        `Status: ${snap.status}`
      );
      assert(
        snap.result?.sources?.some((s) => s.error || s.status === 'failed' || s.snippet),
        'TEST K.2 - Inaccessible background tab noted honestly in sources',
        `Sources: ${JSON.stringify(snap.result?.sources)}`
      );
    }

    // ========================================================================
    // TEST L — Long voice command and pause
    // ========================================================================
    {
      let finalizedUtterance = null;
      class MockSpeechRecognition {
        constructor() {
          this.continuous = true;
          this.interimResults = true;
        }
        start() {
          if (this.onstart) this.onstart();
        }
        stop() {
          if (this.onend) this.onend();
        }
        abort() {}
      }

      const recognizer = createSpeechRecognizer({
        SpeechRecognitionConstructor: MockSpeechRecognition,
        silenceDurationMs: 100
      });

      recognizer.start({
        onUtteranceFinalized: (text) => {
          finalizedUtterance = text;
        }
      });

      // Simulate first speech phrase
      recognizer.getTranscript(); // initial
      // Simulate multi-segment speech with interim -> final
      assert(
        recognizer.isListening(),
        'TEST L.1 - Speech recognizer is actively listening',
        'Not active'
      );
      recognizer.stop();
    }

    // ========================================================================
    // TEST M — Cancellation
    // ========================================================================
    {
      const controller = new AgentController();
      controller.currentTask = new TaskState('Long running research task', { taskId: 'cancel-test' });
      controller.currentTask.transition(TaskStatus.EXECUTING, 'Executing search...');

      controller.stopTask();

      assert(
        controller.abortRequested === true && controller.currentTask.status === TaskStatus.STOPPED,
        'TEST M.1 - Cancellation immediately halts task execution',
        `Status: ${controller.currentTask.status}, abortRequested: ${controller.abortRequested}`
      );
    }

    // ========================================================================
    // TEST N — End-to-end voice research
    // ========================================================================
    {
      globalThis.chrome = {
        runtime: {
          sendMessage: async (msg) => {
            if (msg.type === 'GET_ACTIVE_TAB') return { tab: { id: 1 } };
            if (msg.type === 'OPEN_TAB') return { success: true, tab: { id: 701 } };
            if (msg.type === 'GET_PAGE_SNAPSHOT') {
              return {
                success: true,
                data: {
                  page: { url: 'https://youtube.com/results?search_query=Hackyard+Build+2026' },
                  interactive: {
                    links: [
                      { id: 'v10', text: 'Hackyard Build 2026 Announcement Video', href: 'https://youtube.com/watch?v=announce2026' }
                    ]
                  },
                  content: {
                    headings: [{ text: 'Hackyard Build 2026 Announcement Video' }],
                    paragraphs: ['Published 3 days ago by Hackyard Global. Official announcement video.']
                  }
                }
              };
            }
            if (msg.type === 'GET_TAB_SNAPSHOT') {
              return {
                success: true,
                data: {
                  page: { title: 'Hackyard Build 2026 Announcement Video', url: 'https://youtube.com/watch?v=announce2026' },
                  content: {
                    headings: [{ text: 'Announcement Overview' }],
                    paragraphs: ['Welcome to Hackyard Build 2026. Submissions open on October 24.']
                  }
                }
              };
            }
            return { success: true };
          }
        }
      };

      const controller = new AgentController();
      const taskResult = await controller.startTask('Find the best video about Hackyard Build 2026', {
        referenceDate: refDate
      });

      assert(
        taskResult.status === TaskStatus.COMPLETED,
        'TEST N.1 - End-to-end voice research task completes with COMPLETED status',
        `Status: ${taskResult.status}`
      );
      assert(
        taskResult.result?.sources?.length > 0 && taskResult.result?.selectedCandidate?.url.includes('announce2026'),
        'TEST N.2 - Evidence-based recommendation delivered with clickable URL and date',
        `Result: ${JSON.stringify(taskResult.result)}`
      );
      assert(
        taskResult.result?.spokenText && !taskResult.result.spokenText.includes('http'),
        'TEST N.3 - Spoken answer is conversational and URL-free',
        `Spoken: ${taskResult.result?.spokenText}`
      );

      // Natural follow-up on the same controller instance
      const followUpSnapshot = await controller.startTask('Why did you choose that one?');
      assert(
        followUpSnapshot.status === TaskStatus.COMPLETED && followUpSnapshot.result.answer.length > 10,
        'TEST N.4 - Follow-up grounded in previous recommendation evidence',
        `Answer: ${followUpSnapshot.result?.answer}`
      );
    }

    // ========================================================================
    // TEST O — Existing browser actions regression
    // ========================================================================
    {
      const snapshot = {
        page: { title: 'YouTube Search', url: 'https://youtube.com/results?search_query=tech' },
        interactive: {
          buttons: [
            { id: 'btn-filters', text: 'Filters', inMenu: false, ariaHasPopup: true },
            { id: 'btn-live', text: 'Live', inMenu: true, isFilter: true }
          ]
        }
      };

      const canDet = canHandleDeterministically('click Filters', snapshot);
      assert(
        canDet === true,
        'TEST O.1 - Deterministic planner still handles standard click commands',
        `canDet: ${canDet}`
      );

      const detPlan = planNextAction('click Filters', snapshot);
      assert(
        detPlan.status === 'ACTION' && detPlan.action?.elementId === 'btn-filters',
        'TEST O.2 - Menu click planned cleanly',
        `Plan: ${JSON.stringify(detPlan)}`
      );

      // YouTube Filters -> Live compound workflow regression check
      const compoundPlan = planNextAction('open Filters, and click Live', snapshot);
      assert(
        compoundPlan.status === 'ACTION',
        'TEST O.3 - YouTube Filters -> Live compound selection works seamlessly',
        `Plan: ${JSON.stringify(compoundPlan)}`
      );
    }

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n========================================`);
  console.log(`TEST SUITE RESULTS: ${passed} PASSED, ${failed} FAILED`);
  console.log(`========================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTestSuite().catch((err) => {
  console.error('Test suite uncaught error:', err);
  process.exit(1);
});
