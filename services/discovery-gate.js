/**
 * Discovery Gate Service
 *
 * Enforces minimum discovery conversation before product recommendations.
 * The prompt ASKS the AI to wait and gather info first.
 * This service ENFORCES it at the architecture level.
 *
 * Philosophy: Make it structurally difficult to recommend too early,
 * not just instructionally discouraged.
 */

const { INTENTS } = require("./intent-classifier");

/**
 * Configuration - tune these values based on your needs
 */
const CONFIG = {
  // Minimum exchanges before products can be shown for general browsing
  MINIMUM_EXCHANGES_FOR_RECOMMENDATIONS: 3,

  // Minimum "needs score" before we consider discovery complete
  MINIMUM_NEEDS_SCORE: 3,

  // Intents that bypass the discovery gate (explicit product requests)
  EXPLICIT_PRODUCT_INTENTS: [
    INTENTS.PRODUCT_INFO, // "Tell me about X"
    INTENTS.PRICE_CHECK, // "How much is X?"
    INTENTS.AVAILABILITY, // "Do you have X?"
    INTENTS.PURCHASE, // "I want to buy X"
    INTENTS.COMPARE, // "Compare X and Y"
  ],

  // Intents that should NEVER trigger product recommendations
  NO_PRODUCTS_INTENTS: [
    INTENTS.GREETING,
    INTENTS.THANKS,
    INTENTS.GOODBYE,
    INTENTS.CONTACT,
    INTENTS.SHIPPING,
    INTENTS.RETURNS,
  ],
};

/**
 * Needs indicators with weights
 * Higher weight = stronger signal that customer has expressed real needs
 */
const NEEDS_INDICATORS = [
  // Purpose/recipient expressed (strong signals)
  { pattern: /present|gift|gåva/i, weight: 2, category: "purpose" },
  {
    pattern: /for (my|a|an|the|min|mitt|mina|en|ett)\s+\w+/i,
    weight: 2,
    category: "recipient",
  },
  {
    pattern:
      /mom|mamma|dad|pappa|friend|vän|wife|fru|husband|man|girlfriend|boyfriend|partner|son|daughter|dotter|barn|child/i,
    weight: 2,
    category: "recipient",
  },
  { pattern: /myself|mig själv|åt mig/i, weight: 1, category: "recipient" },

  // Occasion expressed (strong signals)
  {
    pattern:
      /birthday|christmas|wedding|anniversary|valentine|mother'?s day|father'?s day|jul|födelsedag|bröllop|årsdag|graduation|exam/i,
    weight: 2,
    category: "occasion",
  },

  // Budget expressed (very strong signal - they're serious!)
  {
    pattern:
      /budget|under \d+|max(imum)? \d+|around \d+|cirka \d+|ungefär \d+|runt \d+/i,
    weight: 3,
    category: "budget",
  },
  {
    pattern: /\d+\s*(kr|sek|kronor|\$|€|euro)/i,
    weight: 2,
    category: "budget",
  },
  {
    pattern: /cheap|billig|expensive|dyr|afford|råd/i,
    weight: 1,
    category: "budget",
  },

  // Preferences expressed (medium signals)
  {
    pattern: /colou?r|färg|size|storlek|style|stil|type|typ|sort|kind/i,
    weight: 1,
    category: "preference",
  },
  {
    pattern:
      /prefer|föredrar|like|gillar|love|älskar|want|vill ha|looking for|letar efter/i,
    weight: 1,
    category: "preference",
  },
  {
    pattern: /small|liten|big|stor|medium|large|tiny|huge/i,
    weight: 1,
    category: "preference",
  },

  // Use case expressed (medium signals)
  {
    pattern:
      /meditation|healing|decoration|dekoration|collection|samling|everyday|vardag|spiritual|andlig/i,
    weight: 2,
    category: "usecase",
  },
  {
    pattern:
      /beginner|nybörjare|first time|första gången|experienced|erfaren|advanced|expert/i,
    weight: 2,
    category: "experience",
  },
  {
    pattern:
      /home|hemma|office|kontor|bedroom|sovrum|living room|vardagsrum|garden|trädgård/i,
    weight: 1,
    category: "location",
  },

  // Specific product category mentions (they know what area they want)
  {
    pattern:
      /crystal|kristall|stone|sten|jewelry|smycke|necklace|halsband|bracelet|armband|ring/i,
    weight: 1,
    category: "category",
  },
];

