'use strict';
const assert = require('node:assert/strict'), path = require('node:path');
const { Timestamp } = require('module').createRequire(path.join(__dirname, '..', 'functions', 'package.json'))('firebase-admin/firestore');
const L = require('../public/calendar-layout');
module.exports = async ({ page, db, cal, ok, SHOTS }) => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(Date.now());
  const phone = '353860000002', start = time => L.slots(today).find(s => s.time === time).at;
  const fixtures = [
    ['timeline-a', 'Anna Consultation', start('09:00'), start('10:30')],
    ['timeline-b', 'Brian Consultation', start('09:30'), start('10:30')],
    ['timeline-c', 'Cara Consultation', start('10:30'), start('11:00')],
    ['timeline-night', 'Previous day visit', L.range(today).from - 30 * 60000, start('00:30')]
  ];
  for (const [id, customerName, from, to] of fixtures) await db.doc('appointments/' + id).set({phone,customerName,start:Timestamp.fromMillis(from),end:Timestamp.fromMillis(to),durationMin:(to-from)/60000,type:'consultation',location:'Swords',status:'scheduled',version:1,sync:{google:{state:'synced'}}});
  await page.locator('.time-event[data-id="timeline-a"]').waitFor();
  const a=await page.locator('.time-event[data-id="timeline-a"]').boundingBox(), b=await page.locator('.time-event[data-id="timeline-b"]').boundingBox();
  assert.ok(a.x+a.width<=b.x+1 || b.x+b.width<=a.x+1, 'overlapping appointments must not cover each other');
  assert.ok(Math.abs(a.height/b.height-1.5)<.05, '90-minute block must be 1.5 times a 60-minute block');
  assert.equal(await page.locator('.time-event[draggable="true"]').count(),0);
  assert.equal(await page.locator(`.time-column[data-day="${today}"] .time-event[data-id="timeline-night"]`).count(),1);
  await db.doc('appointments/timeline-night').delete();
  await page.waitForFunction(()=>!document.querySelector('.time-event[data-id="timeline-night"]'));
  assert.equal(await page.locator('.time-slot[data-time="07:00"]').count(),0);
  assert.match(await page.locator('.time-ruler').innerText(),/20:00/);
  await page.locator('.time-hours').click();
  assert.equal(await page.locator('.time-slot[data-time="00:00"]').count(),7);
  await page.locator('.time-hours').click();
  await page.locator('.time-scroll').evaluate(e=>{e.scrollTop=0;});
  await page.screenshot({path:path.join(SHOTS,'redesign-week-desktop.png')});
  ok('Week defaults to seven days; overlapping blocks have separate columns and proportional durations; carry-in appointments are visible and hourly dragging is absent');

  await page.locator('.time-event[data-id="timeline-a"]').click();
  await page.waitForSelector('#appt-detail-dlg[open]');
  assert.match(await page.locator('#appt-detail-content').innerText(),/Anna Consultation/);
  assert.equal(await page.getByRole('button',{name:'Reschedule',exact:true}).isVisible(),true);
  await page.click('#appt-detail-close');
  await page.click('#appts-view [data-view="calendar"]');
  await page.locator(`.cal-cell[data-day="${today}"] .cal-select`).click();
  assert.equal(await page.getAttribute('#appts-view [data-view="day"]','aria-pressed'),'true');
  assert.equal(await page.locator('.time-column').count(),1);
  await page.click('#cal-next');
  assert.equal(await page.locator('.time-column').getAttribute('data-day'),L.addDays(today,1));
  await page.click('#cal-prev');
  await page.waitForFunction(()=>!document.querySelector('.time-slot[data-time="13:30"]').disabled);
  const slot=page.locator('.time-slot[data-time="13:00"]');
  await slot.focus(); await slot.press('ArrowDown');
  assert.equal(await page.evaluate(()=>document.activeElement.dataset.time),'13:30');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#appt-customer-dlg[open]');
  await page.fill('#appt-customer-search','Quinn'); await page.locator('.appt-customer-option').click();
  assert.equal(await page.inputValue('#a-date'),today); assert.equal(await page.inputValue('#a-time'),'13:30');
  assert.equal(await page.inputValue('#a-duration'),'60');
  const before=new Set((await db.collection('appointments').get()).docs.map(d=>d.id));
  await page.evaluate(()=>{const f=document.getElementById('appt-form');f.requestSubmit();f.requestSubmit();});
  await page.waitForSelector('#appt-dlg:not([open])',{state:'attached'});
  const added=(await db.collection('appointments').get()).docs.filter(d=>!before.has(d.id)); assert.equal(added.length,1);
  const booked=added[0], eventId=booked.data().sync.google.eventId;
  assert.equal(booked.data().start.toMillis(),start('13:30')); assert.equal(cal.events.has(eventId),true);
  await page.locator(`.time-event[data-id="${booked.id}"]`).click();
  await page.getByRole('button',{name:'Reschedule',exact:true}).click();
  await page.selectOption('#a-time','14:15'); await page.click('#a-go');
  await page.waitForSelector('#appt-dlg:not([open])',{state:'attached'});
  const moved=(await booked.ref.get()).data();
  assert.equal(moved.sync.google.eventId,eventId); assert.equal(moved.version,2);
  assert.equal(new Date(cal.events.get(eventId).start.dateTime).getTime(),moved.start.toMillis());
  ok('Month dates open Day; navigation and keyboard slot booking prefill the right date/time; double-submit creates one Google event and rescheduling updates the same event');

  for(const width of [1360,1024,390,320]){
    await page.setViewportSize({width,height:860});
    await page.click('#appts-view [data-view="day"]');
    await page.locator('.time-scroll').evaluate(e=>{e.scrollTop=0;});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'page overflow '+width);
    if(width<900){const box=await page.locator('.time-slot[data-time="09:00"]').boundingBox();assert.ok(box.height>=44);}
    await page.screenshot({path:path.join(SHOTS,`redesign-day-${width}.png`)});
  }
  await page.locator('.time-event[data-id="timeline-a"]').click();
  await page.waitForSelector('#appt-detail-dlg[open]');
  const detail=await page.locator('#appt-detail-dlg').boundingBox();assert.ok(detail.x>=0 && detail.x+detail.width<=320);
  await page.screenshot({path:path.join(SHOTS,'redesign-mobile-details.png')});
  await page.click('#appt-detail-close'); await page.setViewportSize({width:1360,height:860});
  ok('Compact 08:00–20:00 Day view fits desktop and 390/320px phones; all-hours toggle works, mobile hourly slots meet 44px targets and details fit the screen');
  for(const [id] of fixtures)await db.doc('appointments/'+id).delete();
  await booked.ref.delete(); cal.events.delete(eventId);
};
