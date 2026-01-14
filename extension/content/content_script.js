// ========================================
// Host Genie – Unified Content Script
// ========================================

console.log("Host Genie loaded");

// ===============================
// GLOBAL STATE
// ===============================

let lastUrl = location.href;

// Observers
let calendarObserver = null;
let listingObserver = null;
let messageObserver = null;

// Observer guards
let calendarObserverAttached = false;
let listingObserverAttached = false;
let messageObserverAttached = false;

// Processing guards
let calendarProcessed = false;
let listingProcessed = false;

// Signatures (anti-repeat)
let lastCalendarSignature = null;
let lastListingSignature = null;
let lastMessageSignature = null;

// UI State
let isPanelMinimized = false;

// Runtime context
window.hostGenieContext = {
  pageType: null,
  calendar: {},
  listing: {},
  message: {},
  meta: {
    url: location.href,
    lastUpdated: null
  }
};

// ----------------------------------------
// PAGE DETECTION
// ----------------------------------------
function detectPageType() {
  const url = location.href;

  if (url.includes("/multicalendar")) return "calendar";

  if (url.includes("/hosting/listings/editor")) {
    return "listing-editor";
  }

  if (url.includes("/hosting/listings")) return "listing";

  if (url.includes("/hosting/messages")) return "messages";

  return "unknown";
}

// ----------------------------------------
// ROUTER (NO EXTRACTION HERE)
// ----------------------------------------
function routeHostGenie() {
  const pageType = detectPageType();

  if (window.hostGenieContext.pageType === pageType) return;

  // RESET STATE
  calendarProcessed = false;
  listingProcessed = false;
  lastListingSignature = null;
  lastCalendarSignature = null;

  window.hostGenieContext.pageType = pageType;
  window.hostGenieContext.meta.url = location.href;

  console.log("[HostGenie] Page detected:", pageType);

  // ---- CALENDAR ----
  if (pageType === "calendar") {
    cleanupListingUI();
    cleanupMessageUI();
    observeCalendarChanges();

    // Re-inject if we already have data
    if (window.hostGenieContext.calendar.basePrice) {
      injectHostGeniePanel(window.hostGenieContext.calendar);
    }

    extractCalendarData();
    return;
  }

  // ---- LISTING OVERVIEW ----
  if (pageType === "listing") {
    cleanupCalendarUI();
    cleanupMessageUI();
    observeListingChanges();

    // Re-inject if we already have data
    if (window.hostGenieContext.listing.title) {
      injectListingPanel();
    }

    return;
  }

  // ---- LISTING EDITOR ----
  if (pageType === "listing-editor") {
    cleanupCalendarUI();
    cleanupMessageUI();
    observeListingChanges();

    // Re-inject if we already have data
    if (window.hostGenieContext.listing.title) {
      injectListingPanel();
    }

    return;
  }

  // ---- MESSAGES ----
  if (pageType === "messages") {
    cleanupCalendarUI();
    cleanupListingUI();
    observeMessageChanges();

    // Re-inject if we already have data
    if (window.hostGenieContext.message.lastMessage) {
      injectMessagePanel(window.hostGenieContext.message);
    }

    return;
  }

  // ---- UNKNOWN / DASHBOARD ----
  // Explicitly cleanup if we are on a page where we don't want the panel 
  // (e.g. /hosting "Today" tab, or other non-matched pages)
  if (pageType === "unknown") {
    cleanupCalendarUI();
    cleanupListingUI();
    cleanupMessageUI();
  }
}

// SPA URL tracking
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    routeHostGenie();
  }
}).observe(document, { childList: true, subtree: true });

routeHostGenie();

// ----------------------------------------
// CALENDAR EXTRACTION
// ----------------------------------------
function extractCalendarData() {
  let attempts = 0;
  const MAX_ATTEMPTS = 6;

  const interval = setInterval(() => {
    attempts++;

    let price = null;
    let originalPrice = null;

    // 1. Try Sidebar "New listing price" (Specific selected date)
    // Find all containers with both the label and a price pattern
    const candidates = [...document.querySelectorAll("div, section, aside, span")]
      .filter(el =>
        el.innerText?.includes("New listing price") &&
        /₹\s?[\d,]+/.test(el.innerText)
      );

    // Sort by text length: smallest length = most specific container
    candidates.sort((a, b) => a.innerText.length - b.innerText.length);

    if (candidates.length > 0) {
      // The first candidate is the smallest container (likely the sidebar card)
      const container = candidates[0];
      const text = container.innerText;

      // 1. Current Price
      const m = text.match(/₹\s?([\d,]+)/);
      if (m) price = parseInt(m[1].replace(/,/g, ""), 10);

      // 2. Original Price (Strikethrough) - Look for line-through style or s tag
      // Simple heuristic: find another price in the same container that is DIFFERENT from the main price
      // and likely larger (since it's a discount)
      const allPrices = [...text.matchAll(/₹\s?([\d,]+)/g)]
        .map(m => parseInt(m[1].replace(/,/g, ""), 10));

      // The strikethrough price is usually the larger one
      if (allPrices.length > 1) {
        // Sort descending, the highest is likely the original price before discount
        allPrices.sort((a, b) => b - a);
        if (allPrices[0] !== price) {
          originalPrice = allPrices[0];
        }
      }
    }

    // 2. Fallback: Grid price (if no specific date selected or sidebar missing)
    if (!price) {
      const gridText = [...document.querySelectorAll("span")]
        .map(s => s.innerText)
        .find(t => /^₹\s?\d/.test(t));
      if (gridText) price = parseInt(gridText.replace(/[^\d]/g, ""), 10);
    }

    // 3. Dates Extraction
    let selectedDates = getSelectedDatesFromURL();

    // Fallback: Try to read dates from the sidebar pill (e.g. "Dec 27 – 28")
    if (!selectedDates.length) {
      const datePill = [...document.querySelectorAll("div, button")]
        .find(el => {
          const t = el.innerText?.trim();
          // Look for pattern like "Mmm DD - Mmm DD" or "Mmm DD"
          // Simple check: contains a month name and digits, and small length
          return t && /^[a-zA-Z]{3}\s\d{1,2}/.test(t) && t.length < 20;
        });

      if (datePill) {
        selectedDates = parseDateRangeFromText(datePill.innerText.trim());
      }
    }

    const hasWeekend = selectedDates.some(d => {
      const day = new Date(d).getDay();
      return day === 0 || day === 6;
    });

    if (price || attempts >= MAX_ATTEMPTS) {
      clearInterval(interval);

      const signature = JSON.stringify({ price, originalPrice, selectedDates });
      if (signature === lastCalendarSignature) return;
      lastCalendarSignature = signature;

      window.hostGenieContext.calendar = {
        selectedDates,
        basePrice: price,
        originalPrice,
        hasWeekend
      };

      cleanupCalendarUI();

      // Show panel if we have a price, even if dates are fuzzy
      if (price) {
        injectHostGeniePanel({ price, originalPrice, hasWeekend });
      }

      console.log("[HostGenie] Calendar data", window.hostGenieContext.calendar);
      logConsolidatedState();
    }
  }, 300);
}

