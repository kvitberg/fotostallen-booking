# Koble bookingsiden til fotografenes kalendere

Bookingsiden viser ledige tider på hverdager: oppdrag på 1,5 time med start 08:00, 09:30, 11:00, 12:30, 14:00 og 15:30, og for kveldsfoto én luke som starter 30 minutter før solnedgang i Oslo. Ledighet hentes fra de samme iCloud-kalenderne som fakturaroboten leser, og hver bestilling legges inn i **fotografens egen kalender**.

```
iCloud: «Glenn Foto», «Scott foto», …  ◀──les og skriv (CalDAV)──  synkjobb på Scotts Mac (hvert 5. min)
                                                                       │  bare ledig/opptatt per luke
                                                                       ▼
bookingsiden  ◀──ledige luker / nye bookinger──▶  Apps Script (Scotts Google-konto, kø)
```

- **Synkjobben** (`synk/kalendersynk.mjs`) bruker samme iCloud-innlogging som fakturaroboten (leses fra fakturarobotens `.env.local`). Til Apps Script-en sender den bare ett tegn per dag og fotograf som sier hvilke luker som er ledige. Titler og detaljer fra kalenderne forlater aldri Macen.
- **Apps Script-en** (`apps-script/Code.gs`) svarer bookingsiden og holder nye bookinger i en kø. En booket luke blir opptatt med en gang.
- **Bookingen** legges i kalenderen til fotografen kunden valgte. Velger kunden «Første ledige», trekker siden en tilfeldig fotograf som er ledig på tidspunktet og viser den fotografen («Første ledige → Kristine»). Bookingen havner hos den fotografen.
- **Fakturaroboten** ser bookingen som et oppdrag (tittel «Nettbooking fotografering – Navn – Adresse», kundeinfo i notatet). Tittelen har ikke vanlig «Kontor:Megler»-format, så oppdraget havner i **Sjekk**. Når oppdraget er bekreftet, gi tittelen vanlig format, så faktureres det som andre oppdrag. Avlyses det, slett avtalen.
- Kan en fotografs kalender ikke skrives til, havner bookingen i «Scott foto» med beskjed om hvem den var ment for.
- Macen sender bare forespørsler ut. Ingenting på den åpnes mot internett.

Er Macen av, viser siden de sist kjente ledige tidene. Nye bookinger venter i køen og legges inn når Macen er på igjen. De kommer uansett også inn via Google-skjemaet.

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

Loggen ser du med:

```bash
npm --prefix ~/Claude/fotostallen-booking/synk run logg
```

Stoppe jobben: `npm --prefix ~/Claude/fotostallen-booking/synk run avinstaller`.

---


## Bekreftelse på e-post

Apps Script-en sender en bekreftelse til kunden fra **booking@fotostallen.no**, med kopi til samme adresse, så snart den adressen er lagt inn som «Send e-post som»-alias i Gmail-kontoen som eier skriptet (scott.kvitberg@gmail.com → Innstillinger → Kontoer → Send e-post som). Før aliaset finnes, sendes ingen e-post, og kunden ser bare kvitteringen på siden.

## Endre fotografer, kalendere eller tidsluker

Endringer må gjøres to steder:

- `index.html`: `PHOTOGRAPHERS`, `DURATION_MIN`, `DAY_SLOTS`, `EVENING`, `WORKDAYS`, `MIN_LEAD_HOURS`, `AUTO_ASSIGN_EXCLUDE`
- `apps-script/Code.gs`: `CONFIG` øverst. `ICLOUD_CALENDARS` sier hvilken iCloud-kalender som hører til hvilken fotograf. Lim inn filen på nytt i Apps Script og lag ny versjon av distribusjonen.

## Tester

```bash
node --test apps-script/test.js
```
