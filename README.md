# MediFastBD Mail Server (CareLink + transactional)

Free-tier Node.js server that:
1. Runs a missed-dose check every 15 minutes and emails caregivers when
   2+ consecutive doses are missed.
2. Exposes a tiny `POST /send` endpoint for the Flutter app to send
   transactional emails (receipts, order updates).

Runs on **Render Free** (no credit card). **SMTP2GO** delivers the mail via
its HTTPS API (1,000 emails/month free). Gmail SMTP does **not** work here —
Render blocks outbound SMTP ports (25/465/587) on every plan.

---

## One-time setup

### 1. SMTP2GO account (email delivery)
1. Sign up free at https://www.smtp2go.com (no credit card, no phone
   verification — just confirm your email address).
2. Verify **one sender**: Settings → **Verified Senders** → add your
   Gmail address and click the confirmation link it receives. Caregiver
   alerts can then go to any recipient — no domain or DNS needed.
3. Settings → **API Keys** → **Add API Key** → copy it (starts with
   `api-`).

### 2. Firebase service account
1. Firebase Console → Project Settings → **Service accounts** →
   **Generate new private key**.
2. Open the JSON file — you'll paste its **entire contents** into an env
   var in step 3.

### 3. Deploy on Render (Free Web Service)
1. Push `carelink-server/` to its own GitHub repo (keeps secrets out of
   the app repo).
2. Render dashboard → **New** → **Web Service** → pick the repo.
3. Settings:
   - **Name:** `medifastbd-mail`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
4. **Environment**:
   | Key | Value |
   |---|---|
   | `SMTP2GO_API_KEY` | SMTP2GO API key (`api-…`) |
   | `MAIL_USER` | your **verified SMTP2GO sender** email |
   | `MAIL_SHARED_SECRET` | any random 32+ char string (Flutter sends it as `X-Mail-Secret`) |
   | `FIREBASE_SERVICE_ACCOUNT` | paste the entire JSON from step 2 on one line |
5. Click **Create Web Service**. Wait for the first deploy.

### 4. Keep it awake (Render free sleeps after 15 min idle)
Create a free monitor at https://uptimerobot.com (or
https://cron-job.org) that pings
`https://<your-service>.onrender.com/keepalive` every **14 minutes**.
Without this, the CareLink scheduler will pause whenever the instance
spins down.

### 5. Verify
```bash
curl https://<your-service>.onrender.com/health
# {"ok":true}
```

---

## Endpoints

### `GET /health`
Liveness probe. Returns `{"ok":true}`.

### `GET /keepalive`
Cheap endpoint for uptime monitors. Returns `{"ok":true,"ts":…}`.

### `GET /`
Service info + last check timestamp + last error (if any).

### `POST /send`
Send a transactional email from your Flutter app.

**Headers**
- `Content-Type: application/json`
- `X-Mail-Secret: <MAIL_SHARED_SECRET>`

**Body**
```json
{
  "to": "patient@example.com",
  "subject": "Your MediFastBD receipt",
  "text": "Plain-text fallback",
  "html": "<p>HTML body</p>",
  "replyTo": "support@medifastbd.com"
}
```
`to` may be a string or an array. Either `text` or `html` is required
(missing fields get auto-derived). Rate-limited to 30 / minute / IP.

---

## Free-tier limits to respect

| Service | Limit | Notes |
|---|---|---|
| SMTP2GO API | 1,000 emails / month (200/day) | Plenty for caregiver alerts + receipts |
| Render Free Web Service | 750 hrs / month | Always-on with the uptime pinger |
| Firestore (Spark) | 50k reads / day | CareLink uses ~100 reads / patient / day |
| `/send` rate limit | 30 / min / IP | Adjustable in `server.js` |

---

## Local dev

```bash
cd carelink-server
cp ../.env.example .env   # add SMTP2GO_API_KEY / MAIL_USER / etc.
npm install
node server.js
```

For Firebase in dev, point `FIREBASE_SERVICE_ACCOUNT` at the path of a
local service-account JSON:
```bash
export FIREBASE_SERVICE_ACCOUNT="$(cat ./service-account.json)"
```
