# Voice Browser Agent — Hackathon Project

A voice-first, AI-powered browser agent Chrome Extension UI built for hackathons and production web automation.

Features a **hybrid closed-loop reasoning architecture** combining instant local deterministic execution for common actions with server-side LLM reasoning (Google Gemini, DeepSeek, Qwen, Groq, Ollama) for complex natural-language tasks.

---

## Architecture Overview

```
                      ┌────────────────────────────────────────┐
                      │   User Speech / Text Command           │
                      └──────────────────┬─────────────────────┘
                                         ▼
                      ┌────────────────────────────────────────┐
                      │        AgentController (Extension)     │
                      └──────────────────┬─────────────────────┘
                                         ▼
                     Fresh DOM Observation (observer.js)
                                         │
                   ┌─────────────────────┴─────────────────────┐
                   │                                           │
         Obvious Command?                            Complex NL Task?
                   │                                           │
                   ▼                                           ▼
       Deterministic Planner                       AI Planning Layer
      (0 API cost, 0 latency)                   (Node/Express AI Backend)
      • scroll, navigate, find               • Gemini 2.0 Flash / DeepSeek
      • exact link click, search             • Compact DOM & Password Masking
                   │                         • Structured JSON Action Schema
                   └─────────────────────┬─────────────────────┘
                                         ▼
                             Strict Allowlist Validator
                        (click, type, select, scroll, pressKey, navigate)
                                         ▼
                            High-Risk Sensitive Action?
                          (payment, checkout, flight booking)
                            YES ──► WAITING_FOR_APPROVAL
                             │      (Explicit Human Modal)
                            NO
                             ▼
                            Browser Action Executor
                                         ▼
                            Fresh Post-Action Snapshot
                                         ▼
                             Outcome Verifier (verifier.js)
                            (URL change, DOM mutation, value check)
                                         │
                     ┌───────────────────┴───────────────────┐
                     │                                       │
                  Success                                  Failure
                     │                                       │
                     ▼                                       ▼
             Complete / Next Step                   Bounded Retry (Fresh DOM)
```

---

## Safety & Security Invariants

1. **Zero Arbitrary Code Execution**: The agent never generates or executes `eval()`, JavaScript code strings, shell commands, or arbitrary browser scripts. All actions strictly map to 6 safe primitives: `click`, `type`, `select`, `scroll`, `pressKey`, and `navigate`.
2. **Server-Side API Secrets**: LLM API credentials reside exclusively on the Node/Express backend (`backend/.env`). Extension bundles and frontend code never contain provider secrets.
3. **Password & Data Redaction**: Password input values are strictly replaced with `[MASKED]` before any DOM observation leaves the client.
4. **Prompt Injection Boundary Isolation**: Page content is treated as untrusted data and strictly bounded inside `<<<UNTRUSTED_PAGE_OBSERVATION>>>` delimiters. System safety rules always override webpage text.
5. **Deterministic-First Cost Optimization**: Common operations (scrolling, direct URLs, exact link text, simple search) are handled locally with 0 API calls and 0 latency.
6. **Explicit Approval Guardrail**: Payments, flight bookings, and account deletions pause in `WAITING_FOR_APPROVAL` state, requiring human confirmation before executing.
7. **Truthful Telemetry**: The UI displays real token counts and elapsed latency reported directly by provider responses—never simulated or invented numbers.

---

## Project Structure

```
browsing-agent/
│
├── backend/                           # Node.js / Express AI Reasoning Backend
│   ├── package.json                   # Dependencies: express, cors, dotenv
│   ├── .env.example                   # Provider credential template
│   ├── src/
│   │   ├── index.js                   # Express server entry point (port 3001)
│   │   └── ai/
│   │       ├── aiRouter.js            # /api/plan & /api/models endpoints
│   │       ├── promptBuilder.js       # Compact observation & anti-injection boundary
│   │       ├── responseValidator.js   # Allowlist validation & JSON parser
│   │       └── providers/
│   │           ├── providerInterface.js # BaseAIProvider & error contract
│   │           ├── geminiProvider.js    # Google Gemini REST client (structured JSON)
│   │           ├── openAiCompatibleProvider.js # DeepSeek, Qwen, Groq, Ollama client
│   │           └── mockProvider.js      # Deterministic test & offline provider
│   └── test/
│       └── backend.test.mjs           # 20 automated tests for backend & security
│
├── extension/                         # Chrome Extension (Manifest V3 + React)
│   ├── manifest.json                  # Extension Manifest V3 configuration
│   ├── package.json                   # React, Vite, Lucide dependencies
│   ├── vite.config.js                 # Multi-entry build (sidepanel, background, content)
│   ├── sidepanel.html                 # Chrome sidepanel entry HTML
│   ├── src/
│   │   ├── agent/
│   │   │   ├── agentController.js     # Hybrid closed-loop controller
│   │   │   ├── planner.js             # Local deterministic planner (0 cost)
│   │   │   ├── aiPlanner.js           # Extension-side AI planning integration
│   │   │   ├── aiClient.js            # Backend HTTP client & token tracking
│   │   │   ├── verifier.js            # Post-action DOM outcome verifier
│   │   │   └── taskState.js           # State machine, limits & truthful metrics
│   │   ├── content/
│   │   │   ├── content.js             # Content script runtime bridge
│   │   │   ├── observer.js            # DOM extractor with stable element IDs
│   │   │   └── executor.js            # Direct event dispatcher (trusted click/type)
│   │   ├── background/
│   │   │   └── serviceWorker.js       # Background message router & sidepanel opener
│   │   └── sidepanel/
│   │       ├── App.jsx                # React state machine & hands-free voice loop
│   │       ├── index.css              # Custom styling, dark mode & animations
│   │       └── components/            # UI components (Timeline, ApprovalModal, Metrics, etc.)
│   └── test/
│       ├── deterministicAgent.test.mjs # 31 regression tests (Phase 4)
│       ├── voiceCommand.test.mjs       # 26 hands-free voice tests (Phase 5)
│       └── llmReasoningAgent.test.mjs  # 19 Phase 6 LLM reasoning & hybrid agent tests
│
├── package.json                       # Root workspace scripts
└── README.md                          # This documentation
```

