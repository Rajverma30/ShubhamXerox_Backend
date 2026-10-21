const fs = require('fs');
const path = require('path');

function search(dir, pattern) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        // don't recurse deep
      } else if (e.isFile()) {
        if (pattern.test(e.name)) {
          console.log(full);
        }
      }
    }
  } catch (err) {
    // ignore
  }
}

console.log('--- Downloads ---');
search('C:/Users/LOQ/Downloads', /seo|book|product|sheet|top/i);
console.log('--- Desktop ---');
search('C:/Users/LOQ/Desktop', /seo|book|product|sheet|top/i);
console.log('--- Workspace root ---');
search('S:/Machine learning/Startup/shubhamxerox2', /seo|book|product|sheet|top/i);
