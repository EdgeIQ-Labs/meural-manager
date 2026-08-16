const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const Database = require('better-sqlite3');
const ExifReader = require('exifreader');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const { CognitoIdentityProviderClient, InitiateAuthCommand } = require('@aws-sdk/client-cognito-identity-provider');
require('dotenv').config();

// Initialize Claude client for vision
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
}) : null;

// Configure multer for file uploads (100MB limit, will resize before upload)
const upload = multer({ 
  dest: '/tmp/meural-uploads/',
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max per file (will resize)
});

// Initialize SQLite database for EXIF storage
const dbPath = path.join(__dirname, 'exif-database.sqlite');
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meural_id INTEGER UNIQUE,
    original_filename TEXT,
    uploaded_at TEXT DEFAULT CURRENT_TIMESTAMP,
    
    -- Core EXIF
    date_taken TEXT,
    camera_make TEXT,
    camera_model TEXT,
    lens_model TEXT,
    focal_length REAL,
    focal_length_35mm REAL,
    aperture REAL,
    shutter_speed TEXT,
    iso INTEGER,
    exposure_compensation REAL,
    
    -- GPS
    gps_latitude REAL,
    gps_longitude REAL,
    gps_altitude REAL,
    location_name TEXT,
    
    -- Image details
    width INTEGER,
    height INTEGER,
    orientation INTEGER,
    color_space TEXT,
    white_balance TEXT,
    
    -- Full EXIF blob for anything else
    exif_json TEXT
  );
  
  CREATE INDEX IF NOT EXISTS idx_meural_id ON photos(meural_id);
  CREATE INDEX IF NOT EXISTS idx_date_taken ON photos(date_taken);
