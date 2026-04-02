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

const CENTRAL_SHEET_ID = "13C-zqx2hkSTu2P63eNsYjOONUOHZUqym58ZMMmJmYqw";
const APPS_SCRIPT_URL  = "https://script.google.com/macros/s/AKfycbxg27IYiHhP9MXxbvFgzjwM72PIZb7yPbafA9gHTnmCwPCHdlR1gHPQaBs4nbUxazM7/exec";

// FIX 1: REDIRECT_URI must be set via env var in production (Cloud Functions URL).
//         Never fall back to localhost in production — OAuth will silently fail.
const REDIRECT_URI = "http://localhost:8080";
if (!REDIRECT_URI) {
  console.warn("⚠️  WARNING: REDIRECT_URI env var is not set. OAuth callbacks will fail.");
}

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

  throw new Error("❌ Missing credentials: set CREDENTIALS_JSON env var or provide oauth_credentials.json");
}

function loadToken() {
  // FIX 2: Prioritize ENV token in production (Cloud Functions has no persistent disk).
  //         File-based token only works locally.
  try {
    if (process.env.TOKEN_JSON) {
      console.log("✅ Loading token from ENV");
      const token = JSON.parse(process.env.TOKEN_JSON);
      if (!token.access_token && !token.refresh_token) {
        console.warn("⚠️  TOKEN_JSON exists but contains no usable tokens");
        return null;
      }
      return token;
    }

    const filePath = path.join(__dirname, "token.json");
    if (fs.existsSync(filePath)) {
      console.log("✅ Loading token from file");
      const token = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (!token.access_token && !token.refresh_token) {
        console.warn("⚠️  token.json exists but contains no usable tokens");
        return null;
      }
      return token;
    }
  } catch (err) {
    console.error("❌ Token parse error:", err.message);
  }

  return null;
}

function saveToken(tokens) {
  // FIX 3: On Cloud Functions, the filesystem is ephemeral — log the token so you
  //         can copy it into the TOKEN_JSON env var manually after first auth.
  if (process.env.K_SERVICE) {
    // Running on Cloud Functions/Cloud Run — filesystem writes won't persist
    console.log("☁️  Running on Cloud — token cannot be saved to disk.");
    console.log("📋 Copy this token into your TOKEN_JSON env var:\n", JSON.stringify(tokens));
    return;
  }

  try {
    fs.writeFileSync(
      path.join(__dirname, "token.json"),
      JSON.stringify(tokens, null, 2)
    );
    console.log("💾 Token saved locally");
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
  console.log("✅ Token loaded", {
    hasAccessToken: !!savedToken.access_token,
    hasRefreshToken: !!savedToken.refresh_token,
    expiry: savedToken.expiry_date
      ? new Date(savedToken.expiry_date).toISOString()
      : "unknown"
  });
}

// FIX 4: Don't manually merge credentials — the library already updates
//         oAuth2Client.credentials internally before emitting the 'tokens' event.
//         Just save whatever the client now holds.
oAuth2Client.on("tokens", (tokens) => {
  // Merge new tokens with existing ones (important to preserve refresh_token
  // since Google only sends it on first authorization)
  const merged = { ...oAuth2Client.credentials, ...tokens };
  oAuth2Client.setCredentials(merged);
  saveToken(merged);
  console.log("🔄 Token refreshed and saved");
});

// ================= AUTH =================

function getAuthUrl() {
  if (!REDIRECT_URI) {
    throw new Error("Cannot generate auth URL: REDIRECT_URI env var is not set");
  }
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent", // forces refresh_token to be returned every time
  });
}

// FIX 5: Properly detect missing vs. expired tokens and trigger refresh correctly.
async function ensureValidToken() {
  const creds = oAuth2Client.credentials;

  // No credentials at all — user must go through OAuth flow
  if (!creds || (!creds.access_token && !creds.refresh_token)) {
    throw new Error("AUTH_REQUIRED");
  }

  try {
    // getAccessToken() auto-refreshes using refresh_token if access_token is expired
    const tokenResponse = await oAuth2Client.getAccessToken();
    if (!tokenResponse || !tokenResponse.token) {
      throw new Error("Empty token response");
    }
  } catch (err) {
    console.error("❌ Token validation/refresh failed:", err.message);
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


app.get("/", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Server running");

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);

    res.send("✅ Authorized, you can close this tab");
  } catch (err) {
    res.send("❌ Error: " + err.message);
  }
});


app.get("/testAuth", (req, res) => {
  const creds = oAuth2Client.credentials;
  if (creds?.access_token || creds?.refresh_token) {
    res.json({
      status: "ok",
      hasAccessToken: !!creds.access_token,
      hasRefreshToken: !!creds.refresh_token,
      expiry: creds.expiry_date
        ? new Date(creds.expiry_date).toISOString()
        : "unknown"
    });
  } else {
    try {
      res.json({ status: "not_authorized", authUrl: getAuthUrl() });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  }
});

app.get("/debugToken", (req, res) => {
  const creds = oAuth2Client.credentials;
  res.json({
    hasAccessToken: !!creds?.access_token,
    hasRefreshToken: !!creds?.refresh_token,
    expiry: creds?.expiry_date
      ? new Date(creds.expiry_date).toISOString()
      : "unknown"
  });
});

// ================= OAUTH CALLBACK =================

app.get("/oauth2callback", async (req, res) => {
  const { code, error } = req.query;

  // FIX 6: Handle OAuth errors returned by Google (e.g. user denied access)
  if (error) {
    console.error("❌ OAuth denied by user:", error);
    return res.status(400).send(`Authorization denied: ${error}`);
  }

  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);

    console.log("✅ New token generated", {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token
    });

    res.send("Authorization successful. You can close this tab.");
  } catch (err) {
    console.error("❌ OAuth callback error:", err.message);
    res.status(500).send("Authorization failed: " + err.message);
  }
});