// ----------------------------------------
// CALENDAR OBSERVER
// ----------------------------------------
function observeCalendarChanges() {
  if (calendarObserverAttached) return;

  let debounce;
  calendarObserver = new MutationObserver(() => {
    if (window.hostGenieContext.pageType !== "calendar") return;
    clearTimeout(debounce);
    debounce = setTimeout(extractCalendarData, 500);
  });

  calendarObserver.observe(document.body, { childList: true, subtree: true });
  calendarObserverAttached = true;
}

// ----------------------------------------
// LISTING OBSERVER (OVERVIEW + EDITOR)
// ----------------------------------------
function observeListingChanges() {
  if (listingObserverAttached) return;

  let debounce;

  listingObserver = new MutationObserver(() => {
    const pageType = window.hostGenieContext.pageType;

    if (pageType !== "listing" && pageType !== "listing-editor") return;

    clearTimeout(debounce);
    debounce = setTimeout(() => {

      const data =
        pageType === "listing"
          ? extractListingData()
          : extractListingEditorData();

      if (!data) return;

      // ✅ SAFE NORMALIZATION (important)
      const amenitiesCount = Array.isArray(data.amenities)
        ? data.amenities.length
        : 0;

      const guests = data.numberOfGuests || null;

      // 🔐 CRITICAL SIGNATURE (this fixes lazy loading issue)
      const signature = JSON.stringify({
        pageType,
        title: data.title || null,
        propertyType: data.propertyType || null,
        pricing: data.pricing || null,
        guests,
        amenitiesCount
      });

      if (signature === lastListingSignature) return;
      lastListingSignature = signature;

      window.hostGenieContext.listing = data;

      cleanupListingUI();
      injectListingPanel();

      console.log("[HostGenie] Listing data updated", data);
      logConsolidatedState();

    }, 700);
  });

  listingObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  listingObserverAttached = true;
}


// ----------------------------------------
// LISTING OVERVIEW EXTRACTION
// ----------------------------------------
function extractListingData() {
  if (window.hostGenieContext.pageType !== "listing") return null;

  const getText = sel =>
    document.querySelector(sel)?.innerText?.trim() || null;

  const getAllText = sel =>
    [...document.querySelectorAll(sel)]
      .map(el => el.innerText.trim())
      .filter(Boolean);

  const title =
    document.querySelector('[data-testid="listing-title"]')?.innerText?.trim() ||
    document.querySelector("h1")?.innerText?.trim() ||
    null;

  const listingData = {
    title,
    propertyType: getText('[data-testid="property-type"]'),
    pricing: getText('[data-testid="price"]'),
    availability: getText('[data-testid="availability-status"]'),
    numberOfGuests: getText('[data-testid="guest-capacity"]'),
    location: getText('[data-testid="listing-location"]'),
    extractedAt: new Date().toISOString()
  };


  window.hostGenieContext.listing = listingData;
  console.log("[HostGenie] Listing data extracted", listingData);
  return listingData;
}

