/**
 * get-token.js — one-time Gmail API setup for the MediFastBD mail server.
 *
 * Walks you through Google's OAuth consent in a browser and prints a
 * REFRESH TOKEN that never expires (unless you revoke it). Paste it into
 * Render as GMAIL_REFRESH_TOKEN.
 *
 * Before running:
 *   1. Google Cloud Console (console.cloud.google.com) → pick the project
 *      your Firebase app uses → APIs & Services → Library → search
 *      "Gmail API" → Enable.
 *   2. APIs & Services → OAuth consent screen → External → fill the app
 *      name/email → add your own Gmail as a Test user.
 *   3. APIs & Services → Credentials → Create credentials → OAuth client
 *      ID → Application type: Desktop app → copy the Client ID + Secret.
 *
 * Run (from carelink-server/):
 *   GMAIL_CLIENT_ID=xxx GMAIL_CLIENT_SECRET=yyy node get-token.js
 * or on Windows PowerShell:
 *   $env:GMAIL_CLIENT_ID="xxx"; $env:GMAIL_CLIENT_SECRET="yyy"; node get-token.js
 *
 * Requires no npm dependencies (Node 18+).
 */

const http = require("http");
const crypto = require("crypto");
const { exec } = require("child_process");

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
const PORT = 4692;
const REDIRECT_URI = `http://localhost:${PORT}`;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<h2>Consent failed: " + error + "</h2>You can close this tab.");
    console.error("❌ Consent error:", error);
    process.exit(1);
  }
  if (!code) {
    res.writeHead(404).end();
    return;
  }

  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    "<h2>✅ Success — refresh token printed in the terminal.</h2>You can close this tab."
  );
  server.close();

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
      console.error(
        "❌ No refresh_token in response. Re-run and make sure to pick your account and click Allow (prompt=consent is set, so this should not happen)."
      );
      console.error(JSON.stringify(data, null, 2));
      process.exit(1);
    }

    console.log("\n════════════════════════════════════════════════════════");
    console.log("✅ Add these to Render (Environment) — and keep them secret:");
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

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `❌ Port ${PORT} is busy — an earlier run of this script is still open.`
    );
    console.error(
      "   Find and kill it:  netstat -ano | findstr :4692  →  taskkill /PID <pid> /F"
    );
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log("Opening Google consent in your browser…");
  console.log("(If nothing opens, paste this URL manually):\n");
  console.log(authUrl + "\n");
  const open =
    process.platform === "win32"
      ? `start "" "${authUrl}"`
      : process.platform === "darwin"
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
  exec(open, () => {});
});
