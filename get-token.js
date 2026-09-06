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
 * Two modes, automatic fallback:
 *   - Default: a tiny localhost listener (port 4692) catches Google's
 *     redirect and finishes on its own. Keep this window open.
 *   - If the port is busy or you pass --paste: you paste the redirect URL
 *     from the browser address bar instead.
 *
 * Requires no npm dependencies (Node 18+).
 */

const crypto = require("crypto");
const readline = require("readline");
const http = require("http");
const { exec } = require("child_process");

const CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
const PORT = 4692;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = "https://www.googleapis.com/auth/gmail.send";
const PASTE_MODE = process.argv.includes("--paste");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "❌ Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first — see the header of this file."
  );
  process.exit(1);
}

// Fresh PKCE pair per run — old authorization codes never carry over.
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

function successOutput(refreshToken) {
  console.log("\n════════════════════════════════════════════════════════");
  console.log("✅ Success! Add these to Render (Environment) — keep them secret:");
  console.log("════════════════════════════════════════════════════════\n");
  console.log(`GMAIL_CLIENT_ID=${CLIENT_ID}`);
  console.log(`GMAIL_CLIENT_SECRET=${CLIENT_SECRET}`);
  console.log(`GMAIL_REFRESH_TOKEN=${refreshToken}`);
  console.log("\nMAIL_USER = the Gmail address you just signed in with.\n");
  console.log(
    "⚠️  Anyone with these values can send email as you — treat them like passwords."
  );
}

async function exchangeCode(code) {
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
      "\nredirect_uri_mismatch → the OAuth client must be type “Desktop app”.\n" +
        "invalid_grant → the code was used/expired/truncated — run again and\n" +
        "complete the flow fresh."
    );
    process.exit(1);
  }
  successOutput(data.refresh_token);
  // Small delay avoids a libuv shutdown assertion on Windows consoles.
  setTimeout(() => process.exit(0), 300).unref();
}

function openBrowser() {
  const cmd =
    process.platform === "win32"
      ? `start "" "${authUrl}"`
      : process.platform === "darwin"
        ? `open "${authUrl}"`
        : `xdg-open "${authUrl}"`;
  exec(cmd, () => {});
}

function pasteFlow() {
  console.log("📋 Paste mode.");
  console.log("1. Open this URL in the browser, sign in, click Allow:\n");
  console.log(authUrl + "\n");
  console.log(
    "2. The browser will land on “can't reach this page” — normal.\n" +
      "   Copy the FULL address-bar URL.\n"
  );
  console.log(
    "   TIP: if pasting into this window truncates the URL, paste it into\n" +
      "   Notepad first, then copy it in two halves.\n"
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("Pasted URL (or just the code): ", async (answer) => {
    rl.close();
    const raw = (answer || "").trim();
    const match = raw.match(/[?&]code=([^&\s]+)/);
    let code = match ? decodeURIComponent(match[1]) : raw;
    if (!code || code.startsWith("http")) {
      console.error("❌ No usable ?code= found in what was pasted. Run again.");
      process.exit(1);
    }
    try {
      await exchangeCode(code);
    } catch (e) {
      console.error("❌ Token exchange failed:", e.message);
      process.exit(1);
    }
  });
}

function serverFlow() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    const reply = (html) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    };

    if (error) {
      reply(`<h2>Consent failed: ${error}</h2>You can close this tab.`);
      console.error("❌ Consent error:", error);
      process.exit(1);
    }
    if (!code) {
      res.writeHead(404).end();
      return;
    }

    reply(
      "<h2>✅ Success — refresh token printed in the terminal.</h2>You can close this tab."
    );
    console.log("\n✅ Google redirected back — exchanging the code…");
    server.close();
    try {
      await exchangeCode(code);
    } catch (e) {
      console.error("❌ Token exchange failed:", e.message);
      process.exit(1);
    }
  });

  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.warn(
        `⚠️  Port ${PORT} is busy — switching to paste mode instead.\n`
      );
      pasteFlow();
      return;
    }
    throw e;
  });

  server.listen(PORT, () => {
    console.log("1️⃣  Opening Google consent in your browser…");
    console.log("    (If nothing opens, copy this URL into the browser):\n");
    console.log(authUrl + "\n");
    console.log("2️⃣  Sign in and click Allow. That's it — this window does");
    console.log("    the rest automatically. Keep it open.\n");
    openBrowser();
  });
}

if (PASTE_MODE) {
  pasteFlow();
} else {
  serverFlow();
}