`);

// Extract EXIF from image buffer
function extractExif(buffer, filename) {
  try {
    const tags = ExifReader.load(buffer, { expanded: true });
    
    // Parse date taken
    let dateTaken = null;
    if (tags.exif?.DateTimeOriginal?.description) {
      // Format: "2024:09:25 14:30:00" -> "2024-09-25T14:30:00"
      const dt = tags.exif.DateTimeOriginal.description;
      dateTaken = dt.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3').replace(' ', 'T');
    }
    
    // Parse GPS
    let gpsLat = null, gpsLon = null, gpsAlt = null;
    if (tags.gps?.Latitude && tags.gps?.Longitude) {
      gpsLat = tags.gps.Latitude;
      gpsLon = tags.gps.Longitude;
      gpsAlt = tags.gps?.Altitude || null;
    }
    
    // Parse aperture (FNumber)
    let aperture = null;
    if (tags.exif?.FNumber?.value) {
      aperture = tags.exif.FNumber.value[0] / tags.exif.FNumber.value[1];
    }
    
    // Parse focal length
    let focalLength = null;
    if (tags.exif?.FocalLength?.value) {
      focalLength = tags.exif.FocalLength.value[0] / tags.exif.FocalLength.value[1];
    }
    
    return {
      date_taken: dateTaken,
      camera_make: tags.exif?.Make?.description || null,
      camera_model: tags.exif?.Model?.description || null,
      lens_model: tags.exif?.LensModel?.description || null,
      focal_length: focalLength,
      focal_length_35mm: tags.exif?.FocalLengthIn35mmFilm?.value || null,
      aperture: aperture,
      shutter_speed: tags.exif?.ExposureTime?.description || null,
      iso: tags.exif?.ISOSpeedRatings?.value || null,
      exposure_compensation: tags.exif?.ExposureBiasValue?.value?.[0] / tags.exif?.ExposureBiasValue?.value?.[1] || null,
      gps_latitude: gpsLat,
      gps_longitude: gpsLon,
      gps_altitude: gpsAlt,
      width: tags.file?.['Image Width']?.value || tags.exif?.PixelXDimension?.value || null,
      height: tags.file?.['Image Height']?.value || tags.exif?.PixelYDimension?.value || null,
      orientation: tags.exif?.Orientation?.value || null,
      color_space: tags.exif?.ColorSpace?.description || null,
      white_balance: tags.exif?.WhiteBalance?.description || null,
      exif_json: JSON.stringify(tags)
    };
  } catch (err) {
    console.error('EXIF extraction error:', err.message);
    return { exif_json: null };
  }
}

// Save photo EXIF to database
function savePhotoExif(meuralId, filename, exifData) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO photos (
      meural_id, original_filename, date_taken, camera_make, camera_model,
      lens_model, focal_length, focal_length_35mm, aperture, shutter_speed,
      iso, exposure_compensation, gps_latitude, gps_longitude, gps_altitude,
      width, height, orientation, color_space, white_balance, exif_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    meuralId, filename, exifData.date_taken, exifData.camera_make, exifData.camera_model,
    exifData.lens_model, exifData.focal_length, exifData.focal_length_35mm, exifData.aperture,
    exifData.shutter_speed, exifData.iso, exifData.exposure_compensation,
    exifData.gps_latitude, exifData.gps_longitude, exifData.gps_altitude,
    exifData.width, exifData.height, exifData.orientation, exifData.color_space,
    exifData.white_balance, exifData.exif_json
  );
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MEURAL_API = 'https://api.meural.com/v0';
const COGNITO_CLIENT_ID = '487bd4kvb1fnop6mbgk8gu5ibf';
const COGNITO_REGION = 'eu-west-1';

let authToken = null;
let tokenExpiry = null;

// Auth helper using AWS Cognito (new Meural auth method)
let refreshInterval = null;

async function getToken(forceRefresh = false) {
  const now = Date.now();
  // Refresh 5 minutes (300000 ms) before expiry
  if (!forceRefresh && authToken && tokenExpiry && now < tokenExpiry - 300000) {
    return authToken;
  }
  
  const username = process.env.MEURAL_USERNAME;
  // Read password from file to handle special chars like #
  let password = process.env.MEURAL_PASSWORD;
  try {
    const fs = require('fs');
    const pwFile = path.join(__dirname, '.meural-password');
    if (fs.existsSync(pwFile)) {
      password = fs.readFileSync(pwFile, 'utf8').trim();
    }
  } catch (e) {}
  
  if (!username || !password) {
    throw new Error('MEURAL_USERNAME and MEURAL_PASSWORD must be set in .env');
  }
  
  const client = new CognitoIdentityProviderClient({ region: COGNITO_REGION });
  
  const command = new InitiateAuthCommand({
    ClientId: COGNITO_CLIENT_ID,
    AuthFlow: 'USER_PASSWORD_AUTH',
    AuthParameters: {
      USERNAME: username,
      PASSWORD: password,
    },
  });
  
  const response = await client.send(command);
  
  if (!response.AuthenticationResult?.AccessToken) {
    throw new Error('Authentication failed: ' + JSON.stringify(response));
  }
  
  authToken = response.AuthenticationResult.AccessToken;
  tokenExpiry = Date.now() + 3600000; // 1 hour
  return authToken;
}

// Proactive token refresh — runs every 5 minutes, refreshes if within 10 min of expiry
function startTokenRefresher() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    try {
      await getToken(true); // force refresh
      console.log('[Meural] Token refreshed proactively');
    } catch (err) {
      console.error('[Meural] Proactive token refresh failed:', err.message);
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

// Stop the refresher (for graceful shutdown)
function stopTokenRefresher() {
  if (refreshInterval) clearInterval(refreshInterval);
}

// Meural API proxy
async function meuralRequest(method, path, body = null, retryCount = 0) {
  const token = await getToken();
  const opts = {
    method,
    headers: {
      'Authorization': `Token ${token}`,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  
  const res = await fetch(`${MEURAL_API}${path}`, opts);
  
  // If 401, token might be invalid — force refresh and retry once
  if (res.status === 401 && retryCount === 0) {
    console.log('[Meural] Got 401, forcing token refresh and retrying...');
    await getToken(true);
    return meuralRequest(method, path, body, 1);
  }
  
  return res.json();
}

// Start token refresher on server start
startTokenRefresher();

// Graceful shutdown
process.on('SIGTERM', () => { stopTokenRefresher(); process.exit(0); });
process.on('SIGINT', () => { stopTokenRefresher(); process.exit(0); });

// === API Routes ===

// Get user info (includes storage)
app.get('/api/user', async (req, res) => {
  try {
    const data = await meuralRequest('GET', '/user');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all user items (photos) with pagination
app.get('/api/items', async (req, res) => {
  try {
    const page = req.query.page || 1;
    const count = req.query.count || 100;
    const data = await meuralRequest('GET', `/user/items?page=${page}&count=${count}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload items (photos)