// ----------------------------------------
// LISTING EDITOR EXTRACTION
// ----------------------------------------
function extractListingEditorData() {
  if (window.hostGenieContext.pageType !== "listing-editor") return null;
  // ✅ Count amenities safely (icon-based, editor page)
  const getAmenitiesList = () => {
    // STRATEGY 1: Detailed Amenities Page
    if (location.pathname.includes("/details/amenities")) {
      const amenitiesSection = [...document.querySelectorAll("section, div")]
        .find(el =>
          el.innerText?.trim().startsWith("Amenities") &&
          el.querySelector("svg")
        );

      if (amenitiesSection) {
        const amenityRows = [...amenitiesSection.querySelectorAll("div")]
          .filter(el => {
            const text = el.innerText?.trim();
            return (
              el.querySelector("svg") &&
              text &&
              text.length > 2 &&
              text.length < 40 &&
              !text.includes("\n") &&
              !text.includes("View") &&
              !text.includes("Showcase") &&
              !text.includes("Skip") &&
              !text.includes("Switch")
            );
          });

        const amenities = [...new Set(amenityRows.map(el => el.innerText.trim()))];
        if (amenities.length) return amenities;
      }
    }

    // STRATEGY 2: Main Editor Page (Summary Card)
    // Find the card that starts with "Amenities"
    const amenitiesCard = [...document.querySelectorAll("div")]
      .find(el => el.innerText?.trim().startsWith("Amenities\n"));

    if (amenitiesCard) {
      const lines = amenitiesCard.innerText
        .split("\n")
        .map(l => l.trim())
        .filter(l =>
          l &&
          l !== "Amenities" &&
          l !== "Edit" &&
          l !== "View" &&
          l.length > 2
        );

      // If we found lines, return them (deduplicated)
      if (lines.length > 0) {
        return [...new Set(lines)];
      }
    }

    return null;
  };


  // -----------------------------
  // Helper: read LEFT PANEL cards
  // -----------------------------
  const getValueByLabel = label => {
    // Return everything after the first line (label) joined by pipes
    // Use a more relaxed search for card labels
    const card = [...document.querySelectorAll("div")]
      .find(el => {
        const text = el.innerText?.trim() || "";
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return false;

        const firstLine = lines[0].toLowerCase();
        const target = label.toLowerCase();

        // Match if first line is exactly the label or starts with it
        return firstLine === target || firstLine.startsWith(target + " ") || firstLine.startsWith(target + "\n");
      });

    if (!card) return null;

    const lines = card.innerText
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);

    return lines.length > 1 ? lines.slice(1).join(" | ") : null;
  };

  // -----------------------------
  // LOCATION EXTRACTION (Listing Editor)
  // -----------------------------
  const getLocationData = () => {
    let locData = { lat: null, lng: null, text: null };

    // 1. Find Location Section
    // Look for a heading "Location" and find the map nearby
    const headings = [...document.querySelectorAll('h2, h3, div')];
    const locationHeader = headings.find(h => h.innerText?.trim() === "Location");

    // Fallback: look for map directly
    const mapImg = document.querySelector('img[src*="maps.googleapis"]');
    const mapLink = document.querySelector('a[href*="maps.google"]');

    if (mapImg) {
      // src="...center=10.05,76.54&..."
      const match = mapImg.src.match(/center=([-\d.]+),([-\d.]+)/);
      if (match) {
        locData.lat = match[1];
        locData.lng = match[2];
      }
      // Alt text often has address
      if (mapImg.alt && mapImg.alt.length > 5) {
        locData.text = mapImg.alt;
      }
    }

    if (!locData.lat && mapLink) {
      const match = mapLink.href.match(/@([-\d.]+),([-\d.]+)/) || mapLink.href.match(/q=([-\d.]+),([-\d.]+)/);
      if (match) {
        locData.lat = match[1];
        locData.lng = match[2];
      }
    }

    // Text Fallback if map alt failed
    if (!locData.text && locationHeader) {
      // Try next sibling or closest text container
      // This is tricky in React/Airbnb DOM. 
      // We might just rely on the global 'Location' card scrape we do below in 'getValueByLabel("Location")'
      const possibleText = getValueByLabel("Location");
      if (possibleText) locData.text = possibleText;
    }

    // Final attempt: getValueByLabel "Location" if we haven't checked it yet
    if (!locData.text) {
      locData.text = getValueByLabel("Location") || null;
    }

    // If we only have text, return that. If we have coords, return object.
    if (!locData.lat && !locData.text) return null;

    // Return structured object if possible, or just text if that's all we have (for backward compat)
    // But implementation plan says object.
    return locData;
  };
  const getAllOtherDetails = () => {
    const details = {};
    const allDivs = [...document.querySelectorAll("div")];

    // Filter for elements that likely contain a label and its values
    const potentialCards = allDivs.filter(el => {
      const text = el.innerText?.trim();
      // Heuristic for a card: has text, contains a newline, and is a reasonable size
      // Increased max length to 5000 for long policies/descriptions
      return text && text.includes("\n") && text.length < 5000 && text.length > 5;
    });

    potentialCards.forEach(card => {
      const lines = card.innerText.split("\n").map(l => l.trim()).filter(Boolean);
      if (lines.length >= 2) {
        const label = lines[0];
        const value = lines.slice(1).join(" | ");

        // Skip labels we already handle specifically to avoid redundancy
        const skip = [
          "Title", "Property type", "Pricing", "Availability", "Number of guests",
          "Description", "House rules", "Guest safety", "Cancellation policy",
          "Location", "About the host", "Co-hosts", "Booking settings", "Custom link",
          "Amenities", "Edit", "View", "Listing editor", "Your space", "Arrival guide"
        ];

        // Validate label: not too long, not too short, doesn't match skip list
        if (label.length > 2 && label.length < 60 && !skip.some(s => label.toLowerCase().includes(s.toLowerCase()))) {
          details[label] = value;
        }
      }
    });
    return details;
  };

  const locObj = getLocationData();

  const listingData = {
    title: getValueByLabel("Title"),
    propertyType: getValueByLabel("Property type"),
    pricing: getValueByLabel("Pricing"),
    availability: getValueByLabel("Availability"),
    numberOfGuests: getValueByLabel("Number of guests"),
    description: getValueByLabel("Description"),
    houseRules: getValueByLabel("House rules"),
    guestSafety: getValueByLabel("Guest safety"),
    cancellationPolicy: getValueByLabel("Cancellation policy"),
    location: locObj || getValueByLabel("Location"), // Fallback to simple text if robust fails
    aboutHost: getValueByLabel("About the host"),
    coHosts: getValueByLabel("Co-hosts"),
    bookingSettings: getValueByLabel("Booking settings"),
    customLink: getValueByLabel("Custom link"),
    amenities: getAmenitiesList() || [],
    extraDetails: getAllOtherDetails(), // Capture everything else reliably
    extractedAt: new Date().toISOString(),
    source: "listing-editor"
  };

  console.log("[HostGenie] Listing editor data extracted", listingData);

  return listingData;
}

