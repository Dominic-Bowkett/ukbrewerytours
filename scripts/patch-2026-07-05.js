// One-off (July 2026): rename Manchester/Liverpool tours, add booking_url
// ticket links to tours with known external booking pages.
// Run: node scripts/patch-2026-07-05.js
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'content', 'tours.json');
const tours = JSON.parse(fs.readFileSync(file, 'utf8'));

const patches = {
  'manchester-microbrewery-experience': {
    name: 'Manchester Craft Beer Experience',
    booking_url: 'https://www.ramblingbeerco.com/manchester-beer-tour/',
  },
  'liverpool-microbrewery-experience': {
    name: 'Liverpool Craft Beer Experience',
    booking_url: 'https://www.ramblingbeerco.com/liverpool-beer-tour/',
  },
  'bermondsey-beer-tasting-tour': {
    booking_url: 'https://www.designmynight.com/london/whats-on/drinks-tasting/a-tasting-tour-of-londons-craft-breweries',
  },
  'bermondsey-cheese-meat-beer-tour': {
    booking_url: 'https://www.designmynight.com/london/pubs/southwark/southwark-brewing-company-tap-room/bermondsey-cheese-meat-and-beer-tour',
  },
  'bristol-craft-beer-experience': {
    booking_url: 'https://www.bristolbrewerytours.com/',
  },
  'kent-hop-farm-tour-at-hukins-hops': {
    booking_url: 'https://kent.designmynight.com/6093c0d4a9bfa915525eb288/kent-hop-farm-garden-tour-with-beer-tasting-1',
  },
  'dorset-brewery-tours': {
    booking_url: 'https://www.hall-woodhouse.co.uk/brewery/book-a-tour/',
  },
};

let n = 0;
for (const t of tours) {
  if (patches[t.old_slug]) { Object.assign(t, patches[t.old_slug]); n++; }
}
fs.writeFileSync(file, JSON.stringify(tours, null, 2) + '\n');
console.log(`Patched ${n} tours.`);