/**
 * Calculate "needs score" from conversation
 * This measures how much context we've gathered about what the customer wants
 *
 * @param {Array} history - Conversation history
 * @param {string} currentMessage - Current user message
 * @returns {Object} - Score and breakdown
 */
function calculateNeedsScore(history = [], currentMessage = "") {
  const allUserMessages = [
    currentMessage,
    ...history.filter((m) => m.role === "user").map((m) => m.content),
  ].join(" ");

  let score = 0;
  const matched = [];
  const categories = new Set();

  for (const { pattern, weight, category } of NEEDS_INDICATORS) {
    if (pattern.test(allUserMessages)) {
      score += weight;
      matched.push({ pattern: pattern.source, weight, category });
      categories.add(category);
    }
  }

  return {
    score,
    matched,
    categories: Array.from(categories),
    sufficient: score >= CONFIG.MINIMUM_NEEDS_SCORE,
  };
}

/**
 * Check if discovery is complete enough to show products
 *
 * @param {Object} conversationState - Current conversation state
 * @param {Array} history - Conversation history (optional, for deeper analysis)
 * @param {string} currentMessage - Current user message (optional)
 * @returns {Object} - Discovery status
 */
function isDiscoveryComplete(
  conversationState,
  history = [],
  currentMessage = ""
) {
  const { turnCount, hasExpressedNeeds } = conversationState;

  // Calculate needs score for more granular analysis
  const needsAnalysis = calculateNeedsScore(history, currentMessage);

  // Use the better of: conversationState.hasExpressedNeeds OR our calculated score
  const needsSufficient = hasExpressedNeeds || needsAnalysis.sufficient;

  // Check 1: Minimum exchanges (hard gate)
  if (turnCount < CONFIG.MINIMUM_EXCHANGES_FOR_RECOMMENDATIONS) {
    return {
      complete: false,
      reason: "minimum_exchanges",
      message: `Only ${turnCount} exchanges (need ${CONFIG.MINIMUM_EXCHANGES_FOR_RECOMMENDATIONS})`,
      turnCount,
      needsScore: needsAnalysis.score,
      needsCategories: needsAnalysis.categories,
      needsSufficient,
    };
  }

  // Check 2: Sufficient needs expressed (soft gate - can be overridden by high turn count)
  if (!needsSufficient) {
    // After 5 turns without needs, we might be stuck - allow products but flag it
    if (turnCount >= 5) {
      return {
        complete: true,
        reason: "turn_count_override",
        message: `High turn count (${turnCount}) overrides needs requirement`,
        turnCount,
        needsScore: needsAnalysis.score,
        needsCategories: needsAnalysis.categories,
        needsSufficient: false,
        warning: "Customer hasn't expressed clear needs despite many exchanges",
      };
    }

    return {
      complete: false,
      reason: "insufficient_needs",
      message: `Needs score ${needsAnalysis.score} < ${CONFIG.MINIMUM_NEEDS_SCORE}`,
      turnCount,
      needsScore: needsAnalysis.score,
      needsCategories: needsAnalysis.categories,
      needsSufficient: false,
    };
  }

  // Discovery is complete!
  return {
    complete: true,
    reason: "discovery_complete",
    message: "Ready for recommendations",
    turnCount,
    needsScore: needsAnalysis.score,
    needsCategories: needsAnalysis.categories,
    needsSufficient: true,
  };
}

/**
 * Should we include products in the AI context?
 * This controls what the AI "sees" and can recommend from.
 *
 * @param {Object} conversationState - Current conversation state
 * @param {Object} currentIntent - Classified intent
 * @param {Array} history - Conversation history (optional)
 * @param {string} currentMessage - Current user message (optional)
 * @returns {Object} - Decision and reasoning
 */
