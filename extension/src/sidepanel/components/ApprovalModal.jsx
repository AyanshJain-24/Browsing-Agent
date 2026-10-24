import React from 'react';

export default function ApprovalModal({
  isOpen,
  onApprove,
  onCancel,
  website = 'active page',
  actionTitle = 'Action requires approval',
  details = []
}) {
  if (!isOpen) return null;

  const displayDetails = (details && details.length > 0) ? details : [
    { label: 'Website', value: website || 'Active page' },
    { label: 'Action', value: actionTitle || 'Consequential browser action' },
    { label: 'Safety Policy', value: 'High-impact action requires explicit confirmation' }
  ];

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="approval-title"
    >
      <div className="approval-modal-card">
        <div className="approval-header">
          <div className="shield-icon-badge" aria-hidden="true">
            {/* Shield Check SVG */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </div>
          <div className="approval-title-group">
            <span className="approval-badge">Safety Guardrail</span>
            <h2 id="approval-title" className="approval-title">
              Action requires approval
            </h2>
          </div>
        </div>

        <p className="approval-body-text">
          The agent is ready to perform a high-impact browser action on <strong>{website}</strong>. Please review before proceeding.
        </p>

        <div className="approval-details-box">
          {displayDetails.map((d, i) => (
            <div key={i} className="detail-row">
              <span className="detail-label">{d.label}</span>
              <span className="detail-value">{d.value}</span>
            </div>
          ))}
        </div>

        <div className="approval-button-group">
          <button
            type="button"
            className="btn-secondary"
            onClick={onCancel}
          >
            Cancel / Deny
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={onApprove}
          >
            Approve Action
          </button>
        </div>
      </div>
    </div>
  );
}
