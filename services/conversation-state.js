/**
 * Conversation State Service (IMPROVED)
 *
 * Tracks and analyzes conversation state including:
 * - Journey stage detection (now needs-based, not just turn-based!)
 * - Context building from history
 * - Follow-up context resolution
 * - Needs extraction and scoring
 *
 * Key improvement: Stage advancement is based on ACTUAL customer signals,
 * not just counting turns.
 */

const { INTENTS } = require("./intent-classifier");

/**
 * Journey stages representing where the customer is in their buying journey
 */
const JOURNEY_STAGES = {
  EXPLORING: "exploring", // Just arrived, browsing, unclear needs
  INTERESTED: "interested", // Shown interest in a category or type
  COMPARING: "comparing", // Comparing specific products
  DECIDING: "deciding", // Ready for a recommendation
  READY_TO_BUY: "ready_to_buy", // Wants to purchase
  SEEKING_HELP: "seeking_help", // Needs support (shipping, returns, etc.)
  CLOSING: "closing", // Saying goodbye, ending conversation
};

/**
 * Needs indicators with weights for scoring
 * This is used to determine if customer has expressed enough needs
 */
const NEEDS_INDICATORS = [
  // Purpose/recipient (strong)
  { pattern: /present|gift|gåva/i, weight: 2, category: "purpose" },
  {
    pattern: /for (my|a|an|the|min|mitt|mina|en|ett)\s+\w+/i,
    weight: 2,
    category: "recipient",
  },
  {
    pattern:
      /mom|mamma|dad|pappa|friend|vän|wife|fru|husband|man|girlfriend|boyfriend|partner|son|daughter|dotter|barn/i,
    weight: 2,
    category: "recipient",
  },

  // Occasion (strong)
  {
    pattern:
      /birthday|christmas|wedding|anniversary|valentine|jul|födelsedag|bröllop/i,
    weight: 2,
    category: "occasion",
  },

  // Budget (very strong)
  {
    pattern: /budget|under \d+|max \d+|around \d+|cirka \d+|ungefär \d+/i,
    weight: 3,
    category: "budget",
  },
  { pattern: /\d+\s*(kr|sek|kronor|\$|€)/i, weight: 2, category: "budget" },

  // Preferences (medium)
  {
    pattern: /colou?r|färg|size|storlek|style|stil|type|typ/i,
    weight: 1,
    category: "preference",
  },
  {
    pattern: /prefer|föredrar|like|gillar|love|älskar|want|vill/i,
    weight: 1,
    category: "preference",
  },

  // Use case (medium)
  {
    pattern: /meditation|healing|decoration|dekoration|collection|samling/i,
    weight: 2,
    category: "usecase",
  },
  {
    pattern: /beginner|nybörjare|first time|första|experienced|erfaren/i,
    weight: 2,
    category: "experience",
  },
];

const MINIMUM_NEEDS_SCORE = 3;

/**
 * Calculate needs score from conversation history
 */
function calculateNeedsScore(history, currentMessage) {
  const allUserMessages = [
    currentMessage,
    ...history.filter((m) => m.role === "user").map((m) => m.content),
  ].join(" ");

  let score = 0;
  const categories = new Set();

  for (const { pattern, weight, category } of NEEDS_INDICATORS) {
    if (pattern.test(allUserMessages)) {
      score += weight;
      categories.add(category);
    }
  }

  return {
    score,
    categories: Array.from(categories),
    sufficient: score >= MINIMUM_NEEDS_SCORE,
  };
}

/**
 * IMPROVED: Determine the journey stage based on ACTUAL customer signals
 * Not just turn count!
 *
 * Key changes:
 * - EXPLORING stays until real needs are expressed
 * - INTERESTED requires expressed needs
 * - DECIDING requires needs + product discussion
 * - Turn count is a secondary factor, not primary
 */
