const fs = require('fs');
const j = process.argv[2];
const lines = fs.readFileSync(j, 'utf8').split(/\r?\n/).filter(Boolean);
const results = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter(o => o.type === 'result');

// Inspect the shape of the first result
if (process.argv.includes('--shape')) {
  const r = results[0];
  console.log('keys:', Object.keys(r));
  console.log(JSON.stringify(r, null, 2).slice(0, 1500));
  process.exit(0);
}

// Gather breweries from whatever field holds them
function extractArray(obj) {
  if (!obj) return [];
  // common shapes: obj.result.breweries, obj.result (array), obj.value.breweries
  const cand = obj.result ?? obj.value ?? obj.output ?? obj;
  if (Array.isArray(cand)) return cand;
  if (cand && Array.isArray(cand.breweries)) return cand.breweries;
  if (cand && Array.isArray(cand.tours)) return cand.tours;
  // find first array-of-objects property
  if (cand && typeof cand === 'object') {
    for (const k of Object.keys(cand)) {
      if (Array.isArray(cand[k]) && cand[k].length && typeof cand[k][0] === 'object') return cand[k];
    }
  }
  return [];
}

let all = [];
for (const r of results) all = all.concat(extractArray(r));
console.log('total breweries:', all.length);
if (all.length) {
  console.log('sample keys:', Object.keys(all[0]).join(', '));
  console.log(JSON.stringify(all[0], null, 2));
}
fs.writeFileSync(require('path').join(__dirname, 'brewery-research.json'), JSON.stringify(all, null, 2), 'utf8');
console.log('wrote scripts/brewery-research.json');
