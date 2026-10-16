// Tester ICS-tolkingen og lukeberegningen i Code.gs. Kjør: node --test apps-script/test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const mod = { exports: {} };
new Function("module", fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8"))(mod);
const { busyFromIcs, parseIcs, computeSlots, buildMasks, bookingIcs, zonedToUtc } = mod.exports;

const oslo = (date, h, mi = 0) => zonedToUtc({ y: +date.slice(0, 4), m: +date.slice(5, 7), d: +date.slice(8, 10) }, h, mi, "Europe/Oslo");
const FROM = oslo("2026-10-01", 0), TO = oslo("2026-12-01", 0);
const NOW = Date.UTC(2026, 9, 16, 12, 0); // fredag 16. okt kl. 14 i Oslo

const ics = body => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body.trim().split("\n").map(l => l.trim()).join("\r\n")}\r\nEND:VCALENDAR\r\n`;
// Samme vei som i drift: opptatte perioder → masker (synkjobben) → ledige luker (webappen).
const storeFrom = busyById => ({ updated: NOW, start: "2026-10-01", free: buildMasks(busyById, "2026-10-01", 61) });
const slotsFor = (text, from, to) => computeSlots("glenn", from, to, storeFrom({ glenn: busyFromIcs(text, FROM, TO) }), [], NOW);

test("enkel avtale med TZID blokkerer bare overlappende luker", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:a
    DTSTART;TZID=Europe/Oslo:20261019T100000
    DTEND;TZID=Europe/Oslo:20261019T113000
    END:VEVENT`);
  assert.deepStrictEqual(slotsFor(cal, "2026-10-19", "2026-10-19"), { "2026-10-19": ["08:00", "12:00", "14:00", "16:00"] });
});

test("UTC-tid (Z) og brettede linjer", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:b
    SUMMARY:En veldig lang tittel som
     fortsetter på neste linje
    DTSTART:20261020T120000Z
    DTEND:20261020T130000Z
    END:VEVENT`);
  // 12–13Z = 14–15 i Oslo
  assert.deepStrictEqual(slotsFor(cal, "2026-10-20", "2026-10-20")["2026-10-20"], ["08:00", "10:00", "12:00", "16:00"]);
});

test("ukentlig gjentakelse med BYDAY og EXDATE", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:c
    DTSTART;TZID=Europe/Oslo:20260907T080000
    DTEND;TZID=Europe/Oslo:20260907T090000
    RRULE:FREQ=WEEKLY;BYDAY=MO,WE
    EXDATE;TZID=Europe/Oslo:20261021T080000
    END:VEVENT`);
  const s = slotsFor(cal, "2026-10-19", "2026-10-23");
  assert.ok(!s["2026-10-19"].includes("08:00"), "mandag opptatt");
  assert.ok(s["2026-10-21"].includes("08:00"), "onsdag unntatt (EXDATE)");
  assert.ok(s["2026-10-20"].includes("08:00"), "tirsdag ledig");
});

test("flyttet enkeltforekomst (RECURRENCE-ID)", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:d
    DTSTART;TZID=Europe/Oslo:20261005T100000
    DTEND;TZID=Europe/Oslo:20261005T110000
    RRULE:FREQ=WEEKLY
    END:VEVENT
    BEGIN:VEVENT
    UID:d
    RECURRENCE-ID;TZID=Europe/Oslo:20261026T100000
    DTSTART;TZID=Europe/Oslo:20261027T140000
    DTEND;TZID=Europe/Oslo:20261027T150000
    END:VEVENT`);
  const s = slotsFor(cal, "2026-10-26", "2026-10-27");
  assert.ok(s["2026-10-26"].includes("10:00"), "opprinnelig forekomst er flyttet bort");
  assert.ok(!s["2026-10-27"].includes("14:00"), "ny tid er opptatt");
  assert.ok(!slotsFor(cal, "2026-11-02", "2026-11-02")["2026-11-02"].includes("10:00"), "serien fortsetter");
});

test("heldagsavtale blokkerer hele dagen, men ikke hvis den er markert ledig", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:e
    DTSTART;VALUE=DATE:20261022
    DTEND;VALUE=DATE:20261023
    END:VEVENT
    BEGIN:VEVENT
    UID:f
    DTSTART;VALUE=DATE:20261023
    DTEND;VALUE=DATE:20261024
    TRANSP:TRANSPARENT
    END:VEVENT`);
  const s = slotsFor(cal, "2026-10-22", "2026-10-23");
  assert.strictEqual(s["2026-10-22"], undefined);
  assert.strictEqual(s["2026-10-23"].length, 5);
});

