import React from 'react';

const SUGGESTIONS = [
  { label: 'Fill this form', prompt: 'Fill this form with my profile details', icon: '📝' },
  { label: 'Find best option', prompt: 'Find the best laptop under ₹50,000 with 16GB RAM', icon: '⚡' },
  { label: 'Summarize page', prompt: 'Summarize key specs, pricing, and pros/cons on this page', icon: '📄' },
  { label: 'Search & compare', prompt: 'Compare top 3 sellers and check delivery times', icon: '⚖️' }
];

export default function EmptyState({ onSelectSuggestion }) {
  return (
    <div className="empty-hero">
      <div className="hero-sparkle-icon" aria-hidden="true">
        {/* Sparkle AI Icon */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" />
        </svg>
      </div>

      <h1 className="hero-title">What can I do for you?</h1>
      <p className="hero-description">
        Tell me what you want to accomplish. I'll handle the browser steps for you.
      </p>

      <span className="suggestions-title">Suggested Tasks</span>
      <div className="suggestions-grid" role="group" aria-label="Quick task suggestions">
        {SUGGESTIONS.map((item, idx) => (
          <button
            key={idx}
            className="suggestion-chip"
            onClick={() => onSelectSuggestion(item.prompt)}
          >
            <span className="chip-icon" aria-hidden="true">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
