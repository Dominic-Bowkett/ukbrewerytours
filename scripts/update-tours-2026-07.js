// One-off content update (July 2026): richer sectioned listings sourced from
// DesignMyNight, Hall & Woodhouse, Rambling Beer Co and Bristol Brewery Tours,
// plus price-on-enquiry changes for Heist, Moorhouse's and Birmingham.
// Run: node scripts/update-tours-2026-07.js  (then node build.js)
const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'content', 'tours.json');
const tours = JSON.parse(fs.readFileSync(file, 'utf8'));

const patches = {
  'kent-hop-farm-tour-at-hukins-hops': {
    price: '27.50',
    duration: 'Approximately 2 hours',
    schedule: 'Selected Saturdays during the season, with 11am, 1pm and 3pm time slots',
    summary: 'A two-hour guided tour of the working Hukins Hops farm in Kent — walk the 18-foot-high hop gardens, see the picking and processing facility in action, then relax in the taproom. Children attend free with a paying adult.',
    includes: [
      'Guided walk through the working hop gardens',
      'Tour of the hop picking and processing facility',
      'The story of Kent’s hop-growing heritage',
      'Taproom time afterwards (beer and food available to buy)',
    ],
    description_md: `Kent is rich in hop growing and brewing history. Visit the stunning Hukins Hops estate near Tenterden and see how a modern working hop farm feeds the craft beer market — behind-the-scenes access for hop lovers and beer enthusiasts alike, whether amateur or experienced.

# What you'll do

Step into the 18-foot-high hop gardens for a guided stroll and learn how hops are selected and grown today to meet the dynamic craft beer market — and how they influence the flavour of the beer in your glass.

Then visit the modern picking and processing facility to see how great British engineering combines with modern technology to pick, dry and process 320,000 hop plants in just 30 days of harvest.

After the tour, grab a beer in the taproom at your leisure — food is available to purchase too.

# Good to know

- Tours last approximately 2 hours, with 11am, 1pm and 3pm slots on tour days
- Groups are capped at around 20 people
- Children attend tours free with a paying adult
- Tickets are non-refundable and non-exchangeable after purchase`,
  },

  'dorset-brewery-tours': {
    schedule: 'Selected dates — booking recommended, essential for large groups',
    includes: [
      'Guided tour of the Victorian maltings and modern brewery',
      'The brewery’s 200-year story',
      'A flight of Badger beers (both options)',
      'Expert tutored tasting of the award-winning collection (Brewery Experience option)',
    ],
    description_md: `Wherever you're enjoying a tasty Badger beer, it's always special. But there's something even more wonderful about having one at the home of Badger beers — the independent, family-owned Hall & Woodhouse brewery, nestling by the River Stour at Blandford St Mary in Dorset.

# What you'll do

Explore the Victorian maltings and the modern, state-of-the-art brewery installed in 2012, taking in the rich aroma of brewing beer as your guide explains the brewery's inner workings and its 200-year journey. Tastings of the award-winning Badger beers are enjoyed at the brewery, and the Brewery Tap bar and restaurant is right there for food and a pint afterwards.

Two options are offered: the **Brewery Tour** at £17, and the **Brewery Experience** at £25, which adds an expert tutored tasting of the award-winning beer collection. Both include a flight of beers.

# Good to know

- Check in at the Brewery Shop 10 minutes before your tour
- Maximum group size is 20 — booking is recommended and essential for large groups
- Children over 10 are welcome; under-18s must be accompanied by an adult
- Wear sensible footwear — no open-toed shoes or heels
- The Brewery Tap and Shop are fully accessible, but some areas of the tour route are not suitable for guests with mobility difficulties`,
  },

  'heist-brewery-tours': {
    price: null,
    summary: 'A weekly one-hour tour of Heist Brew Co in Sheffield, seeing the brewing process behind the beers and enjoying 3 x 1/3 pints of Heist beers fresh from the tap.',
    description_md: `Heist Brew Co started brewing in Clowne, Derbyshire in 2018 and quickly built a reputation for a wide variety of bold, modern beers. Now based in Sheffield with expanded fermentation capacity and a brilliant taproom, the team brews flat out to keep the taps flowing — and opens the doors every week to show you how it's done.

# What you'll do

Join the team on their weekly brewery tour and see the process behind the beer, from raw ingredients to finished pint. Then settle into the taproom with three fresh thirds of Heist beer poured straight from the tap.

# Good to know

- Tours run every Friday, 4pm–5pm
- Includes 3 x 1/3 pints of Heist beers fresh from the tap
- Contact us for current pricing and availability`,
  },

  'moorhouses-brewery-tours': {
    price: null,
    description_md: `Discover Moorhouse's — Burnley's famous brewery, home of Pendle Witches Brew and Blond Witch — on a tour behind the scenes, finished off with a proper pie and pea supper.

# What you'll do

A 45-minute guided tour takes you behind the scenes at the brewery to see how the beers are made. Afterwards, sit down to a pie and pea supper. Fancy a drink with it? Add 4 halves of Moorhouse's beers for £6, or 4 pints for £12.

# Good to know

- Visits are arranged by prior appointment only — contact us for pricing and dates
- All bookings and pie choices must be confirmed and paid one week before the event
- Booking as a gift? Include the recipient's email address so we can send event reminders`,
  },

  'birmingham-microbrewery-experience': {
    price: null,
    description_md: `Visit several Birmingham brewery taprooms and craft beer venues in a day, with behind-the-scenes tours of the equipment at two of the city's most characterful breweries.

# What you'll do

We start the day inside Rock and Roll Brewery, where Mark and Lynn take us on a tour of the equipment at this truly unique brewery. It's then on to the award-winning Burning Soul Brewery to meet the team for another look behind the scenes and more tastings of the beers brewed on site. We finish at The Wolf for beer pairings of cheese and meats, with even more beer tastings to round off the day.

# Good to know

- Runs on Saturdays — contact us for dates and availability
- Approximately 4 hours
- Contact us for current pricing`,
  },

  'liverpool-microbrewery-experience': {
    schedule: 'Last Saturday of each month',
    summary: 'A 4-hour guided walk through Liverpool’s craft beer scene — four independent breweries and taprooms, ten craft beer tastings and a flat, walkable city-centre route, on the last Saturday of each month.',
    includes: [
      'Visits to four independent breweries and taprooms',
      'Ten craft beer tastings',
      'Expert guidance from a local beer specialist',
      'Behind-the-scenes brewery access and beer-style education',
    ],
    description_md: `Discover Liverpool's booming craft beer scene and meet its heroes. This guided walking tour takes you on an exclusive behind-the-scenes journey through some of the city's most exciting independent breweries and taprooms.

# What you'll do

Visit four independent breweries and taprooms along a flat, easily walkable route through Liverpool city centre — no strenuous hiking required. Along the way you'll taste ten different craft beers, go behind the scenes to learn how they're made, and pick up local stories and insider recommendations from your beer-specialist guide. The tour champions independent, inclusive venues throughout.

# Good to know

- Around 4 hours, depending on the route and venues
- Tours run on the last Saturday of each month — book ahead, spaces are limited and tours often sell out
- Free cancellation up to 24 hours before the tour
- Private tours available for groups of 10+, with options like cheese pairings`,
  },

  'manchester-microbrewery-experience': {
    duration: '3.5 hours',
    schedule: 'Last Saturday of each month',
    meeting_point: 'Cloudwater Brew Co, near Manchester Piccadilly',
    summary: 'A 3.5-hour guided craft beer walk through Manchester — four hand-picked brewery taprooms and ten tastings at a gentle pace, starting at Cloudwater Brew Co near Piccadilly. Trusted by over 1,000 guests.',
    includes: [
      'Ten craft beer tastings across four venues',
      'A certified beer educator as your guide',
      'Hand-picked taproom route with short walks between venues',
      'Low/no-alcohol and gluten-free options on request',
    ],
    description_md: `Explore Manchester's brilliant brewery scene on a guided craft beer walk that's been enjoyed by over 1,000 guests. Small groups, a gentle walking pace and four hand-picked taprooms make for a relaxed, social afternoon of proper beer.

# What you'll do

Meet at Cloudwater Brew Co near Manchester Piccadilly, then wander between four hand-picked brewery taprooms with only short distances between venues. Across the afternoon you'll enjoy ten craft beer tastings chosen by your guide — from familiar favourites like IPAs to more unusual and rare styles — with expert commentary on brewing, beer styles and Manchester's beer culture along the way.

# Good to know

- 3.5 hours at a gentle walking pace (roughly a mile in total — comfortable shoes recommended)
- Tours run on the last Saturday of each month — advance booking essential
- Low/no-alcohol and gluten-free options available on request
- Cancel or reschedule free of charge up to 24 hours in advance
- Private tours available for groups of 10+, including optional cheese pairings`,
  },

  'bristol-craft-beer-experience': {
    duration: '4 hours (11:45am to approx. 4pm)',
    schedule: 'Selected Saturdays — at least monthly, with more dates in summer',
    summary: 'The ultimate Bristol beer tasting experience, running since 2016: a private harbour cruise on HMS Hops with tastings, a behind-the-scenes tour at Moor Brewery, and a beer flight with cheese and meat platters at The Beer Emporium.',
    includes: [
      'Private 30-minute harbour cruise on HMS Hops with tastings',
      'Behind-the-scenes tour and taproom tastings at Moor Brewery',
      'Beer flight at The Beer Emporium',
      'Cheese and meat sharing platters',
      'Expert guide commentary throughout',
    ],
    description_md: `The ultimate Bristol beer tasting experience, running since 2016 — a Saturday afternoon that packs in a private harbour boat cruise, a behind-the-scenes brewery tour and a King Street beer flight, with cheese and meat platters along the way.

# What you'll do

**HMS Hops.** Meet outside the Grain Barge at 11:45am, then board for a 30-minute private cruise across Bristol's beautiful harbour — tasting Bristol Beer Factory beers while your guide covers beer styles and the city's brewing history, sailing past the old Bristol brewery site.

**Moor Brewery.** A short walk brings you to the award-winning Moor Brewery for a behind-the-scenes look at the brewing kit, followed by tastings in the taproom.

**The Beer Emporium.** A 20-minute stroll through Castle Park leads to the final stop on King Street: a beer flight with cheese and meat sharing platters to finish the afternoon (nibbles rather than a full meal).

# Good to know

- 4 hours: 11:45am start (boat departs midday), finishing around 4pm
- Beers are served in third-pint measures so you can sample a wider variety; keg and cask formats vary with availability
- Groups of up to 30 guests
- Refunds available up to 30 days before your tour; tours run in snow, rain and hail unless conditions are unsafe
- Private group tours available for corporate events and celebrations`,
  },

  'bermondsey-cheese-meat-beer-tour': {
    duration: 'Approximately 2.5 hours',
    schedule: 'Saturdays, 12pm–2:30pm',
    summary: 'A 2.5-hour guided tasting walk through Bermondsey’s beer mile taprooms, pairing quality British cheese and charcuterie with craft beers — small groups capped at around 13.',
    includes: [
      'Welcome drink at Southwark Brewery',
      'Beer, cheese and charcuterie tastings at every stop',
      'Expert food-and-beer pairing guidance',
      'Three Bermondsey taproom visits',
    ],
    description_md: `What could be better than cheese, meat and beer all together? This guided tasting walk showcases quality British cheese and charcuterie alongside carefully chosen craft beers, inside the taprooms of Bermondsey's famous beer mile.

# What you'll do

We meet at Southwark Brewery for a welcome drink and introduction, then head to Billy Frank's Jerky for cheese and beer tastings, before finishing in one of the neighbouring taprooms — Anspach & Hobday, Bianca Road or Moor Vaults. There's at least one tasting at every stop, and your guide talks you through how different foods and flavours pair with different styles of beer.

# What you'll taste

Soft and hard British cheeses, prosciutto and beef jerky, paired against a spread of beer styles from pale ales and IPAs through to stouts.

# Good to know

- Around 2.5 hours, Saturdays from midday
- Small groups — capped at around 13 people
- Over 18s only; bring valid ID
- All venues have step-free access; comfortable shoes recommended
- Meet at Southwark Brewery, 46 Druid Street — a short walk from London Bridge station`,
  },

  'bermondsey-beer-tasting-tour': {
    duration: '2–3.5 hours depending on time slot',
    schedule: 'Various dates, with start times from midday to 6:30pm',
    includes: [
      'Tutored beer tasting led by an accredited Beer Sommelier & Certified Cicerone®',
      'Visits to 4 taprooms on the Bermondsey beer mile',
      'Sensory evaluation techniques used by beer judges',
      'The history and evolution of the beer styles you taste',
    ],
    description_md: `London has a fantastic craft beer scene with over 130 breweries in the city — and nowhere tells the story better than Bermondsey's famous 'beer mile'. This tutored tasting tour visits the best breweries and taprooms of the mile, and it's a step up from a traditional tasting tour.

# What you'll do

Your guide — beer expert Paul Davies, an accredited Beer Sommelier and Certified Cicerone® who has worked with Fuller's and judges beer internationally — personally leads you to four taprooms along the beer mile. At each stop you'll enjoy a tutored tasting: discover how sensory analysts and beer judges evaluate the qualities and style characteristics in a glass of beer, and come away knowing the styles you're tasting, their history and their evolution.

# Good to know

- 2 to 3.5 hours depending on your time slot — start times run from midday to 6:30pm
- Small groups capped at 14, personally guided
- Meet at Southwark Brewing, 46 Druid Street — a short walk from London Bridge station
- Over 18s only; identification may be required`,
  },
};

