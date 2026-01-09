import asyncio
import json
import logging
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

app = FastAPI(title="Host Genie Agent Backend")

# Enable CORS for the Chrome Extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify the extension ID
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AgentEvent(BaseModel):
    event: str
    context: str
    timestamp: str

class AgentAction(BaseModel):
    action: str
    context: str

# --- STUB LLM LOGIC ---

async def mock_llm_response(context: str):
    """
    Simulates an LLM generating a full response.
    """
    full_text = (
        "Hello! I've analyzed the listing and the guest's message. "
        "Based on your current pricing and the guest's inquiry about weekend availability, "
        "I suggest offering a small 5% discount if they book for 3 nights. "
        "\n\nSuggested Reply: 'Hi! Thanks for reaching out. We'd love to host you. "
        "Since you're looking at a weekend stay, I can offer a special rate if you extend to Monday!'"
    )
    
    # Simulate "thinking" time
    await asyncio.sleep(2)
    return full_text

# --- ENDPOINTS ---

@app.post("/agent/events")
async def handle_event(event: AgentEvent):
    """
    Receives background context updates from the extension.
    This allows the agent to stay 'synced' with the host's view.
    """
    logger.info(f"Received Event: {event.event} | Context Length: {len(event.context)} chars | Timestamp: {event.timestamp}")
    # In a real agent, we might update a local state or vector store here.
    return {"status": "acknowledged", "event": event.event}

@app.post("/agent/generate-reply")
async def handle_generate_reply(action: AgentAction):
    """
    Generates a full AI response based on the provided context.
    """
    logger.info(f"Action Requested: {action.action} | Context Length: {len(action.context)} chars")
    
    response_text = await mock_llm_response(action.context)
    return {"reply": response_text}

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting Host Genie Agent Backend on port 3001...")
    uvicorn.run(app, host="0.0.0.0", port=3001)
