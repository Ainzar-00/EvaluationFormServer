const express    = require("express");
const path       = require("path");
const fs         = require("fs");
const { google } = require("googleapis");

const app = express();

// ================= CONFIG =================
const SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/drive",
];

const CENTRAL_SHEET_ID = "13C-zqx2hkSTu2P63eNsYjOONUOHZUqym58ZMMmJmYqw";

// Apps Script web app — must be deployed with "Who has access: Anyone, even anonymous"
// because service accounts cannot authenticate against Apps Script web apps.
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxg27IYiHhP9MXxbvFgzjwM72PIZb7yPbafA9gHTnmCwPCHdlR1gHPQaBs4nbUxazM7/exec";

// ================= SERVICE ACCOUNT AUTH =================
// Set SERVICE_ACCOUNT_JSON on Railway (Dashboard → your service → Variables)
// to the full contents of your service account key JSON file.
// Locally, place the file at service_account.json.

function loadServiceAccount() {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    console.log("✅ Loading service account from SERVICE_ACCOUNT_JSON env var");
    return JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
  }
  const filePath = path.join(__dirname, "service_account.json");
  if (fs.existsSync(filePath)) {
    console.log("✅ Loading service account from service_account.json");
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  throw new Error(
    "❌ Missing service account: set SERVICE_ACCOUNT_JSON env var or provide service_account.json"
  );
}

const serviceAccountKey = loadServiceAccount();

// GoogleAuth handles token generation and auto-refresh transparently.
// No callback URL, no token storage, no manual refresh — it just works.
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccountKey,
  scopes     : SCOPES,
});

console.log(`✅ Service account ready: ${serviceAccountKey.client_email}`);

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

// Health-check: verifies the service account can obtain an access token.
app.get("/testAuth", async (req, res) => {
  try {
    const client      = await auth.getClient();
    const tokenResult = await client.getAccessToken();
    res.json({
      status      : "ok",
      client_email: serviceAccountKey.client_email,
      hasToken    : !!tokenResult?.token,
    });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

// ================= APPS SCRIPT HELPER =================
// No Authorization header — the web app must be deployed as "Anyone, even anonymous".
// Service accounts cannot authenticate against Apps Script web apps.
async function linkFormToSpreadsheet(formId) {
  try {
    console.log(`🔗 Linking formId=${formId} to central spreadsheet...`);

    const res = await fetch(APPS_SCRIPT_URL, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ action: "linkForm", formId }),
    });

    const text = await res.text();

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`🔗 ❌ Apps Script returned non-JSON (HTTP ${res.status})`);
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
      message: "themeNom is required and must be a non-empty string",
    });
  }

  try {
    const formsApi = google.forms({ version: "v1", auth });
    const t0       = Date.now();
    const title    = `Évaluation Formation - ${themeNom.trim()}`;

    // ── Step 1: Create blank form ──────────────────────────────────────────
    console.log("🚀 [1/3] Creating form:", title);
    const createRes = await formsApi.forms.create({
      requestBody: { info: { title } },
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
          description:
            "Il nous paraît tout aussi important d'apprécier la mise en pratique des formations qui ont été engagées pour votre collaborateur, avec quelques semaines de recul. C'est pourquoi nous vous remercions de bien vouloir retourner ce questionnaire dans les plus brefs délais à OIS/HID.",
        },
        updateMask: "description",
      },
    });

    requests.push(lockedTextItem("Formation ID",          "🔒 Ne pas modifier",            idx++));
    requests.push(lockedTextItem("Intitulé de l'action",  "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Collaborateur",         "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Matricule",             "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Service",               "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Formateur",             "🔒 Pré-rempli automatiquement", idx++));
    requests.push(lockedTextItem("Date(s)",               "🔒 Pré-rempli automatiquement", idx++));

    requests.push(checkboxItem(
      "Par quel moyen vous avez apprécié votre collaborateur ?",
      ["Entretien", "Mise en situation professionnelle/Observation", "Autres à préciser"],
      false, idx++
    ));
    requests.push(textItem("Autres à préciser", "", false, idx++));
    requests.push(radioItem("La formation choisie semblait satisfaire votre besoin", idx++));
    requests.push(radioItem("La formation a eu un impact sur la performance individuelle de votre collaborateur", idx++));
    requests.push(radioItem("Votre collaborateur peut mettre en pratique les connaissances acquises lors de sa formation", idx++));
    requests.push(checkboxItem("Si non pourquoi ?", [
      "L'organisation du travail n'a pas permis de lui confier des tâches correspondant aux compétences acquises",
      "Le niveau de compétences acquis est insuffisant",
      "La formation n'a pas porté sur les compétences nécessaires à l'atelier",
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
      requestBody: { requests },
    });
    console.log(`✅ Questions added (${Date.now() - t1}ms)`);

    // ── Step 3: Extract entry IDs by position ─────────────────────────────
    // batchUpdate replies mirror requests 1-to-1.
    // Reply shape: { createItem: { itemId, questionId: ["hexId"] } }
    // Title is NOT echoed — match by request index.
    console.log("🔍 [3/3] Reading back questionIds...");
    const entryIds = {};
    const replies  = batchRes.data.replies || [];

    const requestKeyByIndex = {};
    requests.forEach((req, i) => {
      if (req.createItem) {
        const key = TITLE_TO_KEY[req.createItem.item?.title];
        if (key) requestKeyByIndex[i] = key;
      }
    });

    replies.forEach((reply, i) => {
      const key         = requestKeyByIndex[i];
      if (!key) return;
      const questionIds = reply.createItem?.questionId;
      if (Array.isArray(questionIds) && questionIds.length > 0) {
        entryIds[key] = parseInt(questionIds[0], 16);
      }
    });

    // Fallback GET for any IDs still missing
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

    // Fire-and-forget — does not block the response
    linkFormToSpreadsheet(formId);

    return res.json({
      status         : "success",
      formUrl,
      formId,
      responseSheetId: CENTRAL_SHEET_ID,
      entryIds,
    });

  } catch (err) {
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
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