// ----------------------------------------
// MESSAGE OBSERVER
// ----------------------------------------
function observeMessageChanges() {
  if (messageObserverAttached) return;

  let debounce;
  messageObserver = new MutationObserver((mutations) => {
    if (window.hostGenieContext.pageType !== "messages") return;

    // IGNORE mutations that are just us updating our own panel
    const shouldIgnore = mutations.every(m =>
      m.target.closest("#host-genie-message-box") ||
      (m.target.id === "host-genie-message-box")
    );
    if (shouldIgnore) return;

    clearTimeout(debounce);
    debounce = setTimeout(extractMessageData, 800);
  });

  messageObserver.observe(document.body, { childList: true, subtree: true });
  messageObserverAttached = true;
}

// ----------------------------------------
// MESSAGE EXTRACTION
// ----------------------------------------
function extractMessageData() {
  if (window.hostGenieContext.pageType !== "messages") return;

  // Find the last message content
  // Airbnb messages are usually in divs. We look for the main chat container or just the last few text blocks.

  // 2. ANCHOR STRATEGY: Find the "Type a message" box.
  const inputBox = document.querySelector('textarea[placeholder*="message"], div[contenteditable="true"], textarea[aria-label*="message"]');

  // Helper to find the "Active Chat Container" with Broader Detection
  const getActiveChatContainer = (startNode) => {
    let current = startNode;
    while (current && current.parentElement && current.parentElement !== document.body) {
      const parent = current.parentElement;
      // Broader check for ANY sidebar-like element in the parent
      const hasSidebar = parent.querySelector('nav, aside, [role="navigation"], [class*="sidebar"], [aria-label="Threads"], section[aria-label*="About"]');

      if (hasSidebar) {
        // Verify we are not IN the sidebar ourselves
        const amISidebar = current.matches('nav, aside, [role="navigation"]') || current.querySelector('[aria-label="Threads"]');
        if (!amISidebar) {
          return current; // We are the sibling of the sidebar!
        }
      }
      current = parent;
    }
    return inputBox?.closest('main') || document.body;
  };

  const mainChatArea = getActiveChatContainer(inputBox);
  if (!mainChatArea) return;

  // 1. Gather Forbidden Terms from Sidebars (RIGHT SIDE ONLY)
  // We scan the Right Sidebar for text to BLOCK from the chat extraction.
  const sidebars = document.querySelectorAll('section[aria-label="Reservation details"], section[aria-label="UserProfile"], aside');
  const forbiddenTerms = new Set();

  sidebars.forEach(s => {
    // Don't scan the main chat area by accident
    if (s.contains(inputBox)) return;

    const lines = s.innerText.split("\n");
    lines.forEach(line => {
      const t = line.trim().toLowerCase();
      if (t.length > 3) forbiddenTerms.add(t);
    });
  });

  // 3. Guest Name Detection (Fixed Duplication "Nabhas Nabhas")
  let guestName = "Guest";
  const potentialHeaders = mainChatArea.querySelectorAll('h2, h1, div[data-testid="header-container"] h2');

  for (let h of potentialHeaders) {
    const txt = h.innerText?.trim();
    if (txt && txt !== "Messages" && !forbiddenTerms.has(txt.toLowerCase())) {
      // Clean up duplication: split by whitespace, take unique parts
      const parts = txt.split(/\s+/);
      const unique = [...new Set(parts)];
      guestName = unique.join(" ");
      break;
    }
  }

  // 4. Define Noise Filtering (Strict Anti-Leak)
  const isNoise = (text) => {
    const lowerText = text.toLowerCase();

    if (forbiddenTerms.has(lowerText)) return true;
    if (/^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(text)) return true; // Just time

    // Name checks
    if (text.trim() === guestName) return true;
    if (lowerText.includes(guestName.toLowerCase()) && lowerText.includes("booker")) return true; // "Nabhas - Booker"

    // Reservation / System Phrases to PURGE
    const systemPhrases = [
      "no trips yet", "joined airbnb",
      "listing no longer exists", "show profile", "report this guest",
      "visit the help centre", "aircover for hosts", "payment", "payout",
      "translation on", "translation off", "show reservation",
      "this could be your chance to host", "special offer",
      "show more topics", "reservation", "guest details",
      "resource centre", "airbnb", "what happens after you tap next",
      "check out", "learn more", "show details",
      "read conversation", "switch to travelling", "skip to content", "skip to"
    ];
    if (systemPhrases.some(p => lowerText.includes(p))) return true;

    // Exact matches
    const exactMatches = [
      "Today", "Yesterday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
      "Calendar", "Listings", "Messages", "All", "Unread", "Superhost Ambassador",
      "Translate", "Original language", "Report", "Read Conversation",
      "Show details", "Edit", "Learn More", "Select Certificate",
      "Smartcard / Token User Pin", "Return to Inbox", "Write a message...", "Send",
      "Skip to Last Message (Ctrl-e)", "Skip to Typing Your Message (Ctrl-m)",
      "Enter", "Shift + Enter", "Guest", "Host"
    ];
    if (exactMatches.includes(text)) return true;

    return false;
  };

  // 5. Extract Text
  // Identify Header to exclude
  const headerElement = mainChatArea.querySelector('header') ||
    mainChatArea.querySelector('div[data-testid="header-container"]') ||
    mainChatArea.querySelector('div[style*="border-bottom"]');

  // Select ALL elements 
  const allTextElements = mainChatArea.querySelectorAll('*');

  // Identify Right Sidebar (Reservation / Profile) - STRICTLY
  const allHeaders = Array.from(mainChatArea.querySelectorAll('h2, h3, h4'));
  const sidebarHeader = allHeaders.find(h =>
    (h.innerText.includes("Reservation") || h.innerText.includes("About")) &&
    !h.closest('div[data-testid="message-pane"]')
  );
  const strictSidebar = sidebarHeader?.closest('section') || sidebarHeader?.closest('aside');

  const textBlocks = [];

  // REVERT TO TREEWALKER WITH VISIBILITY CHECKS
  const walker = document.createTreeWalker(mainChatArea, NodeFilter.SHOW_TEXT, null, false);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const el = node.parentElement;

    if (!el || el.closest("#host-genie-message-box")) continue;

    const txt = node.textContent.trim();
    const lowerTxt = txt.toLowerCase();

    // FORCE ACCEPT "Enquiry sent" (Context override)
    if (lowerTxt.includes("enquiry sent") || lowerTxt.includes("guest, ")) {
      textBlocks.push(txt);
      continue; // context found, keep it!
    }

    // HARD TEXT FILTER FOR ACCESSIBILITY LEAKS
    // Ensure "Read Conversation" and "Skip to" are killed regardless of container
    if (txt.startsWith("Read Conversation with") || txt.startsWith("Skip to") || txt.startsWith("Switch to")) continue;

    if (headerElement && headerElement.contains(el)) continue;

    // STRICT RIGHT SIDEBAR EXCLUSION
    if (strictSidebar && strictSidebar.contains(el)) {
      console.log("Dropped (Right Sidebar):", txt);
      continue;
    }

    // STRICT LEFT SIDEBAR / THREAD LIST EXCLUSION (Fixes "Read Conversation with..." leak)
    if (el.closest('nav') ||
      el.closest('[aria-label="Threads"]') ||
      el.closest('[data-testid="conversation-list-item"]') ||
      el.closest('a[href*="/messaging/conversation/"]')) {
      console.log("Dropped (Left Sidebar):", txt);
      continue;
    }

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    if (el.closest('[aria-hidden="true"]')) continue;

    if (txt.length > 1 && !isNoise(txt) && !txt.startsWith("http")) {
      textBlocks.push(txt);
    } else if (txt.length > 0) {
      // console.log(`Dropped (Noise/Short): "${txt}"`); // Original comment, now using the provided one
      console.log(`Dropped (Noise/Short): "${txt}"`);
    }
  }

  if (!textBlocks.length) return;

  // Deduplicate
  const deduplicated = [...new Set(textBlocks)];

  // Latest message & History Split
  let lastMessage = deduplicated.pop() || "";

  // FIX: If deduplicated has only 1 item and it's looking like a name, it's probably the header that snuck in.
  // Validate lastMessage is not just the name
  if (lastMessage.replace(/\s/g, '').toLowerCase() === guestName.replace(/\s/g, '').toLowerCase()) {
    lastMessage = deduplicated.pop() || ""; // Discard header, try next
  }

  const previousConversation = deduplicated.join("\n---\n");

  // Cleaning Last Message
  if (lastMessage.startsWith(guestName)) {
    lastMessage = lastMessage.replace(guestName, "").trim();
  }
  // Clean last message of any lingering timestamps or names if they are prefixes
  // (Simple heuristic: if it starts with name, strip it)
  // Clean last message of any lingering timestamps or names if they are prefixes
  // (Simple heuristic: if it starts with name, strip it)
  if (lastMessage.startsWith(guestName)) {
    lastMessage = lastMessage.replace(guestName, "").trim();
  }

  // Build full chat log for backend (context)
  // MUST RE-ASSEMBLE: History + Last Message
  const fullChat = previousConversation ? (previousConversation + "\n---\n" + lastMessage) : lastMessage;

  const data = {
    guestName,
    lastMessage,
    fullChat,
    previousChat: previousConversation, // FIX: Use the SPLIT history (minus last message) for UI
    extractedAt: new Date().toISOString()
  };

  const signature = JSON.stringify({ guestName, lastMessage, fullChatLength: (fullChat || "").length });

  if (signature === lastMessageSignature) return;
  lastMessageSignature = signature;

  window.hostGenieContext.message = data;

  cleanupMessageUI();
  injectMessagePanel(data);

  // ULTRA CLEAN CONSOLE LOG FOR USER
  console.log(`%c[HostGenie] Chat History for: ${guestName}`, "color: #ff385c; font-weight: bold; font-size: 14px;");
  console.log(fullChat);

  // BRIDGE TRIGGER
  chrome.runtime.sendMessage({
    type: "EVENT_NEW_MESSAGE",
    payload: getConsolidatedDataText()
  });

  console.log("[HostGenie] Message data relayed to bridge");
  logConsolidatedState();
}

