/**
 * background.js - Host Genie Bridge Layer
 * 
 * This script acts as a stateless, event-driven relay between the Airbnb UI 
 * and the Agentic Backend. It enforces the "disposable agent" pattern by 
 * ensuring all necessary context is passed with every event.
 */

const CONFIG = {
  AGENT_SERVER_URL: "http://localhost:3001/agent",
  GENERATE_REPLY_ENDPOINT: "http://localhost:3001/agent/generate-reply"
};

class HostGenieBridge {
  constructor() {
    this.setupListeners();
    console.log("[HostGenie Bridge] Initialized and listening for events...");
  }

  setupListeners() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const { type, payload } = message;
      const tabId = sender.tab?.id;

      console.log(`[Bridge] Received ${type} from tab ${tabId}`);

      // Use an async IIFE to await handlers without blocking the listener return
      (async () => {
        switch (type) {
          case "EVENT_NEW_MESSAGE":
            await this.handleNewMessageEvent(payload);
            break;

          case "ACTION_GENERATE_REPLY":
            await this.handleGenerateReply(payload, tabId);
            break;

          default:
            console.debug("[Bridge] Unhandled message type:", type);
        }
      })();

      return true;
    });
  }

  /**
   * Relays a new message event to the Agent Server.
   * This is a "fire and forget" notification for the agent to update its state
   * or prepare for potential follow-up actions.
   */
  async handleNewMessageEvent(contextText) {
    console.log("[Bridge] Relaying NEW_MESSAGE event to Agent Server...");

    try {
      const response = await fetch(`${CONFIG.AGENT_SERVER_URL}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "MESSAGE_RECEIVED",
          context: contextText,
          timestamp: new Date().toISOString()
        })
      });

      if (!response.ok) throw new Error(`Server responded with ${response.status}`);

      const result = await response.json();
      console.log("[Bridge] Agent Server acknowledged event:", result);
    } catch (error) {
      console.error("[Bridge] Failed to relay event:", error);
    }
  }

  /**
   * Handles the manual request to generate a reply.
   * Fetches the full AI response and relays it back to the UI.
   */
  async handleGenerateReply(contextText, tabId) {
    console.log("[Bridge] Requesting AI Reply from Agent...");

    try {
      // Notify UI that generation has started
      chrome.tabs.sendMessage(tabId, { type: "AI_REPLY_START" });

      const response = await fetch(CONFIG.GENERATE_REPLY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "GENERATE_REPLY",
          context: contextText
        })
      });

      if (!response.ok) throw new Error("Failed to connect to Agent server");

      const result = await response.json();
      const reply = result.reply;

      // Relay the full reply back to the content script
      chrome.tabs.sendMessage(tabId, {
        type: "AI_REPLY_FULL",
        payload: reply
      });

      console.log("[Bridge] AI Reply received and relayed");

    } catch (error) {
      console.error("[Bridge] Generation error:", error);
      chrome.tabs.sendMessage(tabId, {
        type: "AI_REPLY_ERROR",
        payload: error.message
      });
    }
  }
}

// Initialize the bridge
new HostGenieBridge();