// Light sectioning of existing copy (no new facts) for the remaining tours.
const inserts = {
  'leeds-heritage-pub-and-beer-tour': [
    ['Starting at The Tetley,', '# The route\n\nStarting at The Tetley,'],
    ['Throughout the tour, Mike will tell you', '# Drinks along the way\n\nThroughout the tour, Mike will tell you'],
    ['Your guide Mike is Leeds born and bred.', '# Your guide\n\nYour guide Mike is Leeds born and bred.'],
  ],
  'leeds-craft-beer-experience': [
    ['The day starts inside Nomadic Beers', '# What you\'ll do\n\nThe day starts inside Nomadic Beers'],
  ],
  'cardiff-craft-beer-tasting-tour': [
    ['This tour takes place inside 3 different Cardiff brewery taprooms', '# What you\'ll do\n\nThis tour takes place inside 3 different Cardiff brewery taprooms'],
  ],
  'lewes-brewery-tours': [
    ["That's The Beer Talking is founded by Dan", "# Your guide\n\nThat's The Beer Talking is founded by Dan"],
    ['Visit Harvey’s Brewery, Abyss Brewing Co.', '# What you\'ll do\n\nVisit Harvey’s Brewery, Abyss Brewing Co.'],
    ["Visit Harvey's Brewery, Abyss Brewing Co.", "# What you'll do\n\nVisit Harvey's Brewery, Abyss Brewing Co."],
  ],
};

let patched = 0, sectioned = 0;
for (const t of tours) {
  if (patches[t.old_slug]) {
    Object.assign(t, patches[t.old_slug]);
    patched++;
  }
  if (inserts[t.old_slug]) {
    for (const [find, replace] of inserts[t.old_slug]) {
      if (t.description_md.includes(find) && !t.description_md.includes(replace)) {
        t.description_md = t.description_md.replace(find, replace);
        sectioned++;
      }
    }
  }
}

fs.writeFileSync(file, JSON.stringify(tours, null, 2) + '\n');
console.log(`Patched ${patched} tours, added ${sectioned} section headings.`);
