/**
 * Fotostallen booking – ledige tider og foreløpige bookinger.
 *
 * To deler som deler denne filen:
 *  1) Google Apps Script-webapp (på Scotts Google-konto) som bookingsiden snakker med.
 *  2) Synkjobben på Macen (synk/kalendersynk.mjs) laster den samme filen for ICS-tolking og lukeberegning.
 *
 * Flyt:
 *  - Synkjobben leser fotografenes iCloud-kalendere (CalDAV, samme tilgang som fakturaroboten) og sender
 *    hvilke luker som er ledige («masker», ingen titler eller detaljer) hit med action=sync.
 *  - Bookingsiden spør GET ?action=slots&photographer=all&from=…&to=… og får ledige luker for
 *    «første ledige» og hver fotograf (photographer=glenn gir bare én).
 *  - Bookingsiden sender POST { action: "book", … }. Bookingen legges i en kø og blokkerer luken med en gang.
 *  - Synkjobben henter køen, legger hver booking inn i fotografens egen iCloud-kalender (for «første
 *    ledige» velges en fotograf som er ledig), og kvitterer med action=ack. Fakturaroboten ser bookingen
 *    som et oppdrag med ukjent tittelformat, så den havner i Sjekk til tittelen får vanlig format.
 *
 * Skriptegenskaper (Prosjektinnstillinger → Skriptegenskaper):
 *   SYNC_TOKEN = hemmelig nøkkel som synkjobben bruker (står i synk/.env på Macen)
 */

const CONFIG = {
  TZ: "Europe/Oslo",
  // Oppdragets varighet i minutter (standard 1,5 t). Endres her og i index.html (DURATION_MIN).
  DURATION_MIN: 90,
  // Starttider på dagtid. Kveldsfoto får i tillegg én luke per dag som starter ved solnedgang.
  DAY_SLOTS: ["08:00", "09:30", "11:00", "12:30", "14:00", "15:30"],
  EVENING: { LAT: 59.91, LON: 10.75 },
  WORKDAYS: [1, 2, 3, 4, 5], // 0 = søndag
  MIN_LEAD_HOURS: 3,
  MAX_RANGE_DAYS: 62,
  SYNC_DAYS: 120,
  MAX_BOOKINGS_PER_HOUR: 15,
  PHOTOGRAPHERS: {
    glenn: "Glenn Pettersen",
    lars: "Lars Petter Skillestad",
    kevin: "Kevin Fauske",
    scott: "Scott Kvitberg",
    kristine: "Kristine Elvemo",
    henrik: "Henrik Eriksen",
    bjorn: "Bjørn Wad",
  },
  // iCloud-kalendernavn per fotograf (samme kalendere som fakturaroboten leser).
  ICLOUD_CALENDARS: {
    glenn: "Glenn Foto",
    lars: "LPS fotostallen",
    kevin: "Kevin Foto",
    scott: "Scott foto",
    kristine: "Kristine Foto",
    henrik: "Henrik Foto",
    bjorn: "Bjørn Foto",
  },
  // Tildeles aldri automatisk som «første ledige» (Glenn bor i Ålesund), men kan velges direkte.
  AUTO_ASSIGN_EXCLUDE: ["glenn"],
  // Bekreftelse til kunden sendes fra denne adressen når den er lagt inn som alias i Gmail.
  CONFIRM_FROM: "booking@fotostallen.no",
  // Varigheter (min): vanlig, over 150 kvm og heldag (hytte, 08:00–17:00). Reisevei utenfor Oslo kommune
  // (postnummer fra 1300) blokkerer 40 min før og etter.
  DURATIONS: [90, 120, 540],
  TRAVEL_MIN: 40,
  // Værvarsel fra MET Norway (Yr). Vilkårene krever at appen identifiserer seg; svaret mellomlagres i 30 min.
  MET_USER_AGENT: "fotostallen-booking/1.0 https://fotostallen.no",
};
const ANY = "forste"; // «Første ledige»

