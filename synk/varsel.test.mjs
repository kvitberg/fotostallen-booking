// Tester varseltekstene og nummerformatet. Kjør: node --test synk/varsel.test.mjs
import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lagTekster, lagBekreftelser, normaliserNummer, lesKontakter } from "./varsel.mjs";

const q = {
  id: "9225d5a2-84cd", photographer: "kristine", date: "2026-10-20", time: "09:30", duration: 90,
  services: "dagfotografering, hel bolig + drone", address: "Torggata 1, 0181 Oslo",
  navn: "Kari Nordmann", telefon: "99 99 99 99", epost: "kari@example.com", oppdrag: "4711",
  faktura: "Krogsveen AS", note: "Kunden valgte første ledige. Ring på.",
};

test("SMS er kort og har det fotografen trenger", () => {
  const { sms } = lagTekster(q, "Kristine Elvemo", "FS-9225D5A2", 90);
  assert.strictEqual(sms, "Ny booking (første ledige): tirsdag 20.10 kl. 09:30–11:00, Torggata 1, 0181 Oslo. Dagfotografering, hel bolig + drone. Kunde: Kari Nordmann, 99 99 99 99. Ref. FS-9225D5A2");
  assert.ok(sms.length < 300, "passer i to SMS-er");
});

test("e-posten har emne og alle detaljer", () => {
  const { emne, epost } = lagTekster(q, "Kristine Elvemo", "FS-9225D5A2", 90);
  assert.strictEqual(emne, "Ny booking tirsdag 20.10 kl. 09:30–11:00 – Torggata 1, 0181 Oslo");
  assert.ok(epost.startsWith("Hei Kristine,"));
  for (const s of ["Oppdragsnr.: 4711", "Faktura til: Krogsveen AS", "Kommentar: Kunden valgte første ledige. Ring på.", "Referanse: FS-9225D5A2"]) assert.ok(epost.includes(s), s);
  assert.ok(!epost.includes("Størrelse"), "tomme felt utelates");
});

test("kveldsluke over midnatt får riktig sluttid", () => {
  const { sms } = lagTekster({ ...q, time: "22:45", note: "" }, "Scott Kvitberg", "FS-1", 90);
  assert.ok(sms.includes("kl. 22:45–00:15"));
  assert.ok(!sms.includes("første ledige"));
});

test("mobilnummer normaliseres som i fakturaroboten", () => {
  assert.strictEqual(normaliserNummer("912 34 567"), "+4791234567");
  assert.strictEqual(normaliserNummer("0047 41234567"), "+4741234567");
  assert.strictEqual(normaliserNummer("+46701234567"), "+46701234567");
  assert.throws(() => normaliserNummer("1234"));
});

test("kontakter.json går foran fakturarobotens kalenderkonfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "varsel-"));
  const synk = join(dir, "synk"), fk = join(dir, "fk");
  mkdirSync(synk); mkdirSync(join(fk, "config.lokal"), { recursive: true });
  writeFileSync(join(synk, "kontakter.json"), JSON.stringify({ glenn: { mobil: "41111111" } }));
  writeFileSync(join(fk, "config.lokal", "kalendere.json"), JSON.stringify({ "Glenn Foto": { epost: "g@x.no", mobil: "49999999" }, "Scott foto": { epost: "s@x.no" } }));
  const k = lesKontakter(synk, { glenn: "Glenn Foto", scott: "Scott foto", kevin: "Kevin Foto" }, fk);
  assert.deepStrictEqual(k, { glenn: { epost: "g@x.no", mobil: "41111111" }, scott: { epost: "s@x.no", mobil: "" }, kevin: { epost: "", mobil: "" } });
});

test("innsender får bekreftelse; skal selger kontaktes, står det i meldingen", () => {
  const b = lagBekreftelser({ ...q, selgerKontakt: true, selgerBekreftelse: "ingen" }, "FS-1", 90);
  assert.ok(b.innsender.sms.includes("er registrert (ref. FS-1)"));
  assert.ok(b.innsender.sms.includes("Vi tar kontakt med selger i løpet av dagen"));
  assert.ok(b.innsender.epost.startsWith("Hei Kari,"));
  assert.strictEqual(b.selger, null, "ingen bekreftelse til selger valgt");
});

test("selger: dato og «kommer tilbake med tidspunkt» når tiden skal avtales, ellers tidspunktet", () => {
  const base = { ...q, selgerNavn: "Ola Hansen", selgerTlf: "91234567", selgerEpost: "ola@example.com" };
  const avtales = lagBekreftelser({ ...base, selgerKontakt: true, selgerBekreftelse: "sms" }, "FS-1", 90).selger;
  assert.strictEqual(avtales.sms, "Hei Ola! Kari Nordmann har bestilt fotografering av boligen i Torggata 1, 0181 Oslo hos Fotostallen. Vi har satt av tirsdag 20. oktober, og kommer tilbake til deg med tidspunkt. Hilsen Fotostallen");
  assert.deepStrictEqual([avtales.sendSms, avtales.sendEpost], [true, false]);
  const fast = lagBekreftelser({ ...base, selgerKontakt: false, selgerBekreftelse: "begge" }, "FS-1", 90).selger;
  assert.ok(fast.sms.includes("Fotografen kommer tirsdag 20. oktober kl. 09:30–11:00."));
  assert.deepStrictEqual([fast.sendSms, fast.sendEpost], [true, true]);
  assert.ok(!lagBekreftelser({ ...base, selgerKontakt: false }, "FS-1", 90).innsender.sms.includes("selger"));
});
