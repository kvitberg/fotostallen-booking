// Tester ICS-tolkingen og lukeberegningen i Code.gs. Kjør: node --test apps-script/test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const mod = { exports: {} };
new Function("module", fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8"))(mod);
const { busyFromIcs, parseIcs, computeSlots, buildMasks, bookingIcs, bookingTitle, pickFree, slotsOfDay, eveningKey, sunsetUtc, bookingRef, ymd, zonedToUtc } = mod.exports;

const oslo = (date, h, mi = 0) => zonedToUtc({ y: +date.slice(0, 4), m: +date.slice(5, 7), d: +date.slice(8, 10) }, h, mi, "Europe/Oslo");
const FROM = oslo("2026-10-01", 0), TO = oslo("2026-12-01", 0);
const NOW = Date.UTC(2026, 9, 16, 12, 0); // fredag 16. okt kl. 14 i Oslo

const ics = body => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body.trim().split("\n").map(l => l.trim()).join("\r\n")}\r\nEND:VCALENDAR\r\n`;
// Samme vei som i drift: opptatte perioder → masker (synkjobben) → ledige luker (webappen).
const storeFrom = busyById => ({ v: 2, updated: NOW, start: "2026-10-01", free: buildMasks(busyById, "2026-10-01", 61) });
// Alle starttider en dag (dagluker + kveldsluken), og kveldsluken alene.
const all = date => slotsOfDay(ymd(date));
const eve = date => eveningKey(ymd(date));
const without = (date, ...keys) => all(date).filter(k => !keys.includes(k));
const slotsFor = (text, from, to) => computeSlots("glenn", from, to, storeFrom({ glenn: busyFromIcs(text, FROM, TO) }), [], NOW);

test("enkel avtale med TZID blokkerer bare overlappende luker", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:a
    DTSTART;TZID=Europe/Oslo:20261019T100000
    DTEND;TZID=Europe/Oslo:20261019T113000
    END:VEVENT`);
  // 10:00–11:30 overlapper lukene 09:30–11:00 og 11:00–12:30
  assert.deepStrictEqual(slotsFor(cal, "2026-10-19", "2026-10-19"), { "2026-10-19": without("2026-10-19", "09:30", "11:00") });
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
  // 12–13Z = 14–15 i Oslo: bare luken 14:00–15:30 overlapper (12:30–14:00 slutter idet avtalen starter)
  assert.deepStrictEqual(slotsFor(cal, "2026-10-20", "2026-10-20")["2026-10-20"], without("2026-10-20", "14:00"));
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
  assert.ok(s["2026-10-26"].includes("09:30"), "opprinnelig forekomst er flyttet bort");
  assert.ok(!s["2026-10-27"].includes("14:00"), "ny tid er opptatt");
  assert.ok(!slotsFor(cal, "2026-11-02", "2026-11-02")["2026-11-02"].includes("09:30"), "serien fortsetter");
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
  assert.deepStrictEqual(s["2026-10-23"], all("2026-10-23"));
});

test("avlyste avtaler ignoreres", () => {
  const cal = ics(`
    BEGIN:VEVENT
    UID:g
    STATUS:CANCELLED
    DTSTART;TZID=Europe/Oslo:20261019T080000
    DTEND;TZID=Europe/Oslo:20261019T170000
    END:VEVENT`);
  assert.deepStrictEqual(slotsFor(cal, "2026-10-19", "2026-10-19")["2026-10-19"], all("2026-10-19"));
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
  assert.ok(!s["2026-10-20"].includes("12:30") && !s["2026-10-20"].includes("15:30"), "andre dag fortsatt med");
  assert.ok(s["2026-10-21"].includes("12:30") && s["2026-10-21"].includes("15:30"), "tredje dag ikke med");
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
  assert.deepStrictEqual(slotsFor(cal, "2026-10-23", "2026-10-23")["2026-10-23"], all("2026-10-23"));
});

test("helg, dagens passerte luker og første ledige", () => {
  const empty = slotsFor(ics(""), "2026-10-16", "2026-10-19");
  assert.deepStrictEqual(empty["2026-10-16"], [eve("2026-10-16")], "fredag 14:00 + 3 t: bare kveldsluken igjen");
  assert.strictEqual(empty["2026-10-17"], undefined, "lørdag");
  assert.deepStrictEqual(empty["2026-10-19"], all("2026-10-19"));
  const allDay = [{ start: oslo("2026-10-19", 7), end: oslo("2026-10-19", 22) }];
  const store = storeFrom({ glenn: allDay, lars: [], kevin: allDay, scott: allDay, kristine: allDay, henrik: allDay, forste: [] });
  assert.deepStrictEqual(computeSlots("forste", "2026-10-19", "2026-10-19", store, [], NOW)["2026-10-19"], all("2026-10-19"), "én ledig fotograf holder");
  assert.strictEqual(computeSlots("glenn", "2026-10-19", "2026-10-19", store, [], NOW)["2026-10-19"], undefined, "Glenn er opptatt");
  const taken = storeFrom({ forste: [{ start: oslo("2026-10-19", 10), end: oslo("2026-10-19", 12) }] });
  const t = computeSlots("forste", "2026-10-19", "2026-10-19", taken, [], NOW)["2026-10-19"];
  assert.ok(!t.includes("09:30") && !t.includes("11:00") && t.includes("12:30"), "tatt av annen første ledige-booking");
});

