const fs = require('fs');
const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const failed = r.result.items
  .filter(i => !i.fetched || (i.description_md || '').split(/\s+/).filter(Boolean).length < 20)
  .map(i => i.slug);
fs.writeFileSync(__dirname + '/viator-failed-slugs.json', JSON.stringify(failed));
console.log(failed.length + ' failed slugs:');
console.log(failed.join('\n'));
