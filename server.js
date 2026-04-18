// ValCrown App Server — Dedicated service for app distribution
// Runs on Coolify at app.valcrown.com
// Features: version feed, download proxy, load balancing, health monitoring

'use strict';

const express = require('express');
const https   = require('https');
const http    = require('http');
const app     = express();

const PORT       = process.env.PORT || 3000;
const GITHUB_REPO = 'xogamesltd/valcrown-app';
const API_TIMEOUT = parseInt(process.env.API_TIMEOUT_MS) || 3000;

// ── LOAD BALANCER CONFIG ──────────────────────────────────────────────────────
// Primary and fallback endpoints for each service
const ENDPOINTS = {
  api: [
    { url: 'https://api.valcrown.com', priority: 1, healthy: true, latency: 0 },
    { url: 'https://187.127.136.104', priority: 2, healthy: true, latency: 0 },
  ],
  github: [
    { url: 'https://api.github.com', priority: 1, healthy: true, latency: 0 },
    { url: 'https://objects.githubusercontent.com', priority: 2, healthy: true, latency: 0 },
  ]
};

// Track response times and health
const stats = {
  requests: 0,
  downloads: 0,
  updateChecks: 0,
  errors: 0,
  startTime: Date.now(),
};

// ── RELEASE CACHE ─────────────────────────────────────────────────────────────
let releaseCache = null;
let releaseCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchJson(url, timeout = API_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = https.get(url, {
      headers: { 'User-Agent': 'ValCrown-AppServer/1.0' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          resolve({ data: JSON.parse(data), latency: Date.now() - start });
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout after ' + timeout + 'ms')); });
  });
}

async function getLatestRelease() {
  const now = Date.now();
  if (releaseCache && (now - releaseCacheTime) < CACHE_TTL) {
    return releaseCache;
  }

  try {
    const { data, latency } = await fetchJson(
      `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`
    );
    
    const asset = (data.assets || []).find(a => a.name.endsWith('.exe'));
    const release = {
      version:     (data.tag_name || 'v1.0.0').replace(/^v/, ''),
      tag:         data.tag_name || 'v1.0.0',
      name:        data.name || data.tag_name,
      published:   data.published_at,
      downloadUrl: asset?.browser_download_url || null,
      fileName:    asset?.name || null,
      fileSize:    asset ? Math.round(asset.size / 1024 / 1024 * 10) / 10 + ' MB' : null,
      changelog:   (data.body || '').split('\n')
                    .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
                    .slice(0, 8)
                    .map(l => l.replace(/^[-*]\s*/, '').trim()),
      latency,
      cached: false,
    };

    releaseCache    = release;
    releaseCacheTime = now;
    return release;
  } catch(e) {
    stats.errors++;
    if (releaseCache) return { ...releaseCache, cached: true };
    throw e;
  }
}

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  stats.requests++;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Powered-By', 'ValCrown-AppServer');
  next();
});

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  res.json({
    status:   'ok',
    service:  'valcrown-app-server',
    version:  '1.0.0',
    uptime:   uptime + 's',
    stats,
    cache:    releaseCache ? { version: releaseCache.version, age: Math.floor((Date.now() - releaseCacheTime) / 1000) + 's' } : null,
  });
});

// Latest version info — used by app for version check
app.get('/version', async (req, res) => {
  stats.updateChecks++;
  try {
    const release = await getLatestRelease();
    res.json({
      version:     release.version,
      tag:         release.tag,
      name:        release.name,
      published:   release.published,
      downloadUrl: release.downloadUrl,
      fileName:    release.fileName,
      fileSize:    release.fileSize,
      changelog:   release.changelog,
      cached:      release.cached,
      latency:     release.latency,
    });
  } catch(e) {
    stats.errors++;
    res.status(503).json({ error: 'Could not fetch version info', detail: e.message });
  }
});