function determineJourneyStage(history, currentIntent, extractedContext) {
  const { primary } = currentIntent;
  const turnCount = Math.floor(history.length / 2);

  // ===== TERMINAL STAGES (always take priority) =====

  // Closing stage
  if ([INTENTS.GOODBYE, INTENTS.THANKS].includes(primary)) {
    return JOURNEY_STAGES.CLOSING;
  }

  // Support/help stage
  if ([INTENTS.CONTACT, INTENTS.SHIPPING, INTENTS.RETURNS].includes(primary)) {
    return JOURNEY_STAGES.SEEKING_HELP;
  }

  // ===== PURCHASE-RELATED STAGES =====

  // Ready to buy - explicit purchase intent
  if (primary === INTENTS.PURCHASE) {
    return JOURNEY_STAGES.READY_TO_BUY;
  }

  // Ready to buy - affirmative after product discussion
  if (
    primary === INTENTS.AFFIRMATIVE &&
    extractedContext.lastProducts.length > 0
  ) {
    return JOURNEY_STAGES.READY_TO_BUY;
  }

  // ===== PRODUCT-FOCUSED STAGES =====

  // Comparison stage - actively comparing products
  if (primary === INTENTS.COMPARE) {
    return JOURNEY_STAGES.COMPARING;
  }

  // Comparing - asking about specific products we've discussed
  if (
    extractedContext.lastProducts.length > 0 &&
    [INTENTS.PRODUCT_INFO, INTENTS.PRICE_CHECK, INTENTS.AVAILABILITY].includes(
      primary
    )
  ) {
    return JOURNEY_STAGES.COMPARING;
  }

  // Decision help - explicit request for recommendation after context
  if (primary === INTENTS.DECISION_HELP) {
    // Only go to DECIDING if we have context, otherwise stay INTERESTED
    if (
      extractedContext.hasExpressedNeeds ||
      extractedContext.lastProducts.length > 0
    ) {
      return JOURNEY_STAGES.DECIDING;
    }
    return JOURNEY_STAGES.INTERESTED;
  }

  // ===== DISCOVERY STAGES (the key improvement!) =====

  // If they're asking for recommendations, check if we have enough context
  if (primary === INTENTS.RECOMMENDATION) {
    if (extractedContext.hasExpressedNeeds && turnCount >= 2) {
      return JOURNEY_STAGES.DECIDING;
    }
    // Not enough context yet - stay in INTERESTED to gather more info
    return JOURNEY_STAGES.INTERESTED;
  }

  // If we've discussed products and they're searching for more
  if (primary === INTENTS.SEARCH && extractedContext.lastProducts.length > 0) {
    return JOURNEY_STAGES.COMPARING;
  }

  // ===== DEFAULT PROGRESSION (needs-based, not turn-based!) =====

  // EXPLORING: No needs expressed yet, OR very early conversation
  if (!extractedContext.hasExpressedNeeds || turnCount < 2) {
    return JOURNEY_STAGES.EXPLORING;
  }

  // INTERESTED: Has expressed needs but no products discussed yet
  if (
    extractedContext.hasExpressedNeeds &&
    extractedContext.lastProducts.length === 0
  ) {
    // Even with high turn count, don't jump to DECIDING without product discussion
    if (turnCount >= 4) {
      // After many turns with needs but no products, they might be ready
      return JOURNEY_STAGES.DECIDING;
    }
    return JOURNEY_STAGES.INTERESTED;
  }

  // DECIDING: Has expressed needs AND seen products
  if (
    extractedContext.hasExpressedNeeds &&
    extractedContext.lastProducts.length > 0
  ) {
    return JOURNEY_STAGES.DECIDING;
  }

  // Very high turn count override (conversation might be stuck)
  if (turnCount >= 6) {
    return extractedContext.lastProducts.length > 0
      ? JOURNEY_STAGES.DECIDING
      : JOURNEY_STAGES.INTERESTED;
  }

  // Default: stay in exploration
  return JOURNEY_STAGES.EXPLORING;
}

/**
 * Extract products mentioned in conversation history
 */