---

## Provider Support & Selection Rationale

The backend uses a provider-agnostic abstraction (`BaseAIProvider`). Any provider can be selected dynamically or via `.env`:

| Provider | Default Model | Structured JSON Output | Latency & Cost Profile | Best Use Case |
| :--- | :--- | :--- | :--- | :--- |
| **Google Gemini** | `gemini-2.0-flash` | Native (`application/json`) | High throughput, generous free tier, fast inference | **Default & Recommended**: fast, inexpensive, native JSON schema support. |
| **DeepSeek** | `deepseek-chat` | Native (`json_object`) | Extremely cost-effective reasoning | Long complex multi-step reasoning tasks. |
| **Qwen** | `qwen-plus` / `qwen-turbo` | Native (`json_object`) | Strong multilingual and web understanding | Multilingual instructions & international pages. |
| **Groq** | `llama-3.3-70b-versatile` | Native (`json_object`) | Ultra-fast token delivery (<300ms) | Low latency real-time voice browsing. |
| **Mock** | `mock-reasoning-v1` | Built-in deterministic | 0ms / 0 tokens | CI testing, unit testing, offline development. |

---

## Quick Start & Setup

### Prerequisites
- Node.js v18+ (tested on v24)
- Google Chrome (or Chromium-based browser)

### 1. Install Dependencies
```bash
# In project root
npm install
cd backend && npm install
cd ../extension && npm install
cd ..
```

### 2. Configure Backend Secrets
Create `backend/.env` from the provided example:
```bash
cp backend/.env.example backend/.env
```
Edit `backend/.env` and set your preferred provider:
```env
PORT=3001
AI_PROVIDER=gemini
GEMINI_API_KEY=your_actual_gemini_api_key_here
GEMINI_MODEL=gemini-2.0-flash
```
*(If using DeepSeek, Qwen, or Groq, set `AI_PROVIDER=openai_compatible` and supply `OPENAI_COMPATIBLE_API_KEY` and `OPENAI_COMPATIBLE_BASE_URL`.)*

### 3. Start the Backend Server
```bash
npm run dev:backend
```
The backend starts at `http://localhost:3001`. Verify health at `http://localhost:3001/api/models`.

### 4. Build & Load the Extension
```bash
npm run build
```
Then load into Chrome:
1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in upper right corner).
3. Click **Load unpacked** and select the **`extension/dist`** folder.
4. Open the extension sidepanel by clicking the extension icon in Chrome's toolbar.

### 5. Running the Local Dev Preview (Optional)
To preview the React side panel interface in your desktop browser:
```bash
npm run dev
```
Open `http://localhost:5173/sidepanel.html`.

---

## Automated Test Suites

The project includes 96 comprehensive automated tests across 4 test suites:

```bash
# Run all 96 tests across backend and extension
npm test
```

### Breakdown of Test Suites:
1. **Backend & Security Suite (`backend/test/backend.test.mjs` - 20 tests)**:
   - Compact DOM element filtering & password masking (`[MASKED]`).
   - Anti-injection security boundary isolation.
   - Strict action allowlist validation (`click`, `type`, `select`, `scroll`, `pressKey`, `navigate`).
   - Markdown code-fence stripping and malformed JSON recovery.
   - Provider interface compliance, credential validation, and rate-limit handling.
2. **Deterministic Agent Suite (`extension/test/deterministicAgent.test.mjs` - 31 tests)**:
   - Zero-cost deterministic planning for link clicking, scrolling, search, text finding.
   - Ambiguous link detection and stale element rejection.
   - Bounded retries and execution limits (max 15 actions, max 60s).
   - Sensitive action refusal before executor invocation.
3. **Hands-Free Voice Suite (`extension/test/voiceCommand.test.mjs` - 26 tests)**:
   - Continuous Web Speech API recognition loop with silence-threshold auto-submission.
   - Natural pause protection and restart recovery.
   - Speech cancellation and mic permission error handling.
4. **Phase 6 LLM Reasoning Suite (`extension/test/llmReasoningAgent.test.mjs` - 19 tests)**:
   - Simple command handled locally with 0 LLM calls (deterministic-first).
   - Natural-language command genuinely invoking configured LLM.
   - Multi-step structured action sequences.
   - Malformed model response rejection.
   - Unknown action type rejection before executor invocation.
   - Ambiguous instruction handling with `NEEDS_CLARIFICATION`.
   - Navigation followed by fresh observation.
   - Failed action recovery with bounded retries.
   - Sensitive financial action requiring user approval modal.
   - Truthful token counts and latency metrics recorded from provider.
