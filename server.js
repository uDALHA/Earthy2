import express from "express";
import bodyParser from "body-parser";
import OpenAI from "openai";
import { google } from "googleapis";

const app = express();
app.use(bodyParser.json({ limit: "200kb" }));

const { OPENAI_API_KEY, SHEET_ID } = process.env;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY environment variable.");
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error("Missing GOOGLE_APPLICATION_CREDENTIALS environment variable.");
}
if (!SHEET_ID) {
  console.error("Missing SHEET_ID environment variable.");
}

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const SYSTEM_PROMPT =
  'Earthy AI, embedded on a digital marketing website, created by Dalha. You are a warm, patient, and helpful conversational assistant. ' +
  'Rules: always continue conversations (never reset), never repeat greetings, never repeat questions already answered, ask only ONE question at a time, and prioritize lead-generation assistance. ' +
  'Gently steer the conversation back when the user goes off-topic with a brief acknowledgment and redirection. Never sound aggressive, never repeat yourself, and never restart the conversation. ' +
  'Always work toward collecting at least one contact method (email, phone number, WhatsApp, or similar), but ask only one question at a time. If the user avoids sharing contact info, naturally explain the benefit and ask again later in a different phrasing without repeating previous wording. ' +
  'When asking for missing lead info, ask a single clear question at a time. Avoid templates or repeating prior greetings.';

function isValidHistoryArray(h) {
  if (!Array.isArray(h)) return false;
  return h.every(
    (m) =>
      m &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string"
  );
}

function isValidEmail(email) {
  if (typeof email !== "string") return false;
  const trimmed = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}

function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  let s = text.trim();
  const codeFenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeFenceMatch) {
    s = codeFenceMatch[1].trim();
  } else {
    const firstBrace = s.indexOf("{");
    const lastBrace = s.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      s = s.substring(firstBrace, lastBrace + 1);
    }
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

async function generateAssistantReply(messages) {
  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 800,
  });
  if (
    !resp ||
    !resp.choices ||
    !resp.choices.length ||
    !resp.choices[0].message
  ) {
    throw new Error("OpenAI response malformed");
  }
  return resp.choices[0].message.content;
}

async function extractLeadFields({ conversationMessages, assistantReply }) {
  const extractorSystem = {
    role: "system",
    content:
      "You are a JSON extractor. Given the conversation and the assistant reply, extract lead data only when it is explicitly provided by the user. Return ONLY a single JSON object and nothing else.",
  };

  const extractorUser = {
    role: "user",
    content:
      "Extract three fields from the following assistant reply and conversation: name, businessType, email. " +
      "Rules: Return EXACTLY this JSON shape with keys name, businessType, email. Each value must be either a string (the exact value provided by the user) or null. " +
      "If any field is missing or you are not >=90% confident it was explicitly provided by the user, set that field to null. Do NOT guess. Do NOT synthesize values. " +
      "Return only the JSON object and nothing else.\n\n" +
      "Conversation:\n" +
      conversationMessages
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n") +
      "\n\nAssistant reply:\n" +
      assistantReply +
      "\n\nReturn the JSON now.",
  };

  const resp = await openai.chat.completions.create({
    model: MODEL,
    messages: [extractorSystem, extractorUser],
    temperature: 0.0,
    max_tokens: 200,
  });

  const raw = resp.choices?.[0]?.message?.content ?? "";
  const parsed = extractJson(raw);
  if (!parsed) {
    return { name: null, businessType: null, email: null, raw };
  }
  const name =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : null;
  const businessType =
    typeof parsed.businessType === "string" && parsed.businessType.trim().length > 0
      ? parsed.businessType.trim()
      : null;
  const email =
    typeof parsed.email === "string" && parsed.email.trim().length > 0
      ? parsed.email.trim()
      : null;

  return { name, businessType, email, raw };
}

async function appendToSheet({ name, businessType, email }) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error("GOOGLE_APPLICATION_CREDENTIALS not set");
  }
  if (!SHEET_ID) {
    throw new Error("SHEET_ID not set");
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: "v4", auth: authClient });

  const timestamp = new Date().toISOString();
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "A:D",
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[name, businessType, email, timestamp]],
    },
  });

  return res.status === 200 || res.status === 201;
}

app.post("/chat", async (req, res) => {
  try {
    const { input, history } = req.body ?? {};

    if (typeof input !== "string" || input.trim().length === 0) {
      return res.status(400).json({ error: "Invalid or missing 'input' string." });
    }

    let hist = [];
    if (history === undefined || history === null) {
      hist = [];
    } else if (!isValidHistoryArray(history)) {
      return res.status(400).json({
        error:
          "Invalid 'history' format. Must be an array of { role: 'user'|'assistant', content: string }",
      });
    } else {
      hist = history.map((h) => ({ role: h.role, content: h.content }));
    }

    const messages = [{ role: "system", content: SYSTEM_PROMPT }, ...hist];
    messages.push({ role: "user", content: input });

    let assistantReply;
    try {
      assistantReply = await generateAssistantReply(messages);
    } catch (err) {
      console.error("OpenAI reply error:", err);
      return res.status(500).json({ error: "Failed to generate assistant reply." });
    }

    const updatedHistory = [...hist, { role: "user", content: input }, { role: "assistant", content: assistantReply }];

    let extracted;
    try {
      extracted = await extractLeadFields({
        conversationMessages: updatedHistory,
        assistantReply,
      });
    } catch (err) {
      console.error("Lead extraction error:", err);
      extracted = { name: null, businessType: null, email: null, raw: null };
    }

    const nameValid = typeof extracted.name === "string" && extracted.name.trim().length > 0;
    const businessValid = typeof extracted.businessType === "string" && extracted.businessType.trim().length > 0;
    const emailValid = isValidEmail(extracted.email);

    let leadCaptured = false;

    if (nameValid && businessValid && emailValid) {
      try {
        await appendToSheet({
          name: extracted.name,
          businessType: extracted.businessType,
          email: extracted.email,
        });
        leadCaptured = true;
      } catch (err) {
        console.error("Google Sheets append error:", err);
        return res.status(500).json({ error: "Failed to append lead to Google Sheets." });
      }
    }

    return res.json({
      reply: assistantReply,
      history: updatedHistory,
      leadCaptured,
    });
  } catch (err) {
    console.error("Unhandled error in /chat:", err);
    return res.status(500).json({ error: "Internal server error." });
  }
});

app.get("/", (req, res) => res.send("Earthy AI Chat server running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
