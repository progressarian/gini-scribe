import { request } from "@playwright/test";
import { PIN, USERS, CONSULTANTS } from "../fixtures/data.mjs";
import { API_URL } from "../setup/testEnv.mjs";

const everyone = { ...USERS, ...CONSULTANTS };
const cache = new Map();

export function userFor(role) {
  const user = everyone[role];
  if (!user) throw new Error(`No e2e fixture user for "${role}"`);
  return user;
}

export async function tokensFor(role) {
  if (cache.has(role)) return cache.get(role);
  const user = userFor(role);
  const context = await request.newContext({ baseURL: API_URL });
  const response = await context.post("/api/auth/login", {
    data: { doctor_id: user.id, pin: PIN },
  });
  const body = await response.json();
  await context.dispose();
  if (!response.ok())
    throw new Error(`Login as ${role} failed: ${response.status()} ${body.error}`);
  const tokens = { access: body.access_token, refresh: body.refresh_token, doctor: body.doctor };
  cache.set(role, tokens);
  return tokens;
}

export async function apiAs(role) {
  const { access } = await tokensFor(role);
  return request.newContext({
    baseURL: API_URL,
    extraHTTPHeaders: { Authorization: `Bearer ${access}` },
  });
}

export async function anonymousApi() {
  return request.newContext({ baseURL: API_URL });
}

export async function loginAs(page, role) {
  const { access, refresh } = await tokensFor(role);
  await page.addInitScript(
    ([token, refreshToken]) => {
      window.localStorage.setItem("gini_auth_token", token);
      window.localStorage.setItem("gini_refresh_token", refreshToken);
    },
    [access, refresh],
  );
}

export function clearTokenCache() {
  cache.clear();
}
