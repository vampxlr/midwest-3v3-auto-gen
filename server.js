'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const PORTAL_PIN = process.env.PORTAL_PIN || '1234';
const GTM_ID = process.env.GTM_CONTAINER_ID || '';
const PIXEL_ID = process.env.META_PIXEL_ID || '';
const CAPI_TOKEN = process.env.META_CAPI_ACCESS_TOKEN || '';
const CAPI_TEST_CODE = process.env.META_CAPI_TEST_CODE || '';
const SITE_DOMAIN = process.env.SITE_DOMAIN || `http://localhost:${PORT}`;

const DATA_DIR = path.join(__dirname, 'data', 'leagues');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(express.json());

// ─── Static Files ──────────────────────────────────────────────────────────
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));
app.use('/images', express.static(path.join(__dirname, 'images')));

// ─── Portal Route ──────────────────────────────────────────────────────────
app.get('/portal', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'portal', 'index.html'));
});

// ─── League Landing Pages ──────────────────────────────────────────────────
// Serve generated static HTML
app.use('/leagues', express.static(path.join(PUBLIC_DIR, 'leagues')));

// Fallback: if no index.html for this league yet, show a "not found" page
app.get('/leagues/:season/:slug', (req, res) => {
  const { season, slug } = req.params;
  const filePath = path.join(PUBLIC_DIR, 'leagues', season, slug, 'index.html');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).send(`
      <html><body style="font-family:sans-serif;padding:2rem;background:#111;color:#eee">
        <h1 style="color:#FF6B1A">League Not Found</h1>
        <p>The page for <strong>${slug}</strong> hasn't been generated yet.</p>
        <p>Go to <a href="/portal" style="color:#FF6B1A">/portal</a> and click "Update All Leagues".</p>
      </body></html>
    `);
  }
});

// ─── API: Portal Auth ──────────────────────────────────────────────────────
app.post('/api/portal/authenticate', (req, res) => {
  const { pin } = req.body;
  if (pin === PORTAL_PIN) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid PIN' });
  }
});

// ─── API: Leagues Index ────────────────────────────────────────────────────
app.get('/api/leagues', (req, res) => {
  const indexPath = path.join(DATA_DIR, 'index.json');
  if (fs.existsSync(indexPath)) {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    res.json(data);
  } else {
    res.json({ lastUpdated: null, leagues: [] });
  }
});

// ─── API: Trigger Crawl (SSE streaming) ───────────────────────────────────
app.post('/api/portal/update', (req, res) => {
  const { pin } = req.body;
  if (pin !== PORTAL_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }

  // Set up Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const send = (msg) => {
    const data = JSON.stringify({ message: msg, time: new Date().toLocaleTimeString() });
    res.write(`data: ${data}\n\n`);
  };

  send('🚀 Starting crawl...');

  // Dynamically require the crawler (so .env is already loaded)
  const { crawl } = require('./crawler/crawl');
  
  crawl(send)
    .then((results) => {
      send(`✅ Done! ${results.filter(r => r.status === 'ok').length}/${results.length} leagues updated`);
      res.write('data: {"done":true}\n\n');
      res.end();
    })
    .catch((err) => {
      send(`❌ Crawl failed: ${err.message}`);
      res.write('data: {"done":true,"error":true}\n\n');
      res.end();
    });
});

// ─── API: Regenerate from existing data (no crawl) ────────────────────────
app.post('/api/portal/regenerate', (req, res) => {
  const { pin } = req.body;
  if (pin !== PORTAL_PIN) {
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  const { regenerateFromData } = require('./crawler/crawl');
  const count = regenerateFromData();
  res.json({ success: true, count });
});

// ─── API: Meta CAPI Tracking ───────────────────────────────────────────────
app.post('/api/track', (req, res) => {
  // Always respond OK immediately so we don't block the user's browser
  res.json({ ok: true });

  if (!CAPI_TOKEN || CAPI_TOKEN === 'YOUR_CAPI_ACCESS_TOKEN_HERE') return;
  if (!PIXEL_ID || PIXEL_ID === 'YOUR_PIXEL_ID_HERE') return;

  const { event, slug, season, position, url, fbp, fbc } = req.body;

  // Build CAPI event payload
  const payload = {
    data: [{
      event_name: event || 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: url || `${SITE_DOMAIN}/leagues/${season}/${slug}`,
      action_source: 'website',
      user_data: {
        fbp: fbp || undefined,
        fbc: fbc || undefined,
        client_ip_address: req.ip,
        client_user_agent: req.headers['user-agent']
      },
      custom_data: {
        content_name: `${season}/${slug}`,
        content_category: `League Landing Page`,
        position: position
      }
    }]
  };

  if (CAPI_TEST_CODE) {
    payload.test_event_code = CAPI_TEST_CODE;
  }

  // Send to Meta CAPI
  const postData = JSON.stringify(payload);
  const options = {
    hostname: 'graph.facebook.com',
    path: `/v18.0/${PIXEL_ID}/events?access_token=${CAPI_TOKEN}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const request = https.request(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      if (apiRes.statusCode !== 200) {
        console.error('[CAPI] Error response:', data);
      }
    });
  });

  request.on('error', (e) => console.error('[CAPI] Request error:', e.message));
  request.write(postData);
  request.end();
});

// ─── Root redirect to portal ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/portal');
});

// ─── Start Server ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🏀 Midwest 3v3 Landing Page Generator`);
  console.log(`   Server running at http://localhost:${PORT}`);
  console.log(`   Admin portal: http://localhost:${PORT}/portal`);
  console.log(`   GTM: ${GTM_ID || '(not set)'}`);
  console.log(`   Meta Pixel: ${PIXEL_ID || '(not set)'}`);
  console.log(`   Meta CAPI: ${CAPI_TOKEN && CAPI_TOKEN !== 'YOUR_CAPI_ACCESS_TOKEN_HERE' ? 'Configured' : '(not set)'}`);
  console.log(`\n   Edit .env to configure tracking IDs and PIN.\n`);
});