function extractProductsFromHistory(history) {
  const products = [];
  const productPattern = /\{\{([^}]+)\}\}/g;

  for (const msg of history) {
    if (msg.role === "assistant") {
      let match;
      while ((match = productPattern.exec(msg.content)) !== null) {
        const productName = match[1].trim();
        if (!products.includes(productName)) {
          products.push(productName);
        }
      }
    }
    // Also check products_shown array if available
    if (msg.products_shown && Array.isArray(msg.products_shown)) {
      for (const product of msg.products_shown) {
        if (!products.includes(product)) {
          products.push(product);
        }
      }
    }
  }

  return products;
}

/**
 * Extract the last question asked by the assistant
 */
function extractLastQuestion(history) {
  // Work backwards through history to find last assistant message with a question
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "assistant" && msg.content.includes("?")) {
      // Extract the last question from the message
      const sentences = msg.content.split(/(?<=[.!?])\s+/);
      for (let j = sentences.length - 1; j >= 0; j--) {
        if (sentences[j].includes("?")) {
          return sentences[j].trim();
        }
      }
    }
  }
  return null;
}

/**
 * IMPROVED: Check if user has expressed specific needs or preferences
 * Now uses weighted scoring for more accurate detection
 */
function hasExpressedNeeds(history, currentMessage) {
  const needsAnalysis = calculateNeedsScore(history, currentMessage);
  return needsAnalysis.sufficient;
}

/**
 * IMPROVED: Build a context summary from the conversation
 * Now includes needs categories for better AI context
 */
