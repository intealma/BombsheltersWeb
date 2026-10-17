# Demo walkthrough (about 15 minutes)

Before the meeting: `npm run demo:reset`, then open the app once. Have the access code
ready to say out loud. Everything shown is fictional, except that the addresses are real
shelters from MCF's open data; say so at the start. The DEMO strip on every screen helps.

## 1. Länsstyrelse: the county at a glance (4 min)

Role switcher → **Länsstyrelse** → **Länsstyrelsens översikt**.

- The map and the status counts: Förelagd, Försenad, Inskickad, Godkänd, Brister,
  Platsbesök krävs. Point out that each status has its own shape, not just a colour.
- Filter **Kommun: Linköping**, click **Försenad** to show overdue owners, sort by
  capacity, then **Exportera CSV**.
- Choose a few "Ej förelagd" shelters (click them on the map, or Shift-drag a box),
  set a date and **Skapa förelägganden**. Copy the link for Demo Fastigheter AB.
- Open the review queue (**Att granska**) and review one submission item by item.
  Mark one item **Platsbesök krävs** and save. The map updates.
- Optionally, in **Kommunernas insyn**, show that the kommun only gets the overview by
  default.

## 2. Fastighetsskötare: the self-check on a phone (4 min)

Use a phone, or the browser's phone size. **Byt roll** → **Fastighetsskötare**.

- Open a shelter marked **Förelagd** → **Starta egenkontroll**.
- One item per screen: mark one **Brist**, take a photo (required), write a comment.
- Mention that everything is saved on the phone; reload to show the draft survives.
- **Skicka in** → receipt → **Ladda ner PDF**.
- Switch back to **Länsstyrelse**: the shelter is now **Inskickad**, within seconds.

## 3. Fastighetsägare: upkeep and the 48-hour plan (4 min)

**Byt roll** → **Fastighetsägare**.

- The start page: a status and the last check per shelter.
- A shelter's **Underhållslogg**: dated entries, one voided with a reason, **Ladda ner
  PDF**. Explain why it cannot be edited: it is evidence for compensation.
- **48-timmarsplan** → **Starta simulering**. Show the countdown and the SIMULERING
  banner; tick off a task on a shelter page and watch the progress move. End the
  simulation.

## 4. Kommun: informing residents (2 min)

**Byt roll** → **Kommun** → **Beredskapsöversikt**.

- Share of shelters checked and approved, places in approved shelters, the coarse map.
- Point out what is *not* shown: no deficiencies, no photos. The länsstyrelse decides.

## After the meeting

`npm run demo:reset` restores everything in one step.
