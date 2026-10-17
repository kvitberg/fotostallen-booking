// Varsel til fotografen når en nettbooking legges i kalenderen: SMS (via Meldinger på Macen, som
// fakturaroboten) og e-post (via samme SMTP-oppsett som fakturaroboten).
//
// Kontaktinfo: synk/kontakter.json (aldri i git) { "glenn": { "epost": "...", "mobil": "..." }, ... }.
// Mangler en fotograf der, brukes epost/mobil fra fakturarobotens config.lokal/kalendere.json.
import { readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFileP = promisify(execFile);
const WEEKDAYS = ["søndag", "mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag"];
const pad = n => String(n).padStart(2, "0");

/** «+47XXXXXXXX» for norske mobilnumre, ellers uendret +-nummer (samme regel som fakturaroboten). */
export function normaliserNummer(nr) {
  const rent = String(nr || "").replace(/[\s-]/g, "");
  if (/^(\+47|0047)\d{8}$/.test(rent)) return `+47${rent.slice(-8)}`;
  if (/^[49]\d{7}$/.test(rent)) return `+47${rent}`;
  if (/^\+\d{8,15}$/.test(rent) && !rent.startsWith("+47")) return rent;
  throw new Error("Ugyldig mobilnummer");
}

function endTime(time, minutes) {
  const m = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) + minutes;
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

/** Tekstene til fotografen. q = bookingen fra køen, who = fotografens navn, ref = «FS-…». */
export function lagTekster(q, who, ref, durationMin) {
  const d = new Date(q.date + "T12:00");
  const dato = `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  const tid = `kl. ${q.time}–${endTime(q.time, q.duration || durationMin)}`;
  const tjenester = q.services || (q.products || []).join(", ");
  const viaForste = q.photographer === "forste" || /første ledige/i.test(q.note || "");
  const sms = [
    `Ny booking${viaForste ? " (første ledige)" : ""}: ${dato} ${tid}, ${q.address}.`,
    tjenester ? `${tjenester.charAt(0).toUpperCase()}${tjenester.slice(1)}.` : "",
    `Kunde: ${q.navn}, ${q.telefon}.`,
    `Ref. ${ref}`,
  ].filter(Boolean).join(" ");
  const emne = `Ny booking ${dato} ${tid} – ${q.address}`;
  const epost = [
    `Hei ${who.split(" ")[0]},`,
    "",
    `Du har fått en ny booking via fotostallen.no${viaForste ? " (kunden valgte første ledige)" : ""}. Den ligger i kalenderen din.`,
    "",
    `Tid: ${dato} ${tid}`,
    `Adresse: ${q.address}`,
    `Tjenester: ${tjenester || "–"}`,
    "",
    `Kunde: ${q.navn}`,
    `Telefon: ${q.telefon}`,
    `E-post: ${q.epost}`,
    q.oppdrag ? `Oppdragsnr.: ${q.oppdrag}` : null,
    q.faktura ? `Faktura til: ${q.faktura}` : null,
    q.kvm ? `Størrelse: ${q.kvm} kvm` : null,
    q.ankomst ? `Ankomst: ${q.ankomst}` : null,
    q.note ? `Kommentar: ${q.note}` : null,
    "",
    `Referanse: ${ref}`,
    "Tidspunktet må bekreftes med kunden.",
  ].filter(x => x !== null).join("\n");
  return { sms, emne, epost };
}

/** Kontaktinfo per fotograf: kontakter.json først, ellers fakturarobotens kalenderkonfig. */
export function lesKontakter(synkDir, calendars, fakturaDir) {
  const out = {};
  const fil = join(synkDir, "kontakter.json");
  const egne = existsSync(fil) ? JSON.parse(readFileSync(fil, "utf8")) : {};
  const fkFil = join(fakturaDir, "config.lokal", "kalendere.json");
  const fk = existsSync(fkFil) ? JSON.parse(readFileSync(fkFil, "utf8")) : {};
  for (const [pid, kal] of Object.entries(calendars)) {
    const e = egne[pid] || {}, f = fk[kal] || {};
    out[pid] = { epost: e.epost || f.epost || "", mobil: e.mobil || f.mobil || "" };
  }
  return out;
}

// Samme AppleScript som fakturaroboten. Tekst og nummer sendes bare som argumenter, aldri satt
// sammen med skriptet, og et fast første argument hindrer at tekst som starter med «-» blir et flagg.
const SKRIPT = [
  "on run argv",
  "  set meldingstekst to item 2 of argv",
  "  set mottaker to item 3 of argv",
  '  tell application "Messages"',
  "    set smsTjeneste to 1st account whose service type = SMS",
  "    send meldingstekst to participant mottaker of smsTjeneste",
  "  end tell",
  "end run",
];

export async function sendSms(til, tekst) {
  await execFileP("osascript", [...SKRIPT.flatMap(l => ["-e", l]), "kalendersynk", tekst, normaliserNummer(til)], { timeout: 20_000 });
}

/** E-post via fakturarobotens SMTP-oppsett (SMTP_VERT, EPOST_ADRESSE, EPOST_PASSORD). */
export async function lagEpostSender(env) {
  if (!env.EPOST_ADRESSE || !env.EPOST_PASSORD) return null;
  const { default: nodemailer } = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host: env.SMTP_VERT || "mail.uniweb.no", port: 465, secure: true,
    auth: { user: env.EPOST_ADRESSE, pass: env.EPOST_PASSORD },
  });
  return async ({ til, emne, tekst }) => {
    await transport.sendMail({ from: `Fotostallen booking <${env.EPOST_ADRESSE}>`, to: til, subject: emne, text: tekst });
  };
}
