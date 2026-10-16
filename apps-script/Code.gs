/**
 * Fotostallen booking – ledige tider og foreløpige bookinger.
 *
 * Kjører som Google Apps Script-webapp på Scotts Google-konto (se OPPSETT.md).
 *  - GET  ?action=slots&photographer=glenn&from=2026-10-19&to=2026-10-31
 *      → { ok: true, connected: true, slots: { "2026-10-19": ["08:00", "12:00"], ... } }
 *    Leser fotografens iCloud-kalender (offentlig delingslenke) og fotografens bookingkalender.
 *    Bare ledig/opptatt sendes videre, aldri hva avtalene heter.
 *  - POST { action: "book", photographer, date, time, address, ... }
 *      → { ok: true } eller { ok: false, error: "taken" }
 *    Sjekker at tiden fortsatt er ledig og legger inn en «FORELØPIG»-avtale i bookingkalenderen.
 *
 * Skriptegenskaper (Prosjektinnstillinger → Skriptegenskaper):
 *   ICS_glenn, ICS_lars, ...  = iCloud-lenken til kalenderen (webcal://... eller https://...)
 *   CAL_glenn, CAL_lars, ...  = ID til bookingkalenderen (lages av setup())
 */

const CONFIG = {
  TZ: "Europe/Oslo",
  SLOT_STARTS: [8, 10, 12, 14, 16],
  SLOT_HOURS: 2,
  WORKDAYS: [1, 2, 3, 4, 5], // 0 = søndag
  MIN_LEAD_HOURS: 3,
  MAX_RANGE_DAYS: 62,
  MAX_BOOKINGS_PER_HOUR: 15,
  PHOTOGRAPHERS: {
    glenn: "Glenn Pettersen",
    lars: "Lars Petter Skillestad",
    kevin: "Kevin Fauske",
    scott: "Scott Kvitberg",
    kristine: "Kristine Elvemo",
    henrik: "Henrik Eriksen",
  },
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
    return json({ ok: true, connected: isConnected(id), slots: freeSlots(id, p.from, p.to) });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "server" });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const b = JSON.parse(e.postData.contents);
    if (b.action !== "book") return json({ ok: false, error: "unknown_action" });
    const id = b.photographer;
    if (id !== ANY && !CONFIG.PHOTOGRAPHERS[id]) return json({ ok: false, error: "unknown_photographer" });
    if (!isDate(b.date) || CONFIG.SLOT_STARTS.map(slotKey).indexOf(b.time) < 0) return json({ ok: false, error: "bad_slot" });
    if (!clean(b.address, 200) || !clean(b.megler, 200)) return json({ ok: false, error: "missing_fields" });

    lock.waitLock(20000);
    if (tooManyBookings()) return json({ ok: false, error: "rate_limited" });

    // Sjekk på nytt at tiden er ledig (noen kan ha booket i mellomtiden).
    const free = freeSlots(id, b.date, b.date, true)[b.date] || [];
    if (free.indexOf(b.time) < 0) return json({ ok: false, error: "taken" });

    const cal = bookingCalendar(id);
    if (!cal) return json({ ok: false, error: "not_set_up" });
    const start = new Date(zonedToUtc(ymd(b.date), Number(b.time.slice(0, 2)), 0, CONFIG.TZ));
    const end = new Date(start.getTime() + CONFIG.SLOT_HOURS * 3600e3);
    const who = id === ANY ? "Første ledige" : CONFIG.PHOTOGRAPHERS[id];
    const products = Array.isArray(b.products) ? b.products.map(x => clean(x, 60)).join(", ") : "";
    cal.createEvent(`FORELØPIG – ${clean(b.address, 200)}`, start, end, {
      location: clean(b.address, 200),
      description: [
        "Foreløpig booking fra fotostallen.no – må bekreftes.",
        "",
        `Fotograf: ${who}`,
        `Megler: ${clean(b.megler, 200)}`,
        `Kontor: ${clean(b.kontor, 200)}`,
        `E-post: ${clean(b.epost, 200)}`,
        `Størrelse: ${clean(b.kvm, 40)} kvm`,
        `Ankomst: ${clean(b.ankomst, 300)}`,
        `Produkter: ${products || "–"}`,
        b.note ? `Notat: ${clean(b.note, 1000)}` : "",
      ].filter(x => x !== "").join("\n"),
    });
    countBooking();
    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: "server" });
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

/* ---------- Oppsett (kjøres manuelt fra editoren) ---------- */

