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
const { exec } = require('child_process');

// Load environment variables from .env file
try { require('dotenv').config(); } catch (e) { /* dotenv not installed, using process.env only */ }

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

  // Optional: Local image directory for slideshow (bypasses cloud)
  LOCAL_SLIDESHOW_DIR: process.env.MEURAL_LOCAL_SLIDESHOW_DIR || null,

  // Optional: Use single image instead of cycling (prevents flashing)
  LOCAL_SLIDESHOW_SINGLE: process.env.MEURAL_LOCAL_SLIDESHOW_SINGLE === 'true',

  // Cache directory for downloaded images
  CACHE_DIR: process.env.MEURAL_CACHE_DIR || '/tmp/meural-watchdog/',

  // Image post interval (seconds) — very frequent to prevent preview expiry
  POST_INTERVAL: parseInt(process.env.POST_INTERVAL || '5'),

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
    const [sleepCheck, backlight] = await Promise.allSettled([
      httpGet(`${baseUrl}/remote/control_check/sleep/`),
      httpGet(`${baseUrl}/remote/get_backlight/`),
    ]);

    const sleepResult = sleepCheck.status === 'fulfilled' ? sleepCheck.value : null;
    const backlightResult = backlight.status === 'fulfilled' ? backlight.value : null;

    // Log any failures for debugging
    if (sleepCheck.status === 'rejected') {
      log(`Sleep check failed: ${sleepCheck.reason.message}`, 'WARN');
    }
    if (backlight.status === 'rejected') {
      log(`Backlight check failed: ${backlight.reason.message}`, 'WARN');
    }

    return {
      sleeping: sleepResult?.response === true,
      backlight: parseInt(backlightResult?.response) || 0,
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

  return new Promise((resolve, reject) => {
    const cmd = `curl -s -F "photo=@${imagePath}" "${postcardUrl}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        log(`Failed to send postcard: ${error.message}`, 'ERROR');
        resolve(null);
        return;
      }

      if (stderr) {
        log(`Postcard curl stderr: ${stderr}`, 'WARN');
      }

      try {
        const result = JSON.parse(stdout);
        if (result.status === 'pass') {
          log(`Postcard sent successfully: ${path.basename(imagePath)}`, 'ACTION');
          resolve(result);
        } else {
          log(`Postcard failed: ${result.response}`, 'ERROR');
          resolve(null);
        }
      } catch (e) {
        log(`Postcard response parse error: ${stdout}`, 'ERROR');
        resolve(null);
      }
    });
  });
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

async function getLocalImage() {
  if (!CONFIG.LOCAL_SLIDESHOW_DIR) {
    return null;
  }

  try {
    const files = fs.readdirSync(CONFIG.LOCAL_SLIDESHOW_DIR);
    const imageFiles = files.filter(f => /\.(jpe?g|png|gif)$/i.test(f));

    if (imageFiles.length === 0) {
      log(`No images found in ${CONFIG.LOCAL_SLIDESHOW_DIR}`, 'WARN');
      return null;
    }

    // Cycle through images or use single image
    let targetFile;
    if (CONFIG.LOCAL_SLIDESHOW_SINGLE) {
      // Use first image only (static display)
      targetFile = imageFiles[0];
      log(`Single image mode: ${targetFile}`, 'INFO');
    } else {
      // Cycle through all images
      const index = state.slideshowIndex % imageFiles.length;
      state.slideshowIndex = (state.slideshowIndex + 1) % imageFiles.length;
      targetFile = imageFiles[index];
    }

    return path.join(CONFIG.LOCAL_SLIDESHOW_DIR, targetFile);
  } catch (e) {
    log(`Failed to read local directory: ${e.message}`, 'ERROR');
    return null;
  }
}

async function getNextImage() {
  ensureCacheDir();

  // Use local slideshow if configured
  if (CONFIG.LOCAL_SLIDESHOW_DIR) {
    return getLocalImage();
  }

  // Fall back to cloud gallery
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
  } else {
    log(`Frame OK - backlight: ${localStatus.backlight}`, 'INFO');
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

  // Schedule slideshow (local or cloud)
  let slideshowEnabled = false;

  if (CONFIG.LOCAL_SLIDESHOW_DIR) {
    slideshowEnabled = true;
    log(`Local slideshow enabled: ${CONFIG.LOCAL_SLIDESHOW_DIR}`, 'INFO');
  } else if (CONFIG.GALLERY_ID && CONFIG.SERVER_URL) {
    slideshowEnabled = true;
    log(`Cloud slideshow enabled: Gallery ${CONFIG.GALLERY_ID}`, 'INFO');
  } else {
    log('Slideshow disabled - set MEURAL_LOCAL_SLIDESHOW_DIR or both MEURAL_SERVER_URL and MEURAL_GALLERY_ID to enable', 'INFO');
  }

  if (slideshowEnabled) {
    const slideshowInterval = setInterval(async () => {
      try {
        await runSlideshow();
      } catch (e) {
        log(`Slideshow error: ${e.message}`, 'ERROR');
      }
    }, CONFIG.POST_INTERVAL * 1000);

    // Run once immediately
    await runSlideshow();
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
