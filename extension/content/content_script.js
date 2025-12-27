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
    extractCalendarData();
    return;
  }

  // ---- LISTING OVERVIEW ----
  if (pageType === "listing") {
    cleanupCalendarUI();
    cleanupMessageUI();
    observeListingChanges();
    return;
  }

  // ---- LISTING EDITOR ----
  if (pageType === "listing-editor") {
    cleanupCalendarUI();
    cleanupMessageUI();
    observeListingChanges();
    return;
  }

  // ---- MESSAGES ----
  if (pageType === "messages") {
    cleanupCalendarUI();
    cleanupListingUI();
    observeMessageChanges();
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
    const card = [...document.querySelectorAll("div")]
      .find(el =>
        el.innerText?.trim().startsWith(label + "\n")
      );

    if (!card) return null;

    const lines = card.innerText
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean);

    // First line = label, second line = value
    return lines.length > 1 ? lines[1] : null;
  };

  const listingData = {
    title: getValueByLabel("Title"),
    propertyType: getValueByLabel("Property type"),
    pricing: getValueByLabel("Pricing"),
    availability: getValueByLabel("Availability"),
    numberOfGuests: getValueByLabel("Number of guests"),
    amenities: getAmenitiesList(),
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

  // 1. Text scraping from what looks like the chat history
  // Blocklist common hidden labels or non-message text
  const blocklist = [
    "Current Domain", "Show details", "Translate", "Original language",
    "Report", "Signer.Digital", "Resource Centre", "What happens after",
    "Switch to hosting", "Switch to travelling", "Read Conversation",
    "Last message sent"
  ];

  // Added 'p' tag as messages often use paragraphs
  const allTextBlocks = [...document.querySelectorAll('div[dir="ltr"], div[dir="rtl"], span, p')]
    .filter(el => !el.closest("#host-genie-message-box")) // CRITICAL: Don't read our own panel
    .map(el => el.innerText?.trim())
    .filter(t =>
      t &&
      t.length > 5 &&
      t.length < 10000 && // Increased limit significantly for long messages
      !blocklist.some(b => t.includes(b)) && // stricter check
      !t.startsWith("http")
    );

  if (!allTextBlocks.length) return;

  // STRATEGY: Longest Text Block
  // Chat messages are usually the longest continuous text on the screen.
  // We sort by length descending to find the main message content.
  allTextBlocks.sort((a, b) => b.length - a.length);

  const lastMessage = allTextBlocks[0]; // The longest block

  // Detect Guest Name (from sidebar or header)
  // Fix duplication "Sangeeta Sangeeta"
  let guestName = document.querySelector("h2")?.innerText?.trim() || "Guest";

  // Clean duplication
  const parts = guestName.split(/\s+/);
  if (parts.length === 2 && parts[0] === parts[1]) {
    guestName = parts[0];
  } else {
    // General dedupe: "Vivek Vivek" -> "Vivek"
    guestName = [...new Set(parts)].join(" ");
  }

  const data = {
    guestName,
    lastMessage,
    extractedAt: new Date().toISOString()
  };

  // CRITICAL FIX: Do NOT include 'extractedAt' in the signature check.
  // Otherwise, the timestamp changes every time, causing an infinite loop.
  const signature = JSON.stringify({ guestName, lastMessage });

  if (signature === lastMessageSignature) return;
  lastMessageSignature = signature;

  window.hostGenieContext.message = data;

  cleanupMessageUI();
  injectMessagePanel(data);

  console.log("[HostGenie] Message data extracted", data);
}

// ----------------------------------------
// UI – MESSAGE PANEL
// ----------------------------------------
function injectMessagePanel(data) {
  if (!data || !data.lastMessage) return;

  if (document.getElementById("host-genie-message-box")) return;

  const box = document.createElement("div");
  box.id = "host-genie-message-box";

  box.innerHTML = `
    <div style="padding:14px">
      <h3 style="color:#ff385c;font-size:14px">
        Host Genie – Message Insight
      </h3>
      <p><strong>Guest:</strong> ${data.guestName}</p>
      <hr style="border:0;border-top:1px solid #eee;margin:8px 0" />
      <p style="font-style:italic;color:#555">"${data.lastMessage}"</p>
    </div>
  `;

  Object.assign(box.style, {
    position: "fixed",
    top: "120px",
    right: "24px",
    width: "300px",
    background: "#fff",
    borderRadius: "12px",
    boxShadow: "0 12px 30px rgba(0,0,0,0.15)",
    zIndex: "999999",
    border: "1px solid #e5e7eb"
  });

  document.body.appendChild(box);
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
    <small style="color:#6b7280">
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
