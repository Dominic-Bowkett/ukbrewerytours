// For Viator products we could NOT fetch (image still the city+type fallback, i.e. image !== slug),
// replace the thin 2-sentence template with a fuller, honest 3-4 sentence description.
// Does NOT touch enriched products (image === slug).
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'content', 'viator');

const TYPE = {
  'beer-brewery': 'craft beer and brewery experience',
  'food': 'guided food-and-drink experience',
  'distillery-spirits': 'gin, whisky and spirits experience',
  'other': 'drinks-tasting experience',
};
const LINE2 = {
  'beer-brewery': c => `You will explore ${c}'s craft beer scene with tastings and the stories behind the beers, in the company of a knowledgeable local host.`,
  'food': c => `You will graze your way around ${c}, sampling local flavours, independent spots and hidden gems as your guide shares the stories behind them.`,
  'distillery-spirits': c => `You will go behind the scenes to see how the spirits are made and enjoy expert-led tastings along the way.`,
  'other': c => `You will sample a selection of drinks in good company while your host talks you through what you are tasting.`,
};

let updated = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const e of d.viator_experiences) {
    if (e.image === e.slug) continue; // enriched with real data — leave alone
    const label = TYPE[e.type] || TYPE.other;
    const line2 = (LINE2[e.type] || LINE2.other)(e.city);
    const title = e.title.replace(/^[A-Za-z .'&-]+:\s*/, '').trim();
    e.description_md =
      `${e.title} is a ${label} in ${e.city}. ${line2} ` +
      `Full details, the exact itinerary, live availability, up-to-date prices and traveller reviews are all on Viator. ` +
      `Booking is handled by our partner Viator; we may earn a commission at no extra cost to you.`;
    e.summary = `${label[0].toUpperCase() + label.slice(1)} in ${e.city} — ${title}. Booked via our partner Viator.`.slice(0, 158);
    updated++;
  }
  fs.writeFileSync(path.join(dir, f), JSON.stringify(d, null, 2) + '\n', 'utf8');
}
console.log(`improved fallback description for ${updated} unenriched products`);
