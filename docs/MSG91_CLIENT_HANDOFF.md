# MSG91 — What we need from you

Hi! To wire up patient OTP login in the MyHealth Genie app, we need three
values from your MSG91 account. The setup below is a one-time task — once
you share these, we can switch real SMS on from our side.

## Prerequisite — DLT registration

Indian SMS regulations (TRAI) require every SMS to be sent from a
DLT-registered sender, using a DLT-approved template. **This is set up
outside MSG91**, on a DLT portal (most commonly Jio TrueConnect:
https://trueconnect.jio.com).

Please confirm that on the DLT portal you already have:

- [ ] **Principal Entity (PE) registration** for Gini Health
- [ ] **An approved Header** (the 6-letter sender, e.g. `GINIHL`)
- [ ] **An approved Content Template** for OTP delivery. The body must
      contain the placeholder `{#var#}` for the OTP. Suggested wording:

  > Your MyHealth Genie OTP is {#var#}. Do not share with anyone. - GINIHL

If any of these are missing, please complete the DLT registration first —
no SMS to Indian numbers will deliver without it. Typical turnaround is
24–72 hours.

## In MSG91 — three things to set up

### 1. Link your DLT account to MSG91

So MSG91 can use your DLT-approved sender + template.

1. Log in at https://control.msg91.com
2. Left sidebar → **DLT** (or **Settings → DLT**)
3. Click **Link DLT Account** → enter your DLT PE ID and credentials
4. Wait a few minutes for templates and senders to sync over

After this, your approved sender and templates will appear automatically
in MSG91's **Sender IDs** and **Templates** lists.

### 2. Create a Flow

A Flow is MSG91's bundle that ties the sender + template together so we
can trigger it by an ID.

1. Left sidebar → **Flows** → **Create Flow**
2. Name it: `genie_otp` (or anything you like)
3. **Sender:** pick your approved 6-letter sender
4. **Template:** pick the OTP template from step 1
5. **Variable:** the template has one variable for the OTP code. **Rename
   the variable to exactly `OTP`** (uppercase, no spaces). This is
   important — our backend sends `OTP` as the variable name.
6. Save the Flow
7. After save, a **Flow ID** appears next to it (a long alphanumeric
   string like `66a4f2c8d5e2b3e8f9012345`). Copy this — we'll need it.

### 3. Get your Auth Key

1. Profile icon (top-right) → **Auth Keys**
2. Copy the Auth Key (~25 characters, looks like `4XXXXXAabcdefGHIJKLM…`)

### 4. Confirm wallet balance

MSG91 deducts credits per SMS. Make sure the wallet has enough credits
for testing + initial rollout. Recharge from **Wallet → Recharge** if
needed.

---

## What to send us

Please share the following three values (securely — over a password
manager, encrypted message, or via the team's preferred secret-sharing
channel — not plain email):

| Label | Example shape | Where it came from |
|---|---|---|
| **MSG91 Auth Key** | `4XXXXXAabcdefGHIJKLMnop` | Step 3 above |
| **MSG91 Flow ID** | `66a4f2c8d5e2b3e8f9012345` | Step 2.7 above |
| **MSG91 Sender ID** | `GINIHL` (your 6-letter header) | Approved sender from DLT |

Optionally also share:
- Which DLT portal you registered on (Jio / Vi / Airtel / etc.) — so we
  know where to look if a template ever needs updating.
- The MSG91 account email/login — so we can troubleshoot delivery
  failures from the dashboard if needed.

That's it — once we have those three values, we'll plug them into the
backend, switch off the dev-console mode, and real OTP SMS will start
flowing to patient phones. Thanks!