/* ---------- Webapp ---------- */

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (p.action === "weather") return weather(p);
    if (p.action !== "slots") return json({ ok: false, error: "unknown_action" });
    const id = p.photographer;
    if (id !== "all" && id !== ANY && !CONFIG.PHOTOGRAPHERS[id]) return json({ ok: false, error: "unknown_photographer" });
    if (!isDate(p.from) || !isDate(p.to) || p.to < p.from) return json({ ok: false, error: "bad_range" });
    if (daysBetween(p.from, p.to) > CONFIG.MAX_RANGE_DAYS) return json({ ok: false, error: "range_too_long" });
    const store = readStore(), queue = readQueue(), now = Date.now();
    const slotsFor = pid => computeSlots(pid, p.from, p.to, store, queue, now);
    const slots = id === "all"
      ? [ANY].concat(Object.keys(CONFIG.PHOTOGRAPHERS)).reduce((o, pid) => { o[pid] = slotsFor(pid); return o; }, {})
      : slotsFor(id);
    return json({ ok: true, updated: store ? store.updated : null, slots });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "server" });
  }
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json({ ok: false, error: "bad_json" }); }
  if (body.action === "book") return book(body);
  if (body.action === "sync" || body.action === "ack") {
    const token = PropertiesService.getScriptProperties().getProperty("SYNC_TOKEN");
    if (!token || body.token !== token) return json({ ok: false, error: "unauthorized" });
    return body.action === "sync" ? sync(body) : ack(body);
  }
  return json({ ok: false, error: "unknown_action" });
}

function book(b) {
  const lock = LockService.getScriptLock();
  try {
    const id = b.photographer;
    if (id !== ANY && !CONFIG.PHOTOGRAPHERS[id]) return json({ ok: false, error: "unknown_photographer" });
    if (!isDate(b.date) || slotsOfDay(ymd(b.date)).indexOf(b.time) < 0) return json({ ok: false, error: "bad_slot" });
    if (!clean(b.address, 200) || !clean(b.navn, 200)) return json({ ok: false, error: "missing_fields" });
    const dur = CONFIG.DURATIONS.indexOf(Number(b.duration)) >= 0 ? Number(b.duration) : CONFIG.DURATION_MIN;
    if (dur === 540 && b.time !== "08:00") return json({ ok: false, error: "bad_slot" });
    // Reisevei avgjøres av adressen her også, så den ikke kan skrus av fra siden.
    const buf = outsideOslo(b.address) ? CONFIG.TRAVEL_MIN : 0;

    lock.waitLock(20000);
    if (tooManyBookings()) return json({ ok: false, error: "rate_limited" });
    const queue = readQueue();
    // Sjekk på nytt at tiden er ledig (noen kan ha booket i mellomtiden).
    // Hele vinduet (varighet + reisevei) må være ledig; luker som allerede er passert, teller ikke.
    const d = ymd(b.date), earliest = Date.now() + CONFIG.MIN_LEAD_HOURS * 3600e3;
    const freeOf = pid => computeSlots(pid, b.date, b.date, readStore(), queue, Date.now())[b.date] || [];
    const fits = pid => { const free = freeOf(pid); return free.indexOf(b.time) >= 0 &&
      windowKeys(d, b.time, dur, buf).every(k => free.indexOf(k) >= 0 || slotStart(d, k) < earliest); };
    const ok = id === ANY ? Object.keys(CONFIG.PHOTOGRAPHERS).some(fits) : fits(id);
    if (!ok) return json({ ok: false, error: "taken" });

    const q = {
      id: Utilities.getUuid(), created: Date.now(), photographer: id, date: b.date, time: b.time, duration: dur, buffer: buf,
      fakturaTil: b.fakturaTil === "kunde" ? "kunde" : "kontor", firma: clean(b.firma, 200), orgnr: clean(b.orgnr, 20), ehf: !!b.ehf,
      services: clean(b.services, 300),
      navn: clean(b.navn, 200), telefon: clean(b.telefon, 40), epost: clean(b.epost, 200),
      oppdrag: clean(b.oppdrag, 60), faktura: clean(b.faktura, 500),
      address: clean(b.address, 200), kvm: clean(b.kvm, 40), kvmUsikker: !!b.kvmUsikker, ankomst: clean(b.ankomst, 300),
      // Selger: skal vi avtale tid med selger, og skal selger få bekreftelse (ingen/sms/epost/begge)?
      selgerKontakt: !!b.selgerKontakt, selgerNavn: clean(b.selgerNavn, 200), selgerTlf: clean(b.selgerTlf, 40),
      selgerEpost: clean(b.selgerEpost, 200), selgerBekreftelse: ["sms", "epost", "begge"].indexOf(b.selgerBekreftelse) >= 0 ? b.selgerBekreftelse : "ingen",
      nokkel: !!b.nokkel, etasje: clean(b.etasje, 40), leilighet: clean(b.leilighet, 40),
      products: Array.isArray(b.products) ? b.products.slice(0, 10).map(x => clean(x, 60)) : [],
      note: clean(b.note, 1000),
    };
    queue.push(q);
    writeQueue(queue);
    countBooking();
    const ref = bookingRef(q.id);
    // Bekreftelser til innsender og selger sendes fra synkjobben (SMS og e-post) når bookingen legges i kalenderen.
    return json({ ok: true, ref, emailed: false });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "server" });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

