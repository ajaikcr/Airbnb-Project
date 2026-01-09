# Host Genie — AI Co-Host for Airbnb Extension

Host Genie is a Chrome extension designed to assist Airbnb hosts by extracting real-time data from the Airbnb hosting dashboard and providing AI-powered insights and automation.

## 📂 Project Structure

The extension is structured as a standard Chromium extension:

- **`manifest.json`**: The core configuration file. It defines permissions, host access (`airbnb.com`, `localhost:3001`), and entry points for background and content scripts.
- **`background.js`**: The Service Worker. It runs in the background and handles tasks like proxying requests to the AI backend (`http://localhost:3001/generate-reply`) to avoid CORS issues.
- **`content/content_script.js`**: The "brain" of the extension. This script is injected into Airbnb pages. It handles:
  - Page type detection (Calendar, Listing, Messages).
  - Real-time data extraction via DOM scraping.
  - UI injection (floating insight panels).
  - State management for extracted data.
- **`popup/`**: Contains `popup.html`, which provides the extension's browser action interface.

## 🔗 Interfacing with Airbnb & Agentic Backend

The extension uses an **Event-Driven Bridge** architecture (Approach 2):

1.  **Context Extraction**: The `content_script.js` continuously monitors the Airbnb UI. When a new message is detected, it bundles the entire page state (Listing + Calendar + Chat) via `getConsolidatedDataText()`.
2.  **Event Relay**: This context is sent as an `EVENT_NEW_MESSAGE` to `background.js`.
3.  **Stateless Bridge**: `background.js` relays this event to the Agent Server. Because the full context is sent every time, the Agent Server can remain stateless and "disposable."
4.  **Streaming Actions**: When the user clicks "Generate AI Reply," the bridge initiates a streaming connection to the agent. LLM chunks are piped directly back to the UI for a real-time "typing" effect.

## 🚀 How to Run

1.  **Load the Extension**:
    - Open Chrome and navigate to `chrome://extensions/`.
    - Enable **Developer mode**.
    - Click **Load unpacked** and select the `Airbnb-Project/extension` directory.
2.  **Agent Server Setup**:
    - The bridge expects an Agent Server at `http://localhost:3001/agent`.
    - **Endpoints required**:
        - `POST /events`: Receives background context updates.
        - `POST /stream`: Receives context and returns a streaming LLM response.
3.  **Usage**:
    - Navigate to an Airbnb Message thread.
    - The Host Genie panel will appear.
    - Click **Generate AI Reply** to see the agentic backend in action.

## 🧪 Automated Testing

The bridge layer includes a suite of automated tests to ensure reliability:

1.  **Navigate to extension directory**: `cd Airbnb-Project/extension`
2.  **Install dependencies**: `npm install`
3.  **Run tests**: `npm test`

The tests validate:
- Event relaying to the agent server.
- Real-time streaming of AI chunks back to the UI.
- Graceful error handling for server failures.

## 🔑 Entry Points

- **UI Logic**: `content/content_script.js` -> `HostGenieBridge` response handlers.
- **Bridge Logic**: `background.js` -> `HostGenieBridge` class.
- **Data Protocol**: All communication uses the `getConsolidatedDataText()` format for maximum context.

---
*Developed as part of the Airbnb AI Co-Host Project.*