function buildContextSummary(history, currentMessage, extractedContext) {
  const parts = [];

  // Products discussed
  if (extractedContext.lastProducts.length > 0) {
    parts.push(
      `Products discussed: ${extractedContext.lastProducts
        .slice(-3)
        .join(", ")}`
    );
  }

  // Last question
  if (extractedContext.lastQuestion) {
    parts.push(`Last question asked: "${extractedContext.lastQuestion}"`);
  }

  // Needs status with categories
  if (extractedContext.hasExpressedNeeds) {
    const needsAnalysis = calculateNeedsScore(history, currentMessage);
    if (needsAnalysis.categories.length > 0) {
      parts.push(`Customer mentioned: ${needsAnalysis.categories.join(", ")}`);
    } else {
      parts.push("Customer has expressed specific needs/preferences");
    }
  }

  // Turn count
  const turnCount = Math.floor(history.length / 2);
  if (turnCount > 0) {
    parts.push(`Conversation turn: ${turnCount + 1}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Extract specific needs details from conversation
 * Useful for building targeted recommendations
 */
function extractNeedsDetails(history, currentMessage) {
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
    /(?:for |till |åt )?(my |min |mitt )?(mom|mamma|dad|pappa|friend|vän|wife|fru|husband|man|girlfriend|boyfriend|partner|myself|mig själv)/i
  );
  if (recipientMatch) needs.recipient = recipientMatch[0].trim();

  // Extract occasion
  const occasionMatch = allUserMessages.match(
    /(birthday|christmas|wedding|anniversary|valentine|jul|födelsedag|bröllop)/i
  );
  if (occasionMatch) needs.occasion = occasionMatch[0];

  // Extract budget
  const budgetMatch = allUserMessages.match(
    /(under|max|around|cirka|ungefär|budget)\s*\d+\s*(kr|sek|kronor|\$|€)?/i
  );
  if (budgetMatch) needs.budget = budgetMatch[0];

  // Extract use case
  const useCaseMatch = allUserMessages.match(
    /(meditation|healing|decoration|dekoration|collection|everyday|vardag)/i
  );
  if (useCaseMatch) needs.useCase = useCaseMatch[0];

  // Extract experience level
  const experienceMatch = allUserMessages.match(
    /(beginner|nybörjare|first time|första|experienced|erfaren)/i
  );
  if (experienceMatch) needs.experience = experienceMatch[0];

  return needs;
}

/**
 * Build comprehensive conversation state from history and current message
 *
 * @param {Array} history - Conversation history [{role, content}, ...]
 * @param {string} currentMessage - The current user message
 * @param {Object} currentIntent - The classified intent for current message
 * @returns {Object} Conversation state object
 */
function buildConversationState(
  history = [],
  currentMessage = "",
  currentIntent = {}
) {
  // Extract context from history
  const lastProducts = extractProductsFromHistory(history);
  const lastQuestion = extractLastQuestion(history);
  const expressedNeeds = hasExpressedNeeds(history, currentMessage);
  const needsDetails = extractNeedsDetails(history, currentMessage);
  const needsAnalysis = calculateNeedsScore(history, currentMessage);

  const extractedContext = {
    lastProducts,
    lastQuestion,
    hasExpressedNeeds: expressedNeeds,
    needsDetails,
    needsScore: needsAnalysis.score,
    needsCategories: needsAnalysis.categories,
  };

  // Determine journey stage
  const journeyStage = determineJourneyStage(
    history,
    currentIntent,
    extractedContext
  );

  // Build context summary
  const contextSummary = buildContextSummary(
    history,
    currentMessage,
    extractedContext
  );

  return {
    journeyStage,
    turnCount: Math.floor(history.length / 2),
    lastProducts,
    lastQuestion,
    hasExpressedNeeds: expressedNeeds,
    needsDetails,
    needsScore: needsAnalysis.score,
    needsCategories: needsAnalysis.categories,
    contextSummary,
    messageCount: history.length,
  };
}

/**
 * Get follow-up context when user message references previous discussion
 *
 * @param {Object} conversationState - The current conversation state
 * @param {Object} currentIntent - The classified intent
 * @returns {Object} Follow-up context with hasContext and explanation
 */
function getFollowUpContext(conversationState, currentIntent) {
  const { primary } = currentIntent;
  const { lastProducts, lastQuestion } = conversationState;

  // Check for affirmative/negative responses that need context
  if (primary === INTENTS.AFFIRMATIVE) {
    if (lastQuestion) {
      return {
        hasContext: true,
        explanation: `User said YES to: "${lastQuestion}"`,
        type: "question_response",
        referent: lastQuestion,
      };
    }
    if (lastProducts.length > 0) {
      return {
        hasContext: true,
        explanation: `User confirmed interest in: ${
          lastProducts[lastProducts.length - 1]
        }`,
        type: "product_confirmation",
        referent: lastProducts[lastProducts.length - 1],
      };
    }
  }

  if (primary === INTENTS.NEGATIVE) {
    if (lastProducts.length > 0) {
      return {
        hasContext: true,
        explanation: `User declined: ${lastProducts[lastProducts.length - 1]}`,
        type: "product_rejection",
        referent: lastProducts[lastProducts.length - 1],
      };
    }
    if (lastQuestion) {
      return {
        hasContext: true,
        explanation: `User said NO to: "${lastQuestion}"`,
        type: "question_response",
        referent: lastQuestion,
      };
    }
  }

  // Check for product info requests that reference previous products
  if (primary === INTENTS.PRODUCT_INFO && lastProducts.length > 0) {
    return {
      hasContext: true,
      explanation: `User asking about previously mentioned product(s): ${lastProducts
        .slice(-2)
        .join(", ")}`,
      type: "product_followup",
      referent: lastProducts[lastProducts.length - 1],
    };
  }

  // Check for follow-up intent
  if (primary === INTENTS.FOLLOWUP) {
    if (lastProducts.length > 0) {
      return {
        hasContext: true,
        explanation: `User wants more info after discussing: ${lastProducts
          .slice(-2)
          .join(", ")}`,
        type: "continuation",
        referent: lastProducts,
      };
    }
    return {
      hasContext: true,
      explanation: "User wants to continue the conversation",
      type: "continuation",
      referent: null,
    };
  }

  return {
    hasContext: false,
    explanation: null,
    type: null,
    referent: null,
  };
}

module.exports = {
  JOURNEY_STAGES,
  buildConversationState,
  getFollowUpContext,
  determineJourneyStage,
  extractProductsFromHistory,
  extractLastQuestion,
  hasExpressedNeeds,
  calculateNeedsScore,
  extractNeedsDetails,
  MINIMUM_NEEDS_SCORE,
};