/** Synkjobben sender ferske masker og får køen tilbake. */
function sync(b) {
  const d = b.data;
  if (d) {
    if (d.v !== 2 || !isDate(d.start) || typeof d.free !== "object") return json({ ok: false, error: "bad_data" });
    PropertiesService.getScriptProperties().setProperty("STORE", JSON.stringify({ v: 2, updated: Date.now(), start: d.start, free: d.free }));
  }
  return json({ ok: true, queue: readQueue() });
}

/** Synkjobben kvitterer for bookinger som er lagt inn i iCloud. */
function ack(b) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const done = {};
    (b.ids || []).forEach(x => { done[x] = true; });
    writeQueue(readQueue().filter(q => !done[q.id]));
    return json({ ok: true });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

function readStore() {
  const v = PropertiesService.getScriptProperties().getProperty("STORE");
  return v ? JSON.parse(v) : null;
}
function readQueue() {
  const v = PropertiesService.getScriptProperties().getProperty("QUEUE");
  return v ? JSON.parse(v) : [];
}
function writeQueue(q) {
  PropertiesService.getScriptProperties().setProperty("QUEUE", JSON.stringify(q));
}

/* ---------- Ledige luker (ren JavaScript, testes med node) ---------- */

/** Starttidene en dag: dagluker + kveldsluken (rundt solnedgang), sortert og uten duplikater. */
function slotsOfDay(d) {
  const keys = CONFIG.DAY_SLOTS.slice();
  const ev = eveningKey(d);
  if (ev && keys.indexOf(ev) < 0) keys.push(ev);
  return keys.sort();
}

const keyMin = key => Number(key.slice(0, 2)) * 60 + Number(key.slice(3, 5));
const minKey = m => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const slotStart = (d, key) => zonedToUtc(d, Math.floor(keyMin(key) / 60), keyMin(key) % 60, CONFIG.TZ);

/**
 * Masker (v2): for hver fotograf to heks-tegn per dag fra store.start. Bit i = 1 betyr at
 * slotsOfDay(dag)[i] er ledig i kalenderen. Uten data (ikke synket, gammelt format eller dato
 * utenfor vinduet) regnes luken som ledig.
 */
function maskFree(store, pid, date, i) {
  if (!store || store.v !== 2 || !store.free || typeof store.free[pid] !== "string") return true;
  const idx = daysBetween(store.start, date);
  const hex = store.free[pid].substr(idx * 2, 2);
  if (idx < 0 || hex.length < 2) return true;
  return ((parseInt(hex, 16) >> i) & 1) === 1;
}

/**
 * En luke er ledig når den er på en arbeidsdag, starter minst MIN_LEAD_HOURS fra nå, og
 *  - for én fotograf: ledig i fotografens kalender og ikke i køen for fotografen;
 *  - for «Første ledige»: minst én fotograf er ledig, og luken er ikke tatt av en annen «første ledige»-booking.
 */
function computeSlots(id, from, to, store, queue, nowMs) {
  const out = {};
  const earliest = nowMs + CONFIG.MIN_LEAD_HOURS * 3600e3;
  // En booking i køen blokkerer alle luker den overlapper, med varighet og eventuell reisevei.
  const queued = (pid, date, key) => queue.some(q => q.photographer === pid && q.date === date &&
    windowKeys(ymd(date), q.time, q.duration || CONFIG.DURATION_MIN, q.buffer || 0).indexOf(key) >= 0);
  const personFree = (pid, date, i, key) => maskFree(store, pid, date, i) && !queued(pid, date, key);
  const people = Object.keys(CONFIG.PHOTOGRAPHERS);
  for (let d = ymd(from); fmtYmd(d) <= to; d = addDays(d, 1)) {
    const date = fmtYmd(d);
    if (CONFIG.WORKDAYS.indexOf(weekdayOf(d)) < 0) continue;
    const free = [];
    slotsOfDay(d).forEach((key, i) => {
      if (slotStart(d, key) < earliest) return;
      const ok = id === ANY
        ? personFree(ANY, date, i, key) && people.some(pid => personFree(pid, date, i, key))
        : personFree(id, date, i, key);
      if (ok) free.push(key);
    });
    if (free.length) out[date] = free;
  }
  return out;
}

