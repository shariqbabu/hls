/**
 * ⚡ Live Stream Auto-Updater for GitHub Actions & Local Runner
 * Fetches fresh live DASH manifest URL & ClearKey DRM from Touchcric / MHDTV
 * and updates index.html automatically.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Target channel ID (348 = SonyLiv Hindi HD)
const CHANNEL_ID = process.env.CHANNEL_ID || "348";
const PLAYER_ENDPOINT = `https://api.touchcric.vip/drm/player.php?id=${CHANNEL_ID}`;
const REFERER = "https://live.mhdtv.online/";

// Find index.html or sonyliv_shaka_test.html
const TARGET_HTML_PATHS = [
  path.join(__dirname, 'player/index.html'),
  path.join(__dirname, 'player/.html'),
  path.join(process.cwd(), 'index.html'),
  path.join(process.cwd(), 'sonyliv.html')
];

function fetchWithHeaders(url, referer) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': referer
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode} from endpoint: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timed out (15s)'));
    });
    req.end();
  });
}

async function updatePlayer() {
  console.log('====================================================');
  console.log(`📡 Checking latest stream for Channel ID: ${CHANNEL_ID}...`);
  console.log(`Endpoint: ${PLAYER_ENDPOINT}`);
  console.log('====================================================');

  let html;
  try {
    html = await fetchWithHeaders(PLAYER_ENDPOINT, REFERER);
  } catch (err) {
    console.error(`❌ Failed to fetch stream from endpoint:`, err.message);
    process.exit(1);
  }

  // Extract Manifest URL and ClearKey
  const manifestMatch = html.match(/const MANIFEST_URL\s*=\s*"([^"]+)"/i);
  const kidMatch = html.match(/const DRM_KID\s*=\s*"([^"]+)"/i);
  const keyMatch = html.match(/const DRM_KEY\s*=\s*"([^"]+)"/i);

  if (!manifestMatch || !kidMatch || !keyMatch) {
    console.error('❌ Could not parse MANIFEST_URL or DRM_KID / DRM_KEY from response!');
    process.exit(1);
  }

  const freshManifest = manifestMatch[1].trim();
  const freshKid = kidMatch[1].trim();
  const freshKey = keyMatch[1].trim();

  console.log(`\n✅ Fresh Stream Extracted:`);
  console.log(`   Manifest URL: ${freshManifest}`);
  console.log(`   DRM KID     : ${freshKid}`);
  console.log(`   DRM Key     : ${freshKey}`);
  console.log(`   ClearKey    : ${freshKid}:${freshKey}\n`);

  // Locate target HTML file
  let htmlPath = TARGET_HTML_PATHS.find(p => fs.existsSync(p));
  if (!htmlPath) {
    // Default to index.html in current folder
    htmlPath = path.join(process.cwd(), 'index.html');
  }

  if (!fs.existsSync(htmlPath)) {
    console.warn(`⚠️ Target HTML file not found at ${htmlPath}. Creating default index.html.`);
    return;
  }

  let currentContent = fs.readFileSync(htmlPath, 'utf8');

  // Check if update is needed
  const oldManifestMatch = currentContent.match(/const MANIFEST_URL\s*=\s*"([^"]+)"/i);
  const oldKidMatch = currentContent.match(/const DRM_KID\s*=\s*"([^"]+)"/i);
  const oldKeyMatch = currentContent.match(/const DRM_KEY\s*=\s*"([^"]+)"/i);

  const oldManifest = oldManifestMatch ? oldManifestMatch[1] : '';
  const oldKid = oldKidMatch ? oldKidMatch[1] : '';
  const oldKey = oldKeyMatch ? oldKeyMatch[1] : '';

  if (oldManifest === freshManifest && oldKid === freshKid && oldKey === freshKey) {
    console.log(`✨ Player is already 100% up to date! No changes needed.`);
    return;
  }

  console.log(`🔄 Differences detected! Updating ${path.basename(htmlPath)}...`);

  let updatedContent = currentContent
    .replace(/const MANIFEST_URL\s*=\s*"[^"]*"/g, `const MANIFEST_URL = "${freshManifest}"`)
    .replace(/const DRM_KID\s*=\s*"[^"]*"/g, `const DRM_KID = "${freshKid}"`)
    .replace(/const DRM_KEY\s*=\s*"[^"]*"/g, `const DRM_KEY = "${freshKey}"`);

  fs.writeFileSync(htmlPath, updatedContent, 'utf8');
  console.log(`🎉 Successfully updated ${path.basename(htmlPath)} with fresh stream credentials!`);
}

updatePlayer().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
