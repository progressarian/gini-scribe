# MSG91 OTP Setup — Patient Auth

This is the one-time setup for sending real OTP SMS to Indian patient phones
via MSG91. Until step 5 is done, scribe stays in **dev mode** and prints OTPs
to its console instead of sending real SMS — perfectly fine for development.

## How MSG91 fits in

```
LoginScreen → /api/patient/auth/send-otp
        scribe generates 6-digit OTP
        bcrypt-stores it in patients.otp_code
        scribe → MSG91 Flow API → carrier → phone
LoginScreen → /api/patient/auth/verify-otp  (bcrypt compare)
```

MSG91 is **only the SMS delivery channel**. Scribe owns the OTP, the
verification, and the JWT. MSG91 sees the OTP value only as a variable
inside the template body.

## What you need to collect

| Env var | What it is | Where to copy from |
|---|---|---|
| `MSG91_AUTH_KEY` | Your MSG91 account key | MSG91 dashboard → profile icon (top-right) → **Auth Key** |
| `MSG91_SENDER_ID` | 6-letter DLT-approved header (e.g. `GINIHL`) | MSG91 dashboard → **SMS → Sender IDs** — pick a row with status "Approved" |
| `MSG91_FLOW_ID` | MSG91 internal Flow ID tying template + sender | MSG91 dashboard → **Flows** — created in step 4 below |

## Step 1 — Auth Key

1. Log in to https://control.msg91.com.
2. Profile icon (top-right) → **Auth Keys**.
3. Copy the key. ~25 chars, mixed case + digits.

That's `MSG91_AUTH_KEY`.

## Step 2 — Sender ID (a.k.a. Header)

India's TRAI rules require every SMS to come from a 6-letter sender
registered on a **DLT portal**. This is registered **outside MSG91**, on
the DLT operator's website (see "Where DLT IDs come from" below). Once
registered, the sender shows up automatically in MSG91 → **SMS → Sender IDs**
if the DLT entity is linked.

1. Left sidebar → **SMS → Sender IDs**.
2. Find a row with status **Approved** / **DLT Approved**.
3. Copy the 6-letter value.

If the list is empty, the Gini Health DLT entity hasn't been linked yet —
ask the client which sender they registered, or register one (see
DLT section below). **No SMS will deliver to Indian phones without an
approved DLT sender** — this is a hard regulatory wall.

That's `MSG91_SENDER_ID`.

## Step 3 — DLT-approved template

Every SMS body must match a template registered on DLT before it'll
deliver. Template body for our OTP:

```
Your MyHealth Genie OTP is ##OTP##. Do not share with anyone. - GINIHL
```

`##OTP##` is MSG91's placeholder syntax (double hashes around the
variable name).

1. MSG91 sidebar → **SMS → Templates** (a.k.a. **DLT Templates**).
2. Find an approved template that uses an OTP variable. Note its
   **DLT Template ID** — a 19-digit number like `1707169425874952345`.
3. If no template exists: click **Add Template** → category
   **Transactional → OTP** → paste the body that matches what the
   client got DLT-approved → save. Wait for "Approved" status (usually
   instant if the body is byte-identical to the DLT-registered text).

You do **not** put the DLT Template ID in `.env` directly — it goes into
the Flow in step 4.

## Step 4 — Create the Flow

A "Flow" in MSG91 packages a template + sender + variable mapping into
something the Flow API can trigger by ID.

1. Sidebar → **Flows** (sometimes nested under SMS or Campaigns).
2. Click **Create Flow** / **+ New Flow**.
3. Name it `genie_otp` (anything — only the ID matters).
4. **Sender:** the 6-letter sender from step 2.
5. **Template:** the DLT-approved template from step 3.
6. **Variables:** MSG91 detects `##OTP##` and adds it. Confirm the
   variable name shown is **exactly `OTP`** (uppercase). Scribe sends
   `OTP: "123456"` in the payload — names are case-sensitive.
7. Save.
8. After save, the Flow row shows a **Flow ID** (long alphanumeric, like
   `66a4f2c8d5e2b3e8f9012345`). Copy it.

That's `MSG91_FLOW_ID`.



## Where DLT IDs come from

"DLT" = Distributed Ledger Technology, a TRAI-mandated registry that
all Indian SMS senders must register on. Registration happens on a DLT
**operator portal** (one of several, all sync to each other):

| Operator | Portal | Notes |
|---|---|---|
| Jio | https://trueconnect.jio.com | Most common, simplest UI |
| Vodafone-Idea | https://www.vilpower.in | Slightly more bureaucratic |
| Airtel | https://dltconnect.airtel.in | Per-domain registrations |
| BSNL | https://www.ucc-bsnl.co.in | Rarely used standalone |
| Tata Tele | https://smartping.live | Common with enterprise |

You typically pick **one** registrar (Jio is the path of least resistance
for most startups) and the registration auto-propagates to all carriers.

Three things get IDs there:

1. **PE ID (Principal Entity ID)** — your business itself. ~19-digit
   number. One per legal entity. Required before anything else.
2. **Header (Sender ID)** — a 6-letter abbreviation tied to your PE ID.
   Get this **before** you ask MSG91 for a sender — MSG91 just relays
   what DLT approved.
3. **Content Template ID** — per-template ID for the exact SMS body
   text. 19-digit. Required before MSG91 will deliver that body.

**You probably don't need to do the DLT registration yourself** — the
client (Gini Health) almost certainly has a PE ID, an approved header
(`GINIHL` or similar), and template IDs already registered. The
fastest path:

1. Ask the client which DLT portal they registered on.
2. Log in there, list the registered templates, copy the Content
   Template ID for the OTP template.
3. In MSG91 → **DLT** section → link your DLT account (one-time, asks
   for the PE ID and DLT portal credentials). Once linked, MSG91 pulls
   all approved templates automatically and the IDs flow through.
4. Now in MSG91 → **SMS → Templates** you'll see the DLT-approved
   template with its 19-digit DLT ID already attached. Use that
   template when creating the Flow in step 4.

If you're starting from scratch (no DLT registration at all), you need
to register the PE first, which requires KYC documents (company
registration, GST, authorized signatory ID) and is typically a
24–72 hour process. Out of scope of this scribe-side setup — flag to
the client.

## Glossary cheat sheet

- **PE ID** — Principal Entity ID. The business. From DLT portal.
- **Header / Sender ID** — 6-letter "from". From DLT portal, surfaces in MSG91.
- **DLT Template ID / Content Template ID** — Per-message-body ID. From DLT portal, surfaces in MSG91.
- **MSG91 Flow ID** — MSG91's internal package wrapping a template +
  sender + variables. **Not** a DLT thing — created entirely in MSG91.
  This is the only one that goes in `MSG91_FLOW_ID`.
- **MSG91 Auth Key** — Account credential. Goes in `MSG91_AUTH_KEY`.
