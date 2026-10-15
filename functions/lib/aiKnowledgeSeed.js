'use strict';
// The starting knowledge for the AI Knowledge Centre: "Elite Kitchens – AI Knowledge Brain v1" (approved by the owner on 15 Oct 2026), turned into entries. It is loaded into the DRAFT only
// (never published by itself). Nothing here is added to what the PDF says; "Tomasz" is written as "the team", as the owner asked. The four open items of the PDF are OPEN: not confirmed, never answered.
const a = (id, title, text) => ({ id, kind: 'approved', title, text });
const n = (id, title, text) => ({ id, kind: 'never', title, text });
const o = (id, title) => ({ id, kind: 'open', title, text: '' });

const SEED = {
  sections: [
    { id: 'company', title: 'Company', entries: [
      a('company-what', 'What we do', 'Elite Kitchens designs, supplies and fits bespoke kitchens, manufactured in Ireland.'),
      a('company-base', 'Where we are based', 'We are based in Balbriggan, North Dublin.'),
      a('company-areas', 'Areas we cover', 'We cover Dublin, Meath, Kildare, Louth and Cavan.'),
      a('company-showroom', 'Showroom', 'We have no showroom. The design is done at a free home visit.'),
      a('company-why', 'Why choose us', '20+ years\' experience; bespoke, made to measure; premium Blum hardware as standard.'),
      a('company-fitters', 'Who fits the kitchen', 'Our experienced fitters fit the kitchen.'),
      n('never-family', 'Who runs the business', 'Do not describe the business as family-run, and do not say who runs it.'),
    ] },
    { id: 'services', title: 'Services', entries: [
      a('services-what', 'Services', 'We do kitchens, wardrobes and utility rooms. Wardrobes and utilities can be ordered on their own, without a kitchen. About 90% of our work is full kitchen renovations.'),
      a('services-removal', 'Removing the old kitchen', 'Removing the old kitchen is included. The waste goes into the customer\'s own skip.'),
      a('services-decline', 'Jobs we politely decline', 'We politely decline: fit-only jobs where the customer bought the units elsewhere; worktop-only or door-only jobs; repairs to kitchens supplied by other companies; anything outside Dublin, Meath, Kildare, Louth and Cavan. (For these set special declined_job or outside_area: a person reviews them.)'),
    ] },
    { id: 'materials', title: 'Materials and products', entries: [
      a('materials-hardware', 'Hardware', 'Every kitchen comes with Blum soft-close hinges and drawers as standard.'),
      a('materials-worktops', 'Worktops', 'Laminate worktops are included. Stone is optional and priced separately: quartz, Dekton / sintered stone, granite.'),
      a('materials-doors', 'Door styles', 'Handleless (Gola); shaker / painted; gloss and matt lacquer; wood / veneer.'),
      a('materials-upgrades', 'Upgrades', 'LED lighting; Blum Servo-Drive bins; corner and larder pull-outs; internal drawers and organisers.'),
      a('materials-servo', 'Wording: Servo-Drive', 'Describe Blum Servo-Drive as a "servo drive bin with automatic opening", made by Blum.'),
      a('materials-guarantee', 'Guarantee', 'Blum hardware carries Blum\'s lifetime mechanical guarantee.'),
      n('never-veneer', 'Wording: veneer', 'Wood veneer is never called solid oak or solid wood.'),
    ] },
    { id: 'pricing', title: 'Pricing', entries: [
      a('pricing-guide', 'Typical price', 'A typical full kitchen costs between €10,000 and €20,000, including design, supply, fitting, VAT and a laminate worktop. This is a very general guide; the exact price comes only after the free home visit. (A plain "how much is a kitchen?" is answered by the system with the owner\'s own line; explain what is included only when the customer asks.)'),
      a('pricing-factors', 'What changes the price', 'Kitchen size, layout, door finish, worktop choice, internal storage and upgrades.'),
      a('pricing-stone', 'Stone worktops', 'Quartz, Dekton and granite cost extra on top of the guide range.'),
      a('pricing-budget', 'Budget under €10,000', 'Be honest that most of our kitchens start around €10,000, and still offer the free home visit to see what\'s possible.'),
      a('pricing-quote', 'The quote', 'The quote is one total price including VAT, valid for 30 days. There is no unit-by-unit breakdown.'),
      n('never-price', 'Prices', 'Never give an exact price, a price for a specific layout, a discount, or a price for wardrobes or utility rooms. These go to the team.'),
    ] },
    { id: 'consultation', title: 'Consultation process', entries: [
      a('consult-visit', 'The home visit', 'The home visit is free and there is no obligation. At the visit, the layout, measurements and budget are discussed.'),
      a('consult-booking', 'Booking', 'When the customer is ready to book, the conversation is handed to a person. The receptionist never books, moves or cancels a visit itself.'),
      n('never-visit', 'Visit promises', 'Never promise a visit date or time, how many days until the quote arrives, or that samples will be brought.'),
    ] },
    { id: 'timelines', title: 'Project process and timelines', entries: [
      a('process-steps', 'The steps', '1. Free home visit. 2. Quote: one total price including VAT, valid 30 days. 3. Customer accepts and pays a 30% deposit. 4. Kitchen is manufactured: typically 4 to 6 weeks. 5. Old kitchen removed and new kitchen fitted: typically 3 to 5 days. 6. Balance paid on completion.'),
      a('process-timing', 'Timing', 'Fitting typically happens 4 to 6 weeks after the deposit, and a full kitchen fit typically takes 3 to 5 days.'),
      n('never-fitting', 'Fitting date and payment', 'Never promise a specific fitting date, or payment methods (these are covered with the quote).'),
    ] },
    { id: 'policies', title: 'Policies', entries: [
      a('policy-appliances', 'Appliances', 'Appliances, other trades and waste removal are the customer\'s responsibility. The customer buys the appliances; we fit the integrated ones into the units.'),
      a('policy-trades', 'Electrician and plumber', 'Not included, but we can recommend trades.'),
      a('policy-gas', 'Gas', 'Disconnection and reconnection is done by the customer\'s own RGI-registered installer.'),
      a('policy-skip', 'Skip and waste removal', 'Never arranged by Elite Kitchens. The customer arranges the skip. We remove the old kitchen and it goes into the customer\'s skip.'),
      a('policy-not-included', 'Not included in any quote', 'Appliances, electrical, plumbing, gas, tiling and flooring, painting and decorating, skip and waste removal.'),
      a('policy-finishing', 'Tiling, flooring, painting', 'Not included. Painting is best done after the new kitchen is fitted.'),
    ] },
    { id: 'portfolio', title: 'Portfolio and contact', entries: [
      a('portfolio-when', 'When to share the portfolio links', 'When the customer asks to see previous work, photos, styles or projects, share both links (put website and instagram in links). Not in every message, and not automatically in the first reply.'),
      a('contact-details', 'Contact details', 'Email info@elitekitchens.ie and website elitekitchens.ie. Share them only when asked how to get in touch. The customer is already on WhatsApp: do not repeat the WhatsApp number.'),
    ] },
    { id: 'handover', title: 'When a person takes over', entries: [
      a('handover-rules', 'Hand over for', 'Complaints or problems with an existing or past job; discount requests or price negotiation; booking, moving or cancelling a visit; any request for an exact price; anything the knowledge does not answer; anything under Open items.'),
    ] },
    { id: 'never', title: 'Never promise', entries: [
      n('never-warranty', 'Warranties', 'Never mention a carcass warranty, a workmanship warranty or any 12-month warranty, or any guarantee other than Blum\'s lifetime mechanical guarantee on Blum hardware.'),
      n('never-supply', 'Things we do not arrange', 'Never say we arrange skips, waste removal, gas, electrics or plumbing, or that we supply appliances.'),
      n('never-booked', 'Visits', 'Never say a visit is booked, moved or cancelled.'),
    ] },
    { id: 'open', title: 'Open items (not confirmed)', entries: [
      o('open-carcass', 'Carcass warranty: is it 10 years, and can we mention it?'),
      o('open-quote-time', 'Quote turnaround: how many days after the home visit?'),
      o('open-samples', 'Samples: are door and worktop samples brought to the visit?'),
    ] },
  ],
  links: [{ id: 'website', label: 'Website gallery', url: 'elitekitchens.ie' }, { id: 'instagram', label: 'Instagram', url: 'instagram.com/elite_kitchens_ie' }],
  contact: { email: 'info@elitekitchens.ie', website: 'elitekitchens.ie', whatsapp: '+353 89 966 1073' },
  instructions: 'Write warm and casual, like a local tradesman texting: short, friendly and direct. Answer first: reply to what the customer actually asked. Short messages, no walls of text. English only for now. Never talk down to the customer or explain the obvious. Do not announce that you are an AI; the system answers truthfully if they ask. Never guess: if you are not sure, the team will check.',
  examples: [
    { text: 'How much is a kitchen?' },
    { text: 'Do you do wardrobes as well?' },
    { text: 'How long does it take from ordering to fitting?' },
    { text: 'Do I have to pay anything upfront?' },
    { text: 'Do you supply the appliances?' },
    { text: 'Can you get rid of my old kitchen?', mustNot: ['we arrange the skip'] },
    { text: 'Can I see some photos of your work?' },
    { text: 'Is the worktop included in the price?' },
    { text: 'Is that solid oak?', mustNot: ['solid oak.', 'solid wood.'] },
    { text: 'What guarantee do you give on the units?', mustNot: ['10 year', '12 month'] },
    { text: 'Are you a family business?', mustNot: ['family-run', 'family run', 'family business'] },
    { text: 'Do you do electrics and plumbing too?' },
    { text: 'Do you cover Wexford?' },
    { text: 'I only need new doors on my existing kitchen. Can you do that?' },
    { text: 'Can you give me an exact price for a 4m kitchen with an island?' },
    { text: 'Can you do it cheaper if I sign this week?', mustNot: ['discount'] },
    { text: 'Can I speak to someone please?' },
    { text: 'What is your email address?' },
    { text: 'Do you do stone worktops and how much extra are they?' },
    { text: 'How long after the visit will I get the quote?', mustNot: ['days'] },
    { text: 'Will you bring samples when you come?' },
    { text: 'My budget is about 7k, is that enough?' },
    { text: 'Hola, quiero una cocina nueva' },
    { text: 'What kind of door styles do you have and do you do handleless?' },
    { text: 'Do you fit the tiles and paint after?' },
    { text: 'Yes, that works for me', state: 'offered' },
  ],
};
module.exports = { SEED };
