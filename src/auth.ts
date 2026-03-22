/**
 * @file auth.ts
 * @description Next-Auth SSO authentication flow for web.budgetbakers.com.
 *
 * Flow:
 *   1. POST user.ssoSignInEmail  → server sends login email, returns ssoKey
 *   2. User pastes link/token from email
 *   3. POST user.confirmSsoAuth  → exchanges ssoKey + ssoToken for authToken
 *   4. GET  /auth/csrf           → fetches csrfToken required by Next-Auth
 *   5. POST /auth/callback/sso   → sets __Secure-next-auth.session-token cookie
 *   6. GET  user.getUser         → returns userId + CouchDB replication config
 */

import axios from "axios";
import qs from "qs";
import readline from "readline";
import {CookieJar} from "tough-cookie";
import {wrapper} from "axios-cookiejar-support";
import type {LoginResult, ReplicationConfig} from "./types.js";
import {Logger} from "./logger.js";

export const WEB_ORIGIN = "https://web.budgetbakers.com";
export const API_ENDPOINT = `${WEB_ORIGIN}/api`;

interface TrpcResponse<T> {
    result?: { data?: { json?: T } };
}

interface UserData {
    userId: string;
    replication: ReplicationConfig;

    [key: string]: unknown;
}

/** Shared cookie jar — persists Next-Auth session cookie across requests. */
export const jar = new CookieJar();

/** Axios instance with cookie-jar support for web.budgetbakers.com. */
// NodeNext can surface dual-signature Axios types; normalize to wrapper input.
export const webClient = wrapper(axios as unknown as Parameters<typeof wrapper>[0]);
webClient.defaults.jar = jar;
webClient.defaults.withCredentials = true;

/**
 * Triggers an SSO login email to the given address.
 * Returns the `ssoKey` that must be paired with the token from the email.
 */
async function requestSsoEmail(email: string): Promise<string> {
    const res = await webClient.post<[TrpcResponse<string>]>(
        `${API_ENDPOINT}/trpc/user.ssoSignInEmail?batch=1`,
        {"0": {json: email}},
        {headers: {"Content-Type": "application/json"}}
    );
    const key = res.data[0]?.result?.data?.json;
    if (!key) throw new Error(`No SSO key in response: ${JSON.stringify(res.data)}`);
    return key;
}

/**
 * Prompts stdin for the SSO link or raw token from the login email.
 * Accepts either the full redirect URL or the token string alone.
 */
export function promptSsoToken(): Promise<string> {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({input: process.stdin, output: process.stdout});
        rl.question("Paste the SSO link or token from your e-mail: ", (input) => {
            rl.close();
            if (!input?.trim()) {
                reject(new Error("SSO token is required"));
                return;
            }
            const PREFIX = `${WEB_ORIGIN}/sso?ssoToken=`;
            resolve(input.startsWith(PREFIX) ? input.slice(PREFIX.length) : input.trim());
        });
    });
}

/**
 * Exchanges the ssoKey (from the server) and ssoToken (from the email)
 * for a short-lived authToken.
 */
async function confirmSsoAuth(
    email: string,
    ssoKey: string,
    ssoToken: string
): Promise<string> {
    const res = await webClient.post<[TrpcResponse<string>]>(
        `${API_ENDPOINT}/trpc/user.confirmSsoAuth?batch=1`,
        {"0": {json: {ssoKey, ssoToken, userEmail: email}}},
        {headers: {"Content-Type": "application/json"}}
    );
    const token = res.data[0]?.result?.data?.json;
    if (!token) throw new Error(`No auth token in response: ${JSON.stringify(res.data)}`);
    return token;
}

/**
 * Fetches the CSRF token required by Next-Auth for the session callback POST.
 */
async function fetchCsrfToken(): Promise<string> {
    const res = await webClient.get<{ csrfToken?: string }>(`${API_ENDPOINT}/auth/csrf`);
    if (!res.data?.csrfToken) throw new Error("No CSRF token in response");
    return res.data.csrfToken;
}

/**
 * POSTs to the Next-Auth SSO callback endpoint.
 * Stops before following the redirect so the Set-Cookie header can be read.
 * Returns the raw session token value from the cookie.
 */
