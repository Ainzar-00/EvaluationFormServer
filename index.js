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

// ================= CREDENTIALS (env or file) =================
// On Railway: set CREDENTIALS_JSON and TOKEN_JSON as environment variables
// Locally: uses oauth_credentials.json and token.json files

function loadCredentials() {
  if (process.env.CREDENTIALS_JSON) {
    console.log("✅ Loading credentials from CREDENTIALS_JSON env variable");
    return JSON.parse(process.env.CREDENTIALS_JSON);
  }
  const filePath = path.join(__dirname, "oauth_credentials.json");
  if (fs.existsSync(filePath)) {
    console.log("✅ Loading credentials from oauth_credentials.json");
    return JSON.parse(fs.readFileSync(filePath));
  }
  throw new Error("Missing credentials: set CREDENTIALS_JSON env variable or provide oauth_credentials.json");
}

function loadToken() {
  if (process.env.TOKEN_JSON) {
    console.log("✅ Loading token from TOKEN_JSON env variable");
    return JSON.parse(process.env.TOKEN_JSON);
  }
  const filePath = path.join(__dirname, "token.json");
  if (fs.existsSync(filePath)) {
    console.log("✅ Loading token from token.json");
    return JSON.parse(fs.readFileSync(filePath));
  }
  return null;
}

function saveToken(tokens) {
  if (!process.env.CREDENTIALS_JSON) {
    // Local dev — persist to file
    const filePath = path.join(__dirname, "token.json");
    const current = fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath)) : {};
    fs.writeFileSync(filePath, JSON.stringify({ ...current, ...tokens }));
    console.log("🔄 Token saved to token.json");
  } else {
    // Railway — token is kept in memory only
    // If you need to persist after restart, update TOKEN_JSON variable manually
    console.log("🔄 Token refreshed in memory (Railway mode)");
  }
}

const credentials = loadCredentials();
const { client_secret, client_id } = credentials.installed || credentials.web;
const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

const savedToken = loadToken();
if (savedToken) {
  oAuth2Client.setCredentials(savedToken);
  console.log("✅ Token loaded successfully");
}

oAuth2Client.on("tokens", (tokens) => {
  const current = oAuth2Client.credentials || {};
  const merged  = { ...current, ...tokens };
  oAuth2Client.setCredentials(merged);
  saveToken(merged);
});

// ================= MIDDLEWARE =================
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ================= AUTH HELPERS =================
function isAuthorized() {
  return !!(oAuth2Client.credentials && oAuth2Client.credentials.access_token);
}

