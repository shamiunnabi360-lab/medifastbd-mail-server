/**
 * get-token.js — one-time Gmail API setup for the MediFastBD mail server.
 *
 * Walks you through Google's OAuth consent and prints a REFRESH TOKEN that
 * never expires (unless you revoke it). Paste the printed values into
 * Render as GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.
 *
 * Before running:
 *   1. Google Cloud Console → APIs & Services → Library → "Gmail API" → Enable.
 *   2. OAuth consent screen → External → add your Gmail as a Test user
 *      (or publish the app to production).
 *   3. Credentials → Create credentials → OAuth client ID → Desktop app
 *      → copy the Client ID + Secret.
 *
 * Run (from carelink-server/):
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node get-token.js
 * or on Windows PowerShell:
 *   $env:GMAIL_CLIENT_ID="xxx"; $env:GMAIL_CLIENT_SECRET="yyy"; node get-token.js
 *
 * NOTE: after you click "Allow", the browser WILL show "can't reach this
 * page" — that is normal. Copy the URL from the address bar and paste it
 * back here; this script exchanges the code without needing a local
 * web server, so port/timing problems can never occur.
 *
 * Requires no npm dependencies (Node 18+).
 */

const crypto = require("crypto");
const readline = require("readline");

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
const REDIRECT_URI = "http://localhost:4692";
const SCOPE = "https://www.googleapis.com/auth/gmail.send";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "❌ Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first — see the header of this file."
  );
  process.exit(1);
}

const codeVerifier = crypto.randomBytes(32).toString("base64url");
const codeChallenge = crypto
  .createHash("sha256")
  .update(codeVerifier)
  .digest("base64url");

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth" +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  "&response_type=code" +
  `&scope=${encodeURIComponent(SCOPE)}` +
  "&access_type=offline" +
  "&prompt=consent" +
  `&code_challenge=${codeChallenge}` +
  "&code_challenge_method=S256";

console.log("\n1️⃣  Open this URL in your browser and sign in with the");
console.log("    Gmail account that will SEND the emails:\n");
console.log(authUrl + "\n");
console.log("    (Trying to auto-open it for you… if nothing happens, copy the URL above.)\n");

const open =
  process.platform === "win32"
    ? `start "" "${authUrl}"`
    : process.platform === "darwin"
      ? `open "${authUrl}"`
      : `xdg-open "${authUrl}"`;
require("child_process").exec(open, () => {});

console.log("2️⃣  Click Allow.");
console.log("    ⚠️  The browser will then show “can't reach this page” — THAT IS NORMAL.");
console.log("    Copy the FULL URL from the browser's address bar");
console.log("    (it looks like http://localhost:4692/?code=4/0Axxx…&scope=…)");
console.log("    and paste it below, then press Enter.\n");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("Pasted URL (or just the code): ", async (answer) => {
  rl.close();

  const raw = (answer || "").trim();
  let code = raw;

  // Accept a full URL, a redirect URL with extra params, or a bare code.
  const match = raw.match(/[?&]code=([^&\s]+)/);
  if (match) code = decodeURIComponent(match[1]);
  if (code.startsWith("http")) {
    console.error("❌ That looks like a URL but no ?code= parameter was found in it.");
    process.exit(1);
  }
  if (!code) {
    console.error("❌ Nothing pasted. Run the script again.");
    process.exit(1);
  }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) {
      console.error("❌ No refresh_token in the response. Details:");
      console.error(JSON.stringify(data, null, 2));
      console.error(
        "\nIf the error is redirect_uri_mismatch, the OAuth client must be type\n" +
          "“Desktop app”. If invalid_grant, the code was already used or expired —\n" +
          "run this script again and paste a FRESH URL."
      );
      process.exit(1);
    }

    console.log("\n════════════════════════════════════════════════════════");
    console.log("✅ Success! Add these to Render (Environment) — keep them secret:");
    console.log("════════════════════════════════════════════════════════\n");
    console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GMAIL_REFRESH_TOKEN=${data.refresh_token}`);
    console.log(
      "\nMAIL_USER = the Gmail address you just signed in with.\n"
    );
    console.log(
      "⚠️  Anyone with these values can send email as you — treat them like passwords."
    );
    process.exit(0);
  } catch (e) {
    console.error("❌ Token exchange failed:", e.message);
    process.exit(1);
  }
});
