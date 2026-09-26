const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');

const BACKUP_DIR = path.join(__dirname, '..', 'backup');
const IMAGES_DIR = path.join(BACKUP_DIR, 'images');

if (!fs.existsSync(IMAGES_DIR)) {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
}

// Helper to extract all URLs recursively
function extractUrls(obj, set = new Set()) {
  if (!obj) return set;
  if (typeof obj === 'string') {
    if (obj.startsWith('http://') || obj.startsWith('https://')) {
      if (/\.(webp|jpg|jpeg|png|gif|svg|avif|pdf)($|\?)/i.test(obj) || obj.includes('/uploads/')) {
        set.add(obj);
      }
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      extractUrls(item, set);
    }
  } else if (typeof obj === 'object') {
    for (const key of Object.keys(obj)) {
      extractUrls(obj[key], set);
    }
  }
  return set;
}

async function downloadImage(url, destPath) {
  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function run() {
  console.log("Scanning all JSON backup files for image URLs...");
  const jsonFiles = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));

  const urlSet = new Set();
  for (const file of jsonFiles) {
    const filePath = path.join(BACKUP_DIR, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      extractUrls(data, urlSet);
    } catch (e) {
      console.error(`Failed to parse ${file}: ${e.message}`);
    }
  }

  const urls = Array.from(urlSet);
  console.log(`Found total ${urls.length} unique image/media URL(s) across backup files.`);

  let successCount = 0;
  let failCount = 0;
  let skippedCount = 0;

  const CONCURRENCY = 15;
  let index = 0;

  const usedFilenames = new Map(); // filename -> original URL

  async function worker() {
    while (index < urls.length) {
      const i = index++;
      const url = urls[i];

      try {
        const urlObj = new URL(url);
        let baseName = path.basename(urlObj.pathname);
        if (!baseName || baseName.length < 3) {
          const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 8);
          baseName = `image_${hash}.webp`;
        }

        // Avoid filename collisions between different URLs
        if (usedFilenames.has(baseName) && usedFilenames.get(baseName) !== url) {
          const hash = crypto.createHash('md5').update(url).digest('hex').substring(0, 6);
          const ext = path.extname(baseName);
          const nameWithoutExt = path.basename(baseName, ext);
          baseName = `${nameWithoutExt}_${hash}${ext}`;
        }
        usedFilenames.set(baseName, url);

        const destPath = path.join(IMAGES_DIR, baseName);

        if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
          skippedCount++;
          continue;
        }

        await downloadImage(url, destPath);
        successCount++;
        if (successCount % 50 === 0 || i === urls.length - 1) {
          console.log(`[Progress] Scraped ${successCount + skippedCount}/${urls.length} images...`);
        }
      } catch (err) {
        failCount++;
        console.error(`[Error] Failed ${url}: ${err.message}`);
      }
    }
  }

  const workers = [];
  for (let c = 0; c < CONCURRENCY; c++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  console.log("\n==========================================");
  console.log(`All Product & Site Media Images Downloaded!`);
  console.log(`Total URLs found: ${urls.length}`);
  console.log(`Successfully Downloaded: ${successCount}`);
  console.log(`Skipped (already exists): ${skippedCount}`);
  console.log(`Failed: ${failCount}`);
  console.log(`Images Saved in Folder: ${IMAGES_DIR}`);
  console.log("==========================================");
}

run();
