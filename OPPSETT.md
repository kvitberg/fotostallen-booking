# Koble bookingsiden til fotografenes kalendere

Bookingsiden viser ledige tidsluker (08–10, 10–12, 12–14, 14–16, 16–18 på hverdager) for fotografen kunden velger. Ledighet hentes fra de samme iCloud-kalenderne som fakturaroboten leser. Hver bestilling legges inn som en **FORELØPIG**-avtale i iCloud-kalenderen «Fotostallen bookinger».

```
iCloud: «Glenn Foto», «Scott foto», …  ──les (CalDAV)──▶  synkjobb på Scotts Mac (hvert 5. min)
                                                              │  bare ledig/opptatt per luke
                                                              ▼
bookingsiden  ◀──ledige luker──  Apps Script (Scotts Google-konto)  ◀──nye bookinger──  bookingsiden
                                                              │  kø med nye bookinger
                                                              ▼
iCloud: «Fotostallen bookinger»  ◀──FORELØPIG-avtaler──  synkjobb på Scotts Mac
```

- **Synkjobben** (`synk/kalendersynk.mjs`) bruker samme iCloud-innlogging som fakturaroboten (leses fra fakturarobotens `.env.local`). Den sender bare ut ett tegn per dag og fotograf som sier hvilke luker som er ledige. Titler, adresser og kunder forlater aldri Macen.
- **Apps Script-en** (`apps-script/Code.gs`) svarer bookingsiden og holder nye bookinger i en kø. En booket luke blir opptatt med en gang.
- **«Fotostallen bookinger»** er en egen iCloud-kalender. Fakturaroboten leser bare kalenderne i sin `kalendere.json`, så foreløpige bookinger kan aldri bli fakturaer.
- Macen sender bare forespørsler ut. Ingenting på den åpnes mot internett.

Er Macen av, viser siden de sist kjente ledige tidene. Nye bookinger venter i køen og legges inn i iCloud når Macen er på igjen. De kommer uansett også inn via Google-skjemaet.

---

## Steg 1 – Scott: sett opp Apps Script (ca. 5 minutter)

1. Gå til **[script.google.com](https://script.google.com)** → **Nytt prosjekt**, og gi det navnet «Fotostallen booking».
2. Slett innholdet i `Kode.gs`, lim inn hele [`apps-script/Code.gs`](apps-script/Code.gs), og trykk lagre (💾).
3. **Prosjektinnstillinger** (tannhjulet til venstre):
   - Sett **Tidssone** til `(GMT+01:00) Oslo`.
   - Under **Skriptegenskaper** → **Legg til skriptegenskap**:
     - Egenskap: `SYNC_TOKEN`
     - Verdi: verdien etter `SYNC_TOKEN=` i filen `synk/.env` på Macen. Åpne den med:

       ```bash
       open -e ~/Claude/fotostallen-booking/synk/.env
       ```
4. **Distribuer** → **Ny distribusjon** → tannhjulet → **Nettapp**:
   - **Kjør som:** Meg
   - **Hvem har tilgang:** Alle
   - Trykk **Distribuer**, og godkjenn tilgangen Google ber om.
   - Kopier **nettadressen til nettappen** (slutter på `/exec`).
5. Send nettadressen til Claude. Den legges inn i `synk/.env` (`BOOKING_URL`) og i `index.html` (`AVAILABILITY_URL`).

> Endrer du `Code.gs` senere: **Distribuer → Administrer distribusjoner → ✏️ → Versjon: Ny versjon**. Da beholdes samme nettadresse.

## Steg 2 – Start synkjobben på Macen

Test først at alt henger sammen (leser bare, sender ingenting):

```bash
npm --prefix ~/Claude/fotostallen-booking/synk run dry
```

Installer så jobben som kjører hvert 5. minutt:

```bash
npm --prefix ~/Claude/fotostallen-booking/synk run installer
```

Første kjøring lager kalenderen «Fotostallen bookinger» i iCloud. Loggen ser du med:

```bash
npm --prefix ~/Claude/fotostallen-booking/synk run logg
```

Stoppe jobben: `npm --prefix ~/Claude/fotostallen-booking/synk run avinstaller`.

## Steg 3 – Del bookingkalenderen (valgfritt)

I Kalender-appen på Mac: høyreklikk «Fotostallen bookinger» → **Del kalender…** → legg til fotografene. Da ser de de foreløpige bookingene på telefonen. Hver avtale har fotografens navn i tittelen, f.eks. «FORELØPIG – Glenn – Torggata 1».

Når en booking er bekreftet, legg den inn i fotografens vanlige kalender (da plukker fakturaroboten den opp som før), og slett den foreløpige.

---

## Endre fotografer, kalendere eller tidsluker

Endringer må gjøres to steder:

- `index.html`: `PHOTOGRAPHERS` og `SLOT_STARTS`, `SLOT_HOURS`, `WORKDAYS`, `MIN_LEAD_HOURS`
- `apps-script/Code.gs`: `CONFIG` øverst. `ICLOUD_CALENDARS` sier hvilken iCloud-kalender som hører til hvilken fotograf. Lim inn filen på nytt i Apps Script og lag ny versjon av distribusjonen.

## Tester

```bash
node --test apps-script/test.js
```
