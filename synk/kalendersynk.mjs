// Synker fotografenes iCloud-kalendere med bookingsiden. Kjøres hvert 5. minutt av en LaunchAgent på Macen.
//
//  1. Leser fotografenes kalendere.
//  2. Henter køen med nye bookinger fra Apps Script-en og legger hver booking inn i fotografens egen
//     kalender. For «første ledige» velges første fotograf som er ledig på tidspunktet. Kan kalenderen
//     ikke skrives til, havner bookingen i Scotts kalender med beskjed om hvem den var til.
//  3. Sender bare hvilke luker som er ledige (masker) til Apps Script-en.
//     Titler, adresser og andre detaljer fra kalenderne forlater aldri Macen.
//
// Bruker samme iCloud-tilgang som fakturaroboten (ICLOUD_BRUKER/ICLOUD_APP_PASSORD i dens .env.local).
//
//   node synk/kalendersynk.mjs --dry                Leser bare, og viser antall ledige luker per fotograf. Sender og skriver ingenting.
//   node synk/kalendersynk.mjs                      Vanlig kjøring. Fotografen får SMS og e-post om nye bookinger.
//   node synk/kalendersynk.mjs --varsel-test scott  Sender et testvarsel (SMS + e-post) til én fotograf, og avslutter.
//
// VARSEL=av i synk/.env skrur av SMS/e-post til fotografene.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDAVClient } from "tsdav";
import { lagTekster, lesKontakter, sendSms, lagEpostSender } from "./varsel.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes("--dry");

// Samme kode som Apps Script-en kjører: ICS-tolking, masker og bookingfil.
const mod = { exports: {} };
new Function("module", readFileSync(join(here, "..", "apps-script", "Code.gs"), "utf8"))(mod);
const { busyFromIcs, buildMasks, bookingIcs, pickFree, computeSlots, slotStart, bookingRef, zonedToUtc, ymd, addDays, fmtYmd, CONFIG, ANY } = mod.exports;

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
const fakturaDir = local.FAKTURA_DIR || join(here, "..", "..", "fakturaroboten");
const icloud = readEnv(local.ICLOUD_ENV || join(fakturaDir, ".env.local"));
const { ICLOUD_BRUKER, ICLOUD_APP_PASSORD } = icloud;
const { BOOKING_URL, SYNC_TOKEN } = local;

if (!ICLOUD_BRUKER || !ICLOUD_APP_PASSORD) fail("Fant ikke ICLOUD_BRUKER/ICLOUD_APP_PASSORD (fakturarobotens .env.local).");
if (!DRY && (!BOOKING_URL || !SYNC_TOKEN)) fail("Mangler BOOKING_URL og/eller SYNC_TOKEN i synk/.env.");

function fail(msg) {
  console.error(`[${new Date().toISOString()}] FEIL: ${msg}`);
  process.exit(1);
}
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

/* Varsel til fotografen (SMS + e-post). Feil logges, men stopper aldri synken. */
const VARSEL = (local.VARSEL || "på").toLowerCase() !== "av";
const kontakter = lesKontakter(here, CONFIG.ICLOUD_CALENDARS, fakturaDir);
const sendEpost = await lagEpostSender(icloud);
async function varsle(q, pid) {
  const k = kontakter[pid] || {};
  const who = CONFIG.PHOTOGRAPHERS[pid] || pid;
  const t = lagTekster(q, who, bookingRef(q.id), CONFIG.DURATION_MIN);
  const sendt = [];
  if (k.mobil) {
    try { await sendSms(k.mobil, t.sms); sendt.push("SMS"); } catch (err) { log(`SMS til ${who} feilet: ${err.message}`); }
  }
  if (k.epost && sendEpost) {
    try { await sendEpost({ til: k.epost, emne: t.emne, tekst: t.epost }); sendt.push("e-post"); } catch (err) { log(`E-post til ${who} feilet: ${err.message}`); }
  }
  log(sendt.length ? `Varslet ${who} (${sendt.join(" og ")}).` : `Ingen kontaktinfo for ${who}, ingen varsel sendt.`);
}