// ----------------------------------------
// UI – MESSAGE PANEL
// ----------------------------------------
function injectMessagePanel(data) {
  if (!data || !data.lastMessage) return;

  if (document.getElementById("host-genie-message-box")) return;

  const box = document.createElement("div");
  box.id = "host-genie-message-box";

  // Split history if exists
  const history = data.fullChat ? data.fullChat.split("\n---\n") : [];
  const latest = history.length > 0 ? history[history.length - 1] : data.lastMessage;
  const previous = history.length > 1 ? history.slice(0, -1).reverse() : [];

  box.innerHTML = `
    <!-- Toggle Handle -->
    <div id="host-genie-toggle" style="
      position: absolute; left: -30px; top: 20px; 
      width: 30px; height: 40px; background: #ff385c; 
      color: white; display: flex; align-items: center; 
      justify-content: center; border-radius: 8px 0 0 8px; 
      cursor: pointer; box-shadow: -4px 0 10px rgba(0,0,0,0.1);
      font-weight: bold; font-size: 16px;
    ">
      ${isPanelMinimized ? "◀" : "▶"}
    </div>

    <div id="host-genie-content" style="padding:14px; display: flex; flex-direction: column; max-height: 500px; transition: opacity 0.3s; ${isPanelMinimized ? "opacity: 0; pointer-events: none;" : ""}">
      <h3 style="color:#ff385c;font-size:14px; margin-top: 0;">
        Host Genie – Message Insight
      </h3>
      <p style="margin: 4px 0;"><strong>Guest:</strong> ${data.guestName}</p>
      
      <div style="margin-top: 10px;">
        <strong style="font-size: 11px; color: #717171; text-transform: uppercase;">Latest Message</strong>
        <p style="margin: 4px 0; font-weight: 500; line-height: 1.4;">${latest}</p>
      </div>

      <div style="margin-bottom: 2px;">
      <label style="font-size: 10px; color: #717171; display: block; margin-bottom: 1px;">PREVIOUS CHATS</label>
      <div style="font-size: 11px; color: #222; max-height: 80px; overflow-y: auto; background: #f7f7f7; padding: 6px; border-radius: 6px; border: 1px solid #ddd;">
        ${data.previousChat ? data.previousChat.replace(/\n/g, '<br>') : 'No previous history.'}
      </div>
    </div>

      <button id="host-genie-reply-btn" style="
        margin-top: 14px; padding: 10px; width: 100%; 
        background: #000; color: white; border: none; 
        border-radius: 8px; cursor: pointer; font-weight: bold;
        transition: background 0.2s;
      ">Generate AI Reply</button>

      <button id="host-genie-download-btn" style="
        margin-top: 8px; padding: 10px; width: 100%; 
        background: #fff; color: #484848; border: 1px solid #484848; 
        border-radius: 8px; cursor: pointer; font-weight: bold;
        transition: background 0.2s;
      ">Download Context</button>

      <div id="host-genie-ai-response" style="
        display: none; margin-top: 14px; padding: 12px; 
        background: #f7f7f7; border-radius: 8px; 
        font-size: 13px; border: 1px solid #e5e7eb;
        max-height: 200px; overflow-y: auto;
      ">
        <strong style="display:block; margin-bottom: 4px; font-size: 11px; color: #717171; text-transform: uppercase;">AI Suggestion</strong>
        <div id="host-genie-ai-text" style="white-space: pre-wrap; line-height: 1.5; color: #222;"></div>
      </div>
    </div>
  `;

  Object.assign(box.style, {
    position: "fixed",
    top: "120px",
    right: "24px",
    width: "320px",
    background: "#fff",
    borderRadius: "16px",
    boxShadow: "0 16px 40px rgba(0,0,0,0.2)",
    zIndex: "999999",
    transform: isPanelMinimized ? "translateX(310px)" : "translateX(0)",
    transition: "transform 0.4s cubic-bezier(0.19, 1, 0.22, 1)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
  });

  document.body.appendChild(box);

  // Toggle Listener
  document.getElementById("host-genie-toggle")?.addEventListener("click", () => {
    isPanelMinimized = !isPanelMinimized;
    const box = document.getElementById("host-genie-message-box");
    const toggle = document.getElementById("host-genie-toggle");
    const content = document.getElementById("host-genie-content");

    if (box && toggle && content) {
      if (isPanelMinimized) {
        box.style.transform = "translateX(310px)";
        toggle.innerText = "◀";
        content.style.opacity = "0";
        content.style.pointerEvents = "none";
      } else {
        box.style.transform = "translateX(0)";
        toggle.innerText = "▶";
        content.style.opacity = "1";
        content.style.pointerEvents = "auto";
      }
    }
  });
  document.getElementById("host-genie-download-btn")?.addEventListener("click", downloadConsolidatedData);
  document.getElementById("host-genie-reply-btn")?.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "ACTION_GENERATE_REPLY",
      payload: getConsolidatedDataText()
    });
  });
}

