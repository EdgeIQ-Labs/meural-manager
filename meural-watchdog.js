#!/usr/bin/env node
/**
 * Meural Watchdog
 *
 * Prevents blank slides on Meural Canvas frames by monitoring frame status
 * and automatically recovering when issues are detected.
 *
 * Uses the local HTTP API on the frame (bypassing Meural cloud) for:
 * - Health checks
 * - Waking sleeping frames
 * - Sending postcard images to force display
 *
 * Also runs a gallery slideshow that cycles through images via local API
 * to keep the frame active and display your photos.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG = {
  // Frame local IP (required)
  FRAME_IP: process.env.MEURAL_FRAME_IP || '10.5.10.97',

  // Optional: Local server URL for gallery API (if running meural-manager)
  SERVER_URL: process.env.MEURAL_SERVER_URL || null,

  // Optional: Device ID for server API calls
  DEVICE_ID: process.env.MEURAL_DEVICE_ID || null,

  // Optional: Gallery ID to cycle through
  GALLERY_ID: process.env.MEURAL_GALLERY_ID || null,

  // Cache directory for downloaded images
  CACHE_DIR: process.env.MEURAL_CACHE_DIR || '/tmp/meural-watchdog/',

  // Image post interval (seconds)
  POST_INTERVAL: parseInt(process.env.POST_INTERVAL || '30'),

  // How often to check frame health (ms)
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL || '60000'), // 1 minute

  // Stale threshold - frame considered dead if no update in this time (ms)
  STALE_THRESHOLD: parseInt(process.env.STALE_THRESHOLD || '120000'), // 2 minutes

  // Log file
  LOG_FILE: process.env.MEURAL_LOG_FILE || '/tmp/meural-watchdog/watchdog.log',

  // Debug mode (more verbose logging)
  DEBUG: process.env.DEBUG === 'true',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  lastItemId: null,
  lastItemChange: null,
  consecutiveStuck: 0,
  consecutiveBlank: 0,
  slideshowIndex: 0,
  galleryItems: [],
  lastRefreshTime: Date.now(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${level}] ${message}`;
  console.log(entry);

  try {
    const logDir = path.dirname(CONFIG.LOG_FILE);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(CONFIG.LOG_FILE, entry + '\n');
  } catch (e) {
    // Ignore write errors
  }
}

function debug(...args) {
  if (CONFIG.DEBUG) {
    console.log('[DEBUG]', ...args);
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;
    const req = protocol.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function ensureCacheDir() {
  if (!fs.existsSync(CONFIG.CACHE_DIR)) {
    fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Frame Health Checks (via Local API)
// ---------------------------------------------------------------------------

async function checkLocalStatus() {
  const baseUrl = `http://${CONFIG.FRAME_IP}`;

  try {
    const [sleepCheck, backlight] = await Promise.all([
      httpGet(`${baseUrl}/remote/control_check/sleep/`),
      httpGet(`${baseUrl}/remote/get_backlight/`),
    ]);

    return {
      sleeping: sleepCheck.response === true,
      backlight: parseInt(backlight.response) || 0,
      available: true,
    };
  } catch (e) {
    log(`Local API check failed: ${e.message}`, 'WARN');
    return { available: false };
  }
}

// ---------------------------------------------------------------------------
// Frame Recovery Actions (via Local API)
// ---------------------------------------------------------------------------

async function wakeFrame() {
  const baseUrl = `http://${CONFIG.FRAME_IP}`;

  try {
    await httpGet(`${baseUrl}/remote/control_command/resume/`);
    log('Frame woken up via local API', 'ACTION');
    return true;
  } catch (e) {
    log(`Failed to wake frame: ${e.message}`, 'ERROR');
    return false;
  }
}

async function sendPostcard(imagePath) {
  const postcardUrl = `http://${CONFIG.FRAME_IP}/remote/postcard/`;

  try {
    const FormData = require('formdata-node');
    const file = require('fs').createReadStream(imagePath);
    const form = new FormData();
    form.append('photo', file, path.basename(imagePath));

    const urlObj = new URL(postcardUrl);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 80,
      path: urlObj.pathname,
      method: 'POST',
      headers: form.getHeaders(),
    };

    return new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            log(`Postcard sent successfully`, 'ACTION');
            resolve(result);
          } catch (e) {
            log(`Postcard response parse error: ${e.message}`, 'ERROR');
            resolve(null);
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      form.pipe(req);
    });
  } catch (e) {
    log(`Failed to send postcard: ${e.message}`, 'ERROR');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Gallery Slideshow
// ---------------------------------------------------------------------------

async function fetchGalleryItems() {
  if (!CONFIG.SERVER_URL || !CONFIG.GALLERY_ID) {
    log('No server URL or gallery ID configured - slideshow disabled', 'WARN');
    return [];
  }

  try {
    const url = `${CONFIG.SERVER_URL}/api/galleries/${CONFIG.GALLERY_ID}/items`;
    const data = await httpGet(url);
    const items = data?.data || data?.items || [];
    log(`Fetched ${items.length} gallery items`, 'INFO');
    return items;
  } catch (e) {
    log(`Failed to fetch gallery items: ${e.message}`, 'ERROR');
    return [];
  }
}

async function downloadImage(itemUrl, cachePath) {
  if (fs.existsSync(cachePath)) {
    const stats = fs.statSync(cachePath);
    const age = Date.now() - stats.mtimeMs;
    if (age < 24 * 60 * 60 * 1000) { // 24 hour cache
      return cachePath;
    }
  }

  return new Promise((resolve, reject) => {
    const url = new URL(itemUrl);
    const protocol = url.protocol === 'https:' ? https : http;
    const file = fs.createWriteStream(cachePath + '.tmp');

    protocol.get(url.toString(), (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.destroy();
        resolve(downloadImage(res.headers.location, cachePath));
        return;
      }

      res.pipe(file);
      file.on('finish', () => {
        file.close();
        fs.renameSync(cachePath + '.tmp', cachePath);
        resolve(cachePath);
      });
    }).on('error', (err) => {
      fs.unlinkSync(cachePath + '.tmp');
      reject(err);
    });
  });
}

async function getNextImage() {
  ensureCacheDir();

  // Refresh gallery periodically
  const now = Date.now();
  if (now - state.lastRefreshTime > 5 * 60 * 1000) { // 5 minutes
    state.galleryItems = await fetchGalleryItems();
    state.lastRefreshTime = now;
  }

  if (state.galleryItems.length === 0) {
    log('No gallery items available', 'WARN');
    return null;
  }

  // Find next uncached image
  const item = state.galleryItems[state.slideshowIndex % state.galleryItems.length];
  state.slideshowIndex = (state.slideshowIndex + 1) % state.galleryItems.length;

  const itemId = item.id || item.meuralId || item._id;
  const imageUrl = item.downloadUrl || item.url || item.imageUrl;

  if (!itemId || !imageUrl) {
    debug('Skipping item without ID or URL:', item);
    return getNextImage();
  }

  const cachePath = path.join(CONFIG.CACHE_DIR, `${itemId}_conv.jpg`);

  try {
    return await downloadImage(imageUrl, cachePath);
  } catch (e) {
    log(`Failed to download image ${itemId}: ${e.message}`, 'ERROR');
    return getNextImage();
  }
}

async function runSlideshow() {
  const imagePath = await getNextImage();
  if (!imagePath) {
    log('No image to post', 'WARN');
    return;
  }

  const result = await sendPostcard(imagePath);
  if (!result) {
    log('Postcard failed', 'ERROR');
  }
}

// ---------------------------------------------------------------------------
// Main Check Cycle
// ---------------------------------------------------------------------------

async function check() {
  log('Running health check...');

  const localStatus = await checkLocalStatus();

  if (!localStatus.available) {
    log('Frame is offline - will retry on next cycle', 'ERROR');
    return;
  }

  // Check if frame is sleeping
  if (localStatus.sleeping) {
    log('Frame is sleeping - waking up', 'ACTION');
    await wakeFrame();

    // Send a postcard to ensure something displays
    await sendPostcard(path.join(CONFIG.CACHE_DIR, 'poster.jpg'));
  }

  debug('Frame status:', localStatus);
}

// ---------------------------------------------------------------------------
// Entry Point
// ---------------------------------------------------------------------------

async function main() {
  log('='.repeat(50));
  log('Meural Watchdog Starting');
  log(`Frame IP: ${CONFIG.FRAME_IP}`);
  log(`Check Interval: ${CONFIG.CHECK_INTERVAL}ms`);
  log(`Cache Dir: ${CONFIG.CACHE_DIR}`);
  log(`Slideshow Interval: ${CONFIG.POST_INTERVAL}s`);
  log(`Log File: ${CONFIG.LOG_FILE}`);
  log('='.repeat(50));

  ensureCacheDir();

  // Schedule health checks
  const checkInterval = setInterval(async () => {
    try {
      await check();
    } catch (e) {
      log(`Check failed: ${e.message}`, 'ERROR');
    }
  }, CONFIG.CHECK_INTERVAL);

  // Schedule slideshow (only if gallery ID configured)
  if (CONFIG.GALLERY_ID && CONFIG.SERVER_URL) {
    const slideshowInterval = setInterval(async () => {
      try {
        await runSlideshow();
      } catch (e) {
        log(`Slideshow error: ${e.message}`, 'ERROR');
      }
    }, CONFIG.POST_INTERVAL * 1000);

    // Run once immediately
    await runSlideshow();
  } else {
    log('Slideshow disabled - set MEURAL_SERVER_URL and MEURAL_GALLERY_ID to enable', 'INFO');
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    log('Shutting down...');
    clearInterval(checkInterval);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    log('Shutting down...');
    clearInterval(checkInterval);
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    log(`Uncaught exception: ${err.message}`, 'ERROR');
    log(err.stack, 'ERROR');
  });
}

main().catch((err) => {
  log(`Failed to start: ${err.message}`, 'ERROR');
  process.exit(1);
});
