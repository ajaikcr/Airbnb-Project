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

    // 1. Try Sidebar Pricing Card (Specific selected date)
    // Broaden labels to handle variations like "Last-minute price", "Base price", "Multiple prices", etc.
    const pricingLabels = ["New listing price", "Last-minute price", "Base price", "Listing price", "Standard price", "Multiple prices"];

    const candidates = [...document.querySelectorAll("div, section, aside, span")]
      .filter(el =>
        pricingLabels.some(label => el.innerText?.includes(label)) &&
        /₹\s?[\d,]+/.test(el.innerText)
      );

    // Sort by text length: smallest length = most specific container
    candidates.sort((a, b) => a.innerText.length - b.innerText.length);

    if (candidates.length > 0) {
      // The first candidate is the smallest container (likely the sidebar card)
      const container = candidates[0];
      const text = container.innerText;

      // 1. Current Price (Airbnb Price)
      // Support ranges: "₹2,445 – ₹2,574" -> we take the range string or first price
      const priceMatches = [...text.matchAll(/₹\s?([\d,]+)/g)]
        .map(m => m[1].replace(/,/g, ""));

      if (priceMatches.length > 0) {
        // If it's a range in the UI, we might want the range text or just the first number
        // For the AI context, we'll try to represent the current active price(s)
        price = parseInt(priceMatches[0], 10);

        // If it's exactly two prices and looks like a range (no strikethrough logic yet)
        // But usually, strikethrough is handled separately.
      }

      // 2. Original Price (Actual Price / Strikethrough)
      // Look for all prices. If there's a discount, the "Actual" price is usually the UN-discounted one (larger).
      // However, if it's a RANGE (₹A - ₹B), we need to be careful not to mistake ₹B for an original price of ₹A.
      const allPrices = [...text.matchAll(/₹\s?([\d,]+)/g)]
        .map(m => parseInt(m[1].replace(/,/g, ""), 10));

      if (allPrices.length > 1) {
        // Sort descending
        const uniquePrices = [...new Set(allPrices)];
        uniquePrices.sort((a, b) => b - a);

        // If there's a price significantly larger than the others, it's likely the strikethrough
        // In the user's screenshot: "₹2,445 – ₹2,574" and then a separate strikethrough "₹2,574"
        // Wait, if it's a range, "Actual" might not exist OR it might be a discount on the range.
        // If the same price appears multiple times, one might be the strikethrough.

        // Heuristic: If we find a price that is NOT part of the primary "Current Price" display
        // In Airbnb, strikethrough prices often have a specific style, but we are using text.
        if (uniquePrices[0] > price) {
          originalPrice = uniquePrices[0];
        } else if (allPrices.length > priceMatches.length) {
          // If we have more price matches than what's in the main range, the extra one is likely the discount source
          originalPrice = allPrices[allPrices.length - 1];
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

    // Enhanced DOM Detection: Look for selected dates in the grid
    // Airbnb usually marks selected dates with specific classes or ARIA attributes
    const domSelectedDates = [...document.querySelectorAll('[aria-checked="true"], [aria-selected="true"]')];
    if (domSelectedDates.length > 0) {
      // If we find selected dates in the DOM, we should ideally use them to complement the URL
      // This is complex as we need to map the DOM element back to a date string.
      // For now, let's stick to the URL and Pill as they are more reliable for parsing,
      // but we'll use the presence of DOM selection to "force" another attempt if URI is empty.
    }

    // Fallback: Try to read dates from the sidebar pill (e.g. "Dec 27 – 28")
    if (!selectedDates.length) {
      const datePill = [...document.querySelectorAll("div, button")]
        .find(el => {
          const t = el.innerText?.trim();
          // Look for pattern like "Mmm DD - Mmm DD" or "Mmm DD"
          return t && /^[a-zA-Z]{3}\s\d{1,2}/.test(t) && t.length < 20;
        });

      if (datePill) {
        selectedDates = parseDateRangeFromText(datePill.innerText.trim());
      }
    }

    // Expanded Weekend Logic: Friday (5), Saturday (6), or Sunday (0)
    const hasWeekend = selectedDates.some(d => {
      const day = new Date(d).getDay();
      return day === 0 || day === 6 || day === 5;
    });

    if (price || attempts >= MAX_ATTEMPTS) {
      clearInterval(interval);

      // 🕵️ Get Month Context for Signature
      // We run a quick pre-check to see which month we are looking at
      const tempAvailable = getAvailableDatesFromGrid(selectedDates);
      const activeMonthName = window.hostGenieContext.calendar.activeMonth || "unknown";

      const signature = JSON.stringify({
        price,
        originalPrice,
        selectedDates,
        activeMonthInfo: activeMonthName + (new Date().getMonth()) // Force refresh on scroll if month changes
      });

      if (signature === lastCalendarSignature) return;
      lastCalendarSignature = signature;

      const availableDates = tempAvailable;

      window.hostGenieContext.calendar = {
        selectedDates,
        availableDates, // NEW
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

  listingObserver = new MutationObserver((mutations) => {
    const pageType = window.hostGenieContext.pageType;

    if (pageType !== "listing" && pageType !== "listing-editor") return;

    // 🛡️ IGNORE mutations from our own UI
    const isOurUI = mutations.every(m =>
      m.target.closest?.("#host-genie-listing-box") ||
      m.target.closest?.("#host-genie-price-box") ||
      m.target.closest?.("#host-genie-message-box")
    );
    if (isOurUI) return;

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
        amenitiesCount,
        description: (data.description || "").slice(0, 20), // Include snippet of description
        locationText: (data.location?.text || data.location || "").slice(0, 20)
      });

      if (signature === lastListingSignature) return;
      lastListingSignature = signature;

      // ✅ SMART MERGE: Keep old values if new ones are null/empty
      const current = window.hostGenieContext.listing || {};
      const merged = { ...current };

      for (const [key, value] of Object.entries(data)) {
        // Only overwrite if the new value is actually useful (not null, not "Not set", and not empty)
        if (value && value !== "Not set") {
          merged[key] = value;
        }
      }

      // Special handling for amenities to avoid losing the list
      if (data.amenities && data.amenities.length > 0) {
        merged.amenities = data.amenities;
      } else {
        merged.amenities = current.amenities || [];
      }

      window.hostGenieContext.listing = merged;

      cleanupListingUI();
      injectListingPanel();

      console.log("[HostGenie] Listing data updated (Smart Merge)", window.hostGenieContext.listing);
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
    const target = label.toLowerCase();

    // 1. Try card strategy (labels in the same div area)
    const card = [...document.querySelectorAll("div")]
      .find(el => {
        const text = el.innerText?.trim() || "";
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return false;

        const firstLine = lines[0].toLowerCase();

        // Match if first line is exactly the label or starts with it
        return firstLine === target || firstLine.startsWith(target + " ") || firstLine.startsWith(target + "\n");
      });

    if (card) {
      const lines = card.innerText
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
      return lines.length > 1 ? lines.slice(1).join(" | ") : null;
    }

    // 2. Sub-page strategy (Header -> Sibling text)
    // Find a header (h1, h2, h3) or bold text that matches the label
    const headers = [...document.querySelectorAll('h1, h2, h3, div[role="heading"], strong, label')];
    const targetHeader = headers.find(el => el.innerText?.trim().toLowerCase() === target);

    if (targetHeader) {
      // Strategy A: Next sibling that has text
      let sibling = targetHeader.nextElementSibling;
      while (sibling) {
        const txt = sibling.innerText?.trim();
        if (txt && txt.length > 0 && !txt.toLowerCase().includes("add details")) {
          return txt.split("\n")[0]; // Just the first paragraph/line
        }
        sibling = sibling.nextElementSibling;
      }

      // Strategy B: Siblings of the parent (common in React)
      let parent = targetHeader.parentElement;
      let depth = 0;
      while (parent && depth < 2) {
        const textNodes = [...parent.children]
          .filter(el => el !== targetHeader && !el.contains(targetHeader))
          .map(el => el.innerText?.trim())
          .filter(txt => txt && txt.length > 5 && !txt.toLowerCase().includes(target));

        if (textNodes.length > 0) return textNodes[0].split("\n")[0];
        parent = parent.parentElement;
        depth++;
      }
    }

    return null;
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
    description: getValueByLabel("Description") || getValueByLabel("Listing description") || getValueByLabel("Your property"),
    houseRules: getValueByLabel("House rules"),
    guestSafety: getValueByLabel("Guest safety"),
    cancellationPolicy: getValueByLabel("Cancellation policy"),
    location: locObj || getValueByLabel("Location") || getValueByLabel("Where you’ll be"), // Fallback to simple text if robust fails
    aboutHost: getValueByLabel("About the host") || getValueByLabel("Host profiles"),
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
    <!-- Toggle Handle -->
    <div id="host-genie-toggle-calendar" style="
      position: absolute; left: -30px; top: 20px; 
      width: 30px; height: 40px; background: #ff385c; 
      color: white; display: flex; align-items: center; 
      justify-content: center; border-radius: 8px 0 0 8px; 
      cursor: pointer; box-shadow: -4px 0 10px rgba(0,0,0,0.1);
      font-weight: bold; font-size: 16px;
    ">
      ${isPanelMinimized ? "◀" : "▶"}
    </div>

    <div id="host-genie-content-calendar" style="padding:14px; transition: opacity 0.3s; ${isPanelMinimized ? "opacity: 0; pointer-events: none;" : ""}">
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
    right: "24px",
    width: "260px",
    background: "#fff",
    borderRadius: "12px",
    boxShadow: "0 12px 30px rgba(0,0,0,0.15)",
    zIndex: "999999",
    transform: isPanelMinimized ? "translateX(250px)" : "translateX(0)",
    transition: "transform 0.4s cubic-bezier(0.19, 1, 0.22, 1)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
  });

  document.body.appendChild(box);

  // Toggle Listener
  document.getElementById("host-genie-toggle-calendar")?.addEventListener("click", () => {
    isPanelMinimized = !isPanelMinimized;
    const box = document.getElementById("host-genie-price-box");
    const toggle = document.getElementById("host-genie-toggle-calendar");
    const content = document.getElementById("host-genie-content-calendar");

    if (box && toggle && content) {
      if (isPanelMinimized) {
        box.style.transform = "translateX(250px)";
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
    <!-- Toggle Handle -->
    <div id="host-genie-toggle-listing" style="
      position: absolute; left: -30px; top: 20px; 
      width: 30px; height: 40px; background: #ff385c; 
      color: white; display: flex; align-items: center; 
      justify-content: center; border-radius: 8px 0 0 8px; 
      cursor: pointer; box-shadow: -4px 0 10px rgba(0,0,0,0.1);
      font-weight: bold; font-size: 16px;
    ">
      ${isPanelMinimized ? "◀" : "▶"}
    </div>

    <div id="host-genie-content-listing" style="padding:14px; transition: opacity 0.3s; ${isPanelMinimized ? "opacity: 0; pointer-events: none;" : ""}">
      <h3 style="color:#ff385c;font-size:14px">
        Host Genie – Listing Insights
      </h3>

      <p><strong>Title:</strong> ${listingData.title || "Not set"}</p>
      <p><strong>Property:</strong> ${listingData.propertyType || "Not set"}</p>
      <p><strong>Guests:</strong> ${listingData.numberOfGuests || "Not set"}</p>
      <p><strong>Price:</strong> ${listingData.pricing || "Not set"}</p>
      <p><strong>Location:</strong> ${listingData.location?.text || listingData.location || "Not set"}</p>
      <div style="margin-top: 8px;">
        <label style="font-size: 11px; color: #717171; text-transform: uppercase; font-weight: bold;">Listing Description</label>
        <p style="margin: 2px 0; font-size: 12px; max-height: 60px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;">
          ${listingData.description || "Not set"}
        </p>
      </div>
      <p><strong>Amenities:</strong> ${amenitiesText}</p>
      <button id="host-genie-download-listing-btn" style="
          margin-top: 10px; padding: 8px; width: 100%; 
          background: #ff385c; color: white; border: none; 
          border-radius: 8px; cursor: pointer; font-weight: bold;
      ">Download for AI</button>
      <button id="host-genie-fill-listing-btn" style="
          margin-top: 10px; padding: 8px; width: 100%; 
          background: #222; color: white; border: none; 
          border-radius: 8px; cursor: pointer; font-weight: bold;
      ">Fill with AI</button>
      <small style="color:#6b7280; display: block; margin-top: 5px;">
        ${listingData.source}
      </small>
    </div>
  `;


  Object.assign(box.style, {
    position: "fixed",
    top: "120px",
    right: "24px",
    width: "300px",
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: "12px",
    boxShadow: "0 12px 30px rgba(0,0,0,0.15)",
    zIndex: "999999",
    transform: isPanelMinimized ? "translateX(290px)" : "translateX(0)",
    transition: "transform 0.4s cubic-bezier(0.19, 1, 0.22, 1)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
  });

  document.body.appendChild(box);

  // Toggle Listener
  document.getElementById("host-genie-toggle-listing")?.addEventListener("click", () => {
    isPanelMinimized = !isPanelMinimized;
    const box = document.getElementById("host-genie-listing-box");
    const toggle = document.getElementById("host-genie-toggle-listing");
    const content = document.getElementById("host-genie-content-listing");

    if (box && toggle && content) {
      if (isPanelMinimized) {
        box.style.transform = "translateX(290px)";
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
  document.getElementById("host-genie-download-listing-btn")?.addEventListener("click", downloadConsolidatedData);
  document.getElementById("host-genie-fill-listing-btn")?.addEventListener("click", generateAiDescription);
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
// GRID AVAILABILITY PARSER
// ----------------------------------------
function getAvailableDatesFromGrid(selectedDates = []) {
  try {
    const available = [];
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthIndexMap = {};
    monthNames.forEach((m, i) => { monthIndexMap[m] = i; monthIndexMap[m.slice(0, 3)] = i; });

    const candidates = [...document.querySelectorAll('button, [role="button"], [role="gridcell"]')];
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const currentYear = today.getFullYear();

    let activeMonth = null;
    let activeYear = currentYear;

    // 1. PRIORITY: USE SELECTED DATE AS HINT
    if (Array.isArray(selectedDates) && selectedDates.length > 0) {
      const firstDate = new Date(selectedDates[0]);
      if (!isNaN(firstDate.getTime())) {
        activeMonth = monthNames[firstDate.getMonth()];
        activeYear = firstDate.getFullYear();
        // Tag context so we can use it in signature
        window.hostGenieContext.calendar.activeMonth = `${activeMonth} ${activeYear}`;
        console.log(`[HostGenie] Target Month (from Selection): ${activeMonth} ${activeYear}`);
      }
    }

    // 2. FALLBACK: DETECT VISIBLE MONTH (Scroll-based)
    if (!activeMonth) {
      const headers = [...document.querySelectorAll('h1, h2, h3, [role="heading"]')];
      const monthHeaders = headers.filter(h => {
        const text = h.innerText?.trim() || "";
        return monthNames.some(m => text.startsWith(m)) && text.length < 25;
      });

      if (monthHeaders.length > 0) {
        // Pick the header that is most visible in the upper half of the viewport
        const visibleHeader = monthHeaders.find(h => {
          const rect = h.getBoundingClientRect();
          return rect.top >= 0 && rect.top < 500;
        }) || monthHeaders[0];

        const headerText = visibleHeader.innerText.trim();
        activeMonth = monthNames.find(m => headerText.includes(m));
        const yearMatch = headerText.match(/\d{4}/);
        if (yearMatch) activeYear = parseInt(yearMatch[0], 10);
        window.hostGenieContext.calendar.activeMonth = `${activeMonth} ${activeYear}`;
        console.log(`[HostGenie] Target Month (from Header Visibility): ${activeMonth} ${activeYear}`);
      }
    }

    candidates.forEach(el => {
      const label = el.getAttribute('aria-label') || "";
      const text = el.innerText || "";

      // Look for month in label OR text
      const monthFound = monthNames.find(m =>
        label.includes(m) || label.includes(m.slice(0, 3)) ||
        text.includes(m) || text.includes(m.slice(0, 3))
      );

      const hasNumber = /\d{1,2}/.test(label) || /\d{1,2}/.test(text);
      if (!monthFound || !hasNumber) return;

      // 1. Basic Availability checks
      const isDisabled = el.getAttribute('aria-disabled') === 'true' || el.disabled;
      const isBlocked = label.toLowerCase().includes("blocked") ||
        text.toLowerCase().includes("blocked") ||
        label.includes("Not available");

      // 2. "Grayed Out" (Past Dates or Manually Blocked)
      // Airbnb often uses low opacity or specific colors for unavailable dates
      const style = window.getComputedStyle(el);
      const isGrayed = parseFloat(style.opacity) < 0.7 ||
        style.color.includes("176, 176, 176") || // #b0b0b0
        style.backgroundColor.includes("247, 247, 247");

      if (!isDisabled && !isBlocked && !isGrayed) {
        // Parse day
        const dayMatch = label.match(/(\d{1,2})/) || text.match(/(\d{1,2})/);
        if (!dayMatch) return;

        const day = parseInt(dayMatch[1], 10);
        const monthIdx = monthIndexMap[monthFound.includes(" ") ? monthFound.split(" ")[0] : monthFound] || monthIndexMap[monthFound.slice(0, 3)];

        const yearMatch = label.match(/\d{4}/) || text.match(/\d{4}/);
        // SMART YEAR INHERITANCE: If no year in label, use activeYear (Crucial for March/Future)
        const year = yearMatch ? parseInt(yearMatch[0], 10) : activeYear;

        // 🎯 FILTER BY ACTIVE MONTH (per user request)
        if (activeMonth) {
          if (monthFound !== activeMonth || year !== activeYear) return;
        }

        const dateObj = new Date(year, monthIdx, day);

        // 3. Past Date Filter (Don't include dates before today)
        if (!isNaN(dateObj.getTime()) && dateObj >= today) {
          const y = dateObj.getFullYear();
          const m = String(dateObj.getMonth() + 1).padStart(2, '0');
          const d = String(dateObj.getDate()).padStart(2, '0');
          available.push(`${y}-${m}-${d}`);
        }
      }
    });

    return [...new Set(available)].sort();
  } catch (e) {
    console.error("[HostGenie] Error parsing grid availability", e);
    return [];
  }
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
    text += `availableDates: ${JSON.stringify(ctx.calendar.availableDates || [])}\n`;
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

    // 2. Fill the appropriate box based on page type
    if (window.hostGenieContext.pageType === "listing-editor") {
      // In the Listing Editor, we might want to fill the "Listing description" by default
      // or handle a more structured payload if the AI provides one.
      fillListingField("Listing description", reply);
    } else {
      fillAirbnbMessageBox(reply);
    }

    console.log(`[HostGenie] AI Reply received and ${window.hostGenieContext.pageType === "listing-editor" ? "listing field" : "message box"} filled`);
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

/**
 * Sends a request to the background script to generate a listing description.
 */
function generateAiDescription() {
  const context = getConsolidatedDataText();
  const promptHint = "\n\nTask: Generate a professional and engaging listing description based on the details above. Return ONLY the description text.";

  chrome.runtime.sendMessage({
    type: "ACTION_GENERATE_REPLY",
    payload: context + promptHint
  });

  console.log("[HostGenie] AI Description generation requested");
}

/**
 * Fills a specific field in the Listing Editor based on its label.
 * @param {string} labelText - The exact or partial label text (e.g., "Listing description")
 * @param {string} value - The text to fill.
 */
function fillListingField(labelText, value) {
  try {
    // 1. Find the header/label element
    const labels = [...document.querySelectorAll('h1, h2, h3, div, span, label')];
    const targetHeader = labels.find(el => el.innerText?.trim() === labelText);

    if (!targetHeader) {
      console.warn(`[HostGenie] Could not find field with label: ${labelText}`);
      // Fallback: search for any textarea if labelText is "Listing description"
      if (labelText === "Listing description") {
        const fallback = document.querySelector('textarea, [role="textbox"]');
        if (fallback) return injectText(fallback, value);
      }
      return;
    }

    // 2. Find the input element (textarea or contenteditable) nearby
    // Usually it's a sibling or inside a sibling container
    let container = targetHeader.parentElement;
    let input = null;
    let attempts = 0;

    while (container && !input && attempts < 5) {
      input = container.querySelector('textarea, [role="textbox"], [contenteditable="true"]');
      if (!input) {
        // Look in next siblings of the container
        let next = container.nextElementSibling;
        while (next && !input) {
          input = next.querySelector('textarea, [role="textbox"], [contenteditable="true"]') ||
            (next.matches('textarea, [role="textbox"]') ? next : null);
          next = next.nextElementSibling;
        }
      }
      container = container.parentElement;
      attempts++;
    }

    if (input) {
      injectText(input, value);
    } else {
      console.warn(`[HostGenie] Found label "${labelText}" but no input field nearby.`);
    }
  } catch (e) {
    console.error("[HostGenie] Error filling listing field", e);
  }
}

/**
 * Helper to inject text into an element and trigger events.
 */
function injectText(element, text) {
  element.focus();

  if (element.tagName === "TEXTAREA" || element.tagName === "INPUT") {
    element.value = text;
  } else {
    element.innerText = text;
  }

  // Trigger events for React/Airbnb state
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  // Specific React-internal value tracker update if needed
  // This is a common trick to bypass React's virtual DOM sync for native inputs
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    element.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLDivElement.prototype,
    element.tagName === "TEXTAREA" ? "value" : "innerText"
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  console.log(`[HostGenie] Injected text into ${element.tagName}`);
}

