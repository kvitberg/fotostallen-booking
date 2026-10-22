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
const MONTHS = ["januar", "februar", "mars", "april", "mai", "juni", "juli", "august", "september", "oktober", "november", "desember"];
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
  const tid = q.duration === 540 ? "hele dagen (08:00–17:00)" : `kl. ${q.time}–${endTime(q.time, q.duration || durationMin)}`;
  const tjenester = q.services || (q.products || []).join(", ");
  const selger = [q.selgerNavn, q.selgerTlf].filter(Boolean).join(", ");
  const viaForste = q.photographer === "forste" || /første ledige/i.test(q.note || "");
  const sms = [
    `Ny booking${viaForste ? " (første ledige)" : ""}: ${dato} ${tid}, ${q.address}.`,
    tjenester ? `${tjenester.charAt(0).toUpperCase()}${tjenester.slice(1)}.` : "",
    `Megler: ${[q.navn, q.telefon].filter(Boolean).join(", ")}.`,
    selger ? `${q.selgerKontakt ? "Avtal tid med selger" : "Selger"}: ${selger}.` : q.selgerKontakt ? "Avtal tid med selger." : "",
    q.buffer ? "Utenfor Oslo (reisevei)." : "",
    q.nokkel ? "Nøkkeloppdrag." : "",
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
    `Megler: ${q.navn}`,
    q.telefon ? `Telefon: ${q.telefon}` : null,
    q.epost ? `E-post: ${q.epost}` : null,
    q.oppdrag ? `Oppdragsnr.: ${q.oppdrag}` : null,
    q.faktura ? `Faktura til: ${q.faktura}` : null,
    q.kvmUsikker ? "Størrelse: usikker" : q.kvm ? `Størrelse: ${q.kvm} kvm${q.duration === 120 ? " (satt av ca. 2 timer)" : ""}` : null,
    q.buffer ? `Utenfor Oslo: ca. ${q.buffer} min reisevei før og etter.` : null,
    q.nokkel ? `Nøkkeloppdrag${[q.etasje && `etasje ${q.etasje}`, q.leilighet && `leil. ${q.leilighet}`].filter(Boolean).map(x => `, ${x}`).join("")}` : null,
    q.selgerKontakt ? "Selger skal kontaktes for å avtale tidspunkt." : null,
    q.selgerNavn || q.selgerTlf || q.selgerEpost ? `Selger: ${[q.selgerNavn, q.selgerTlf, q.selgerEpost].filter(Boolean).join(", ")}` : null,
    q.ankomst ? `Ankomst: ${q.ankomst}` : null,
    q.note ? `Kommentar: ${q.note}` : null,
    "",
    `Referanse: ${ref}`,
    "Tidspunktet må bekreftes med kunden.",
  ].filter(x => x !== null).join("\n");
  return { sms, emne, epost };
}

/**
 * Bekreftelser til den som bestilte (alltid SMS og e-post) og til selger (kanal etter valget i skjemaet).
 * Skal vi avtale tid med selger, får selger beskjed om at datoen er satt av og at vi kommer tilbake med
 * tidspunkt; ellers står tidspunktet i meldingen.
 */
export function lagBekreftelser(q, ref, durationMin) {
  const d = new Date(q.date + "T12:00");
  const dato = `${WEEKDAYS[d.getDay()]} ${d.getDate()}. ${MONTHS[d.getMonth()]}`;
  const tid = q.duration === 540 ? "hele dagen (08:00–17:00)" : `kl. ${q.time}–${endTime(q.time, q.duration || durationMin)}`;
  const tjenester = q.services || (q.products || []).join(", ");
  const kontakt = !!q.selgerKontakt;
  const fornavn = navn => (navn || "").trim().split(/\s+/)[0];
  // Tiden er en forespørsel, ikke endelig: den kan endres om noe uforutsett krasjer.
  const neste = kontakt
    ? "Vi tar kontakt med selger i løpet av dagen for å avtale tidspunkt."
    : "Tidspunktet er ikke endelig. Vi bekrefter det, og gir beskjed hvis noe uforutsett gjør at det må endres.";

  const innsender = {
    sms: `Takk! Forespørselen om fotografering i ${q.address} er registrert (ref. ${ref}). Ønsket tid: ${dato} ${tid}. ${neste} Hilsen Fotostallen`,
    emne: `Forespørsel registrert – ${q.address}`,
    epost: [
      `Hei ${fornavn(q.navn)},`,
      "",
      `Takk for forespørselen. Den er registrert hos oss. ${neste}`,
      "",
      `Adresse: ${q.address}`,
      `Ønsket tid: ${dato} ${tid}`,
      `Tjenester: ${tjenester || "–"}`,
      q.nokkel ? `Nøkkeloppdrag${[q.etasje && `etasje ${q.etasje}`, q.leilighet && `leil. ${q.leilighet}`].filter(Boolean).map(x => `, ${x}`).join("")}` : null,
      q.selgerNavn || q.selgerTlf ? `Selger: ${[q.selgerNavn, q.selgerTlf].filter(Boolean).join(", ")}` : null,
      q.oppdrag ? `Oppdragsnr.: ${q.oppdrag}` : null,
      `Referanse: ${ref}`,
      "",
      "Tidspunktet er en forespørsel og ikke endelig. Vi bekrefter det, og gir beskjed hvis noe uforutsett gjør at vi må foreslå en annen tid.",
      "",
      "Hilsen Fotostallen",
      "kontakt@fotostallen.no",
    ].filter(x => x !== null).join("\n"),
  };

  let selger = null;
  if (q.selgerBekreftelse && q.selgerBekreftelse !== "ingen") {
    const hei = q.selgerNavn ? `Hei ${fornavn(q.selgerNavn)}!` : "Hei!";
    const hva = `${q.navn} har bestilt fotografering av boligen i ${q.address} hos Fotostallen.`;
    const nar = kontakt
      ? `Vi har satt av ${dato}, og kommer tilbake til deg med tidspunkt.`
      : `Foreløpig tid er ${dato} ${tid}. Vi gir beskjed hvis tiden må endres.`;
    selger = {
      sms: `${hei} ${hva} ${nar} Hilsen Fotostallen`,
      emne: `Fotografering av boligen – ${dato}`,
      epost: [hei, "", hva, nar, "", "Har du spørsmål, svar på denne e-posten eller skriv til kontakt@fotostallen.no.", "", "Hilsen Fotostallen"].join("\n"),
      sendSms: q.selgerBekreftelse === "sms" || q.selgerBekreftelse === "begge",
      sendEpost: q.selgerBekreftelse === "epost" || q.selgerBekreftelse === "begge",
    };
  }
  return { innsender, selger };
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
