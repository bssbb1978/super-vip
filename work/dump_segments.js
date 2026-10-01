const fs = require('fs');
const segs = JSON.parse(fs.readFileSync('segments.json', 'utf8'));
fs.mkdirSync('segs', { recursive: true });
segs.forEach((s, i) => {
  fs.writeFileSync(`segs/seg${i + 1}.js`, s);
});
console.log('wrote', segs.length, 'segments to segs/');