function getAuthUrl() {
  return oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

// ================= OAUTH CALLBACK =================
app.get("/oauth2callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code parameter.");
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    saveToken(tokens);
    console.log("✅ Token saved — authorization complete!");
    res.send(`
      <html>
        <body style="font-family:sans-serif;text-align:center;padding:50px">
          <h2>✅ Authorization successful!</h2>
          <p>You can close this tab and go back to your app.</p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("🔥 OAuth callback error:", err.message);
    res.status(500).send("Authorization failed: " + err.message);
  }
});

// ================= ROUTES =================
app.get("/", (req, res) => res.send("Server is running ✅"));

app.get("/testAuth", (req, res) => {
  if (isAuthorized()) {
    res.json({ status: "ok", expires: oAuth2Client.credentials.expiry_date });
  } else {
    res.json({ status: "not_authorized", authUrl: getAuthUrl() });
  }
});

// ================= APPS SCRIPT HELPER =================
async function linkFormToSpreadsheet(formId) {
  try {
    console.log(`🔗 Linking formId=${formId} to central spreadsheet...`);
    const res = await fetch(APPS_SCRIPT_URL, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ action: "linkForm", formId })
    });
    const data = await res.json();
    if (data.status === "success") {
      console.log(`🔗 ✅ Form linked: ${data.title}`);
    } else {
      console.error(`🔗 ❌ linkForm failed:`, data.message);
    }
  } catch (err) {
    console.error(`🔗 ❌ linkForm error:`, err.message);
  }
}

// ================= ITEM BUILDERS =================
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
              type: "RADIO",
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
              type: "CHECKBOX",
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
            required: true,
            dateQuestion: { includeTime: false, includeYear: true }
          }
        }
      },
      location: { index: idx }
    }
  };
}

// ================= MAIN POST =================
app.post("/createForm", async (req, res) => {
  try {
    if (!isAuthorized()) {
      const authUrl = getAuthUrl();
      console.log("\n🔐 Not authorized — open this URL:\n", authUrl, "\n");
      return res.status(401).json({ status: "unauthorized", authUrl });
    }

    const { themeNom, competences } = req.body;
    if (!themeNom || typeof themeNom !== "string") {
      return res.status(400).json({ status: "error", message: "themeNom required" });
    }

    const formsApi = google.forms({ version: "v1", auth: oAuth2Client });
    const t0 = Date.now();

    // ── CALL 1: Create form ──────────────────────────────────────
    console.log("CALL 1: Creating form...");
    const createRes = await formsApi.forms.create({
      requestBody: {
        info: { title: `Évaluation Formation - ${themeNom}` }
      }
    });

    const formId  = createRes.data.formId;
    const formUrl = `https://docs.google.com/forms/d/${formId}/viewform`;
    console.log(`CALL 1 ✅ formId: ${formId} (${Date.now() - t0}ms)`);

    // ── Build questions ──────────────────────────────────────────
    let idx = 0;
    const requests = [];

    // Set description
    requests.push({
      updateFormInfo: {
        info: {
          description: "Il nous paraît tout aussi important d'apprécier la mise en pratique des formations qui ont été engagées pour votre collaborateur, avec quelques semaines de recul. C'est pourquoi nous vous remercions de bien vouloir retourner ce questionnaire dans les plus brefs délais à OIS/HID."
        },
        updateMask: "description"
      }
    });

    // Prefilled fields
    requests.push(lockedTextItem("Formation ID",          "🔒 Ne pas modifier",            idx++));
    requests.push(lockedTextItem("Intitulé de l'action",  "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Collaborateur",          "🔒 Pré-rempli automatiquement",idx++));
    requests.push(lockedTextItem("Matricule",              "🔒 Pré-rempli automatiquement",idx++));
    requests.push(lockedTextItem("Service",                "🔒 Pré-rempli automatiquement",idx++));
    requests.push(lockedTextItem("Formateur",              "🔒 Pré-rempli automatiquement",idx++));
    requests.push(lockedTextItem("Date(s)",                "🔒 Pré-rempli automatiquement",idx++));

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

    // ── CALL 2: batchUpdate ──────────────────────────────────────
    console.log("CALL 2: Adding questions...");
    const t1 = Date.now();

    const batchRes = await formsApi.forms.batchUpdate({
      formId,
      requestBody: { requests }
    });

    console.log(`CALL 2 ✅ Questions added (${Date.now() - t1}ms)`);

    // ── Extract entry IDs from batchUpdate response ──────────────
    const titleToKey = {
      "Formation ID"        : "formationId",
      "Intitulé de l'action": "intituleAction",
      "Collaborateur"       : "nomPrenom",
      "Matricule"           : "matricule",
      "Service"             : "service",
      "Formateur"           : "formateur",
      "Date(s)"             : "dates",
    };

    const entryIds = {};
    const replies  = batchRes.data.replies || [];

    replies.forEach(reply => {
      const item = reply.createItem?.item;
      if (!item) return;
      const key = titleToKey[item.title];
      if (!key) return;
      const questionId = item.questionItem?.question?.questionId;
      if (questionId) entryIds[key] = parseInt(questionId, 16);
    });

    // Fallback: fetch form if any entry IDs are missing
    const missingKeys = Object.keys(titleToKey).filter(t => !entryIds[titleToKey[t]]);
    if (missingKeys.length > 0) {
      console.log("Fallback: fetching form for missing entry IDs...");
      const formDetails = await formsApi.forms.get({ formId });
      (formDetails.data.items || []).forEach(item => {
        const key = titleToKey[item.title];
        if (key && !entryIds[key] && item.questionItem?.question?.questionId) {
          entryIds[key] = parseInt(item.questionItem.question.questionId, 16);
        }
      });
    }

    console.log(`✅ Done in ${Date.now() - t0}ms — entryIds:`, entryIds);

    // Link form to spreadsheet in background
    linkFormToSpreadsheet(formId);

    return res.json({
      status         : "success",
      formUrl,
      formId,
      responseSheetId: CENTRAL_SHEET_ID,
      entryIds,
    });

  } catch (err) {
    console.error("🔥 ERROR:", err.message);
    if (err.response) {
      console.error("📦 Google API Error:", JSON.stringify(err.response.data, null, 2));
    }
    return res.status(500).json({
      status : "error",
      message: err.message || "Unknown error",
      details: err.response?.data || null,
    });
  }
});

// ================= START SERVER =================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  if (!isAuthorized()) {
    console.log("\n🔐 Not authorized yet — open this URL in your browser:");
    console.log(getAuthUrl());
    console.log();
  }
});

// ================= EXPORT FOR CLOUD FUNCTIONS =================
const functions = require("@google-cloud/functions-framework");
functions.http("myHttpFunction", app);