function shouldIncludeProductsInContext(
  conversationState,
  currentIntent,
  history = [],
  currentMessage = ""
) {
  const { primary } = currentIntent;

  // NEVER include products for terminal/info intents
  if (CONFIG.NO_PRODUCTS_INTENTS.includes(primary)) {
    return {
      include: false,
      reason: "excluded_intent",
      message: `Intent ${primary} does not need products`,
    };
  }

  // ALWAYS include for explicit product requests
  // (Customer asked specifically about a product by name or wants to compare)
  if (CONFIG.EXPLICIT_PRODUCT_INTENTS.includes(primary)) {
    return {
      include: true,
      reason: "explicit_product_intent",
      message: `Intent ${primary} explicitly requests product info`,
      bypassDiscovery: true,
    };
  }

  // For general browsing/recommendations, check discovery gate
  const discovery = isDiscoveryComplete(
    conversationState,
    history,
    currentMessage
  );

  if (!discovery.complete) {
    return {
      include: false,
      reason: discovery.reason,
      message: discovery.message,
      discoveryStatus: discovery,
    };
  }

  return {
    include: true,
    reason: "discovery_complete",
    message: "Customer has expressed sufficient needs",
    discoveryStatus: discovery,
  };
}

/**
 * Should we allow product cards in the response?
 * This is the final gate before showing product cards to the user.
 *
 * @param {Object} conversationState - Current conversation state
 * @param {Object} currentIntent - Classified intent
 * @param {string} aiResponse - The AI's response text
 * @param {Array} history - Conversation history (optional)
 * @param {string} currentMessage - Current user message (optional)
 * @returns {Object} - Decision and reasoning
 */
function shouldAllowProductCards(
  conversationState,
  currentIntent,
  aiResponse,
  history = [],
  currentMessage = ""
) {
  const { primary } = currentIntent;

  // Always allow for explicit purchase/confirmation intents
  if (primary === INTENTS.PURCHASE) {
    return {
      allow: true,
      reason: "purchase_intent",
    };
  }

  // Always allow for affirmative after product discussion
  if (
    primary === INTENTS.AFFIRMATIVE &&
    conversationState.lastProducts?.length > 0
  ) {
    return {
      allow: true,
      reason: "product_confirmation",
    };
  }

  // Always allow for explicit product info requests
  if (CONFIG.EXPLICIT_PRODUCT_INTENTS.includes(primary)) {
    return {
      allow: true,
      reason: "explicit_product_intent",
    };
  }

  // Check discovery gate
  const discovery = isDiscoveryComplete(
    conversationState,
    history,
    currentMessage
  );

  if (!discovery.complete) {
    // Check if AI used product tags despite instructions
    const hasProductTags = /\{\{[^}]+\}\}/.test(aiResponse);

    if (hasProductTags) {
      console.warn(
        `[Discovery Gate] AI recommended products too early (turn ${conversationState.turnCount}, needs score ${discovery.needsScore}) - suppressing cards`
      );
      return {
        allow: false,
        reason: "discovery_incomplete",
        suppressCards: true,
        message: `Suppressing premature recommendation: ${discovery.message}`,
        discoveryStatus: discovery,
      };
    }

    // No product tags, so nothing to suppress
    return {
      allow: true,
      reason: "no_products_in_response",
    };
  }

  return {
    allow: true,
    reason: "discovery_complete",
    discoveryStatus: discovery,
  };
}

/**
 * Strip product tags from AI response if needed
 * Use this when suppressing premature recommendations
 *
 * @param {string} response - AI response text
 * @returns {string} - Response with product tags removed
 */
function stripProductTags(response) {
  return response.replace(/\s*\{\{[^}]+\}\}/g, "").trim();
}

/**
 * Extract and summarize what needs have been expressed
 * Useful for building context summary for the AI
 *
 * @param {Array} history - Conversation history
 * @param {string} currentMessage - Current user message
 * @returns {Object} - Extracted needs summary
 */