// Auto-update feed for electron-updater (GitHub provider format)
app.get('/update/:platform/:version', async (req, res) => {
  stats.updateChecks++;
  const { platform, version } = req.params;
  
  try {
    const release = await getLatestRelease();
    const currentVer = version.replace(/^v/, '');
    const latestVer  = release.version;
    
    // Compare versions
    const parse = v => v.split('.').map(Number);
    const [lMaj, lMin, lPat] = parse(latestVer);
    const [cMaj, cMin, cPat] = parse(currentVer);
    
    const isNewer = lMaj > cMaj || 
                   (lMaj === cMaj && lMin > cMin) || 
                   (lMaj === cMaj && lMin === cMin && lPat > cPat);

    if (!isNewer) {
      return res.status(204).send(); // No update
    }

    if (!release.downloadUrl) {
      return res.status(404).json({ error: 'No download available' });
    }

    // Return update info in electron-updater format
    res.json({
      version:      release.tag,
      releaseDate:  release.published,
      releaseNotes: release.changelog.join('\n'),
      path:         release.fileName,
      url:          release.downloadUrl,
    });
  } catch(e) {
    stats.errors++;
    res.status(503).json({ error: 'Update check failed', detail: e.message });
  }
});

// Download redirect — proxies download with fallback
app.get('/download', async (req, res) => {
  stats.downloads++;
  try {
    const release = await getLatestRelease();
    if (!release.downloadUrl) {
      return res.redirect('https://valcrown.com/download.html');
    }
    
    // Check if GitHub is fast enough
    const start = Date.now();
    const testReq = https.get(release.downloadUrl, { method: 'HEAD' }, testRes => {
      const latency = Date.now() - start;
      testRes.destroy();
      
      if (latency > API_TIMEOUT) {
        // Too slow — redirect to website
        res.redirect('https://valcrown.com/download.html');
      } else {
        // Fast enough — redirect to direct GitHub download
        res.redirect(release.downloadUrl);
      }
    });
    testReq.on('error', () => res.redirect('https://valcrown.com/download.html'));
    testReq.setTimeout(API_TIMEOUT, () => {
      testReq.destroy();
      res.redirect('https://valcrown.com/download.html');
    });
  } catch(e) {
    res.redirect('https://valcrown.com/download.html');
  }
});

// API proxy with load balancing and fallback
app.all('/proxy/*', async (req, res) => {
  const endpoint = req.path.replace('/proxy', '');
  
  // Try primary API first, fallback if slow
  const primary = ENDPOINTS.api[0];
  const fallback = ENDPOINTS.api[1];
  
  const tryEndpoint = (baseUrl, timeout) => {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const url = new URL(endpoint, baseUrl);
      const options = {
        method: req.method,
        headers: { ...req.headers, host: url.host },
        timeout,
      };
      
      const r = https.request(url, options, response => {
        let data = '';
        response.on('data', c => data += c);
        response.on('end', () => {
          resolve({ data, status: response.statusCode, latency: Date.now() - start });
        });
      });
      
      r.on('error', reject);
      r.setTimeout(timeout, () => { r.destroy(); reject(new Error('Timeout')); });
      
      if (req.body && Object.keys(req.body).length) {
        r.write(JSON.stringify(req.body));
      }
      r.end();
    });
  };

  try {
    // Try primary with short timeout
    const result = await tryEndpoint(primary.url, API_TIMEOUT);
    primary.latency = result.latency;
    res.status(result.status).send(result.data);
  } catch(e) {
    // Primary failed — try fallback
    try {
      stats.errors++;
      const result = await tryEndpoint(fallback.url, API_TIMEOUT * 2);
      fallback.latency = result.latency;
      res.setHeader('X-Fallback', 'true');
      res.status(result.status).send(result.data);
    } catch(e2) {
      stats.errors++;
      res.status(503).json({ error: 'Service unavailable', detail: 'Both API endpoints failed' });
    }
  }
});

// Endpoint health status
app.get('/status', async (req, res) => {
  const checks = await Promise.allSettled([
    fetchJson('https://api.valcrown.com/health', 3000),
    fetchJson('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest', 5000),
  ]);

  res.json({
    timestamp: new Date().toISOString(),
    services: {
      api: checks[0].status === 'fulfilled'
        ? { status: 'ok', latency: checks[0].value.latency + 'ms' }
        : { status: 'down', error: checks[0].reason?.message },
      github: checks[1].status === 'fulfilled'
        ? { status: 'ok', latency: checks[1].value.latency + 'ms', version: checks[1].value.data.tag_name }
        : { status: 'down', error: checks[1].reason?.message },
    },
    appServer: { status: 'ok', uptime: Math.floor((Date.now() - stats.startTime) / 1000) + 's' },
  });
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('[AppServer] ValCrown App Server running on port ' + PORT);
  console.log('[AppServer] Endpoints: /health /version /download /update/:platform/:version /status');
});

module.exports = app;
