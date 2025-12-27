// server.js
// ================================
// Host Genie Backend
// ================================

const express = require("express");
const cors = require("cors");

const { generateAIReply } = require("./llm"); // ✅ THIS PATH IS CORRECT

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Host Genie backend running" });
});

// AI endpoint
app.post("/generate-reply", async (req, res) => {
  try {
    const { guestMessage, provider, apiKey } = req.body;

    if (!guestMessage) {
      return res.status(400).json({ error: "guestMessage is required" });
    }

    const prompt = `
You are an Airbnb host assistant.
Reply politely, clearly, and professionally.

Guest message:
"${guestMessage}"
    `;

    const aiReply = await generateAIReply({
      prompt,
      provider,
      apiKey
    });

    res.json({ reply: aiReply });

  } catch (err) {
    console.error("AI Error:", err.message);
    res.status(500).json({
      error: "Failed to generate AI reply",
      details: err.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Host Genie backend running on http://localhost:${PORT}`);
});