async function exchangeForSessionToken(
    authToken: string,
    csrfToken: string
): Promise<string> {
    const cookies = await jar.getCookies(WEB_ORIGIN);
    const callbackUrl =
        cookies.find((c) => c.key.includes("callback-url"))?.value ?? WEB_ORIGIN;

    const res = await webClient.post(
        `${API_ENDPOINT}/auth/callback/sso`,
        qs.stringify({token: authToken, csrfToken, callbackUrl}),
        {
            headers: {"Content-Type": "application/x-www-form-urlencoded"},
            maxRedirects: 0,
            validateStatus: (s) => s >= 200 && s < 400,
        }
    );

    const COOKIE_NAME = "__Secure-next-auth.session-token=";
    const sessionToken = (res.headers["set-cookie"] as string[] | undefined)
        ?.find((c) => c.startsWith(COOKIE_NAME))
        ?.split(";")[0]
        ?.slice(COOKIE_NAME.length);

    if (!sessionToken) {
        throw new Error(
            `No session token in callback response: ${JSON.stringify(res.headers)}`
        );
    }
    return sessionToken;
}

/**
 * Fetches the user profile which contains both the userId and the CouchDB
 * replication credentials (`replication.login` + `replication.token`).
 *
 * This is the single source of truth for CouchDB auth — no separate call needed.
 */
export async function fetchUserData(): Promise<UserData> {
    const input = encodeURIComponent(
        JSON.stringify({"0": {json: null, meta: {values: ["undefined"]}}})
    );
    const res = await webClient.get<[TrpcResponse<UserData>]>(
        `${API_ENDPOINT}/trpc/user.getUser?batch=1&input=${input}`
    );
    const data = res.data[0]?.result?.data?.json;
    if (!data?.userId) throw new Error("No userId in getUser response");
    if (!data?.replication) throw new Error("No replication config in getUser response");
    return data;
}

/**
 * Authenticates with BudgetBakers.
 *
 * Two modes:
 * - **Session reuse**: pass a previously saved `sessionToken` to skip SSO entirely.
 * - **Full SSO**: omit `sessionToken` — triggers login email and prompts stdin.
 *
 * Always persist the returned `sessionToken` for subsequent runs.
 *
 * @example
 * // First run
 * const { sessionToken, replication } = await login("you@example.com");
 * fs.writeFileSync(".session", sessionToken);
 *
 * // Subsequent runs
 * const saved = fs.readFileSync(".session", "utf8").trim();
 * await login("you@example.com", saved);
 */
export async function login(
    email: string,
    sessionToken: string | null = null,
    log: Logger
): Promise<LoginResult> {
    if (!email?.trim()) throw new Error("E-mail address is required");

    const mask = (token: string): string => {
        if (token.length <= 10) return "[masked]";
        return `${token.slice(0, 4)}...${token.slice(-4)}`;
    };

    if (sessionToken) {
        log("Reusing existing session token", {sessionToken: mask(sessionToken)});
        // Inject the existing session cookie so subsequent web requests are authed.
        await jar.setCookie(
            `__Secure-next-auth.session-token=${sessionToken}; Path=/; Secure; HttpOnly; SameSite=Lax`,
            WEB_ORIGIN
        );
    } else {
        log("Starting full SSO flow");
        const ssoKey = await requestSsoEmail(email);
        log("Received ssoKey", {ssoKey: mask(ssoKey)});
        const ssoToken = await promptSsoToken();
        log("Received ssoToken", {ssoToken: mask(ssoToken)});
        const authToken = await confirmSsoAuth(email, ssoKey, ssoToken);
        log("Received authToken", {authToken: mask(authToken)});
        const csrfToken = await fetchCsrfToken();
        log("Received csrfToken", {csrfToken: mask(csrfToken)});
        sessionToken = await exchangeForSessionToken(authToken, csrfToken);
        log("Session exchange completed", {sessionToken: mask(sessionToken)});
    }

    const user = await fetchUserData();
    log("Fetched user data", {userId: user.userId});
    return {sessionToken, userId: user.userId, replication: user.replication};
}
