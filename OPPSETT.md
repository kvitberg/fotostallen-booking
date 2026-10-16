# Koble bookingsiden til fotografenes kalendere

Bookingsiden viser ledige tidsluker (08–10, 10–12, 12–14, 14–16, 16–18 på hverdager) for fotografen kunden velger. Hver bestilling legges inn som en **FORELØPIG**-avtale i en egen bookingkalender for fotografen.

Slik henger det sammen:

```
iCloud-kalender (hver fotograf) ──les──▶ Apps Script på Scotts Google-konto ──ledig/opptatt──▶ bookingsiden
                                              │
                                              └──skriv──▶ «Fotostallen bookinger – Glenn» osv. ──abonnement──▶ Apple Kalender
```

Bookingsiden får aldri se hva avtalene heter, bare om lukene er ledige eller opptatte. Ingen Apple-passord lagres noe sted.

## Kom i gang: bare Scotts kalender

Vi starter med å koble bare Scotts kalender. De andre fotografene viser alle luker på hverdager som ledige til de kobles på senere. Bookinger på dem havner likevel i deres egne bookingkalendere, så samme luke ikke kan bookes to ganger via siden.

1. **Del 1** for deg selv: kopier lenken til jobbkalenderen din i iCloud.
2. **Del 2**: legg inn bare `ICS_scott` i skriptegenskapene, og gjør resten av stegene som beskrevet.
3. **Del 3** for deg selv: abonner på «Fotostallen bookinger – Scott» og «Fotostallen bookinger – Første ledige».

Når en ny fotograf skal kobles på: be dem gjøre del 1, legg til `ICS_<navn>` i skriptegenskapene (ingen ny distribusjon trengs), og send dem adressen i del 3.

---

Fullt oppsett har tre deler. Del 1 gjør hver fotograf, del 2 gjør Scott én gang, og del 3 gjør hver fotograf.

---

## Del 1 – Hver fotograf: del iCloud-kalenderen som lenke

**På Mac (Kalender-appen):**
1. Høyreklikk på kalenderen med jobbavtalene i venstre kolonne → **Del kalender…**
2. Huk av **Offentlig kalender**, og trykk **Ferdig**.
3. Høyreklikk på kalenderen igjen → **Kopier URL**. Lenken starter med `webcal://`.

**På iPhone:**
1. Kalender-appen → **Kalendere** nederst → trykk **ⓘ** ved jobbkalenderen.
2. Slå på **Offentlig kalender** → **Del lenke…** → kopier.

Send lenken til Scott på en privat kanal. Alle som har lenken kan se avtalene, så den skal ikke deles videre.

> Bruker du flere kalendere (f.eks. «Jobb» og «Privat»), velg den som styrer når du kan ta oppdrag. Foreløpig støttes én kalender per fotograf.

---

## Del 2 – Scott: sett opp skriptet (ca. 10 minutter, én gang)

1. Gå til **[script.google.com](https://script.google.com)** (logget inn med Google-kontoen din) → **Nytt prosjekt**. Gi det navnet «Fotostallen booking».
2. Slett innholdet i `Kode.gs`, og lim inn hele [`apps-script/Code.gs`](apps-script/Code.gs). Trykk lagre (💾).
3. **Prosjektinnstillinger** (tannhjulet til venstre):
   - Sett **Tidssone** til `(GMT+01:00) Oslo`.
   - Under **Skriptegenskaper**, legg til én linje per fotograf som har sendt lenke:

     | Egenskap | Verdi |
     |---|---|
     | `ICS_glenn` | iCloud-lenken til Glenn |
     | `ICS_lars` | iCloud-lenken til Lars Petter |
     | `ICS_kevin` | … |
     | `ICS_scott` | … |
     | `ICS_helene` | … |
     | `ICS_kristine` | … |

     Fotografer som ikke er koblet ennå vises med alle luker ledige (bortsett fra luker som allerede er booket via siden).
4. Tilbake i editoren: velg funksjonen **`setup`** i menyen øverst og trykk **Kjør**. Godkjenn tilgangen Google ber om (kalender og eksterne nettadresser). Dette lager én bookingkalender per fotograf, pluss én for «Første ledige».
5. Velg **`testConnections`** og trykk **Kjør**. I loggen nederst skal hver koblet fotograf få en linje som «glenn: 12 opptatte perioder neste 30 dager».
6. **Distribuer** → **Ny distribusjon** → tannhjulet → **Nettapp**:
   - **Kjør som:** Meg
   - **Hvem har tilgang:** Alle
   - Trykk **Distribuer**, og kopier **nettadressen til nettappen** (slutter på `/exec`).
7. Send nettadressen til Claude, eller lim den inn selv i `index.html`:

   ```js
   const AVAILABILITY_URL = "https://script.google.com/macros/s/…/exec";
   ```

   Når den er satt og pushet, henter siden ekte ledige tider.

> Endrer du `Code.gs` senere: **Distribuer → Administrer distribusjoner → ✏️ → Versjon: Ny versjon**. Da beholdes samme nettadresse.

---

## Del 3 – Hver fotograf: se de foreløpige bookingene i Apple Kalender

Scott sender hver fotograf adressen til fotografens egen bookingkalender:

1. **Scott:** Åpne [Google Kalender](https://calendar.google.com) → tannhjulet → **Innstillinger** → velg «Fotostallen bookinger – Glenn» til venstre → kopier **Hemmelig adresse i iCal-format**. Send den til Glenn (og tilsvarende for de andre).
2. **Fotografen, på Mac:** Kalender → **Arkiv → Nytt kalenderabonnement…** → lim inn adressen. Velg **Oppdater: Hvert 5. minutt** og plassering **iCloud**, så den synkes til iPhone også.
   **På iPhone:** Innstillinger → Kalender → Kontoer → Legg til konto → Annet → **Legg til abonnert kalender**.

Når en foreløpig booking bekreftes, legg den inn i din vanlige kalender (eller endre tittelen i Google Kalender). Bookingkalenderen er bare et varsel.

«Første ledige»-bookinger havner i «Fotostallen bookinger – Første ledige». Den bør Scott (eller den som fordeler oppdrag) abonnere på.

---

## Endre tidsluker eller arbeidsdager

Lukene står to steder, og de må være like:

- `index.html`: `SLOT_STARTS`, `SLOT_HOURS`, `WORKDAYS`, `MIN_LEAD_HOURS`
- `apps-script/Code.gs`: `CONFIG` øverst (husk ny versjon av distribusjonen etterpå)

## Teste skriptet lokalt

```bash
node --test apps-script/test.js
```
