const express = require("express");
const path    = require("path");
const fs      = require("fs");
const { google } = require("googleapis");

const app = express();

// ================= CONFIG =================
const SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/drive"
];

const CENTRAL_SHEET_ID = "13C-zqx2hkSTu2P63eNsYjOONUOHZUqym58ZMMmJmYqw";
const APPS_SCRIPT_URL  = "https://script.google.com/macros/s/AKfycbxg27IYiHhP9MXxbvFgzjwM72PIZb7yPbafA9gHTnmCwPCHdlR1gHPQaBs4nbUxazM7/exec";

// MERGED FIX: Use env var in production; fall back to localhost WITH /oauth2callback path.
//             Doc2 was missing the /oauth2callback path — that breaks the OAuth flow.
const REDIRECT_URI = process.env.REDIRECT_URI || "http://localhost:8080/oauth2callback";
if (!process.env.REDIRECT_URI) {
  console.warn("⚠️  REDIRECT_URI not set — using localhost fallback (local dev only)");
}

// ================= CREDENTIALS =================

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

// MERGED FIX (from Doc2): Validate token contents and wrap in try/catch.
function loadToken() {
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

// MERGED FIX (from Doc2): Use K_SERVICE to detect Cloud Functions (the correct standard env var).
//             Doc1 was checking CREDENTIALS_JSON which is unrelated to the runtime environment.
function saveToken(tokens) {
  if (process.env.K_SERVICE) {
    console.log("☁️  Running on Cloud — token cannot be saved to disk.");
    console.log("📋 Copy this token into your TOKEN_JSON env var:\n", JSON.stringify(tokens));
    return;
  }
  try {
    const filePath = path.join(__dirname, "token.json");
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2));
    console.log("💾 Token saved locally");
  } catch (err) {
    console.error("❌ Save token failed:", err.message);
  }
}

// ================= OAUTH CLIENT =================

const credentials = loadCredentials();
const { client_secret, client_id } = credentials.installed || credentials.web;

const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const savedToken = loadToken();
if (savedToken) {
  oAuth2Client.setCredentials(savedToken);
  console.log("✅ Token loaded", {
    hasAccessToken : !!savedToken.access_token,
    hasRefreshToken: !!savedToken.refresh_token,
    expiry         : savedToken.expiry_date
      ? new Date(savedToken.expiry_date).toISOString()
      : "unknown"
  });
}

// MERGED FIX (from Doc2): Merge into oAuth2Client.credentials to preserve refresh_token,
//             which Google only sends on the very first authorization.
oAuth2Client.on("tokens", (tokens) => {
  const merged = { ...oAuth2Client.credentials, ...tokens };
  oAuth2Client.setCredentials(merged);
  saveToken(merged);
  console.log("🔄 Token refreshed and saved");
});

// ================= AUTH HELPERS =================

function getAuthUrl() {
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope      : SCOPES,
    prompt     : "consent", // forces refresh_token on every auth
  });
}