function extractExpressedNeeds(history = [], currentMessage = "") {
  const allUserMessages = [
    currentMessage,
    ...history.filter((m) => m.role === "user").map((m) => m.content),
  ].join(" ");

  const needs = {
    recipient: null,
    occasion: null,
    budget: null,
    preferences: [],
    useCase: null,
    experience: null,
  };

  // Extract recipient
  const recipientMatch = allUserMessages.match(
    /(?:for |till |åt )?(my |min |mitt |mina )?(mom|mamma|dad|pappa|friend|vän|wife|fru|husband|man|girlfriend|boyfriend|partner|myself|mig själv|son|daughter|dotter|barn)/i
  );
  if (recipientMatch) needs.recipient = recipientMatch[0].trim();

  // Extract occasion
  const occasionMatch = allUserMessages.match(
    /(birthday|christmas|wedding|anniversary|valentine|mother'?s day|father'?s day|jul|födelsedag|bröllop|årsdag|graduation)/i
  );
  if (occasionMatch) needs.occasion = occasionMatch[0];

  // Extract budget
  const budgetMatch = allUserMessages.match(
    /(under|max|around|cirka|ungefär|budget|runt)\s*\d+\s*(kr|sek|kronor|\$|€)?/i
  );
  if (budgetMatch) needs.budget = budgetMatch[0];

  // Extract use case
  const useCaseMatch = allUserMessages.match(
    /(meditation|healing|decoration|dekoration|collection|samling|everyday|vardag|spiritual|andlig)/i
  );
  if (useCaseMatch) needs.useCase = useCaseMatch[0];

  // Extract experience level
  const experienceMatch = allUserMessages.match(
    /(beginner|nybörjare|first time|första|new to|ny på|experienced|erfaren|advanced)/i
  );
  if (experienceMatch) needs.experience = experienceMatch[0];

  return needs;
}

/**
 * Get a prompt addition explaining the discovery status
 * Use this to help the AI understand where we are in discovery
 *
 * @param {Object} discoveryStatus - Result from isDiscoveryComplete
 * @param {string} language - 'Swedish' or 'English'
 * @returns {string} - Prompt addition
 */
function getDiscoveryPromptAddition(discoveryStatus, language = "Swedish") {
  if (discoveryStatus.complete) {
    // Discovery complete - no need for additional prompting
    return "";
  }

  const sv = language === "Swedish";

  if (discoveryStatus.reason === "minimum_exchanges") {
    return sv
      ? `\n\n⚠️ VIKTIGT: Du har bara haft ${discoveryStatus.turnCount} utbyte(n). Ha minst ${CONFIG.MINIMUM_EXCHANGES_FOR_RECOMMENDATIONS} utbyten innan du rekommenderar produkter. Ställ fler frågor för att förstå kundens behov!`
      : `\n\n⚠️ IMPORTANT: You've only had ${discoveryStatus.turnCount} exchange(s). Have at least ${CONFIG.MINIMUM_EXCHANGES_FOR_RECOMMENDATIONS} exchanges before recommending products. Ask more questions to understand the customer's needs!`;
  }

  if (discoveryStatus.reason === "insufficient_needs") {
    const missingInfo = [];
    if (!discoveryStatus.needsCategories.includes("recipient")) {
      missingInfo.push(sv ? "vem produkten är till" : "who the product is for");
    }
    if (!discoveryStatus.needsCategories.includes("occasion")) {
      missingInfo.push(sv ? "tillfälle/anledning" : "occasion/reason");
    }
    if (!discoveryStatus.needsCategories.includes("budget")) {
      missingInfo.push(sv ? "budget" : "budget");
    }
    if (!discoveryStatus.needsCategories.includes("preference")) {
      missingInfo.push(sv ? "preferenser/stil" : "preferences/style");
    }

    const missing = missingInfo.slice(0, 2).join(sv ? " eller " : " or ");

    return sv
      ? `\n\n⚠️ VIKTIGT: Du vet inte tillräckligt om kundens behov ännu. Fråga om: ${missing}. REKOMMENDERA INGA PRODUKTER ÄNNU - ställ frågor istället!`
      : `\n\n⚠️ IMPORTANT: You don't know enough about the customer's needs yet. Ask about: ${missing}. DO NOT RECOMMEND PRODUCTS YET - ask questions instead!`;
  }

  return "";
}

module.exports = {
  // Main functions
  isDiscoveryComplete,
  shouldIncludeProductsInContext,
  shouldAllowProductCards,

  // Helper functions
  calculateNeedsScore,
  extractExpressedNeeds,
  getDiscoveryPromptAddition,
  stripProductTags,

  // Configuration (exported for testing/tuning)
  CONFIG,
  NEEDS_INDICATORS,
};
