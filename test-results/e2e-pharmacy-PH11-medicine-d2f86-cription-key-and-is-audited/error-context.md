# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: e2e/pharmacy/PH11-medicines.spec.js >> PH11 pharmacy medicines >> a new medicine gets a code and a prescription key, and is audited
- Location: e2e/pharmacy/PH11-medicines.spec.js:52:3

# Error details

```
Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3101
Call log:
  - → POST http://localhost:3101/api/auth/login
    - user-agent: Playwright/1.64.1 (x64; ubuntu 22.04) node/24.18
    - accept: */*
    - accept-encoding: gzip,deflate,br
    - content-type: application/json
    - content-length: 31

```

# Test source

```ts
  1  | import { request } from "@playwright/test";
  2  | import { PIN, USERS, CONSULTANTS } from "../fixtures/data.mjs";
  3  | import { API_URL } from "../setup/testEnv.mjs";
  4  | 
  5  | const everyone = { ...USERS, ...CONSULTANTS };
  6  | const cache = new Map();
  7  | 
  8  | export function userFor(role) {
  9  |   const user = everyone[role];
  10 |   if (!user) throw new Error(`No e2e fixture user for "${role}"`);
  11 |   return user;
  12 | }
  13 | 
  14 | export async function tokensFor(role) {
  15 |   if (cache.has(role)) return cache.get(role);
  16 |   const user = userFor(role);
  17 |   const context = await request.newContext({ baseURL: API_URL });
> 18 |   const response = await context.post("/api/auth/login", {
     |                                  ^ Error: apiRequestContext.post: connect ECONNREFUSED 127.0.0.1:3101
  19 |     data: { doctor_id: user.id, pin: PIN },
  20 |   });
  21 |   const body = await response.json();
  22 |   await context.dispose();
  23 |   if (!response.ok())
  24 |     throw new Error(`Login as ${role} failed: ${response.status()} ${body.error}`);
  25 |   const tokens = { access: body.access_token, refresh: body.refresh_token, doctor: body.doctor };
  26 |   cache.set(role, tokens);
  27 |   return tokens;
  28 | }
  29 | 
  30 | export async function apiAs(role) {
  31 |   const { access } = await tokensFor(role);
  32 |   return request.newContext({
  33 |     baseURL: API_URL,
  34 |     extraHTTPHeaders: { Authorization: `Bearer ${access}` },
  35 |   });
  36 | }
  37 | 
  38 | export async function anonymousApi() {
  39 |   return request.newContext({ baseURL: API_URL });
  40 | }
  41 | 
  42 | export async function loginAs(page, role) {
  43 |   const { access, refresh } = await tokensFor(role);
  44 |   await page.addInitScript(
  45 |     ([token, refreshToken]) => {
  46 |       window.localStorage.setItem("gini_auth_token", token);
  47 |       window.localStorage.setItem("gini_refresh_token", refreshToken);
  48 |     },
  49 |     [access, refresh],
  50 |   );
  51 | }
  52 | 
  53 | export function clearTokenCache() {
  54 |   cache.clear();
  55 | }
  56 | 
```