# Voice Browser Agent — Chrome Extension Frontend

A voice-first AI browser agent Chrome Extension UI built for hackathons and rapid demonstration. This extension enables users to command browser navigation, automated form filling, product comparisons, and multi-step web tasks through a responsive, modern Chrome Side Panel interface.

> **Note**: This repository contains the **Frontend UI and Chrome Extension Shell** with static/mock data for visual inspection and hackathon presentations. Backend LLMs, real speech recognition APIs, and real browser automation are intentionally omitted in this phase.

---

## 📁 File Structure & Explanations

### `manifest.json`
→ Chrome extension configuration and permissions (Manifest V3, Side Panel API, tabs, storage).

### `package.json`
→ Frontend dependencies (React 18, Vite) and build scripts.

### `vite.config.js`
→ Vite build configuration with Rollup multi-entry bundling for side panel, background service worker, and content scripts.

### `sidepanel.html`
→ HTML entry point for the Chrome Side Panel UI with Inter typography.

### `index.html`
→ Local browser preview entry point for running the Vite development server.

### `src/background/serviceWorker.js`
→ Background extension logic that configures side panel behavior (`openPanelOnActionClick`) and handles tab query messaging.

### `src/content/content.js`
→ Will eventually communicate with the active webpage DOM and relay state to the side panel.

### `src/content/observer.js`
→ Will eventually inspect webpage elements (inputs, buttons, forms, links) for agent observation.

### `src/content/executor.js`
→ Will eventually execute browser actions (clicking, typing, submitting, scrolling) determined by the agent.

### `src/sidepanel/main.jsx`
→ React entry point mounting the root `<App />` component.

### `src/sidepanel/App.jsx`
→ Main React application managing state machines (Idle, Listening, Thinking, Executing, Approval, Takeover, Completed, Error), modals, and interactions.

### `src/sidepanel/index.css`
→ Main styling featuring responsive 320px–420px constraints, design tokens, micro-animations (voice ripples, waveform equalizer), and full Light/Dark theme support.

### `src/sidepanel/components/`
- **`Header.jsx`**: Extension branding, live browser connection badge, and settings toggle.
- **`PageContext.jsx`**: Active webpage context card (Website name, URL, page category, status indicator).
- **`EmptyState.jsx`**: Hero introduction and clickable task suggestion chips.
- **`VoiceButton.jsx`**: Large circular microphone button with pulsing ripple animations, audio equalizer bars, and mock transcription.
- **`CommandInput.jsx`**: Sleek integrated command bar with text input, quick mic toggle, and send button.
- **`TaskProgress.jsx`**: Active task goal, progress bar, and stop button.
- **`ActionTimeline.jsx`**: Multi-state browser action timeline (completed, active, pending, failed).
- **`AIStatusPill.jsx`**: High-level safe status indicator (Observing page, Planning, Verifying).
- **`ApprovalModal.jsx`**: Professional security guardrail modal for high-impact actions.
- **`HumanTakeover.jsx`**: Alert card for CAPTCHA/2FA pausing with "Resume Agent" button.
- **`TaskCompleted.jsx`**: Success celebration card with outcome summary and navigation actions.
- **`Metrics.jsx`**: Task efficiency metrics card (Task time, DOM steps, AI calls, Estimated cost).
- **`SettingsModal.jsx`**: Slide-over configuration drawer (voice responses, auto-approval, dark mode).
- **`DevStateSwitcher.jsx`**: Developer toolbar to immediately preview any state or run the automated demo flow.

---

## 🚀 Getting Started

### 1. Install Dependencies
Open a terminal in the `extension/` directory and run:
```bash
npm install
```

### 2. Run the Frontend (Live Preview Server)
To preview and inspect the UI locally in your standard web browser with hot module replacement (HMR):
```bash
npm run dev
```
Open **`http://localhost:5173/`** or **`http://localhost:5173/sidepanel.html`** in Chrome, Edge, or any browser.

### 3. Build the Chrome Extension
To bundle the extension for production:
```bash
npm run build
```
This generates the `dist/` directory containing the bundled manifest, service worker, content scripts, and side panel assets.

---

## 🧩 Loading into Chrome (`chrome://extensions`)

1. Open Google Chrome.
2. Navigate to `chrome://extensions/` in the address bar.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button in the top left.
5. Select the **`dist`** directory inside `voice-browser-agent/extension/dist`.
6. Click the extension icon in the Chrome toolbar (or open Chrome's Side Panel dropdown and choose **Voice Browser Agent**).
7. The Voice Browser Agent side panel will open alongside your active webpage!

---

## 🎨 Interactive State Preview
Use the top developer bar (**Preview**) to test all UI states:
- **Idle**: Hero state with suggestion chips and large voice button.
- **Listening**: Animated microphone ripples, 5-bar waveform, and speech transcription.
- **Thinking**: Compact AI planning pill with progress indicator.
- **Executing**: Active task progress card, action timeline, and efficiency metrics.
- **Approval**: Guardrail modal asking for user verification before high-risk actions.
- **Takeover**: Paused agent warning when manual input (CAPTCHA/login) is needed.
- **Completed**: Success screen with result summary and efficiency benchmark.
- **Error**: Graceful timeout/failure card with retry option.
- **▶ Auto Flow**: Automatically plays through the entire agent lifecycle!