// Upload a single photo to Meural (shared helper)
async function uploadSinglePhoto(file, token, totalFiles) {
  let fileBuffer = fs.readFileSync(file.path);
  const exifData = extractExif(fileBuffer, file.originalname);
  const resizeResult = await resizeIfNeeded(fileBuffer, file.originalname);
  fileBuffer = resizeResult.buffer;

  const mimeType = resizeResult.resized ? 'image/jpeg' : file.mimetype;
  const blob = new Blob([fileBuffer], { type: mimeType });
  const form = new FormData();
  form.append('image', blob, file.originalname);

  const response = await fetch(`${MEURAL_API}/items`, {
    method: 'POST',
    headers: { 'Authorization': `Token ${token}` },
    body: form
  });

  const responseText = await response.text();
  let data;
  try {
    data = JSON.parse(responseText);
  } catch (parseErr) {
    console.error(`Upload failed for ${file.originalname}: HTTP ${response.status}, body: ${responseText.substring(0, 300)}`);
    throw new Error(`Meural API returned non-JSON (HTTP ${response.status}).`);
  }

  let location = null;
  let smartDescription = null;
  let visionCaption = null;

  if (response.ok && data.data?.id) {
    if (exifData.gps_latitude && exifData.gps_longitude) {
      location = await reverseGeocode(exifData.gps_latitude, exifData.gps_longitude);
      if (location) exifData.location_name = location.display_name;
    }

    if (totalFiles <= 5) {
      visionCaption = await analyzeImageWithVision(fileBuffer, file.mimetype);
      smartDescription = await generateSmartDescription(exifData, location, visionCaption);
      if (smartDescription) {
        try {
          await meuralRequest('PUT', `/items/${data.data.id}`, { name: smartDescription, description: smartDescription });
        } catch (e) { console.error('Failed to apply description:', e.message); }
      }
    }

    savePhotoExif(data.data.id, file.originalname, exifData);
  }

  fs.unlinkSync(file.path);

  return {
    filename: file.originalname,
    success: response.ok,
    meural_id: response.ok ? data.data?.id : null,
    resized: resizeResult.resized ? {
      from: `${(resizeResult.originalSize / 1024 / 1024).toFixed(1)}MB`,
      to: `${(resizeResult.newSize / 1024 / 1024).toFixed(1)}MB`,
      dimensions: resizeResult.dimensions
    } : null,
    exif: response.ok ? {
      date_taken: exifData.date_taken,
      camera: exifData.camera_model,
      lens: exifData.lens_model,
      aperture: exifData.aperture,
      shutter: exifData.shutter_speed,
      iso: exifData.iso,
      gps: exifData.gps_latitude ? true : false,
      location: location?.city || location?.display_name || null,
      season: getSeason(exifData.date_taken)
    } : null,
    vision_caption: visionCaption,
    smart_description: smartDescription,
    error: response.ok ? null : data
  };
}

// SSE streaming upload endpoint — real-time progress + parallel uploads
app.post('/api/items/upload-stream', upload.any(), async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files received' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const token = await getToken();
    const total = files.length;
    const concurrency = 4;
    let completed = 0;
    const results = [];

    send('start', { total });

    // Process in parallel batches
    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async (file) => {
          try {
            const result = await uploadSinglePhoto(file, token, total);
            completed++;
            send('progress', { completed, total, filename: result.filename, success: result.success });
            return result;
          } catch (err) {
            completed++;
            const failResult = { filename: file.originalname, success: false, error: err.message };
            send('progress', { completed, total, filename: file.originalname, success: false, error: err.message });
            try { fs.unlinkSync(file.path); } catch (e) {}
            return failResult;
          }
        })
      );
      results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : r.reason));
    }

    send('done', { results });
  } catch (err) {
    send('error', { message: err.message });
  }

  res.end();
});