/** Utenfor Oslo kommune: siste postnummer i adressen (fire sifre fulgt av stedsnavn) er 1300 eller høyere. */
function outsideOslo(text) {
  const all = String(text || "").match(/(?:^|[\s,])(\d{4})\s+[A-Za-zÆØÅæøåÉé]/g);
  if (!all) return false;
  return +all[all.length - 1].match(/\d{4}/)[0] >= 1300;
}

/** Lukene et oppdrag berører: alle luker som overlapper [start − reisevei, slutt + reisevei]. */
function windowKeys(d, key, durMin, bufMin) {
  const a = slotStart(d, key) - bufMin * 60e3, b = slotStart(d, key) + (durMin + bufMin) * 60e3;
  return slotsOfDay(d).filter(k => slotStart(d, k) < b && slotStart(d, k) + CONFIG.DURATION_MIN * 60e3 > a);
}

/** Brukes av synkjobben: lager masker (v2) fra opptatte perioder per fotograf. */
function buildMasks(busyById, start, days) {
  const free = {};
  Object.keys(busyById).forEach(pid => {
    let str = "";
    for (let n = 0; n < days; n++) {
      const d = addDays(ymd(start), n);
      let bits = 0;
      slotsOfDay(d).forEach((key, i) => {
        const s = slotStart(d, key);
        if (!overlaps(busyById[pid], s, s + CONFIG.DURATION_MIN * 60e3)) bits |= 1 << i;
      });
      str += pad2(bits.toString(16));
    }
    free[pid] = str;
  });
  return free;
}

/**
 * Solnedgang (UTC-ms) for en dato, etter NOAAs forenklede algoritme. Nøyaktig nok (± et par minutter)
 * til å legge kveldsluken. Gir null ved midnattssol.
 */
function sunsetUtc(d) {
  const rad = Math.PI / 180;
  const N = Math.round((Date.UTC(d.y, d.m - 1, d.d) - Date.UTC(d.y, 0, 0)) / 86400e3);
  const lngHour = CONFIG.EVENING.LON / 15;
  const t = N + (18 - lngHour) / 24;
  const M = 0.9856 * t - 3.289;
  const L = (M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634 + 360) % 360;
  let RA = (Math.atan(0.91764 * Math.tan(L * rad)) / rad + 360) % 360;
  RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(CONFIG.EVENING.LAT * rad)) / (cosDec * Math.cos(CONFIG.EVENING.LAT * rad));
  if (cosH < -1 || cosH > 1) return null;
  const H = Math.acos(cosH) / rad / 15;
  const UT = ((H + RA - 0.06571 * t - 6.622 - lngHour) % 24 + 24) % 24;
  return Date.UTC(d.y, d.m - 1, d.d) + UT * 3600e3;
}

/** Kveldsluken: starter ved solnedgang, rundet opp til nærmeste kvarter (lokal tid), aldri før. */
function eveningKey(d) {
  const ss = sunsetUtc(d);
  if (ss === null) return null;
  const localMin = Math.ceil(((ss + tzOffsetMs(ss, CONFIG.TZ)) % 86400e3) / 60e3);
  const start = Math.ceil(localMin / 15) * 15;
  return start >= 24 * 60 ? null : minKey(start);
}

function overlaps(list, s, e) {
  return list.some(b => b.start < e && b.end > s);
}

/**
 * Brukes av synkjobben: iCalendar-tekst for en booking i fotografens kalender.
 * assigned = fotografen bookingen legges hos (for «første ledige» valgt av synkjobben).
 *
 * Tittelen er laget for fakturaroboten: «fotografering» gjør den til et oppdrag, og uten «Kode:Navn»-format
 * havner den i Sjekk. Kolon, klammer og ordene «faktura»/«utsatt» fjernes fra kundens tekst, så den ikke
 * feiltolkes.
 */
