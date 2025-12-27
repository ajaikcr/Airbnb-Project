chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GENERATE_REPLY") {
    fetch("http://localhost:3001/generate-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guestMessage: msg.guestMessage })
    })
      .then(r => r.json())
      .then(data => sendResponse({ success: true, reply: data.reply }))
      .catch(err => sendResponse({ success: false }));
    return true;
  }


});
