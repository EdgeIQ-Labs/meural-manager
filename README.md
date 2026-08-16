# Meural Watchdog 🖼️

Keep your Meural Canvas digital frame alive — no cloud required.

When Meural's cloud servers have issues (or Netgear steps back like they did), your frame goes blank. This watchdog monitors your frame via its **local API** and automatically recovers when problems are detected.

## What It Does

1. **Monitors frame health** every minute via local API
2. **Wakes sleeping frames** automatically
3. **Sends postcards** to force display when needed
4. **Optional slideshow** — cycles through your gallery images (requires local server)

## Why This Exists

Netgear is stepping back from Meural. The official app hasn't been updated in over a year, and the Nimbus Bridge (the paid alternative) costs $69+ just to start.

Your Meural frame has a local HTTP API that the official app uses internally. We can talk to it directly and keep it alive without any cloud dependency.

## Installation

```bash
# Clone or download this repo
git clone https://github.com/davemorin/meural-manager.git
cd meural-manager

# Install dependencies
npm install

# Configure
cp .env.example .env
# Edit .env and set MEURAL_FRAME_IP to your frame's IP
```

### Find Your Frame's IP

Check your router's connected devices list, or scan your network:

```bash
nmap -sn 192.168.1.0/24  # adjust for your subnet
```

Look for a device with hostname containing "meural".

## Usage

### Quick Start (Watchdog Only)

```bash
npm start
```

The watchdog will:
- Poll your frame every minute
- Wake it if sleeping
- Log everything to `/tmp/meural-watchdog/watchdog.log`

### With Slideshow (Optional)

If you're running a local Meural server (like meural-manager), enable the slideshow:

```bash
export MEURAL_SERVER_URL=http://localhost:3333
export MEURAL_GALLERY_ID=your-gallery-id
npm start
```

### As a Systemd Service

For auto-start on boot:

```bash
sudo cp meural-watchdog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable meural-watchdog
sudo systemctl start meural-watchdog
```

Check status:

```bash
sudo systemctl status meural-watchdog
journalctl -u meural-watchdog -f
```

### Debug Mode

```bash
DEBUG=true npm run dev
```

## Configuration

All settings via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `MEURAL_FRAME_IP` | `10.5.10.97` | IP of your Meural frame |
| `MEURAL_SERVER_URL` | — | Local server URL (for slideshow) |
| `MEURAL_GALLERY_ID` | — | Gallery to cycle through |
| `MEURAL_CACHE_DIR` | `/tmp/meural-watchdog/` | Image cache location |
| `CHECK_INTERVAL` | `60000` | Health check interval (ms) |
| `POST_INTERVAL` | `30` | Slideshow image interval (seconds) |
| `DEBUG` | `false` | Enable verbose logging |

## How It Works

The Meural Canvas exposes a local HTTP API at `http://<frame-ip>/`:

- `/remote/control_check/sleep/` — Is the frame sleeping?
- `/remote/control_command/resume/` — Wake it up
- `/remote/postcard/` — Send an image directly
- `/remote/get_backlight/` — Get current brightness

The watchdog uses these endpoints to monitor and recover the frame without touching Meural's cloud infrastructure.

## Local API Reference

The Meural frame's local API accepts HTTP GET/POST requests:

```
GET  http://<ip>/remote/control_check/sleep/
POST http://<ip>/remote/control_command/resume/
POST http://<ip>/remote/postcard/       (multipart form with photo)
GET  http://<ip>/remote/get_backlight/
```

These endpoints work without authentication — the frame trusts local network requests.

## Testing

Before running the full watchdog, test connectivity:

```bash
# Check if frame is reachable
curl http://10.5.10.97/

# Check sleep state
curl http://10.5.10.97/remote/control_check/sleep/

# Wake the frame
curl -X POST http://10.5.10.97/remote/control_command/resume/
```

## Troubleshooting

### Frame not responding
- Verify the frame is on the same network
- Check firewall rules (frame uses port 80)
- Try pinging the frame IP

### Blank screen persists
- The watchdog sends a postcard after waking — give it 30 seconds
- Check logs: `tail -f /tmp/meural-watchdog/watchdog.log`
- Enable debug mode for more detail

### Slideshow not working
- Ensure `MEURAL_SERVER_URL` and `MEURAL_GALLERY_ID` are set
- Verify the local server is running and accessible
- Check that gallery items have valid download URLs

## License

MIT — do whatever you want with it.

## Related

- [Meural Manager](https://github.com/davemorin/meural-manager) — Web UI for managing photos and playlists
- [Nimbus Bridge](https://nimbusdigitalart.com/meural/) — Commercial alternative ($69+)

---

*Built because Netgear abandoned Meural and I have four frames full of family photos.*
