/* =====================================================
   C1 English Tracker – Server
   Serves the static app and provides a /api/data
   endpoint so study data is backed up server-side.
   ===================================================== */

'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const fs        = require('fs');
const path      = require('path');

const app      = express();
const DATA_DIR  = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracker-data.json');
const PORT      = process.env.PORT || 3000;

// Ensure the data directory exists on first run
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: '10mb' }));

// ── Rate limiters ────────────────────────────────────
const readLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
});

const writeLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

const staticLimiter = rateLimit({
    windowMs: 60 * 1000,  // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

// ── Static front-end files ───────────────────────────
// Only expose the three browser-facing assets to avoid leaking
// server-side files (package.json, server.js, data/, etc.).
const STATIC_FILES = {
    '/':           'index.html',
    '/index.html': 'index.html',
    '/script.js':  'script.js',
    '/styles.css': 'styles.css',
};
Object.entries(STATIC_FILES).forEach(([route, file]) => {
    app.get(route, staticLimiter, (_req, res) => res.sendFile(path.join(__dirname, file)));
});

// ── GET /api/data ────────────────────────────────────
// Returns the stored tracker data (sessions + vocabulary).
app.get('/api/data', readLimiter, (_req, res) => {
    try {
        if (!fs.existsSync(DATA_FILE)) {
            return res.json({ sessions: [], vocabulary: [], version: 3 });
        }
        const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        res.json(data);
    } catch (err) {
        console.error('[C1 Tracker] Read error:', err);
        res.status(500).json({ error: 'Failed to load data' });
    }
});

// ── POST /api/data ───────────────────────────────────
// Persists the tracker data sent from the browser.
app.post('/api/data', writeLimiter, (req, res) => {
    const data = req.body;
    if (
        !data ||
        !Array.isArray(data.sessions) ||
        !Array.isArray(data.vocabulary) ||
        typeof data.version !== 'number'
    ) {
        return res.status(400).json({ error: 'Invalid payload: expected sessions[], vocabulary[], and version fields' });
    }
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        res.json({ ok: true });
    } catch (err) {
        console.error('[C1 Tracker] Write error:', err);
        res.status(500).json({ error: 'Failed to save data' });
    }
});

app.listen(PORT, () => {
    console.log(`C1 English Tracker running on http://localhost:${PORT}`);
});