// MERGED FIX (from Doc2): Replace simple isAuthorized() with a proper async check that
//             actually attempts a token refresh before declaring the session invalid.
async function ensureValidToken() {
  const creds = oAuth2Client.credentials;
  if (!creds || (!creds.access_token && !creds.refresh_token)) {
    throw new Error("AUTH_REQUIRED");
  }
  try {
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

app.get("/", (req, res) => res.send("Server is running ✅"));

app.get("/testAuth", async (req, res) => {
  const creds = oAuth2Client.credentials;
  if (creds?.access_token || creds?.refresh_token) {
    res.json({
      status         : "ok",
      hasAccessToken : !!creds.access_token,
      hasRefreshToken: !!creds.refresh_token,
      expiry         : creds.expiry_date
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

// MERGED (from Doc2): Useful for quick token inspection during debugging.
app.get("/debugToken", (req, res) => {
  const creds = oAuth2Client.credentials;
  res.json({
    hasAccessToken : !!creds?.access_token,
    hasRefreshToken: !!creds?.refresh_token,
    expiry         : creds?.expiry_date
      ? new Date(creds.expiry_date).toISOString()
      : "unknown"
  });
});

// ================= OAUTH CALLBACK =================

app.get("/oauth2callback", async (req, res) => {
  const { code, error } = req.query;

  // MERGED FIX (from Doc2): Handle the case where the user denied access.
  if (error) {
    console.error("❌ OAuth denied by user:", error);
    return res.status(400).send(`Authorization denied: ${error}`);
  }

  if (!code) return res.status(400).send("Missing authorization code.");

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);
    console.log("✅ New token generated", {
      hasAccessToken : !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token
    });
    // MERGED (from Doc1): Nicer HTML confirmation page.
    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:50px">
          <h2>✅ Authorization successful!</h2>
          <p>You can close this tab and go back to your app.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("❌ OAuth callback error:", err.message);
    res.status(500).send("Authorization failed: " + err.message);
  }
});

// ================= APPS SCRIPT HELPER =================

// Links the newly created form to the central spreadsheet via Apps Script.
// FIX: Apps Script can return an HTML error page when the deployment is broken or
//      the script throws. Always read as text first, then attempt JSON.parse() safely.
async function linkFormToSpreadsheet(formId) {
  try {
    console.log(`🔗 Linking formId=${formId} to central spreadsheet...`);
    const res  = await fetch(APPS_SCRIPT_URL, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ action: "linkForm", formId })
    });

    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // Apps Script returned HTML (error page, login wall, stale deployment, etc.)
      console.error(`🔗 ❌ linkForm: Apps Script returned non-JSON (HTTP ${res.status})`);
      console.error(`🔗    First 300 chars: ${text.slice(0, 300)}`);
      return;
    }

    if (data.status === "success") {
      console.log(`🔗 ✅ Form linked: ${data.title}`);
    } else {
      console.error(`🔗 ❌ linkForm failed:`, data.message);
    }
  } catch (err) {
    console.error(`🔗 ❌ linkForm network error:`, err.message);
  }
}

// ================= ITEM BUILDERS =================
// MERGED (from Doc1): Full set of question-type builders for the complete evaluation form.

function lockedTextItem(title, helpText, idx) {
  return {
    createItem: {
      item: {
        title,
        description: helpText || "",
        questionItem: {
          question: { required: false, textQuestion: { paragraph: false } }
        }
      },
      location: { index: idx }
    }
  };
}

function textItem(title, helpText, required, idx) {
  return {
    createItem: {
      item: {
        title,
        description: helpText || "",
        questionItem: {
          question: { required: !!required, textQuestion: { paragraph: false } }
        }
      },
      location: { index: idx }
    }
  };
}

function radioItem(title, idx) {
  return {
    createItem: {
      item: {
        title,
        questionItem: {
          question: {
            required: true,
            choiceQuestion: {
              type   : "RADIO",
              options: [
                { value: "Très satisfaisant" },
                { value: "Satisfaisant" },
                { value: "Peu satisfaisant" },
                { value: "Insatisfaisant" }
              ],
              shuffle: false
            }
          }
        }
      },
      location: { index: idx }
    }
  };
}

function checkboxItem(title, choices, required, idx) {
  return {
    createItem: {
      item: {
        title,
        questionItem: {
          question: {
            required: !!required,
            choiceQuestion: {
              type   : "CHECKBOX",
              options: choices.map(v => ({ value: String(v) })),
              shuffle: false
            }
          }
        }
      },
      location: { index: idx }
    }
  };
}

function paragraphItem(title, helpText, idx) {
  return {
    createItem: {
      item: {
        title,
        description: helpText || "",
        questionItem: {
          question: { required: false, textQuestion: { paragraph: true } }
        }
      },
      location: { index: idx }
    }
  };
}

function dateItem(title, idx) {
  return {
    createItem: {
      item: {
        title,
        questionItem: {
          question: {
            required    : true,
            dateQuestion: { includeTime: false, includeYear: true }
          }
        }
      },
      location: { index: idx }
    }
  };
}

// ================= ENTRY ID MAP =================
// Maps form question titles to the response object keys returned to the client.
const TITLE_TO_KEY = {
  "Formation ID"         : "formationId",
  "Intitulé de l'action" : "intituleAction",
  "Collaborateur"        : "nomPrenom",
  "Matricule"            : "matricule",
  "Service"              : "service",
  "Formateur"            : "formateur",
  "Date(s)"              : "dates",
};

// ================= MAIN POST =================

app.post("/createForm", async (req, res) => {
  const { themeNom, competences } = req.body;

  if (!themeNom || typeof themeNom !== "string" || !themeNom.trim()) {
    return res.status(400).json({
      status : "error",
      message: "themeNom is required and must be a non-empty string"
    });
  }

  try {
    // MERGED FIX: Use the robust token-refresh check from Doc2 instead of the
    //             simple isAuthorized() boolean from Doc1.
    await ensureValidToken();

    const formsApi = google.forms({ version: "v1", auth: oAuth2Client });
    const t0    = Date.now();
    const title = `Évaluation Formation - ${themeNom.trim()}`;

    // ── Step 1: Create blank form ──────────────────────────────────────────
    console.log("🚀 [1/3] Creating form:", title);
    const createRes = await formsApi.forms.create({
      requestBody: { info: { title } }
    });
    const formId  = createRes.data.formId;
    const formUrl = `https://docs.google.com/forms/d/${formId}/viewform`;
    console.log(`✅ Form created: ${formId} (${Date.now() - t0}ms)`);

    // ── Step 2: Build and send all questions ───────────────────────────────
    let idx = 0;
    const requests = [];

    requests.push({
      updateFormInfo: {
        info: {
          description: "Il nous paraît tout aussi important d'apprécier la mise en pratique des formations qui ont été engagées pour votre collaborateur, avec quelques semaines de recul. C'est pourquoi nous vous remercions de bien vouloir retourner ce questionnaire dans les plus brefs délais à OIS/HID."
        },
        updateMask: "description"
      }
    });

    // Prefilled / locked fields
    requests.push(lockedTextItem("Formation ID",          "🔒 Ne pas modifier",            idx++));
    requests.push(lockedTextItem("Intitulé de l'action",  "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Collaborateur",         "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Matricule",             "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Service",               "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Formateur",             "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Date(s)",               "🔒 Pré-rempli automatiquement", idx++));

    // Evaluation questions
    requests.push(checkboxItem("Par quel moyen vous avez apprécié votre collaborateur ?", [
      "Entretien",
      "Mise en situation professionnelle/Observation",
      "Autres à préciser"
    ], false, idx++));
    requests.push(textItem("Autres à préciser", "", false, idx++));
    requests.push(radioItem("La formation choisie semblait satisfaire votre besoin", idx++));
    requests.push(radioItem("La formation a eu un impact sur la performance individuelle de votre collaborateur", idx++));
    requests.push(radioItem("Votre collaborateur peut mettre en pratique les connaissances acquises lors de sa formation", idx++));
    requests.push(checkboxItem("Si non pourquoi ?", [
      "L'organisation du travail n'a pas permis de lui confier des tâches correspondant aux compétences acquises",
      "Le niveau de compétences acquis est insuffisant",
      "La formation n'a pas porté sur les compétences nécessaires à l'atelier"
    ], false, idx++));
    requests.push(radioItem("Globalement quel est votre degré de satisfaction", idx++));

    if (Array.isArray(competences) && competences.length > 0) {
      requests.push(checkboxItem(
        "Les nouvelles compétences que votre collaborateur a pu acquérir suite à la formation suivie",
        competences, false, idx++
      ));
    }

    requests.push(paragraphItem("Avez-vous des propositions et des suggestions d'amélioration ?", "Vos suggestions...", idx++));
    requests.push(dateItem("Date de l'évaluation", idx++));

    console.log("📝 [2/3] Adding questions...");
    const t1       = Date.now();
    const batchRes = await formsApi.forms.batchUpdate({
      formId,
      requestBody: { requests }
    });
    console.log(`✅ Questions added (${Date.now() - t1}ms)`);

    // ── Step 3: Extract entry IDs ──────────────────────────────────────────
    // FIX: The batchUpdate reply structure for createItem is:
    //        { createItem: { itemId: "...", questionId: ["..."] } }
    //      The reply does NOT echo back the item title — it only has IDs.
    //      We must match each reply back to its request BY POSITION.
    //      Non-createItem requests (e.g. updateFormInfo) return an empty {} reply,
    //      so we build an index map first, then walk replies in order.
    console.log("🔍 [3/3] Reading back questionIds...");
    const entryIds = {};
    const replies  = batchRes.data.replies || [];

    // Map: request array index → key (only for the 7 prefilled/locked fields)
    const requestKeyByIndex = {};
    requests.forEach((req, i) => {
      if (req.createItem) {
        const title = req.createItem.item?.title;
        const key   = TITLE_TO_KEY[title];
        if (key) requestKeyByIndex[i] = key;
      }
    });

    // replies[i] corresponds 1-to-1 with requests[i]
    replies.forEach((reply, i) => {
      const key        = requestKeyByIndex[i];
      if (!key) return;
      const questionIds = reply.createItem?.questionId;   // array of hex strings
      if (Array.isArray(questionIds) && questionIds.length > 0) {
        entryIds[key] = parseInt(questionIds[0], 16);
      }
    });

    // Fallback: if any IDs are still missing, do a GET on the form.
    // This covers edge cases where the API omits questionIds in the reply.
    const missingTitles = Object.keys(TITLE_TO_KEY).filter(t => !entryIds[TITLE_TO_KEY[t]]);
    if (missingTitles.length > 0) {
      console.warn("⚠️  Falling back to GET for missing IDs:", missingTitles);
      const formDetails = await formsApi.forms.get({ formId });
      (formDetails.data.items || []).forEach(item => {
        const key = TITLE_TO_KEY[item.title];
        if (key && !entryIds[key] && item.questionItem?.question?.questionId) {
          entryIds[key] = parseInt(item.questionItem.question.questionId, 16);
        }
      });
    }

    console.log(`✅ Done in ${Date.now() - t0}ms — entryIds:`, entryIds);

    // Link form to central spreadsheet in the background (non-blocking)
    linkFormToSpreadsheet(formId);

    return res.json({
      status         : "success",
      formUrl,
      formId,
      responseSheetId: CENTRAL_SHEET_ID,
      entryIds,
    });

  } catch (err) {
    if (err.message === "AUTH_REQUIRED") {
      try {
        return res.status(401).json({ status: "unauthorized", authUrl: getAuthUrl() });
      } catch (urlErr) {
        return res.status(401).json({
          status : "unauthorized",
          message: "Auth required but REDIRECT_URI is not configured"
        });
      }
    }

    console.error("🔥 createForm error:", err.message);
    if (err.response) {
      console.error("📦 Google API error:", JSON.stringify(err.response.data, null, 2));
    }
    return res.status(500).json({
      status : "error",
      message: err.message || "Unknown error",
      details: err.response?.data || null,
    });
  }
});

// ================= START =================

// MERGED FIX (from Doc2): Don't call app.listen() on Cloud Functions — the framework
//             manages the HTTP server. Calling it there causes port conflicts or crashes.
const isCloudFunction = !!process.env.K_SERVICE || !!process.env.FUNCTION_TARGET;

if (!isCloudFunction) {
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    try {
      if (!oAuth2Client.credentials?.access_token && !oAuth2Client.credentials?.refresh_token) {
        console.log("🔐 Not authorized yet — open this URL in your browser:");
        console.log(getAuthUrl());
      }
    } catch (err) {
      console.warn("⚠️  Could not generate auth URL:", err.message);
    }
  });
}

// ================= EXPORT =================

const functions = require("@google-cloud/functions-framework");
functions.http("myHttpFunction", app);