function cleanupMessageUI() {
  document.getElementById("host-genie-message-box")?.remove();
}



// ----------------------------------------
// UI – CALENDAR PANEL
// ----------------------------------------
function injectHostGeniePanel(data = {}) {
  const { price = null, originalPrice = null } = data;
  if (price == null) return;

  if (document.getElementById("host-genie-price-box")) return;

  const box = document.createElement("div");
  box.id = "host-genie-price-box";

  // Show "Actual" if originalPrice exists, else just show Airbnb price
  const originalRow = originalPrice
    ? `<p><strong>Actual:</strong> ₹${originalPrice}</p>`
    : `<p><strong>Actual:</strong> <span>N/A</span></p>`;

  box.innerHTML = `
    <div style="padding:14px">
      <h3>Host Genie – Pricing Insight</h3>
      <p><strong>Airbnb:</strong> ₹${price}</p>
      ${originalRow}
      <button id="host-genie-download-price-btn" style="
        margin-top: 10px; padding: 8px; width: 100%; 
        background: #ff385c; color: white; border: none; 
        border-radius: 8px; cursor: pointer; font-weight: bold;
      ">Download for AI</button>
    </div>
  `;

  Object.assign(box.style, {
    position: "fixed",
    top: "120px",
    right: "420px",
    width: "260px",
    background: "#fff",
    borderRadius: "12px",
    boxShadow: "0 12px 30px rgba(0,0,0,0.15)",
    zIndex: "999999"
  });

  document.body.appendChild(box);
  document.getElementById("host-genie-download-price-btn")?.addEventListener("click", downloadConsolidatedData);
}

