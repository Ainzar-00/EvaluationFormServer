```js
const express = require("express");
const path = require("path");
const fs = require("fs");
const { google } = require("googleapis");

const app = express();

// ================= CONFIG =================
const SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/drive"
];

const CENTRAL_SHEET_ID = "1Wj0LzFPa5esKLCjGW_UfsdYUAtOIJ-YnhKiCA8X9o44";
const APPS_SCRIPT_URL  = "https://script.google.com/macros/s/AKfycbwxFrbzD1aTkAbUaydrZ_05U9RR4qH5xUcjTRFaPAE981ToOJ1r95TWYxfW4IIX_Kfo/exec";
const REDIRECT_URI     = process.env.REDIRECT_URI || "http://localhost:8080/oauth2callback";

// ================= LOADERS =================

function loadCredentials() {
  if (process.env.CREDENTIALS_JSON) {
    console.log("✅ Loading credentials from ENV");
    return JSON.parse(process.env.CREDENTIALS_JSON);
  }

  const filePath = path.join(__dirname, "oauth_credentials.json");
  if (fs.existsSync(filePath)) {
    console.log("✅ Loading credentials from file");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  throw new Error("Missing credentials");
}

function loadToken() {
  try {
    if (process.env.TOKEN_JSON) {
      console.log("✅ Loading token from ENV");
      return JSON.parse(process.env.TOKEN_JSON);
    }

    const filePath = path.join(__dirname, "token.json");
    if (fs.existsSync(filePath)) {
      console.log("✅ Loading token from file");
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    console.error("❌ Token parse error:", err.message);
  }

  return null;
}

function saveToken(tokens) {
  try {
    fs.writeFileSync(
      path.join(__dirname, "token.json"),
      JSON.stringify(tokens, null, 2)
    );
    console.log("🔄 Token saved locally");
  } catch (err) {
    console.error("❌ Save token failed:", err.message);
  }
}

// ================= OAUTH =================

const credentials = loadCredentials();
const { client_secret, client_id } = credentials.installed || credentials.web;

const oAuth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  REDIRECT_URI
);

const savedToken = loadToken();

if (savedToken) {
  oAuth2Client.setCredentials(savedToken);
  console.log("✅ Token loaded");
  console.log("🧾 Info:", {
    hasAccessToken: !!savedToken.access_token,
    hasRefreshToken: !!savedToken.refresh_token,
    expiry: savedToken.expiry_date
  });
}

// auto-save refreshed tokens
oAuth2Client.on("tokens", (tokens) => {
  const merged = { ...oAuth2Client.credentials, ...tokens };
  oAuth2Client.setCredentials(merged);
  saveToken(merged);
  console.log("🔄 Token refreshed");
});

// ================= AUTH =================

function getAuthUrl() {
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

async function ensureValidToken() {
  try {
    const token = await oAuth2Client.getAccessToken();
    if (!token || !token.token) {
      throw new Error("No token");
    }
  } catch (err) {
    console.error("❌ Auth failed:", err.message);
    throw new Error("AUTH_REQUIRED");
  }
}

// ================= MIDDLEWARE =================

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ================= ROUTES =================

app.get("/", (req, res) => res.send("Server running ✅"));

app.get("/testAuth", (req, res) => {
  if (oAuth2Client.credentials?.access_token) {
    res.json({
      status: "ok",
      expiry: oAuth2Client.credentials.expiry_date
    });
  } else {
    res.json({
      status: "not_authorized",
      authUrl: getAuthUrl()
    });
  }
});

app.get("/debugToken", (req, res) => {
  res.json({
    credentials: oAuth2Client.credentials,
    hasAccessToken: !!oAuth2Client.credentials?.access_token,
    hasRefreshToken: !!oAuth2Client.credentials?.refresh_token,
  });
});

// ================= OAUTH CALLBACK =================

app.get("/oauth2callback", async (req, res) => {
  try {
    const { tokens } = await oAuth2Client.getToken(req.query.code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);

    console.log("✅ New token generated");

    res.send("Authorization successful. You can close this tab.");
  } catch (err) {
    console.error("❌ OAuth error:", err.message);
    res.status(500).send("Auth failed");
  }
});

// ================= MAIN =================

app.post("/createForm", async (req, res) => {
  try {
    await ensureValidToken();

    const { themeNom } = req.body;

    const formsApi = google.forms({
      version: "v1",
      auth: oAuth2Client
    });

    console.log("🚀 Creating form...");

    const createRes = await formsApi.forms.create({
      requestBody: {
        info: { title: `Évaluation Formation - ${themeNom}` }
      }
    });

    return res.json({
      status: "success",
      formId: createRes.data.formId
    });

  } catch (err) {

    if (err.message === "AUTH_REQUIRED") {
      return res.status(401).json({
        status: "unauthorized",
        authUrl: getAuthUrl()
      });
    }

    console.error("🔥 ERROR:", err.message);

    return res.status(500).json({
      status: "error",
      message: err.message
    });
  }
});

// ================= START =================

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
  console.log("🔐 Auth URL:", getAuthUrl());
});

// ================= EXPORT =================

const functions = require("@google-cloud/functions-framework");
functions.http("myHttpFunction", app);
```
