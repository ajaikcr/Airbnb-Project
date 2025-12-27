// llm.js
// ================================
// Host Genie – LLM Router (MOCK FIRST)
// ================================

const axios = require("axios");

const USE_REAL_LLM = false; // 🔴 IMPORTANT

async function generateAIReply({ prompt, provider, apiKey }) {

  // ----------------
  // MOCK MODE (MVP)
  // ----------------
  if (!USE_REAL_LLM) {
    return `Thanks for your message! 😊

Check-in is from 2 PM onwards. Please let me know if you need any further details.`;
  }

  // ----------------
  // REAL LLM MODE (FUTURE)
  // ----------------

  if (provider === "openai") return openai(prompt, apiKey);
  if (provider === "gemini") return gemini(prompt, apiKey);
  if (provider === "groq") return groq(prompt, apiKey);

  throw new Error("Unsupported LLM provider");
}

// -------- OpenAI --------
async function openai(prompt, key) {
  if (!key) throw new Error("OpenAI API key missing");

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }]
    },
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      }
    }
  );

  return response.data.choices[0].message.content;
}

// Placeholders
async function gemini() {
  throw new Error("Gemini not enabled");
}
async function groq() {
  throw new Error("Groq not enabled");
}

module.exports = { generateAIReply };