// ----------------------------------------
// UI – LISTING PANEL
// ----------------------------------------
function injectListingPanel(data = null) {
  // Always resolve data safely
  const listingData = data || window.hostGenieContext.listing;
  if (!listingData) return;

  // Prevent duplicates
  if (document.getElementById("host-genie-listing-box")) return;

  // Create panel
  const box = document.createElement("div");
  box.id = "host-genie-listing-box";

  const amenitiesText =
    Array.isArray(listingData.amenities) && listingData.amenities.length
      ? listingData.amenities.slice(0, 4).join(", ")
      : "View details";

  box.innerHTML = `
  <div style="padding:14px">
    <h3 style="color:#ff385c;font-size:14px">
      Host Genie – Listing Insights
    </h3>

    <p><strong>Title:</strong> ${listingData.title || "Not set"}</p>
    <p><strong>Property:</strong> ${listingData.propertyType || "Not set"}</p>
    <p><strong>Guests:</strong> ${listingData.numberOfGuests || "Not set"}</p>
    <p><strong>Price:</strong> ${listingData.pricing || "Not set"}</p>
    <p><strong>Amenities:</strong> ${amenitiesText}</p>
    <button id="host-genie-download-listing-btn" style="
        margin-top: 10px; padding: 8px; width: 100%; 
        background: #ff385c; color: white; border: none; 
        border-radius: 8px; cursor: pointer; font-weight: bold;
    ">Download for AI</button>
    <small style="color:#6b7280; display: block; margin-top: 5px;">
      ${listingData.source}
    </small>
  </div>
`;


  // Styling (unchanged)
  box.style.position = "fixed";
  box.style.top = "120px";
  box.style.right = "24px";
  box.style.width = "300px";
  box.style.background = "#fff";
  box.style.border = "1px solid #e5e7eb";
  box.style.borderRadius = "12px";
  box.style.boxShadow = "0 12px 30px rgba(0,0,0,0.15)";
  box.style.zIndex = "999999";

  document.body.appendChild(box);
  document.getElementById("host-genie-download-listing-btn")?.addEventListener("click", downloadConsolidatedData);
}



// ----------------------------------------
// CLEANUP
// ----------------------------------------
function cleanupCalendarUI() {
  document.getElementById("host-genie-price-box")?.remove();
}

function cleanupListingUI() {
  document.getElementById("host-genie-listing-box")?.remove();
}

