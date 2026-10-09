import React from 'react';

export default function TaskProgress({
  taskTitle = 'Find the cheapest laptop under ₹50,000',
  progress = 65,
  onStopTask
}) {
  return (
    <div className="task-progress-card">
      <div className="task-card-header">
        <span className="task-tag">
          <span className="pulse-dot" style={{ width: 5, height: 5 }} aria-hidden="true"></span>
          Working on task
        </span>
        <button
          className="stop-btn"
          onClick={onStopTask}
          aria-label="Stop task"
        >
          ■ Stop task
        </button>
      </div>

      <div className="task-goal">
        {taskTitle}
      </div>

      <div
        className="progress-track"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div className="progress-fill" style={{ width: `${progress}%` }}></div>
      </div>
    </div>
  );
}
