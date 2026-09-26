const fs = require('fs');
const path = require('path');

const file = path.resolve(__dirname, '../../products_date_13_14.json');
const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = arr[0];

console.log('count', arr.length);
console.log('images field sample:', JSON.stringify(s.images));
console.log('keys:', Object.keys(s));

for (const [k, v] of Object.entries(s)) {
  if (/img|image|url|photo|media|cover/i.test(k)) {
    console.log('KEY', k, JSON.stringify(v).slice(0, 300));
  }
}

let found = 0;
for (const p of arr) {
  if (p.images && p.images.length) {
    found += 1;
    if (found <= 5) console.log('HAS', p.slug, JSON.stringify(p.images).slice(0, 300));
  }
}
console.log('productsWithNonEmptyImagesArray', found);

const raw = fs.readFileSync(file, 'utf8');
const urlRe = /https?:\/\/[^"\s]+?\.(?:webp|jpg|jpeg|png)/gi;
const urls = raw.match(urlRe) || [];
console.log('urlLikeInRawFile', urls.length);
console.log('sampleUrls', [...new Set(urls)].slice(0, 15));

const up = raw.match(/\/uploads\/[^"\s]+/g) || [];
console.log('uploadsPathCount', up.length);
console.log('sampleUploads', [...new Set(up)].slice(0, 15));

const imgKey = raw.includes('"images"');
const imgEmpty = (raw.match(/"images"\s*:\s*\[\s*\]/g) || []).length;
console.log({ hasImagesKey: imgKey, emptyImagesArrays: imgEmpty });
