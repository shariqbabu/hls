/**
 * ⚡ Multi-Channel Live Stream Auto-Updater for GitHub Actions
 * Fetches fresh DASH manifest URLs & ClearKey DRM for:
 *  - SonyLiv Hindi HD (ID: 348)
 *  - SonyLiv English HD (ID: 347)
 *  - FanCode HD (ID: 343)
 * And updates index.html automatically.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CHANNELS_CONFIG = [
  { key: 'sonyliv_hindi', id: '348', name: 'SonyLiv Hindi HD' },
  { key: 'sonyliv_eng',   id: '347', name: 'SonyLiv English HD' },
  { key: 'fancode',       id: '343', name: 'FanCode HD' }
];

const REFERER = "https://live.mhdtv.online/";

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
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
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

async function extractChannel(channel) {
  const url = `https://api.touchcric.vip/drm/player.php?id=${channel.id}`;
  const html = await fetchWithHeaders(url, REFERER);

  const manifestMatch = html.match(/const MANIFEST_URL\s*=\s*"([^"]+)"/i);
  const kidMatch = html.match(/const DRM_KID\s*=\s*"([^"]+)"/i);
  const keyMatch = html.match(/const DRM_KEY\s*=\s*"([^"]+)"/i);

  if (!manifestMatch || !kidMatch || !keyMatch) {
    throw new Error(`Failed to extract credentials for ${channel.name} (ID: ${channel.id})`);
  }

  return {
    key: channel.key,
    id: channel.id,
    name: channel.name,
    manifestUrl: manifestMatch[1].trim(),
    kid: kidMatch[1].trim(),
    keyVal: keyMatch[1].trim()
  };
}

async function updateAllChannels() {
  console.log('====================================================');
  console.log('📡 Fetching latest stream credentials for all channels...');
  console.log('====================================================');

  const freshResults = [];
  for (const ch of CHANNELS_CONFIG) {
    try {
      const res = await extractChannel(ch);
      freshResults.push(res);
      console.log(`✅ [${res.name}] Manifest & ClearKey fetched successfully!`);
      console.log(`   ClearKey: ${res.kid}:${res.keyVal}`);
    } catch (e) {
      console.warn(`⚠️ [${ch.name}] Extraction error: ${e.message}`);
    }
  }

  if (freshResults.length === 0) {
    console.error('❌ Could not fetch any channel credentials!');
    process.exit(1);
  }

  const htmlPath = path.join(process.cwd(), 'index.html');
  if (!fs.existsSync(htmlPath)) {
    console.error(`❌ index.html not found at: ${htmlPath}`);
    process.exit(1);
  }

  let htmlContent = fs.readFileSync(htmlPath, 'utf8');
  let hasChanges = false;

  for (const fresh of freshResults) {
    // Regex targeting specific channel object inside CHANNELS map
    const blockRegex = new RegExp(`(${fresh.key}:\\s*\\{[\\s\\S]*?manifestUrl:\\s*)"[^"]*"([\\s\\S]*?kid:\\s*)"[^"]*"([\\s\\S]*?key:\\s*)"[^"]*"`, 'i');

    const match = htmlContent.match(blockRegex);
    if (match) {
      const updatedBlock = `${match[1]}"${fresh.manifestUrl}"${match[2]}"${fresh.kid}"${match[3]}"${fresh.keyVal}"`;
      if (match[0] !== updatedBlock) {
        hasChanges = true;
        htmlContent = htmlContent.replace(blockRegex, updatedBlock);
        console.log(`🔄 Updated ${fresh.name} credentials in index.html`);
      } else {
        console.log(`✨ ${fresh.name} is already up to date.`);
      }
    }
  }

  if (hasChanges) {
    fs.writeFileSync(htmlPath, htmlContent, 'utf8');
    console.log('\n🎉 Successfully updated index.html with fresh credentials for all channels!');
  } else {
    console.log('\n✨ All channels in index.html are already 100% up to date!');
  }
}

updateAllChannels().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
