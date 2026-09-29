# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: billing/phase4/P4-38-floor-trial-rehearsal.spec.js >> P4-38 floor trial rehearsal >> one OPD session at the Billing Counter, every case on the checklist
- Location: billing/phase4/P4-38-floor-trial-rehearsal.spec.js:169:3

# Error details

```
Test timeout of 600000ms exceeded.
```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]: G
      - generic [ref=e7]:
        - generic [ref=e8]: Gini Scribe
        - generic [ref=e9]: E2E Reception
    - generic [ref=e10]:
      - button "🔍 Find" [ref=e11] [cursor=pointer]
      - button "Logout" [ref=e12] [cursor=pointer]
  - generic [ref=e13]:
    - link "🏠 Home" [ref=e14] [cursor=pointer]:
      - /url: /
    - link "🔍 Find" [ref=e15] [cursor=pointer]:
      - /url: /find
    - link "🏥 OPD" [ref=e16] [cursor=pointer]:
      - /url: /opd
    - link "👤" [ref=e17] [cursor=pointer]:
      - /url: /patient
    - link "💊 Refills" [ref=e18] [cursor=pointer]:
      - /url: /refills
    - link "🧪 Lab Requests" [ref=e19] [cursor=pointer]:
      - /url: /lab-requests
    - link "🏥 Reception" [ref=e20] [cursor=pointer]:
      - /url: /reception-inbox
    - link "📞 OBT Dashboard" [ref=e21] [cursor=pointer]:
      - /url: /obt-dashboard
    - link "🏥 GHM Ops" [ref=e22] [cursor=pointer]:
      - /url: /ghm
    - link "💊 Medicine Collection" [ref=e23] [cursor=pointer]:
      - /url: /medicine-collection
    - link "🏥 Flow Check-in" [ref=e24] [cursor=pointer]:
      - /url: /flow/checkin
    - link "🧭 GF Stations" [ref=e25] [cursor=pointer]:
      - /url: /giniflow/stations
    - link "🕐 Gini Flow" [ref=e26] [cursor=pointer]:
      - /url: /giniflow/manager
    - link "⚖️ Stations" [ref=e27] [cursor=pointer]:
      - /url: /flow/station
  - generic [ref=e28]:
    - generic [ref=e29]:
      - generic [ref=e30]: Gini Flow
      - generic [ref=e31]: 🧾 Billing Counter
      - generic [ref=e32]:
        - generic "Changes on the floor reach this screen within a second" [ref=e33]: Live
        - link "← Stations" [ref=e35] [cursor=pointer]:
          - /url: /giniflow/stations
    - generic [ref=e36]:
      - complementary "Today's patients" [ref=e37]:
        - generic [ref=e38]:
          - generic [ref=e39]:
            - text: Patients
            - generic [ref=e40]: "6"
          - searchbox "Search today's patients" [ref=e41]
        - generic [ref=e42]:
          - generic [ref=e43]:
            - text: On the floor
            - generic [ref=e44]: "0"
          - generic [ref=e45]: Nobody on the floor.
          - button "Not arrived 6" [ref=e46] [cursor=pointer]:
            - generic [aria-hidden] [ref=e47]: ▸
            - text: Not arrived
            - generic [ref=e48]: "6"
      - separator "Resize the patient list" [ref=e49]
      - generic [ref=e52]:
        - tablist "Billing counter" [ref=e53]:
          - tab "Bill" [ref=e54] [cursor=pointer]
          - tab "Shift" [selected] [ref=e55] [cursor=pointer]
        - tabpanel "Shift" [ref=e56]:
          - region "Shift" [ref=e57]:
            - heading "Your shift" [level=3] [ref=e58]
            - generic [ref=e59]: Open since 29 Sept, 10:48 am · 0 payments on 0 bills
            - table "Drawer" [ref=e60]:
              - rowgroup [ref=e61]:
                - row [ref=e62]:
                  - rowheader "Opening cash" [ref=e63]
                  - cell "₹2,000" [ref=e64]
                - row [ref=e65]:
                  - rowheader "Cash collected" [ref=e66]
                  - cell "₹0" [ref=e67]
                - row [ref=e68]:
                  - rowheader "Card collected" [ref=e69]
                  - cell "₹0" [ref=e70]
                - row [ref=e71]:
                  - rowheader "UPI collected" [ref=e72]
                  - cell "₹0" [ref=e73]
                - row [ref=e74]:
                  - rowheader "Expected in the drawer" [ref=e75]
                  - cell "₹2,000" [ref=e76]
            - generic [ref=e77]:
              - generic [ref=e78]:
                - generic [ref=e79]: Counted cash
                - textbox "Counted cash" [ref=e80]
              - generic [ref=e81]:
                - generic [ref=e82]: Note
                - textbox "Note" [ref=e83]
              - generic "Difference" [ref=e84]: Difference ₹-2,000
              - button "Close shift" [disabled] [ref=e85]
```