test("bookinger i køen blokkerer luken med en gang", () => {
  const queue = [{ photographer: "kevin", date: "2026-10-20", time: "09:30" }, { photographer: "forste", date: "2026-10-20", time: "14:00" }];
  const kevin = computeSlots("kevin", "2026-10-20", "2026-10-20", null, queue, NOW)["2026-10-20"];
  assert.deepStrictEqual(kevin, without("2026-10-20", "09:30"), "Kevins kø blokkerer bare Kevin, ikke første ledige-luken");
  const any = computeSlots("forste", "2026-10-20", "2026-10-20", null, queue, NOW)["2026-10-20"];
  assert.ok(any.includes("09:30") && !any.includes("14:00"));
});

test("uten synkdata, eller med gammelt format, er alle luker på hverdager ledige", () => {
  assert.deepStrictEqual(computeSlots("scott", "2026-10-19", "2026-10-23", null, [], NOW)["2026-10-21"], all("2026-10-21"));
  const old = { updated: NOW, start: "2026-10-01", free: { scott: "0".repeat(61) } }; // v1 (base-32), alt opptatt
  assert.deepStrictEqual(computeSlots("scott", "2026-10-21", "2026-10-21", old, [], NOW)["2026-10-21"], all("2026-10-21"), "v1-data brukes ikke");
});

test("kveldsluken starter ved solnedgang, rundet opp til kvarter", () => {
  const min = k => Number(k.slice(0, 2)) * 60 + Number(k.slice(3));
  const ssMin = date => { const t = new Date(sunsetUtc(ymd(date))).toLocaleTimeString("nb-NO", { timeZone: "Europe/Oslo", hour: "2-digit", minute: "2-digit" }).split(/[:.]/).map(Number); return t[0] * 60 + t[1]; };
  assert.strictEqual(eve("2027-05-05"), "21:30", "Scotts eksempel: solnedgang 21:23");
  for (const d of ["2026-10-19", "2026-12-21", "2027-03-20", "2027-06-21", "2027-05-05"]) {
    assert.ok(min(eve(d)) >= ssMin(d), `${d}: aldri før solnedgang (${eve(d)})`);
    assert.ok(min(eve(d)) - ssMin(d) <= 15, `${d}: høyst et kvarter etter`);
    assert.strictEqual(min(eve(d)) % 15, 0, `${d}: kvarter`);
  }
  assert.ok(min(eve("2026-10-26")) < min(eve("2026-10-23")) - 50, "sommertid slutter 25. okt: klokka hopper en time");
});

test("masker i nytt format: én dag, sju luker", () => {
  const m = buildMasks({ scott: [{ start: oslo("2026-10-19", 8), end: oslo("2026-10-19", 9) }] }, "2026-10-19", 2);
  assert.strictEqual(m.scott.length, 4, "to heks-tegn per dag");
  assert.strictEqual(parseInt(m.scott.slice(0, 2), 16) & 1, 0, "08:00 opptatt");
  assert.strictEqual(parseInt(m.scott.slice(2, 4), 16), (1 << all("2026-10-20").length) - 1, "neste dag helt ledig");
});

test("bookingfilen til iCloud kan leses tilbake og merkes med fotograf", () => {
  const q = { id: "abc-123", photographer: "glenn", date: "2026-10-26", time: "08:00", duration: 90, services: "Dagfotografering, hel bolig + drone", address: "Torggata 1, 0181 Oslo; 3. etg",
    navn: "Kari Nordmann", telefon: "99999999", epost: "kari@example.com", oppdrag: "1234", faktura: "Krogsveen AS, faktura@example.com",
    kvm: "80", ankomst: "Kode 1234",
    products: ["Dagbilder helbolig", "Drone"], note: "Ring på\nfør du går opp" };
  const text = bookingIcs(q, NOW, "glenn");
  assert.ok(text.split("\r\n").every(l => l.length <= 75), "linjer er brettet");
  const [ev] = parseIcs(text);
  assert.strictEqual(ev.fotograf, "glenn");
  assert.strictEqual(ev.uid, "abc-123@booking.fotostallen.no");
  assert.deepStrictEqual(busyFromIcs(text, FROM, TO), [{ start: oslo("2026-10-26", 8), end: oslo("2026-10-26", 9, 30) }], "riktig tid og varighet etter sommertid");
  const flat = text.replace(/\r\n /g, "");
  assert.ok(flat.includes("SUMMARY:Nettbooking fotografering – Kari Nordmann – Torggata 1\\, 0181 Oslo\\; 3. etg"), "tittel med escaping");
  assert.ok(flat.includes("Kunde: Kari Nordmann") && flat.includes("Oppdragsnr.: 1234") && flat.includes("Faktura til: Krogsveen AS"), "kundefelt i beskrivelsen");
  assert.ok(flat.includes("Tjenester: Dagfotografering\\, hel bolig + drone"), "tjenester i beskrivelsen");
  assert.ok(!/STATUS:TENTATIVE|FORELØPIG/.test(flat), "vanlig avtale, ikke foreløpig");
});

