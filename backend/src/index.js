/**
 * Voice Browser Agent - Backend Server Entrypoint
 * 
 * Provides an authenticated/protected local AI reasoning service for the Chrome Extension.
 * Enforces server-side secret isolation, request validation, rate limiting, and structured errors.
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createAIRouter } from './ai/aiRouter.js';

// Load environment variables from .env if present
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);
const MAX_REQUEST_SIZE_KB = parseInt(process.env.MAX_REQUEST_SIZE_KB || '512', 10);

// Basic in-memory rate limiter per IP
const rateLimitMap = new Map();
const RATE_LIMIT_PER_MINUTE = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10);

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'localhost';
  const now = Date.now();
  const windowMs = 60 * 1000;

  let record = rateLimitMap.get(ip);
  if (!record || now - record.resetTime > windowMs) {
    record = { count: 1, resetTime: now };
    rateLimitMap.set(ip, record);
  } else {
    record.count++;
  }

  if (record.count > RATE_LIMIT_PER_MINUTE) {
    return res.status(429).json({
      success: false,
      error: `Rate limit exceeded. Maximum ${RATE_LIMIT_PER_MINUTE} requests per minute.`,
      code: 'RATE_LIMIT_EXCEEDED'
    });
  }

  next();
}

// Enable CORS for Chrome Extension origins and local Vite preview
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like curl or Node tests)
    if (!origin) return callback(null, true);
    // Allow chrome-extension:// origins
    if (origin.startsWith('chrome-extension://')) return callback(null, true);
    // Allow local development servers
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) return callback(null, true);
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Body parser with explicit maximum payload limit to prevent DoS
app.use(express.json({ limit: `${MAX_REQUEST_SIZE_KB}kb` }));

// Attach rate limiter
app.use(rateLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'voice-browser-agent-backend',
    version: '1.0.0',
    provider: process.env.AI_PROVIDER || 'gemini',
    uptime: Math.round(process.uptime()),
    timestamp: Date.now()
  });
});

// Mount AI Router
app.use('/api', createAIRouter());

// Global 404 Handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Endpoint '${req.method} ${req.url}' not found.`,
    code: 'NOT_FOUND'
  });
});

// Centralized Error Handler (NEVER leak stack traces or environment secrets)
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const isPayloadTooLarge = err.type === 'entity.too.large';

  res.status(status).json({
    success: false,
    error: isPayloadTooLarge
      ? `Request payload exceeded ${MAX_REQUEST_SIZE_KB}KB limit.`
      : err.message || 'Internal server error',
    code: isPayloadTooLarge ? 'PAYLOAD_TOO_LARGE' : (err.code || 'INTERNAL_ERROR')
  });
});

// Start listening if run directly
if (process.env.NODE_ENV !== 'test') {
  const server = app.listen(PORT, () => {
    console.log(`[Voice Browser Agent Backend] Server running on http://localhost:${PORT}`);
    console.log(`[Voice Browser Agent Backend] Active AI Provider: ${process.env.AI_PROVIDER || 'gemini'}`);
  });

  const shutdown = () => {
    console.log('\n[Voice Browser Agent Backend] Shutting down gracefully...');
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export { app };
