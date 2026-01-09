# Host Genie Agent Backend (Python)

This is a minimal Python-based backend for the Host Genie Airbnb Extension. It is designed to be stateless and disposable, receiving the full context from the extension with every request.

## 🚀 Features
- **Event Handling**: Receives real-time context updates from the browser.
- **Streaming AI Replies**: Provides a mock streaming interface that simulates an LLM response.
- **CORS Enabled**: Configured to accept requests from the Chrome Extension.

## 🛠️ Setup

1. **Create a Virtual Environment**:
   ```bash
   python -m venv venv
   source venv/bin/activate  # On Windows: venv\Scripts\activate
   ```

2. **Install Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Run the Server**:
   ```bash
   python main.py
   ```
   The server will start at `http://localhost:3001`.

## 📡 API Endpoints

### `POST /agent/events`
Used by the extension to notify the agent of UI changes (e.g., new messages).
- **Payload**: `AgentEvent` (event name, full context string, timestamp).

### `POST /agent/stream`
Used to generate a streaming AI suggestion.
- **Payload**: `AgentAction` (action name, full context string).
- **Returns**: A text stream of the AI's response.

---
*Note: This server is a stub. Future versions will integrate the OpenAI Agents SDK.*
