'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ical = require('../lib/ical');

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Boardroom', 'X-WR-TIMEZONE:Europe/Dublin', ...events, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const times = (events) => events.map((e) => [e.summary, e.start.dateTime || e.start.date, e.end.dateTime || e.end.date]);
const window = (from, to) => [new Date(from), new Date(to)];
const run = (text, from, to) => ical.expand(ical.parseCalendar(text), ...window(from, to), 'Europe/Dublin');

test('links: webcal is https, and a link is told apart from an entity id', () => {
  assert.equal(ical.fetchableUrl('webcal://p01-caldav.icloud.com/published/2/abc'), 'https://p01-caldav.icloud.com/published/2/abc');
  assert.equal(ical.isCalendarUrl('https://calendar.google.com/calendar/ical/x/private-y/basic.ics'), true);
  assert.equal(ical.isCalendarUrl('webcal://example.com/a.ics'), true);
  assert.equal(ical.isCalendarUrl('calendar.boardroom'), false);
  // Its label never shows the secret part.
  assert.equal(ical.linkLabel('https://outlook.office365.com/owa/calendar/abc/secret/calendar.ics'), 'outlook.office365.com');
});

test('a Google-style calendar: UTC times, folded and escaped text, its name', () => {
  const text = ics(
    vevent('UID:1@google.com', 'DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z', 'SUMMARY:Quarterly review\\, Q3', 'DESCRIPTION:Agenda:\\n budgets and', '  the roadmap')
  );
  const cal = ical.parseCalendar(text);
  assert.equal(cal.name, 'Boardroom');
  const ev = ical.expand(cal, ...window('2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z'), 'Europe/Dublin');
  assert.deepEqual(times(ev), [['Quarterly review, Q3', '2026-10-05T08:00:00.000Z', '2026-10-05T09:00:00.000Z']]);
  assert.equal(ev[0].description, 'Agenda:\n budgets and the roadmap');
});

test("Outlook's Windows zone names, a weekly meeting, a day off and a moved one", () => {
  // Every Monday and Wednesday at 10:00 Irish time, from 28 Sep 2026.
  // 7 Oct is excepted; 12 Oct moved to 14:00; 14 Oct cancelled.
  const text = ics(
    vevent(
      'UID:standup',
      'DTSTART;TZID=GMT Standard Time:20260928T100000',
      'DTEND;TZID=GMT Standard Time:20260928T103000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1',
      'EXDATE;TZID=GMT Standard Time:20261007T100000',
      'SUMMARY:Stand-up'
    ),
    vevent('UID:standup', 'RECURRENCE-ID;TZID=GMT Standard Time:20261012T100000', 'DTSTART;TZID=GMT Standard Time:20261012T140000', 'DTEND;TZID=GMT Standard Time:20261012T143000', 'SUMMARY:Stand-up (moved)'),
    vevent('UID:standup', 'RECURRENCE-ID;TZID=GMT Standard Time:20261014T100000', 'DTSTART;TZID=GMT Standard Time:20261014T100000', 'DTEND;TZID=GMT Standard Time:20261014T103000', 'STATUS:CANCELLED', 'SUMMARY:Stand-up')
  );
  const ev = run(text, '2026-10-05T00:00:00Z', '2026-10-17T00:00:00Z');
  assert.deepEqual(times(ev), [
    ['Stand-up', '2026-10-05T09:00:00.000Z', '2026-10-05T09:30:00.000Z'], // 10:00 IST is 09:00 UTC
    ['Stand-up (moved)', '2026-10-12T13:00:00.000Z', '2026-10-12T13:30:00.000Z']
  ]);
});

test('a weekly meeting keeps its local time across the clocks going back', () => {
  const text = ics(vevent('UID:w', 'DTSTART;TZID=Europe/Dublin:20261019T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;COUNT=3', 'SUMMARY:Weekly'));
  // Ireland goes from IST (UTC+1) to GMT on 25 Oct 2026.
  assert.deepEqual(
    run(text, '2026-10-01T00:00:00Z', '2026-12-01T00:00:00Z').map((e) => e.start.dateTime),
    ['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z', '2026-11-02T09:00:00.000Z']
  );
});