// Legacy non-streaming upload endpoint (kept for backward compat)
app.post('/api/items/upload', upload.any(), async (req, res) => {
  try {
    const token = await getToken();
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files received' });
    }

    const concurrency = 4;
    const results = [];

    for (let i = 0; i < files.length; i += concurrency) {
      const batch = files.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(async (file) => {
          try {
            return await uploadSinglePhoto(file, token, files.length);
          } catch (err) {
            try { fs.unlinkSync(file.path); } catch (e) {}
            return { filename: file.originalname, success: false, error: err.message };
          }
        })
      );
      results.push(...batchResults.map(r => r.status === 'fulfilled' ? r.value : r.reason));
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get EXIF stats summary (must be before :meuralId route)
app.get('/api/exif/stats', (req, res) => {
  try {
    const cameras = db.prepare('SELECT camera_model, COUNT(*) as count FROM photos WHERE camera_model IS NOT NULL GROUP BY camera_model ORDER BY count DESC').all();
    const lenses = db.prepare('SELECT lens_model, COUNT(*) as count FROM photos WHERE lens_model IS NOT NULL GROUP BY lens_model ORDER BY count DESC').all();
    const years = db.prepare("SELECT strftime('%Y', date_taken) as year, COUNT(*) as count FROM photos WHERE date_taken IS NOT NULL GROUP BY year ORDER BY year DESC").all();
    const withGps = db.prepare('SELECT COUNT(*) as count FROM photos WHERE gps_latitude IS NOT NULL').get();
    const total = db.prepare('SELECT COUNT(*) as count FROM photos').get();
    
    res.json({
      total: total.count,
      with_gps: withGps.count,
      cameras,
      lenses,
      years
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all photos with EXIF data
app.get('/api/exif', (req, res) => {
  try {
    const stmt = db.prepare(`
      SELECT meural_id, original_filename, date_taken, camera_make, camera_model,
             lens_model, focal_length, aperture, shutter_speed, iso,
             gps_latitude, gps_longitude, location_name, width, height
      FROM photos 
      ORDER BY date_taken DESC
    `);
    const photos = stmt.all();
    res.json({ data: photos, count: photos.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get EXIF data for a photo
app.get('/api/exif/:meuralId', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM photos WHERE meural_id = ?');
    const photo = stmt.get(req.params.meuralId);
    if (photo) {
      res.json({ data: photo });
    } else {
      res.json({ data: null, message: 'No EXIF data found for this photo' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete an item
app.delete('/api/items/:id', async (req, res) => {
  try {
    const data = await meuralRequest('DELETE', `/items/${req.params.id}`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk delete items
app.post('/api/items/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    const results = [];
    for (const id of ids) {
      try {
        await meuralRequest('DELETE', `/items/${id}`);
        results.push({ id, success: true });
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update item metadata (name, description, etc.)
app.put('/api/items/:id', async (req, res) => {
  try {
    const data = await meuralRequest('PUT', `/items/${req.params.id}`, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analyze existing photo with vision and generate smart description
app.post('/api/items/:id/analyze', async (req, res) => {
  try {
    // Get the photo from Meural
    const itemData = await meuralRequest('GET', `/items/${req.params.id}`);
    if (!itemData.data) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    
    const photo = itemData.data;
    
    // Download the image
    const imageUrl = photo.image || photo.image_large;
    if (!imageUrl) {
      return res.status(400).json({ error: 'No image URL available' });
    }
    
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    
    // Get EXIF from our database if we have it
    const stmt = db.prepare('SELECT * FROM photos WHERE meural_id = ?');
    const exifRecord = stmt.get(req.params.id);
    
    // Analyze with vision
    const visionCaption = await analyzeImageWithVision(imageBuffer, 'image/jpeg');
    
    // Build location info
    let location = null;
    if (exifRecord?.gps_latitude && exifRecord?.gps_longitude) {
      location = await reverseGeocode(exifRecord.gps_latitude, exifRecord.gps_longitude);
    }
    
    // Generate smart description
    const exifData = exifRecord || {};
    const smartDescription = await generateSmartDescription(exifData, location, visionCaption);
    
    res.json({
      id: req.params.id,
      current_name: photo.name,
      current_description: photo.description,
      vision_caption: visionCaption,
      location: location?.city || null,
      season: getSeason(exifData.date_taken),
      smart_description: smartDescription
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Bulk analyze and update photos
app.post('/api/items/bulk-analyze', async (req, res) => {
  try {
    const { ids, apply = false } = req.body;
    const results = [];
    
    for (const id of ids) {
      try {
        // Get the photo from Meural
        const itemData = await meuralRequest('GET', `/items/${id}`);
        if (!itemData.data) {
          results.push({ id, success: false, error: 'Not found' });
          continue;
        }
        
        const photo = itemData.data;
        const imageUrl = photo.image || photo.image_large;
        
        if (!imageUrl) {
          results.push({ id, success: false, error: 'No image URL' });
          continue;
        }
        
        // Download and analyze
        const imageResponse = await fetch(imageUrl);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const visionCaption = await analyzeImageWithVision(imageBuffer, 'image/jpeg');
        
        // Get EXIF and location
        const stmt = db.prepare('SELECT * FROM photos WHERE meural_id = ?');
        const exifRecord = stmt.get(id);
        
        let location = null;
        if (exifRecord?.gps_latitude && exifRecord?.gps_longitude) {
          location = await reverseGeocode(exifRecord.gps_latitude, exifRecord.gps_longitude);
        }
        
        const smartDescription = await generateSmartDescription(exifRecord || {}, location, visionCaption);
        
        // Apply if requested
        if (apply && smartDescription) {
          await meuralRequest('PUT', `/items/${id}`, { 
            name: smartDescription,
            description: smartDescription 
          });
        }
        
        results.push({
          id,
          success: true,
          vision_caption: visionCaption,
          smart_description: smartDescription,
          applied: apply && smartDescription ? true : false
        });
        
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
        
      } catch (err) {
        results.push({ id, success: false, error: err.message });
      }
    }
    
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all galleries (playlists)
app.get('/api/galleries', async (req, res) => {
  try {
    const data = await meuralRequest('GET', '/user/galleries');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get items in a gallery (paginated or all)
app.get('/api/galleries/:id/items', async (req, res) => {
  try {
    if (req.query.all === 'true') {
      // Fetch all items across all pages
      let allItems = [];
      let page = 1;
      const perPage = 100;
      while (true) {
        const data = await meuralRequest('GET', `/galleries/${req.params.id}/items?page=${page}&count=${perPage}`);
        const items = data.data || [];
        allItems = allItems.concat(items);
        if (items.length < perPage || data.isLast) break;
        page++;
      }
      // Enrich with local EXIF date_taken
      const exifLookup = {};
      try {
        const exifRows = db.prepare('SELECT meural_id, date_taken FROM photos WHERE date_taken IS NOT NULL').all();
        exifRows.forEach(r => { exifLookup[r.meural_id] = r.date_taken; });
      } catch (e) {}
      allItems.forEach(item => {
        item.dateTaken = exifLookup[item.id] || null;
      });
      res.json({ data: allItems, count: allItems.length });
    } else {
      const page = req.query.page || 1;
      const count = req.query.count || 100;
      const data = await meuralRequest('GET', `/galleries/${req.params.id}/items?page=${page}&count=${count}`);
      res.json(data);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a gallery
app.post('/api/galleries', async (req, res) => {
  try {
    const data = await meuralRequest('POST', '/galleries', req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a gallery
app.put('/api/galleries/:id', async (req, res) => {
  try {
    const data = await meuralRequest('PUT', `/galleries/${req.params.id}`, req.body);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a gallery
app.delete('/api/galleries/:id', async (req, res) => {
  try {
    const data = await meuralRequest('DELETE', `/galleries/${req.params.id}`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add item to gallery
app.post('/api/galleries/:galleryId/items/:itemId', async (req, res) => {
  try {
    const data = await meuralRequest('POST', `/galleries/${req.params.galleryId}/items/${req.params.itemId}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove item from gallery
app.delete('/api/galleries/:galleryId/items/:itemId', async (req, res) => {
  try {
    const data = await meuralRequest('DELETE', `/galleries/${req.params.galleryId}/items/${req.params.itemId}`);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all devices (frames)
app.get('/api/devices', async (req, res) => {
  try {
    const data = await meuralRequest('GET', '/user/devices');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign gallery to device
app.post('/api/devices/:deviceId/galleries/:galleryId', async (req, res) => {
  try {
    const data = await meuralRequest('POST', `/devices/${req.params.deviceId}/galleries/${req.params.galleryId}`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get device galleries
app.get('/api/devices/:id/galleries', async (req, res) => {
  try {
    const data = await meuralRequest('GET', `/devices/${req.params.id}/galleries`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
  console.log(`Meural Manager running at http://localhost:${PORT}`);
});

// Resize image if too large for Meural (20MB limit, 1920x1080 display)
async function resizeIfNeeded(fileBuffer, filename) {
  const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
  const MAX_DIMENSION = 3000; // Max pixels on long edge
  const QUALITY = 90;
  
  // If file is small enough, return as-is
  if (fileBuffer.length <= MAX_FILE_SIZE) {
    return { buffer: fileBuffer, resized: false };
  }
  
  console.log(`Resizing ${filename}: ${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB exceeds 20MB limit`);
  
  try {
    // Get image metadata
    const metadata = await sharp(fileBuffer).metadata();
    
    // Calculate new dimensions (maintain aspect ratio)
    let width = metadata.width;
    let height = metadata.height;
    
    if (width > height && width > MAX_DIMENSION) {
      height = Math.round(height * (MAX_DIMENSION / width));
      width = MAX_DIMENSION;
    } else if (height > MAX_DIMENSION) {
      width = Math.round(width * (MAX_DIMENSION / height));
      height = MAX_DIMENSION;
    }
    
    // Resize and compress
    const resizedBuffer = await sharp(fileBuffer)
      .resize(width, height, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY, mozjpeg: true })
      .toBuffer();
    
    console.log(`Resized ${filename}: ${(fileBuffer.length / 1024 / 1024).toFixed(1)}MB → ${(resizedBuffer.length / 1024 / 1024).toFixed(1)}MB (${width}x${height})`);
    
    return { 
      buffer: resizedBuffer, 
      resized: true,
      originalSize: fileBuffer.length,
      newSize: resizedBuffer.length,
      dimensions: { width, height }
    };
  } catch (err) {
    console.error(`Failed to resize ${filename}:`, err.message);
    // Return original if resize fails
    return { buffer: fileBuffer, resized: false, error: err.message };
  }
}

// Get season from date
function getSeason(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  const month = date.getMonth(); // 0-11
  
  // Northern hemisphere seasons
  if (month >= 2 && month <= 4) return 'Spring';
  if (month >= 5 && month <= 7) return 'Summer';
  if (month >= 8 && month <= 10) return 'Fall';
  return 'Winter';
}

// Get time of day from date
function getTimeOfDay(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  const hour = date.getHours();
  
  if (hour >= 5 && hour < 8) return 'dawn';
  if (hour >= 8 && hour < 11) return 'morning';
  if (hour >= 11 && hour < 14) return 'midday';
  if (hour >= 14 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 20) return 'golden hour';
  if (hour >= 20 && hour < 22) return 'dusk';
  return 'night';
}

// Analyze image with Claude Vision
async function analyzeImageWithVision(imageBuffer, mimeType) {
  if (!anthropic) {
    console.log('No Anthropic API key configured, skipping vision analysis');
    return null;
  }
  
  try {
    const base64Image = imageBuffer.toString('base64');
    
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType || 'image/jpeg',
              data: base64Image
            }
          },
          {
            type: 'text',
            text: `Describe this photo in 3-6 words for a digital frame caption. Focus on the subject, activity, or mood. Be poetic but concise. Examples: "Kids playing in autumn leaves", "Golden hour on the beach", "Birthday candles and laughter", "Quiet morning with coffee". Just give the caption, nothing else.`
          }
        ]
      }]
    });
    
    const caption = response.content[0]?.text?.trim();
    console.log('Vision caption:', caption);
    return caption;
  } catch (err) {
    console.error('Vision analysis error:', err.message);
    return null;
  }
}

// Generate smart name from EXIF, location, and vision
async function generateSmartDescription(exifData, location, visionCaption) {
  const parts = [];
  
  // Location first (most grounding context)
  if (location?.city) {
    parts.push(location.city);
  }
  
  // Season
  const season = getSeason(exifData.date_taken);
  if (season) {
    parts.push(season);
  }
  
  // Vision caption (the star of the show)
  if (visionCaption) {
    parts.push(visionCaption);
  }
  
  // If we have nothing, fall back to date
  if (parts.length === 0 && exifData.date_taken) {
    const date = new Date(exifData.date_taken);
    parts.push(date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }));
  }
  
  return parts.join(' · ') || null;
}

// Reverse geocode GPS coordinates to location name
async function reverseGeocode(lat, lon) {
  try {
    // Using free Nominatim API (OpenStreetMap)
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`,
      { headers: { 'User-Agent': 'MeuralManager/1.0' } }
    );
    const data = await response.json();
    
    // Build a clean location name
    const parts = [];
    if (data.address?.city || data.address?.town || data.address?.village) {
      parts.push(data.address.city || data.address.town || data.address.village);
    }
    if (data.address?.state) {
      parts.push(data.address.state);
    }
    if (data.address?.country) {
      parts.push(data.address.country);
    }
    
    return {
      display_name: parts.join(', ') || data.display_name,
      city: data.address?.city || data.address?.town || data.address?.village || null,
      state: data.address?.state || null,
      country: data.address?.country || null,
      country_code: data.address?.country_code || null
    };
  } catch (err) {
    console.error('Geocoding error:', err.message);
    return null;
  }
}