/** Lager én bookingkalender per fotograf (+ «Første ledige») og lagrer ID-ene. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  const ids = Object.keys(CONFIG.PHOTOGRAPHERS).concat([ANY]);
  ids.forEach(id => {
    if (props.getProperty("CAL_" + id)) return;
    const name = id === ANY ? "Første ledige" : CONFIG.PHOTOGRAPHERS[id].split(" ")[0];
    const cal = CalendarApp.createCalendar(`Fotostallen bookinger – ${name}`, { timeZone: CONFIG.TZ });
    props.setProperty("CAL_" + id, cal.getId());
    console.log(`Laget kalender for ${name}: ${cal.getId()}`);
  });
  console.log("Ferdig. Del den hemmelige iCal-adressen til hver kalender med riktig fotograf (se OPPSETT.md).");
}

/** Viser hvor mange avtaler som leses fra hver fotografs iCloud-kalender de neste 30 dagene. */
function testConnections() {
  const from = Date.now(), to = from + 30 * 86400e3;
  Object.keys(CONFIG.PHOTOGRAPHERS).forEach(id => {
    if (!isConnected(id)) return console.log(`${id}: ikke koblet (mangler ICS_${id})`);
    try {
      const busy = icsBusy(id, from, to, true);
      console.log(`${id}: ${busy.length} opptatte perioder neste 30 dager`);
    } catch (err) {
      console.log(`${id}: FEIL – ${err}`);
    }
  });
}

/* ---------- Ledige tider ---------- */

function freeSlots(id, from, to, fresh) {
  const startMs = zonedToUtc(ymd(from), 0, 0, CONFIG.TZ);
  const endMs = zonedToUtc(addDays(ymd(to), 1), 0, 0, CONFIG.TZ);
  const people = id === ANY ? Object.keys(CONFIG.PHOTOGRAPHERS) : [id];
  const busyById = {};
  people.forEach(pid => { busyById[pid] = busyFor(pid, startMs, endMs, fresh); });
  // Bookinger på «Første ledige» blokkerer ingen bestemt fotograf, men samme luke på den kalenderen.
  const anyBusy = id === ANY ? calendarBusy(ANY, startMs, endMs) : [];
  return computeSlots(from, to, people.map(pid => busyById[pid]), anyBusy, Date.now());
}

/**
 * Ren beregning (testbar): en luke er ledig hvis minst én av personene er ledig
 * (for én fotograf: den ene), luken ikke er tatt i «Første ledige»-kalenderen,
 * den er på en arbeidsdag og starter minst MIN_LEAD_HOURS fra nå.
 */
function computeSlots(from, to, busyLists, sharedBusy, nowMs) {
  const out = {};
  const earliest = nowMs + CONFIG.MIN_LEAD_HOURS * 3600e3;
  for (let d = ymd(from); fmtYmd(d) <= to; d = addDays(d, 1)) {
    const weekday = new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay();
    if (CONFIG.WORKDAYS.indexOf(weekday) < 0) continue;
    const free = [];
    CONFIG.SLOT_STARTS.forEach(h => {
      const s = zonedToUtc(d, h, 0, CONFIG.TZ);
      const e = s + CONFIG.SLOT_HOURS * 3600e3;
      if (s < earliest) return;
      if (overlaps(sharedBusy, s, e)) return;
      if (busyLists.some(list => !overlaps(list, s, e))) free.push(slotKey(h));
    });
    if (free.length) out[fmtYmd(d)] = free;
  }
  return out;
}

function overlaps(list, s, e) {
  return list.some(b => b.start < e && b.end > s);
}

function busyFor(id, fromMs, toMs, fresh) {
  return icsBusy(id, fromMs, toMs, fresh).concat(calendarBusy(id, fromMs, toMs));
}

function isConnected(id) {
  if (id === ANY) return Object.keys(CONFIG.PHOTOGRAPHERS).some(isConnected);
  return !!PropertiesService.getScriptProperties().getProperty("ICS_" + id);
}

function bookingCalendar(id) {
  const calId = PropertiesService.getScriptProperties().getProperty("CAL_" + id);
  return calId ? CalendarApp.getCalendarById(calId) : null;
}

function calendarBusy(id, fromMs, toMs) {
  const cal = bookingCalendar(id);
  if (!cal) return [];
  return cal.getEvents(new Date(fromMs), new Date(toMs)).map(ev => ({
    start: ev.getStartTime().getTime(),
    end: ev.getEndTime().getTime(),
  }));
}

/** Opptatte perioder fra iCloud-kalenderen. Resultatet caches i 5 minutter. */
function icsBusy(id, fromMs, toMs, fresh) {
  const url = PropertiesService.getScriptProperties().getProperty("ICS_" + id);
  if (!url) return [];
  const cache = CacheService.getScriptCache();
  const key = `busy_${id}_${fromMs}_${toMs}`;
  if (!fresh) {
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  }
  const res = UrlFetchApp.fetch(url.replace(/^webcal:/i, "https:"), { muteHttpExceptions: true, followRedirects: true });
  if (res.getResponseCode() !== 200) throw new Error(`iCloud svarte ${res.getResponseCode()} for ${id}`);
  const busy = busyFromIcs(res.getContentText(), fromMs, toMs);
  try { cache.put(key, JSON.stringify(busy), 300); } catch (err) { /* for stort for cache */ }
  return busy;
}

/* ---------- ICS-tolking (ren JavaScript, testes med node) ---------- */

function busyFromIcs(text, fromMs, toMs) {
  const events = parseIcs(text);
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
if (typeof module !== "undefined") module.exports = { busyFromIcs, computeSlots, zonedToUtc, CONFIG };
