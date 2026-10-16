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
 *  - Bookingsiden spør GET ?action=slots&photographer=glenn&from=…&to=… og får ledige luker.
 *  - Bookingsiden sender POST { action: "book", … }. Bookingen legges i en kø og blokkerer luken med en gang.
 *  - Synkjobben henter køen, legger hver booking inn som «FORELØPIG» i iCloud-kalenderen
 *    «Fotostallen bookinger» (som fakturaroboten ikke leser), og kvitterer med action=ack.
 *
 * Skriptegenskaper (Prosjektinnstillinger → Skriptegenskaper):
 *   SYNC_TOKEN = hemmelig nøkkel som synkjobben bruker (står i synk/.env på Macen)
 */

const CONFIG = {
  TZ: "Europe/Oslo",
  SLOT_STARTS: [8, 10, 12, 14, 16],
  SLOT_HOURS: 2,
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
  },
  // iCloud-kalendernavn per fotograf (samme kalendere som fakturaroboten leser).
  ICLOUD_CALENDARS: {
    glenn: "Glenn Foto",
    lars: "LPS fotostallen",
    kevin: "Kevin Foto",
    scott: "Scott foto",
    kristine: "Kristine Foto",
    henrik: "Henrik Foto",
  },
  BOOKING_CALENDAR: "Fotostallen bookinger",
};
const ANY = "forste"; // «Første ledige»

/* ---------- Webapp ---------- */