// Testvarsel til én fotograf: node synk/kalendersynk.mjs --varsel-test scott
const testIdx = process.argv.indexOf("--varsel-test");
if (testIdx > 0) {
  const pid = process.argv[testIdx + 1];
  if (!CONFIG.PHOTOGRAPHERS[pid]) fail(`Ukjent fotograf «${pid}». Bruk en av: ${Object.keys(CONFIG.PHOTOGRAPHERS).join(", ")}.`);
  const tomorrow = fmtYmd(addDays(ymd(new Intl.DateTimeFormat("sv-SE", { timeZone: CONFIG.TZ }).format(new Date())), 1));
  await varsle({ id: "00000000-test", photographer: pid, date: tomorrow, time: "09:30", duration: CONFIG.DURATION_MIN,
    services: "TEST – dette er bare en prøve av varselet", address: "Testveien 1, Oslo", navn: "Test Testesen", telefon: "00000000",
    epost: "test@example.com", note: "Ingen ekte booking." }, pid);
  process.exit(0);
}

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

// 1) Opptatt per fotograf
const busy = {};
const cals = {};
const missing = [];
for (const [pid, name] of Object.entries(CONFIG.ICLOUD_CALENDARS)) {
  const cal = byName(name);
  if (!cal) { missing.push(name); continue; }
  cals[pid] = cal;
  busy[pid] = busyFromIcs(await icsText(cal), fromMs, toMs);
}
if (missing.length) log(`Fant ikke kalender: ${missing.join(", ")} (fotografen vises som ledig).`);

// 2) Nye bookinger fra køen → fotografens kalender
if (!DRY) {
  const { queue } = await post({ action: "sync" });
  const done = [];
  for (const q of queue) {
    let target = q.photographer === ANY ? pickFree(busy, q) : q.photographer;
    if (!target || !cals[target]) target = "scott"; // ingen ledig / ukjent kalender: Scott fordeler
    let res = await client.createCalendarObject({ calendar: cals[target], filename: `${q.id}.ics`, iCalString: bookingIcs(q, Date.now(), target) });
    if (!res.ok && res.status !== 412 && target !== "scott") {
      log(`Kunne ikke skrive til «${cals[target].displayName}» (${res.status}); legger bookingen i Scotts kalender.`);
      const intended = target;
      target = "scott";
      res = await client.createCalendarObject({
        calendar: cals.scott, filename: `${q.id}.ics`,
        iCalString: bookingIcs({ ...q, note: [`Var ment for ${CONFIG.PHOTOGRAPHERS[intended]}.`, q.note].filter(Boolean).join(" ") }, Date.now(), intended),
      });
    }
    // 412 = finnes allerede (lagt inn ved en tidligere kjøring som ikke rakk å kvittere).
    if (res.ok || res.status === 412) {
      done.push(q.id);
      // Varsle bare når avtalen faktisk ble lagt inn nå (412 = allerede lagt inn og varslet tidligere).
      if (res.ok && VARSEL) await varsle(q, target);
      const s = slotStart(ymd(q.date), q.time);
      (busy[target] = busy[target] || []).push({ start: s, end: s + (q.duration || CONFIG.DURATION_MIN) * 60e3 });
      log(`Booking ${q.date} kl. ${q.time} lagt i «${cals[target].displayName}».`);
    } else {
      log(`Kunne ikke legge inn booking ${q.id} (${q.date} ${q.time}): iCloud svarte ${res.status}. Prøver igjen neste gang.`);
    }
  }
  if (done.length) await post({ action: "ack", ids: done });
}

const free = buildMasks(busy, start, days);

if (DRY) {
  const to = fmtYmd(addDays(ymd(start), 13));
  const store = { v: 2, start, free };
  log(`Tørrkjøring, ingenting sendt. Ledige luker neste 14 dager (dag- og kveldsluker på hverdager):`);
  for (const pid of Object.keys(CONFIG.PHOTOGRAPHERS).concat([ANY])) {
    const slots = computeSlots(pid, start, to, store, [], Date.now());
    const n = Object.values(slots).reduce((a, s) => a + s.length, 0);
    const label = pid === ANY ? "Første ledige" : CONFIG.PHOTOGRAPHERS[pid];
    const periods = pid === ANY ? "minst én ledig" : busy[pid] ? `${busy[pid].length} opptatte perioder i vinduet` : "ingen kalender";
    log(`  ${label.padEnd(24)} ${String(n).padStart(3)} ledige   (${periods})`);
  }
} else {
  await post({ action: "sync", data: { v: 2, start, free } });
  log(`Synket ledighet for ${Object.keys(busy).length} fotografer (${days} dager).`);
}