test('monthly rules: the second Tuesday, the last Friday, the last weekday, the 31st', () => {
  const starts = (rule, from = '20260101T120000') =>
    run(ics(vevent('UID:m', `DTSTART;TZID=Europe/Dublin:${from}`, 'DURATION:PT30M', rule, 'SUMMARY:x')), '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z').map((e) => e.start.dateTime.slice(0, 10));
  assert.deepEqual(starts('RRULE:FREQ=MONTHLY;BYDAY=2TU'), ['2026-01-13', '2026-02-10', '2026-03-10', '2026-04-14']);
  assert.deepEqual(starts('RRULE:FREQ=MONTHLY;BYDAY=-1FR'), ['2026-01-30', '2026-02-27', '2026-03-27', '2026-04-24']);
  assert.deepEqual(starts('RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1'), ['2026-01-30', '2026-02-27', '2026-03-31', '2026-04-30']);
  // A month without a 31st is skipped, as the standard says.
  assert.deepEqual(starts('RRULE:FREQ=MONTHLY', '20260131T120000'), ['2026-01-31', '2026-03-31']);
});

test('daily with UNTIL, every other week, and yearly', () => {
  const starts = (rule, from, to) =>
    run(ics(vevent('UID:r', `DTSTART:${from}`, 'DURATION:PT1H', rule, 'SUMMARY:x')), '2026-01-01T00:00:00Z', to).map((e) => e.start.dateTime.slice(0, 10));
  assert.deepEqual(starts('RRULE:FREQ=DAILY;UNTIL=20260104T235959Z', '20260101T090000Z', '2026-02-01T00:00:00Z'), ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  assert.deepEqual(starts('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH', '20260101T090000Z', '2026-02-15T00:00:00Z'), ['2026-01-01', '2026-01-15', '2026-01-29', '2026-02-12']);
  assert.deepEqual(starts('RRULE:FREQ=YEARLY', '20200615T090000Z', '2028-01-01T00:00:00Z'), ['2026-06-15', '2027-06-15']);
});

test('all-day events stay dates; one from years ago repeats into this week', () => {
  const text = ics(
    vevent('UID:a', 'DTSTART;VALUE=DATE:20261005', 'DTEND;VALUE=DATE:20261006', 'SUMMARY:Offsite'),
    vevent('UID:b', 'DTSTART;VALUE=DATE:20100105', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:Bins')
  );
  assert.deepEqual(times(run(text, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z')), [
    ['Bins', '2026-10-05', '2026-10-06'],
    ['Offsite', '2026-10-05', '2026-10-06']
  ]);
});

test('an unknown zone falls back to the calendar’s own; a long-running daily rule is quick', () => {
  const text = ics(vevent('UID:z', 'DTSTART;TZID=Somewhere Odd:20261005T090000', 'DTEND;TZID=Somewhere Odd:20261005T100000', 'SUMMARY:Odd'));
  assert.equal(run(text, '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z')[0].start.dateTime, '2026-10-05T08:00:00.000Z');
  const t0 = Date.now();
  const daily = ics(vevent('UID:d', 'DTSTART:20000101T090000Z', 'DURATION:PT15M', 'RRULE:FREQ=DAILY', 'SUMMARY:Daily'));
  assert.equal(run(daily, '2026-10-05T00:00:00Z', '2026-10-07T00:00:00Z').length, 2);
  assert.ok(Date.now() - t0 < 1000);
});

test('eventsFor: read once, cached, and a failure keeps the last good copy', async () => {
  ical.clearCache();
  let calls = 0;
  let fail = false;
  const fetchImpl = async () => {
    calls++;
    if (fail) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => ics(vevent('UID:1', 'DTSTART:20261005T080000Z', 'DTEND:20261005T090000Z', 'SUMMARY:Review')) };
  };
  const range = { start: new Date('2026-10-05T00:00:00Z'), end: new Date('2026-10-06T00:00:00Z') };
  const a = await ical.eventsFor('webcal://cal.example/room.ics', range, 'Europe/Dublin', { fetchImpl });
  assert.deepEqual([a.name, a.events.length, a.error], ['Boardroom', 1, '']);
  await ical.eventsFor('webcal://cal.example/room.ics', range, 'Europe/Dublin', { fetchImpl });
  assert.equal(calls, 1);
  fail = true;
  await ical.refresh('webcal://cal.example/room.ics', { fetchImpl });
  const c = await ical.eventsFor('webcal://cal.example/room.ics', range, 'Europe/Dublin', { fetchImpl });
  assert.deepEqual([c.events.length, c.error], [1, 'HTTP 503']);
  // Not a calendar at all.
  ical.clearCache();
  const d = await ical.eventsFor('https://cal.example/page', range, 'Europe/Dublin', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html></html>' }) });
  assert.match(d.error, /isn't an iCal/);
});