function doGet(e) {
  try {
    const p = e.parameter || {};
    if (p.action !== "slots") return json({ ok: false, error: "unknown_action" });
    const id = p.photographer;
    if (id !== ANY && !CONFIG.PHOTOGRAPHERS[id]) return json({ ok: false, error: "unknown_photographer" });
    if (!isDate(p.from) || !isDate(p.to) || p.to < p.from) return json({ ok: false, error: "bad_range" });
    if (daysBetween(p.from, p.to) > CONFIG.MAX_RANGE_DAYS) return json({ ok: false, error: "range_too_long" });
    const store = readStore();
    return json({ ok: true, updated: store ? store.updated : null, slots: computeSlots(id, p.from, p.to, store, readQueue(), Date.now()) });
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
    if (!isDate(b.date) || CONFIG.SLOT_STARTS.map(slotKey).indexOf(b.time) < 0) return json({ ok: false, error: "bad_slot" });
    if (!clean(b.address, 200) || !clean(b.megler, 200)) return json({ ok: false, error: "missing_fields" });

    lock.waitLock(20000);
    if (tooManyBookings()) return json({ ok: false, error: "rate_limited" });
    const queue = readQueue();
    // Sjekk på nytt at tiden er ledig (noen kan ha booket i mellomtiden).
    const free = computeSlots(id, b.date, b.date, readStore(), queue, Date.now())[b.date] || [];
    if (free.indexOf(b.time) < 0) return json({ ok: false, error: "taken" });

    queue.push({
      id: Utilities.getUuid(), created: Date.now(), photographer: id, date: b.date, time: b.time,
      address: clean(b.address, 200), megler: clean(b.megler, 200), kontor: clean(b.kontor, 200),
      epost: clean(b.epost, 200), kvm: clean(b.kvm, 40), ankomst: clean(b.ankomst, 300),
      products: Array.isArray(b.products) ? b.products.slice(0, 10).map(x => clean(x, 60)) : [],
      note: clean(b.note, 1000),
    });
    writeQueue(queue);
    countBooking();
    return json({ ok: true });
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
    if (!isDate(d.start) || typeof d.free !== "object") return json({ ok: false, error: "bad_data" });
    PropertiesService.getScriptProperties().setProperty("STORE", JSON.stringify({ updated: Date.now(), start: d.start, free: d.free }));
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

/**
 * Masker: for hver fotograf (og «forste») en streng med ett tegn per dag fra store.start.
 * Tegnet er et base-32-siffer der bit i = 1 betyr at luke SLOT_STARTS[i] er ledig i kalenderen.
 * Uten data (ikke synket ennå, eller dato utenfor vinduet) regnes luken som ledig.
 */
function maskFree(store, pid, date, i) {
  if (!store || !store.free || typeof store.free[pid] !== "string") return true;
  const idx = daysBetween(store.start, date);
  const ch = store.free[pid][idx];
  if (idx < 0 || ch === undefined) return true;
  return ((parseInt(ch, 32) >> i) & 1) === 1;
}

/**
 * En luke er ledig når den er på en arbeidsdag, starter minst MIN_LEAD_HOURS fra nå, og
 *  - for én fotograf: ledig i fotografens kalender og ikke i køen for fotografen;
 *  - for «Første ledige»: minst én fotograf er ledig, og luken er ikke tatt av en annen «første ledige»-booking.
 */
function computeSlots(id, from, to, store, queue, nowMs) {
  const out = {};
  const earliest = nowMs + CONFIG.MIN_LEAD_HOURS * 3600e3;
  const queued = (pid, date, key) => queue.some(q => q.photographer === pid && q.date === date && q.time === key);
  const personFree = (pid, date, i, key) => maskFree(store, pid, date, i) && !queued(pid, date, key);
  const people = Object.keys(CONFIG.PHOTOGRAPHERS);
  for (let d = ymd(from); fmtYmd(d) <= to; d = addDays(d, 1)) {
    const date = fmtYmd(d);
    if (CONFIG.WORKDAYS.indexOf(weekdayOf(d)) < 0) continue;
    const free = [];
    CONFIG.SLOT_STARTS.forEach((h, i) => {
      const key = slotKey(h);
      if (zonedToUtc(d, h, 0, CONFIG.TZ) < earliest) return;
      const ok = id === ANY
        ? personFree(ANY, date, i, key) && people.some(pid => personFree(pid, date, i, key))
        : personFree(id, date, i, key);
      if (ok) free.push(key);
    });
    if (free.length) out[date] = free;
  }
  return out;
}

/** Brukes av synkjobben: lager masker fra opptatte perioder per fotograf. */
function buildMasks(busyById, start, days) {
  const free = {};
  Object.keys(busyById).forEach(pid => {
    let str = "";
    for (let n = 0; n < days; n++) {
      const d = addDays(ymd(start), n);
      let bits = 0;
      CONFIG.SLOT_STARTS.forEach((h, i) => {
        const s = zonedToUtc(d, h, 0, CONFIG.TZ);
        if (!overlaps(busyById[pid], s, s + CONFIG.SLOT_HOURS * 3600e3)) bits |= 1 << i;
      });
      str += bits.toString(32);
    }
    free[pid] = str;
  });
  return free;
}

function overlaps(list, s, e) {
  return list.some(b => b.start < e && b.end > s);
}

/** Brukes av synkjobben: iCalendar-tekst for en foreløpig booking. */
function bookingIcs(q, nowMs) {
  const start = zonedToUtc(ymd(q.date), Number(q.time.slice(0, 2)), 0, CONFIG.TZ);
  const end = start + CONFIG.SLOT_HOURS * 3600e3;
  const who = q.photographer === ANY ? "Første ledige" : CONFIG.PHOTOGRAPHERS[q.photographer].split(" ")[0];
  const desc = [
    "Foreløpig booking fra fotostallen.no – må bekreftes.",
    "",
    `Fotograf: ${q.photographer === ANY ? "Første ledige" : CONFIG.PHOTOGRAPHERS[q.photographer]}`,
    `Megler: ${q.megler}`,
    `Kontor: ${q.kontor}`,
    `E-post: ${q.epost}`,
    `Størrelse: ${q.kvm} kvm`,
    `Ankomst: ${q.ankomst}`,
    `Produkter: ${(q.products || []).join(", ") || "–"}`,
    q.note ? `Notat: ${q.note}` : "",
  ].filter(x => x !== "").join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fotostallen//Booking//NO", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${q.id}@booking.fotostallen.no`,
    `DTSTAMP:${utcStamp(nowMs)}`,
    `DTSTART:${utcStamp(start)}`,
    `DTEND:${utcStamp(end)}`,
    `SUMMARY:${icsText(`FORELØPIG – ${who} – ${q.address}`)}`,
    `LOCATION:${icsText(q.address)}`,
    `DESCRIPTION:${icsText(desc)}`,
    "STATUS:TENTATIVE",
    `X-FOTOSTALLEN-FOTOGRAF:${q.photographer}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

function icsText(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
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
    expandEvent(ev, fromMs, toMs).forEach(iv => {
      if (!skip[iv.start]) out.push(iv);
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
function slotKey(h) { return `${pad2(h)}:00`; }
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
if (typeof module !== "undefined") module.exports = { busyFromIcs, parseIcs, computeSlots, buildMasks, bookingIcs, zonedToUtc, fmtYmd, addDays, ymd, CONFIG, ANY };