// ----------------------------------------
// URL DATE PARSER
// ----------------------------------------
function getSelectedDatesFromURL() {
  const match = location.href.match(
    /edit-selected-dates\/(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?/
  );

  if (!match) return [];

  const start = match[1];
  const end = match[2] || match[1];

  const dates = [];
  let current = new Date(start);
  const last = new Date(end);

  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

// Helper to parse "Dec 27 – 28" or "Dec 28 – Jan 2"
function parseDateRangeFromText(text) {
  try {
    // Normalize hyphen/dash
    const clean = text.replace(/–|—/g, "-");
    const parts = clean.split("-").map(p => p.trim());

    if (parts.length === 0) return [];

    const currentYear = new Date().getFullYear();
    const dates = [];

    // Helper to parse "Dec 27" -> Date object
    const parsePart = (str, fallbackMonthVal = -1) => {
      const m = str.match(/([a-zA-Z]{3})\s?(\d{1,2})/);
      if (m) {
        const monthStr = m[1];
        const day = parseInt(m[2], 10);
        const monthIndex = new Date(`${monthStr} 1, 2000`).getMonth();
        return new Date(currentYear, monthIndex, day);
      }
      // Case: "28" (inherits month)
      else if (/^\d{1,2}$/.test(str) && fallbackMonthVal !== -1) {
        return new Date(currentYear, fallbackMonthVal, parseInt(str, 10));
      }
      return null;
    };

    let start = parsePart(parts[0]);
    if (!start) return []; // strict fail

    let end = parts.length > 1 ? parsePart(parts[1], start.getMonth()) : start;
    if (!end) end = start;

    // Handle year rollover (Dec 28 - Jan 2)
    // If end month is earlier than start month, add 1 year to end
    if (end.getMonth() < start.getMonth()) {
      end.setFullYear(currentYear + 1);
    }

    // Case: Parsing historical dates or future dates crossing year boundary relative to "now"
    // For simple calendar usage, we assume closest logical dates. 
    // Airbnb usually shows current/future. 

    // Generate range
    let current = new Date(start);
    while (current <= end) {
      // Format YYYY-MM-DD to match URL format
      // Note: toISOString uses UTC, so we must be careful with timezones.
      // Use local string construction to avoid off-by-one errors due to timezone.
      const year = current.getFullYear();
      const mon = String(current.getMonth() + 1).padStart(2, '0');
      const day = String(current.getDate()).padStart(2, '0');
      dates.push(`${year}-${mon}-${day}`);

      current.setDate(current.getDate() + 1);
    }

    return dates;

  } catch (e) {
    console.error("[HostGenie] Date parsing error", e);
    return [];
  }
}

// ========================================
// CONSOLIDATED DATA FOR AI
// ========================================

function getConsolidatedDataText() {
  const ctx = window.hostGenieContext;
  let text = "--- HOST GENIE CONSOLIDATED DATA ---\n\n";

  // CALENDAR
  text += "[CALENDAR]\n";
  if (ctx.calendar.basePrice) {
    text += `basePrice: ${ctx.calendar.basePrice}\n`;
    text += `originalPrice: ${ctx.calendar.originalPrice || "N/A"}\n`;
    text += `hasWeekend: ${ctx.calendar.hasWeekend}\n`;
    text += `selectedDates: ${JSON.stringify(ctx.calendar.selectedDates)}\n`;
  } else {
    text += "No calendar data extracted yet.\n";
  }
  text += "\n";

  // LISTING
  text += "[LISTING]\n";
  if (ctx.listing.title) {
    text += `title: "${ctx.listing.title}"\n`;
    text += `propertyType: "${ctx.listing.propertyType || "N/A"}"\n`;
    text += `pricing: "${ctx.listing.pricing || "N/A"}"\n`;
    text += `availability: "${ctx.listing.availability || "N/A"}"\n`;
    text += `numberOfGuests: "${ctx.listing.numberOfGuests || "N/A"}"\n`;
    text += `description: "${ctx.listing.description || "N/A"}"\n`;
    text += `houseRules: "${ctx.listing.houseRules || "N/A"}"\n`;
    text += `guestSafety: "${ctx.listing.guestSafety || "N/A"}"\n`;
    text += `cancellationPolicy: "${ctx.listing.cancellationPolicy || "N/A"}"\n`;
    text += `location: "${ctx.listing.location || "N/A"}"\n`;
    text += `aboutHost: "${ctx.listing.aboutHost || "N/A"}"\n`;
    text += `coHosts: "${ctx.listing.coHosts || "N/A"}"\n`;
    text += `bookingSettings: "${ctx.listing.bookingSettings || "N/A"}"\n`;
    text += `customLink: "${ctx.listing.customLink || "N/A"}"\n`;
    text += `amenities: ${JSON.stringify(ctx.listing.amenities || [])}\n`;

    // Extra Details (Rules, Policy, etc.)
    if (ctx.listing.extraDetails) {
      for (const [key, val] of Object.entries(ctx.listing.extraDetails)) {
        text += `${key}: "${val}"\n`;
      }
    }

    text += `source: "${ctx.listing.source || "N/A"}"\n`;
  } else {
    text += "No listing data extracted yet.\n";
  }
  text += "\n";

  // MESSAGE
  text += "[MESSAGE]\n";
  if (ctx.message.lastMessage) {
    text += `guestName: "${ctx.message.guestName || "Guest"}"\n`;
    text += `lastMessage: "${ctx.message.lastMessage}"\n`;
    text += `fullChat:\n${ctx.message.fullChat || "N/A"}\n`;
    text += `extractedAt: "${ctx.message.extractedAt}"\n`;
  } else {
    text += "No message data extracted yet.\n";
  }

  return text;
}

function logConsolidatedState() {
  console.log("%c[HostGenie] Consolidated Data Updated", "color: #ff385c; font-weight: bold;");
  console.log(window.hostGenieContext);
  console.log(getConsolidatedDataText());
}

function downloadConsolidatedData() {
  const text = getConsolidatedDataText();
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  a.href = url;
  a.download = `host-genie-data-${timestamp}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  console.log("[HostGenie] Data exported to file.");
}

// ----------------------------------------
// BRIDGE RESPONSE HANDLERS
// ----------------------------------------
chrome.runtime.onMessage.addListener((msg) => {
  const responseBox = document.getElementById("host-genie-ai-response");
  const textBox = document.getElementById("host-genie-ai-text");

  if (msg.type === "AI_REPLY_START") {
    if (responseBox) responseBox.style.display = "block";
    if (textBox) {
      textBox.innerText = "Thinking...";
      textBox.style.color = "#717171";
    }
  }

  if (msg.type === "AI_REPLY_FULL") {
    const reply = msg.payload;

    // 1. Update the Host Genie UI
    if (textBox) {
      textBox.innerText = reply;
      textBox.style.color = "#222";

      // Auto-scroll to bottom
      if (responseBox) responseBox.scrollTop = responseBox.scrollHeight;
    }

    // 2. Fill the Airbnb message box
    fillAirbnbMessageBox(reply);

    console.log("[HostGenie] AI Reply received and message box filled");
  }

  if (msg.type === "AI_REPLY_ERROR") {
    if (textBox) {
      textBox.innerText = "Error: " + msg.payload;
      textBox.style.color = "#ff385c";
    }
  }
});

/**
 * Fills the Airbnb message box with the provided text.
 * Handles contenteditable and triggers necessary events for Airbnb's UI to react.
 */
function fillAirbnbMessageBox(text) {
  // Try multiple selectors to be robust
  const messageBox =
    document.getElementById("message_input") ||
    document.querySelector('[data-testid="messaging-composebar"]') ||
    document.querySelector('div[role="textbox"][aria-label="Write a message..."]');

  if (!messageBox) {
    console.error("[HostGenie] Could not find Airbnb message box");
    return;
  }

  // Focus the element first
  messageBox.focus();

  // Set the text
  // For contenteditable, we can use innerText or textContent
  messageBox.innerText = text;

  // Trigger input event so Airbnb's React/internal state updates
  const inputEvent = new Event('input', { bubbles: true });
  messageBox.dispatchEvent(inputEvent);

  // Some frameworks also listen for 'change'
  const changeEvent = new Event('change', { bubbles: true });
  messageBox.dispatchEvent(changeEvent);

  console.log("[HostGenie] Message box filled successfully");
}

