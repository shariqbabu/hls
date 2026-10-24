/**
 * ⚡ Multi-Channel Live Stream Auto-Updater for GitHub Actions & Supabase
 * 
 * Automatically:
 *  1. Fetches fresh live DASH manifest & ClearKeys from Touchcric / MHDTV.
 *  2. Constructs the FULL ready-to-play URL with clearkey:
 *     `${manifestUrl}?clearkey=${kid}:${key}`
 *  3. Updates Supabase table `public.live_channels` (stream_url, cdn_url, KID, is_active).
 *  4. Updates `index.html` for GitHub Pages player.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_KEY = (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

const CHANNELS_CONFIG = [
  { key: 'sonyliv_hindi', supabaseId: 'sonyliv_hi', id: '348', name: 'SonyLiv Hindi HD', lang: 'Hindi', category: 'Cricket', sort_order: 1 },
  { key: 'sonyliv_eng',   supabaseId: 'sonyliv_en', id: '347', name: 'SonyLiv English HD', lang: 'English', category: 'Cricket', sort_order: 2 },
  { key: 'fancode',       supabaseId: 'fancode',     id: '343', name: 'FanCode HD Live', lang: 'Hindi / English', category: 'Cricket', sort_order: 3 }
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

  const manifestUrl = manifestMatch[1].trim();
  const kid = kidMatch[1].trim();
  const keyVal = keyMatch[1].trim();

  // 🚀 Construct FULL URL with clearkey for Supabase & ExoPlayer
  const fullStreamUrl = `${manifestUrl}?clearkey=${kid}:${keyVal}`;

  return {
    key: channel.key,
    supabaseId: channel.supabaseId,
    id: channel.id,
    name: channel.name,
    lang: channel.lang,
    category: channel.category,
    sort_order: channel.sort_order,
    manifestUrl,
    kid,
    keyVal,
    fullStreamUrl
  };
}

async function syncToSupabase(results) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  console.log('\n🗄️ Syncing FULL stream URLs to Supabase live_channels...');

  for (const item of results) {
    const payload = {
      id: item.supabaseId,
      title: item.name,
      stream_url: item.fullStreamUrl,  // 🚀 Full URL with ?clearkey=KID:KEY
      cdn_url: item.fullStreamUrl,
      KID: `${item.kid}:${item.keyVal}`,
      referer: REFERER,
      category: item.category,
      language: item.lang,
      quality: "1080p HD",
      is_active: true,
      sort_order: item.sort_order
    };

    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/live_channels`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates,return=representation'
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        console.log(`  ✅ [Supabase] ${item.supabaseId} -> Saved Full Stream URL:`);
        console.log(`     ${item.fullStreamUrl}`);
      } else {
        const err = await res.text();
        console.warn(`  ⚠️ [Supabase] ${item.supabaseId} error: ${err}`);
      }
    } catch (e) {
      console.warn(`  ⚠️ [Supabase] network error: ${e.message}`);
    }
  }
}

async function updateAllChannels() {
  console.log('====================================================');
  console.log('📡 Fetching & Generating FULL stream URLs for all channels...');
  console.log('====================================================');

  const freshResults = [];
  for (const ch of CHANNELS_CONFIG) {
    try {
      const res = await extractChannel(ch);
      freshResults.push(res);
      console.log(`\n✅ [${res.name}]`);
      console.log(`   Full Stream URL: ${res.fullStreamUrl}`);
      console.log(`   ClearKey       : ${res.kid}:${res.keyVal}`);
    } catch (e) {
      console.warn(`⚠️ [${ch.name}] Extraction error: ${e.message}`);
    }
  }

  if (freshResults.length === 0) {
    console.error('❌ Could not fetch any channel credentials!');
    process.exit(1);
  }

  // 1. Sync FULL URLs with ?clearkey= to Supabase
  await syncToSupabase(freshResults);

  // 2. Update index.html for Web Player
  const htmlPath = path.join(process.cwd(), 'index.html');
  if (fs.existsSync(htmlPath)) {
    let htmlContent = fs.readFileSync(htmlPath, 'utf8');
    let hasChanges = false;

    for (const fresh of freshResults) {
      const blockRegex = new RegExp(`(${fresh.key}:\\s*\\{[\\s\\S]*?manifestUrl:\\s*)"[^"]*"([\\s\\S]*?kid:\\s*)"[^"]*"([\\s\\S]*?key:\\s*)"[^"]*"`, 'i');

      const match = htmlContent.match(blockRegex);
      if (match) {
        const updatedBlock = `${match[1]}"${fresh.manifestUrl}"${match[2]}"${fresh.kid}"${match[3]}"${fresh.keyVal}"`;
        if (match[0] !== updatedBlock) {
          hasChanges = true;
          htmlContent = htmlContent.replace(blockRegex, updatedBlock);
          console.log(`🔄 Updated ${fresh.name} in index.html`);
        }
      }
    }

    if (hasChanges) {
      fs.writeFileSync(htmlPath, htmlContent, 'utf8');
      console.log('🎉 Successfully saved fresh credentials to index.html!');
    }
  }

  console.log('\n====================================================');
  console.log('✨ All channels successfully updated with FULL clearkey URLs!');
  console.log('====================================================\n');
}

updateAllChannels().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