// ================= HELPERS =================

/**
 * The 7 visible questions to add to every evaluation form.
 * Order matters — it determines the index used when reading back questionIds.
 */
const FORM_QUESTIONS = [
  { key: "formationId",    title: "ID Formation",       type: "SHORT_ANSWER" },
  { key: "intituleAction", title: "Intitulé de l'action de formation", type: "SHORT_ANSWER" },
  { key: "nomPrenom",      title: "Nom et Prénom",       type: "SHORT_ANSWER" },
  { key: "matricule",      title: "Matricule",           type: "SHORT_ANSWER" },
  { key: "service",        title: "Service",             type: "SHORT_ANSWER" },
  { key: "formateur",      title: "Formateur",           type: "SHORT_ANSWER" },
  { key: "dates",          title: "Dates de formation",  type: "SHORT_ANSWER" },
];

/**
 * Build a batchUpdate request body that appends all 7 questions to the form.
 */
function buildAddQuestionsRequest() {
  return {
    requests: FORM_QUESTIONS.map((q, index) => ({
      createItem: {
        item: {
          title: q.title,
          questionItem: {
            question: {
              required: false,
              textQuestion: {
                paragraph: false  // SHORT_ANSWER = single line
              }
            }
          }
        },
        location: { index }
      }
    }))
  };
}

/**
 * After batchUpdate, fetch the form and extract questionIds in order.
 * Returns an object like: { formationId: "entry.123456", ... }
 */
function extractEntryIds(formData) {
  const entryIds = {};

  // formData.items is ordered — matches the insertion order above
  (formData.items || []).forEach((item, i) => {
    const key = FORM_QUESTIONS[i]?.key;
    const questionId = item?.questionItem?.question?.questionId;
    if (key && questionId) {
      // Google prefill URL format uses "entry." prefix
      entryIds[key] = "entry." + questionId;
    }
  });

  return entryIds;
}

/**
 * Build a prefilled Google Form URL with empty placeholders for each field.
 * Android app will substitute real values before opening the URL.
 */
function buildFormUrl(formId, entryIds) {
  const base = `https://docs.google.com/forms/d/${formId}/viewform`;
  const params = Object.values(entryIds)
    .map(entryId => `${encodeURIComponent(entryId)}=`)
    .join("&");
  return `${base}?${params}`;
}

// ================= MAIN =================

app.post("/createForm", async (req, res) => {
  const { themeNom } = req.body;
  if (!themeNom || typeof themeNom !== "string" || !themeNom.trim()) {
    return res.status(400).json({
      status: "error",
      message: "themeNom is required and must be a non-empty string"
    });
  }

  try {
    await ensureValidToken();

    const formsApi = google.forms({ version: "v1", auth: oAuth2Client });
    const title = "Evaluation Formation - " + themeNom.trim();

    // ── Step 1: Create the blank form ──────────────────────────────────────
    console.log("🚀 [1/3] Creating form:", title);
    const createRes = await formsApi.forms.create({
      requestBody: { info: { title } }
    });
    const formId = createRes.data.formId;
    console.log("✅ Form created:", formId);

    // ── Step 2: Add the 7 visible questions ────────────────────────────────
    console.log("📝 [2/3] Adding questions...");
    await formsApi.forms.batchUpdate({
      formId,
      requestBody: buildAddQuestionsRequest()
    });
    console.log("✅ Questions added");

    // ── Step 3: Fetch the form to read back questionIds → entryIds ─────────
    console.log("🔍 [3/3] Reading back questionIds...");
    const formData = await formsApi.forms.get({ formId });
    const entryIds = extractEntryIds(formData.data);
    console.log("✅ Entry IDs:", entryIds);

    // Warn if any field is missing (mis-indexed)
    const missingKeys = FORM_QUESTIONS.map(q => q.key).filter(k => !entryIds[k]);
    if (missingKeys.length > 0) {
      console.warn("⚠️  Missing entryIds for:", missingKeys);
    }

    const formUrl = buildFormUrl(formId, entryIds);
    console.log("🔗 Form URL:", formUrl);

    return res.json({
      status:    "success",
      formId,
      formUrl,
      entryIds,
      // responseSheetId intentionally omitted — handled by your Apps Script
    });

  } catch (err) {
    if (err.message === "AUTH_REQUIRED") {
      try {
        return res.status(401).json({ status: "unauthorized", authUrl: getAuthUrl() });
      } catch (urlErr) {
        return res.status(401).json({
          status: "unauthorized",
          message: "Auth required but REDIRECT_URI is not configured"
        });
      }
    }

    console.error("🔥 createForm error:", err.message, err.stack);
    return res.status(500).json({ status: "error", message: err.message });
  }
});

// ================= START =================

// FIX 8: Only call app.listen() when running locally.
//         On Cloud Functions, the framework manages the HTTP server — calling
//         app.listen() will crash the function or cause port conflicts.
const isCloudFunction = !!process.env.K_SERVICE || !!process.env.FUNCTION_TARGET;

if (!isCloudFunction) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    try {
      console.log("🔐 Auth URL:", getAuthUrl());
    } catch {
      console.warn("⚠️  Could not generate auth URL (REDIRECT_URI not set)");
    }
  });
}

// ================= EXPORT =================

const functions = require("@google-cloud/functions-framework");
functions.http("myHttpFunction", app);