test("avlyste avtaler ignoreres", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:g
    STATUS:CANCELLED
    DTSTART;TZID=Europe/Oslo:20261019T080000
    DTEND;TZID=Europe/Oslo:20261019T170000
    END:VEVENT`);
  assert.strictEqual(slotsFor(cal, "2026-10-19", "2026-10-19")["2026-10-19"].length, 5);
});

test("sommertid: luken kl. 08 er 06:00Z før og 07:00Z etter 25. oktober", () => {
  assert.strictEqual(new Date(oslo("2026-10-23", 8)).toISOString(), "2026-10-23T06:00:00.000Z");
  assert.strictEqual(new Date(oslo("2026-10-26", 8)).toISOString(), "2026-10-26T07:00:00.000Z");
});

test("serie med COUNT og dato-UNTIL stopper riktig", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:h
    DTSTART;TZID=Europe/Oslo:20261019T120000
    DTEND;TZID=Europe/Oslo:20261019T130000
    RRULE:FREQ=DAILY;COUNT=2
    END:VEVENT
    BEGIN:VEVENT
    UID:i
    DTSTART;TZID=Europe/Oslo:20261019T160000
    DTEND;TZID=Europe/Oslo:20261019T170000
    RRULE:FREQ=DAILY;UNTIL=20261020
    END:VEVENT`);
  const s = slotsFor(cal, "2026-10-19", "2026-10-21");
  assert.ok(!s["2026-10-20"].includes("12:00") && !s["2026-10-20"].includes("16:00"), "andre dag fortsatt med");
  assert.ok(s["2026-10-21"].includes("12:00") && s["2026-10-21"].includes("16:00"), "tredje dag ikke med");
});

test("månedlig siste fredag (BYDAY=-1FR)", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:j
    DTSTART;TZID=Europe/Oslo:20260925T080000
    DTEND;TZID=Europe/Oslo:20260925T170000
    RRULE:FREQ=MONTHLY;BYDAY=-1FR
    END:VEVENT`);
  assert.strictEqual(slotsFor(cal, "2026-10-30", "2026-10-30")["2026-10-30"], undefined);
  assert.strictEqual(slotsFor(cal, "2026-10-23", "2026-10-23")["2026-10-23"].length, 5);
});

test("helg, dagens passerte luker og første ledige", () => {
  const empty = slotsFor(ics(""), "2026-10-16", "2026-10-19");
  assert.strictEqual(empty["2026-10-16"], undefined, "fredag 14:00 + 3 t: ingen luker igjen");
  assert.strictEqual(empty["2026-10-17"], undefined, "lørdag");
  assert.strictEqual(empty["2026-10-19"].length, 5);
  const allDay = [{ start: oslo("2026-10-19", 8), end: oslo("2026-10-19", 18) }];
  const store = storeFrom({ glenn: allDay, lars: [], kevin: allDay, scott: allDay, kristine: allDay, henrik: allDay, forste: [] });
  assert.strictEqual(computeSlots("forste", "2026-10-19", "2026-10-19", store, [], NOW)["2026-10-19"].length, 5, "én ledig fotograf holder");
  assert.strictEqual(computeSlots("glenn", "2026-10-19", "2026-10-19", store, [], NOW)["2026-10-19"], undefined, "Glenn er opptatt");
  const taken = storeFrom({ forste: [{ start: oslo("2026-10-19", 10), end: oslo("2026-10-19", 12) }] });
  assert.ok(!computeSlots("forste", "2026-10-19", "2026-10-19", taken, [], NOW)["2026-10-19"].includes("10:00"), "tatt av annen første ledige-booking");
});

test("bookinger i køen blokkerer luken med en gang", () => {
  const queue = [{ photographer: "kevin", date: "2026-10-20", time: "10:00" }, { photographer: "forste", date: "2026-10-20", time: "14:00" }];
  const kevin = computeSlots("kevin", "2026-10-20", "2026-10-20", null, queue, NOW)["2026-10-20"];
  assert.deepStrictEqual(kevin, ["08:00", "12:00", "14:00", "16:00"], "Kevins kø blokkerer bare Kevin, ikke første ledige-luken");
  const any = computeSlots("forste", "2026-10-20", "2026-10-20", null, queue, NOW)["2026-10-20"];
  assert.ok(any.includes("10:00") && !any.includes("14:00"));
});

test("uten synkdata er alle luker på hverdager ledige", () => {
  assert.strictEqual(computeSlots("scott", "2026-10-19", "2026-10-23", null, [], NOW)["2026-10-21"].length, 5);
});

test("bookingfilen til iCloud kan leses tilbake og merkes med fotograf", () => {
  const q = { id: "abc-123", photographer: "glenn", date: "2026-10-26", time: "08:00", address: "Torggata 1, 0181 Oslo; 3. etg",
    megler: "Kari Megler 99999999", kontor: "Krogsveen", epost: "kari@example.com", kvm: "80", ankomst: "Kode 1234",
    products: ["Dagbilder helbolig", "Drone"], note: "Ring på\nfør du går opp" };
  const text = bookingIcs(q, NOW);
  assert.ok(text.split("\r\n").every(l => l.length <= 75), "linjer er brettet");
  const [ev] = parseIcs(text);
  assert.strictEqual(ev.fotograf, "glenn");
  assert.strictEqual(ev.uid, "abc-123@booking.fotostallen.no");
  const busy = busyFromIcs(text, FROM, TO, e => e.fotograf === "glenn");
  assert.deepStrictEqual(busy, [{ start: oslo("2026-10-26", 8), end: oslo("2026-10-26", 10) }], "riktig tid etter sommertid");
  assert.deepStrictEqual(busyFromIcs(text, FROM, TO, e => e.fotograf === "kevin"), [], "filtreres per fotograf");
  assert.ok(/SUMMARY:FORELØPIG – Glenn – Torggata 1\\, 0181 Oslo\; 3. etg/.test(text.replace(/\r\n /g, "")), "tittel med escaping");
});