test("tittelen tolkes av fakturaroboten som oppdrag med ukjent format (havner i Sjekk)", () => {
  // Samme mønster som fakturaroboten/src/lib/parse/tittel.ts (KONTOR_MOENSTER) – må ikke treffe.
  const KONTOR = /([A-Za-zÆØÅæøå]{2,})\s*:\s*([A-Za-zÆØÅæøå.]+(?:\s+[A-Za-zÆØÅæøå.]+)*?)\s*(?:[-–]\s*(.*))?$/;
  const t = bookingTitle({ navn: "Per: Hansen [privat]", address: "Fakturaveien 2 utsatt" });
  assert.ok(!KONTOR.test(t), "ingen «Kode:Navn»");
  assert.ok(!/fakt|utsatt|\[/i.test(t), "ingen ord som endrer behandlingen");
  assert.ok(/\bfotografering\b/.test(t), "sterkt jobbord");
});

test("første ledige i synkjobben: første ledige fotograf, men aldri Glenn", () => {
  const q = { date: "2026-10-20", time: "09:30" };
  const opptatt = [{ start: oslo("2026-10-20", 10), end: oslo("2026-10-20", 11) }];
  assert.strictEqual(pickFree({ glenn: [], lars: opptatt, kevin: [] }, q), "kevin", "Glenn hoppes over, Lars er opptatt");
  assert.strictEqual(pickFree({ glenn: [], lars: opptatt }, q), null, "bare Glenn ledig: ingen automatisk tildeling");
});

test("referansenummer", () => {
  assert.strictEqual(bookingRef("9225d5a2-84cd-4809-8603-257551e80d39"), "FS-9225D5A2");
});

const { summarizeForecast } = mod.exports;
// Oslo-tid for tester (UTC+2 i oktober): «yyyy-MM-dd HH:mm».
const osloLocal = t => new Date(Date.parse(t) + 2 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
const entry = (time, temp, n1, n6) => ({ time, data: { instant: { details: { air_temperature: temp } },
  ...(n1 && { next_1_hours: { summary: { symbol_code: n1[0] }, details: { precipitation_amount: n1[1] } } }),
  ...(n6 && { next_6_hours: { summary: { symbol_code: n6[0] }, details: { precipitation_amount: n6[1] } } }) } });

test("værvarsel: bare valgt dato i Oslo-tid, timesnedbør summeres", () => {
  const ts = [
    entry("2026-10-19T21:00:00Z", 6, ["cloudy", 0.5]),            // 23:00 den 19. – annen dato
    entry("2026-10-19T22:00:00Z", 5, ["rain", 0.4]),              // 00:00 den 20.
    entry("2026-10-20T10:00:00Z", 11, ["partlycloudy_day", 0.1], ["rain", 3]),
    entry("2026-10-20T21:00:00Z", 7, ["clearsky_night", 0]),      // 23:00 den 20.
  ];
  const s = summarizeForecast(ts, "2026-10-20", osloLocal);
  assert.deepStrictEqual(s.points.map(p => p.t), ["00:00", "12:00", "23:00"]);
  assert.strictEqual(s.points[1].symbol, "partlycloudy_day", "timessymbol foran seks-timers");
  assert.strictEqual(s.precip, 0.5);
});

test("værvarsel: seks-timersverdier lenger fram telles uten overlapp", () => {
  const ts = ["T04:00", "T10:00", "T16:00", "T22:00"].map((h, i) => entry(`2026-10-25${h}:00Z`, 8, null, ["lightrain", [1, 2, 0, 4][i]]));
  const s = summarizeForecast(ts, "2026-10-25", osloLocal);   // 06, 12, 18 lokal (00:00 den 26. faller utenfor)
  assert.strictEqual(s.points.length, 3);
  assert.strictEqual(s.precip, 3);
  assert.deepStrictEqual(summarizeForecast(ts, "2026-11-30", osloLocal), { points: [], precip: 0 });
});

test("kalendernotatet tar med selger, nøkkel og usikker kvm", () => {
  const q = { id: "abc", date: "2026-10-20", time: "09:30", duration: 90, photographer: "scott", navn: "Kari", telefon: "1", epost: "k@x.no",
    faktura: "Kari", address: "Gata 1", kvm: "", kvmUsikker: true, nokkel: true, etasje: "3", leilighet: "H0301",
    selgerKontakt: true, selgerNavn: "Ola", selgerTlf: "91234567", selgerEpost: "", selgerBekreftelse: "sms" };
  const text = bookingIcs(q, NOW, "scott").replace(/\r\n /g, "").replace(/\\n/g, "\n").replace(/\\,/g, ",");
  for (const s of ["Størrelse: usikker", "Nøkkeloppdrag, etasje 3, leil. H0301", "Kontakt selger for å avtale tidspunkt.", "Selger: Ola, 91234567", "Bekreftelse til selger: SMS"])
    assert.ok(text.includes(s), s);
});