function bookingIcs(q, nowMs, assigned) {
  const start = slotStart(ymd(q.date), q.time);
  const end = start + (q.duration || CONFIG.DURATION_MIN) * 60e3;
  const who = CONFIG.PHOTOGRAPHERS[assigned] || assigned;
  const desc = [
    "Bestilt via fotostallen.no – tidspunktet må bekreftes med kunden.",
    "",
    `Fotograf: ${who}${q.photographer === ANY ? " (tildelt som første ledige)" : ""}`,
    `Megler: ${q.navn}`,
    q.telefon ? `Telefon: ${q.telefon}` : null,
    q.epost ? `E-post: ${q.epost}` : null,
    q.oppdrag ? `Oppdragsnr.: ${q.oppdrag}` : null,
    `Faktura til: ${q.faktura}`,
    q.duration === 540 ? "Heldagsoppdrag (hytte), 08:00–17:00." : q.duration === 120 ? "Over 150 kvm: satt av ca. 2 timer." : null,
    q.buffer ? `Utenfor Oslo: ca. ${q.buffer} min reisevei før og etter.` : null,
    `Adresse: ${q.address}`,
    q.kvmUsikker ? "Størrelse: usikker" : q.kvm ? `Størrelse: ${q.kvm} kvm` : null,
    q.ankomst ? `Ankomst: ${q.ankomst}` : null,
    q.nokkel ? `Nøkkeloppdrag${[q.etasje && `etasje ${q.etasje}`, q.leilighet && `leil. ${q.leilighet}`].filter(Boolean).map(x => `, ${x}`).join("")}` : null,
    q.selgerKontakt ? "Kontakt selger for å avtale tidspunkt." : null,
    q.selgerNavn || q.selgerTlf || q.selgerEpost ? `Selger: ${[q.selgerNavn, q.selgerTlf, q.selgerEpost].filter(Boolean).join(", ")}` : null,
    q.selgerBekreftelse && q.selgerBekreftelse !== "ingen" ? `Bekreftelse til selger: ${{ sms: "SMS", epost: "e-post", begge: "SMS og e-post" }[q.selgerBekreftelse]}` : null,
    q.services ? `Tjenester: ${q.services}` : `Produkter: ${(q.products || []).join(", ") || "–"}`,
    q.note ? `Notat: ${q.note}` : null,
  ].filter(x => x !== null).join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fotostallen//Booking//NO", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${q.id}@booking.fotostallen.no`,
    `DTSTAMP:${utcStamp(nowMs)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${icsText(bookingTitle(q))}`,
    `LOCATION:${icsText(q.address)}`,
    `DESCRIPTION:${icsText(desc)}`,
    `X-FOTOSTALLEN-FOTOGRAF:${assigned}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function bookingTitle(q) {
  const safe = t => String(t || "").replace(/[:\[\]]/g, " ").replace(/\b(faktura\w*|utsatt)\b/gi, " ").replace(/\s+/g, " ").trim();
  return ["Nettbooking fotografering", safe(q.navn), safe(q.address)].filter(Boolean).join(" – ");
}

/** Brukes av synkjobben når en booking står som «første ledige»: første ledige fotograf som kan tildeles automatisk. */
function pickFree(busyById, q) {
  const s = slotStart(ymd(q.date), q.time);
  const e = s + (q.duration || CONFIG.DURATION_MIN) * 60e3;
  return Object.keys(CONFIG.PHOTOGRAPHERS)
    .filter(pid => CONFIG.AUTO_ASSIGN_EXCLUDE.indexOf(pid) < 0)
    .find(pid => busyById[pid] && !overlaps(busyById[pid], s, e)) || null;
}

/** Kort referanse kunden kan oppgi, f.eks. «FS-9225D5A2». */
function bookingRef(id) {
  return "FS-" + String(id).replace(/-/g, "").slice(0, 8).toUpperCase();
}

/**
 * Sender bekreftelse til kunden fra CONFIRM_FROM, med kopi til samme adresse. Gjør ingenting før
 * adressen er lagt inn som «Send e-post som»-alias i Gmail, så det aldri sendes fra en privat adresse.
 */
/**
 * Værvarsel for én dato og ett sted (MET Norway locationforecast, compact). Gir punkter for datoen
 * (lokal tid: klokkeslett, temperatur, symbol) og samlet nedbør. Datoer utenfor varselet gir points: [].
 */
function weather(p) {
  const lat = Math.round(Number(p.lat) * 100) / 100, lon = Math.round(Number(p.lon) * 100) / 100;
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !isDate(p.date)) return json({ ok: false, error: "bad_params" });
  const cache = CacheService.getScriptCache(), key = `met:${lat}:${lon}`;
  let body = cache.get(key);
  if (!body) {
    const r = UrlFetchApp.fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": CONFIG.MET_USER_AGENT }, muteHttpExceptions: true });
    if (r.getResponseCode() !== 200) return json({ ok: false, error: "met" });
    body = r.getContentText();
    try { cache.put(key, body, 1800); } catch (err) { /* for stort for mellomlageret: hentes på nytt neste gang */ }
  }
  const ts = JSON.parse(body).properties.timeseries;
  return json(Object.assign({ ok: true, date: p.date }, summarizeForecast(ts, p.date, t => Utilities.formatDate(new Date(t), CONFIG.TZ, "yyyy-MM-dd HH:mm"))));
}

/** Plukker ut én dato fra MET-tidsserien. local(t) gir «yyyy-MM-dd HH:mm» i Oslo-tid. */
function summarizeForecast(ts, date, local) {
  const points = [];
  let precip = 0, coveredUntil = 0;
  ts.forEach(e => {
    const [d, hm] = local(e.time).split(" ");
    if (d !== date) return;
    const n1 = e.data.next_1_hours, n6 = e.data.next_6_hours;
    const sym = (n1 || n6 || {}).summary;
    points.push({ t: hm, temp: e.data.instant.details.air_temperature, symbol: sym ? sym.symbol_code : null });
    // Nedbør uten dobbelttelling: timesverdier der de finnes, ellers seks-timersverdier.
    const ms = Date.parse(e.time);
    if (ms < coveredUntil) return;
    if (n1 && n1.details) { precip += n1.details.precipitation_amount || 0; coveredUntil = ms + 3600e3; }
    else if (n6 && n6.details) { precip += n6.details.precipitation_amount || 0; coveredUntil = ms + 6 * 3600e3; }
  });
  return { points, precip: Math.round(precip * 10) / 10 };
}

function sendConfirmation(q, ref) {
  try {
    if (!/^\S+@\S+\.\S+$/.test(q.epost)) return false;
    const from = CONFIG.CONFIRM_FROM;
    if (GmailApp.getAliases().indexOf(from) < 0) return false;
    const d = ymd(q.date);
    const end = minKey(keyMin(q.time) + (q.duration || CONFIG.DURATION_MIN));
    const dato = `${["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"][weekdayOf(d)]} ${d.d}.${d.m}.${d.y}`;
    const who = q.photographer === ANY ? "Første ledige fotograf" : CONFIG.PHOTOGRAPHERS[q.photographer];
    const body = [
      `Hei ${q.navn.split(" ")[0]},`,
      "",
      "Takk for bestillingen! Vi har satt av tiden, og bekrefter så snart vi kan.",
      "",
      `Tjenester: ${q.services || (q.products || []).join(", ")}`,
      `Tid: ${dato} kl. ${q.time}–${end}`,
      `Adresse: ${q.address}`,
      `Fotograf: ${who}`,
      `Referanse: ${ref}`,
      "",
      "Må du endre noe, er det bare å svare på denne e-posten.",
      "",
      "Hilsen Fotostallen",
    ].join("\n");
    GmailApp.sendEmail(q.epost, `Bestilling mottatt – ${dato} kl. ${q.time} (${ref})`, body, { from, name: "Fotostallen", replyTo: from, bcc: from });
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

function icsText(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Bretter linjer slik iCalendar krever (maks 75 byte; vi bretter på 60 tegn for å tåle æøå). */
function foldLine(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 60) out.push((i ? " " : "") + line.slice(i, i + 60));
  return out.join("\r\n");
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/* ---------- ICS-tolking (ren JavaScript, testes med node) ---------- */

function busyFromIcs(text, fromMs, toMs, keep) {
  const events = parseIcs(text).filter(ev => !keep || keep(ev));
  const overridden = {}; // uid → { startMs: true } for enkeltforekomster som er flyttet/endret
  events.forEach(ev => {
    if (ev.recurrenceId) {
      overridden[ev.uid] = overridden[ev.uid] || {};
      overridden[ev.uid][toEpoch(ev.recurrenceId)] = true;
    }
  });
  const out = [];
  events.forEach(ev => {
    if (!ev.dtstart) return;
    if (ev.status === "CANCELLED" || ev.transp === "TRANSPARENT") return;
    const skip = ev.recurrenceId ? {} : (overridden[ev.uid] || {});
    // Avtaler med adresse utenfor Oslo: fotografen trenger reisevei før og etter.
    const pad = outsideOslo(ev.location) ? CONFIG.TRAVEL_MIN * 60e3 : 0;
    expandEvent(ev, fromMs, toMs).forEach(iv => {
      if (!skip[iv.start]) out.push(pad ? { start: iv.start - pad, end: iv.end + pad } : iv);
    });
  });
  return out;
}

function parseIcs(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const events = [];
  let cur = null;
  lines.forEach(line => {
    if (line === "BEGIN:VEVENT") { cur = { exdates: [] }; return; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; return; }
    if (!cur) return;
    const i = line.indexOf(":");
    if (i < 0) return;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const parts = head.split(";");
    const name = parts[0].toUpperCase();
    const params = {};
    parts.slice(1).forEach(pv => {
      const j = pv.indexOf("=");
      if (j > 0) params[pv.slice(0, j).toUpperCase()] = pv.slice(j + 1).replace(/^"|"$/g, "");
    });
    const dt = v => ({ value: v.trim(), tzid: params.TZID || null, isDate: params.VALUE === "DATE" || /^\d{8}$/.test(v.trim()) });
    if (name === "UID") cur.uid = value.trim();
    else if (name === "DTSTART") cur.dtstart = dt(value);
    else if (name === "DTEND") cur.dtend = dt(value);
    else if (name === "DURATION") cur.duration = value.trim();
    else if (name === "RRULE") cur.rrule = value.trim();
    else if (name === "RECURRENCE-ID") cur.recurrenceId = dt(value);
    else if (name === "STATUS") cur.status = value.trim().toUpperCase();
    else if (name === "TRANSP") cur.transp = value.trim().toUpperCase();
    else if (name === "EXDATE") value.split(",").forEach(v => cur.exdates.push(dt(v)));
    else if (name === "X-FOTOSTALLEN-FOTOGRAF") cur.fotograf = value.trim();
    else if (name === "LOCATION") cur.location = value.replace(/\\([,;\\])/g, "$1").replace(/\\n/gi, " ").trim();
  });
  return events;
}

/** Lokal veggklokketid for et DTSTART/DTEND-felt: { y, m, d, h, mi, s, z } (z = UTC). */
function wall(f) {
  const v = f.value;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(v);
  if (!m) throw new Error("Ukjent datoformat: " + v);
  return { y: +m[1], m: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0), z: m[7] === "Z" };
}

function zoneOf(f) {
  if (!f.tzid) return CONFIG.TZ;
  return validZone(f.tzid) ? f.tzid : CONFIG.TZ;
}

function toEpoch(f) {
  const w = wall(f);
  if (w.z) return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  return zonedToUtc(w, w.h, w.mi, zoneOf(f), w.s);
}

function durationMs(ev) {
  if (ev.dtend) return toEpoch(ev.dtend) - toEpoch(ev.dtstart);
  if (ev.duration) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(ev.duration);
    if (m) return (((+(m[2] || 0) * 7 + +(m[3] || 0)) * 24 + +(m[4] || 0)) * 60 + +(m[5] || 0)) * 60e3 + +(m[6] || 0) * 1e3;
  }
  return ev.dtstart.isDate ? 86400e3 : 0;
}

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function expandEvent(ev, fromMs, toMs) {
  const dur = durationMs(ev);
  const first = toEpoch(ev.dtstart);
  if (!ev.rrule) return first < toMs && first + dur > fromMs ? [{ start: first, end: first + dur }] : [];

  const rule = {};
  ev.rrule.split(";").forEach(kv => { const p = kv.split("="); rule[p[0].toUpperCase()] = p[1]; });
  const freq = rule.FREQ;
  const interval = Math.max(1, +(rule.INTERVAL || 1));
  const count = rule.COUNT ? +rule.COUNT : Infinity;
  // UNTIL er inklusiv; er den bare en dato, gjelder hele den dagen.
  const untilIsDate = rule.UNTIL && /^\d{8}$/.test(rule.UNTIL);
  const until = rule.UNTIL ? toEpoch({ value: rule.UNTIL, tzid: ev.dtstart.tzid, isDate: untilIsDate }) + (untilIsDate ? 86400e3 - 1 : 0) : Infinity;
  const byday = rule.BYDAY ? rule.BYDAY.split(",") : null;
  const zone = ev.dtstart.value.endsWith("Z") ? "UTC" : zoneOf(ev.dtstart);
  const w0 = wall(ev.dtstart);
  const ex = {};
  ev.exdates.forEach(f => { ex[toEpoch(f)] = true; });

  const out = [];
  let n = 0;
  const emit = d => {
    // Returnerer false når vi skal stoppe.
    const start = zone === "UTC" ? Date.UTC(d.y, d.m - 1, d.d, w0.h, w0.mi, w0.s) : zonedToUtc(d, w0.h, w0.mi, zone, w0.s);
    if (start < first) return true;
    if (start > until || n >= count || start >= toMs) return false;
    n++;
    if (!ex[start] && start + dur > fromMs) out.push({ start, end: start + dur });
    return true;
  };

  const base = { y: w0.y, m: w0.m, d: w0.d };
  for (let i = 0; i < 5000; i++) {
    let days = [];
    if (freq === "DAILY") {
      days = [addDays(base, i * interval)];
    } else if (freq === "WEEKLY") {
      const wd0 = weekdayOf(base);
      const monday = addDays(base, -((wd0 + 6) % 7) + i * 7 * interval);
      const codes = byday || [Object.keys(DAY_CODES).filter(k => DAY_CODES[k] === wd0)[0]];
      days = codes.map(c => addDays(monday, (DAY_CODES[c.slice(-2)] + 6) % 7)).sort(cmpYmd);
    } else if (freq === "MONTHLY") {
      const mo = addMonths(base, i * interval);
      if (byday) days = byday.map(c => nthWeekday(mo.y, mo.m, c)).filter(Boolean).sort(cmpYmd);
      else if (base.d <= daysInMonth(mo.y, mo.m)) days = [{ y: mo.y, m: mo.m, d: base.d }];
    } else if (freq === "YEARLY") {
      const y = base.y + i * interval;
      if (base.d <= daysInMonth(y, base.m)) days = [{ y, m: base.m, d: base.d }];
    } else {
      emit(base); // ukjent frekvens: bare første forekomst
      return out;
    }
    for (let k = 0; k < days.length; k++) if (!emit(days[k])) return out;
  }
  return out;
}

/* ---------- Dato- og tidssonehjelpere ---------- */

function ymd(s) { return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) }; }
function fmtYmd(d) { return `${d.y}-${pad2(d.m)}-${pad2(d.d)}`; }
function pad2(n) { return String(n).padStart(2, "0"); }
function isDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function cmpYmd(a, b) { return Date.UTC(a.y, a.m - 1, a.d) - Date.UTC(b.y, b.m - 1, b.d); }
function weekdayOf(d) { return new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay(); }
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function daysBetween(a, b) { return Math.round(cmpYmd(ymd(b), ymd(a)) / 86400e3); }

function addDays(d, n) {
  const t = new Date(Date.UTC(d.y, d.m - 1, d.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function addMonths(d, n) {
  const t = new Date(Date.UTC(d.y, d.m - 1 + n, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 };
}

/** «2TU» = andre tirsdag, «-1FR» = siste fredag i måneden. */
function nthWeekday(y, m, code) {
  const mm = /^([+-]?\d+)?([A-Z]{2})$/.exec(code);
  if (!mm) return null;
  const nth = mm[1] ? +mm[1] : 1;
  const wd = DAY_CODES[mm[2]];
  const dim = daysInMonth(y, m);
  const matches = [];
  for (let d = 1; d <= dim; d++) if (weekdayOf({ y, m, d }) === wd) matches.push(d);
  const d = nth > 0 ? matches[nth - 1] : matches[matches.length + nth];
  return d ? { y, m, d } : null;
}

/** Veggklokketid i en tidssone → epoch-ms (håndterer sommertid). */
function zonedToUtc(d, h, mi, tz, s) {
  const guess = Date.UTC(d.y, d.m - 1, d.d, h, mi, s || 0);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
}

function tzOffsetMs(ms, tz) {
  if (tz === "UTC") return 0;
  if (typeof Utilities !== "undefined") {
    const z = Utilities.formatDate(new Date(ms), tz, "Z"); // f.eks. "+0200"
    const sign = z[0] === "-" ? -1 : 1;
    return sign * (+z.slice(1, 3) * 60 + +z.slice(3, 5)) * 60e3;
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = t => +parts.find(p => p.type === t).value;
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000;
}

function validZone(tz) {
  try {
    if (typeof Utilities !== "undefined") { Utilities.formatDate(new Date(), tz, "Z"); return /\//.test(tz) || tz === "UTC"; }
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch (err) {
    return false;
  }
}

/* ---------- Diverse ---------- */

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function tooManyBookings() {
  const key = "bookings_" + Math.floor(Date.now() / 3600e3);
  return +(CacheService.getScriptCache().get(key) || 0) >= CONFIG.MAX_BOOKINGS_PER_HOUR;
}

function countBooking() {
  const cache = CacheService.getScriptCache();
  const key = "bookings_" + Math.floor(Date.now() / 3600e3);
  cache.put(key, String(+(cache.get(key) || 0) + 1), 3700);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Gjør funksjonene tilgjengelige for testene i node (ignoreres i Apps Script).
if (typeof module !== "undefined") module.exports = { outsideOslo, windowKeys, summarizeForecast, busyFromIcs, parseIcs, computeSlots, buildMasks, bookingIcs, bookingTitle, pickFree, slotsOfDay, eveningKey, sunsetUtc, slotStart, bookingRef, zonedToUtc, fmtYmd, addDays, ymd, CONFIG, ANY };
