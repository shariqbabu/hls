async function testAll3() {
  const channels = [
    { id: 348, name: 'SonyLiv Hindi' },
    { id: 347, name: 'SonyLiv English' },
    { id: 343, name: 'FanCode HD' }
  ];

  for (const c of channels) {
    const res = await fetch('https://api.touchcric.vip/drm/player.php?id=' + c.id, {
      headers: {
        'accept': 'text/html',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://live.mhdtv.online/'
      }
    });
    const txt = await res.text();
    const manifestMatch = txt.match(/const MANIFEST_URL\s*=\s*"([^"]+)"/i);
    const kidMatch = txt.match(/const DRM_KID\s*=\s*"([^"]+)"/i);
    const keyMatch = txt.match(/const DRM_KEY\s*=\s*"([^"]+)"/i);
    console.log(`${c.name} (ID ${c.id}):`);
    if (manifestMatch) {
      console.log('  Manifest:', manifestMatch[1]);
      console.log('  KID:', kidMatch ? kidMatch[1] : 'N/A');
      console.log('  KEY:', keyMatch ? keyMatch[1] : 'N/A');
      const mRes = await fetch(manifestMatch[1]);
      console.log('  Manifest Status:', mRes.status);
    } else {
      console.log('  Failed to extract manifest');
    }
  }
}
testAll3();
