// Synker fotografenes iCloud-kalendere med bookingsiden. Kjøres hvert 5. minutt av en LaunchAgent på Macen.
//
//  1. Henter køen med nye bookinger fra Apps Script-en og legger dem inn som «FORELØPIG»-avtaler
//     i iCloud-kalenderen «Fotostallen bookinger» (som fakturaroboten ikke leser).
//  2. Leser fotografenes kalendere og sender bare hvilke luker som er ledige (masker) til Apps Script-en.
//     Titler, adresser og andre detaljer forlater aldri Macen.
//
// Bruker samme iCloud-tilgang som fakturaroboten (ICLOUD_BRUKER/ICLOUD_APP_PASSORD i dens .env.local).
//
//   node synk/kalendersynk.mjs --dry   Leser bare, og viser antall ledige luker per fotograf. Sender og skriver ingenting.
//   node synk/kalendersynk.mjs         Vanlig kjøring.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDAVClient } from "tsdav";

const here = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");

// Samme kode som Apps Script-en kjører: ICS-tolking, masker og bookingfil.
const mod = { exports: {} };
new Function("module", readFileSync(join(here, "..", "apps-script", "Code.gs"), "utf8"))(mod);
const { busyFromIcs, buildMasks, bookingIcs, computeSlots, zonedToUtc, ymd, addDays, fmtYmd, CONFIG, ANY } = mod.exports;

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const local = readEnv(join(here, ".env"));
const icloud = readEnv(local.ICLOUD_ENV || join(here, "..", "..", "fakturaroboten", ".env.local"));
const { ICLOUD_BRUKER, ICLOUD_APP_PASSORD } = icloud;
const { BOOKING_URL, SYNC_TOKEN } = local;

if (!ICLOUD_BRUKER || !ICLOUD_APP_PASSORD) fail("Fant ikke ICLOUD_BRUKER/ICLOUD_APP_PASSORD (fakturarobotens .env.local).");
if (!DRY && (!BOOKING_URL || !SYNC_TOKEN)) fail("Mangler BOOKING_URL og/eller SYNC_TOKEN i synk/.env.");

function fail(msg) {
  console.error(`[${new Date().toISOString()}] FEIL: ${msg}`);
  process.exit(1);
}
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

async function post(body) {
  const r = await fetch(BOOKING_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...body, token: SYNC_TOKEN }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`Apps Script svarte ${j.error}`);
  return j;
}

const client = await createDAVClient({
  serverUrl: "https://caldav.icloud.com",
  credentials: { username: ICLOUD_BRUKER, password: ICLOUD_APP_PASSORD },
  authMethod: "Basic",
  defaultAccountType: "caldav",
});
const calendars = await client.fetchCalendars();
const byName = name => calendars.find(c => String(c.displayName) === name);

// Vindu: fra i dag (norsk tid) og SYNC_DAYS dager fram.
const start = new Intl.DateTimeFormat("sv-SE", { timeZone: CONFIG.TZ }).format(new Date());
const days = CONFIG.SYNC_DAYS;
const fromMs = zonedToUtc(ymd(start), 0, 0, CONFIG.TZ);
const toMs = zonedToUtc(addDays(ymd(start), days), 0, 0, CONFIG.TZ);
const range = { start: new Date(fromMs).toISOString(), end: new Date(toMs).toISOString() };

async function icsText(calendar) {
  const objects = await client.fetchCalendarObjects({ calendar, timeRange: range });
  return objects.map(o => o.data || "").join("\n");
}

// 1) Nye bookinger fra køen → iCloud
let bookingCal = byName(CONFIG.BOOKING_CALENDAR);
if (!DRY) {
  if (!bookingCal) {
    // Lag bookingkalenderen ved siden av de andre kalenderne på kontoen (bare første gang).
    const home = calendars.find(c => /\/calendars\/[^/]+\/$/.test(c.url)).url.replace(/[^/]+\/$/, "");
    await client.makeCalendar({
      url: `${home}fotostallen-bookinger/`,
      props: { "d:displayname": CONFIG.BOOKING_CALENDAR },
    });
    bookingCal = (await client.fetchCalendars()).find(c => String(c.displayName) === CONFIG.BOOKING_CALENDAR);
    if (!bookingCal) fail(`Klarte ikke å lage kalenderen «${CONFIG.BOOKING_CALENDAR}».`);
    log(`Laget kalenderen «${CONFIG.BOOKING_CALENDAR}».`);
  }
  const { queue } = await post({ action: "sync" });
  const done = [];
  for (const q of queue) {
    const res = await client.createCalendarObject({ calendar: bookingCal, filename: `${q.id}.ics`, iCalString: bookingIcs(q, Date.now()) });
    // 412 = finnes allerede (lagt inn ved en tidligere kjøring som ikke rakk å kvittere).
    if (res.ok || res.status === 412) done.push(q.id);
    else log(`Kunne ikke legge inn booking ${q.id} (${q.date} ${q.time}): iCloud svarte ${res.status}`);
  }
  if (done.length) {
    await post({ action: "ack", ids: done });
    log(`La inn ${done.length} foreløpig${done.length === 1 ? "" : "e"} booking${done.length === 1 ? "" : "er"} i «${CONFIG.BOOKING_CALENDAR}».`);
  }
}

// 2) Ledighet per fotograf
const busy = {};
const missing = [];
for (const [pid, name] of Object.entries(CONFIG.ICLOUD_CALENDARS)) {
  const cal = byName(name);
  if (!cal) { missing.push(name); continue; }
  busy[pid] = busyFromIcs(await icsText(cal), fromMs, toMs);
}
const bookingText = bookingCal ? await icsText(bookingCal) : "";
for (const pid of Object.keys(busy)) {
  busy[pid].push(...busyFromIcs(bookingText, fromMs, toMs, ev => ev.fotograf === pid));
}
busy[ANY] = busyFromIcs(bookingText, fromMs, toMs, ev => ev.fotograf === ANY);
if (missing.length) log(`Fant ikke kalender: ${missing.join(", ")} (fotografen vises som ledig).`);

const free = buildMasks(busy, start, days);

if (DRY) {
  const to = fmtYmd(addDays(ymd(start), 13));
  const store = { start, free };
  log(`Tørrkjøring, ingenting sendt. Ledige luker neste 14 dager (av ${10 * CONFIG.SLOT_STARTS.length} mulige på hverdager):`);
  for (const pid of Object.keys(CONFIG.PHOTOGRAPHERS).concat([ANY])) {
    const slots = computeSlots(pid, start, to, store, [], Date.now());
    const n = Object.values(slots).reduce((a, s) => a + s.length, 0);
    const label = pid === ANY ? "Første ledige" : CONFIG.PHOTOGRAPHERS[pid];
    const periods = busy[pid] ? `${busy[pid].length} opptatte perioder i vinduet` : "ingen kalender";
    log(`  ${label.padEnd(24)} ${String(n).padStart(3)} ledige   (${periods})`);
  }
} else {
  await post({ action: "sync", data: { start, free } });
  log(`Synket ledighet for ${Object.keys(busy).length - 1} fotografer (${days} dager).`);
}
