/**
 * Conversation State Service
 *
 * Tracks and analyzes conversation state including:
 * - Journey stage detection
 * - Context building from history
 * - Follow-up context resolution
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
 * Determine the journey stage based on conversation history and current intent
 */
function determineJourneyStage(history, currentIntent, extractedContext) {
  const { primary } = currentIntent;
  const turnCount = Math.floor(history.length / 2);

  // Terminal stages
  if ([INTENTS.GOODBYE, INTENTS.THANKS].includes(primary)) {
    return JOURNEY_STAGES.CLOSING;
  }

  // Support/help stages
  if ([INTENTS.CONTACT, INTENTS.SHIPPING, INTENTS.RETURNS].includes(primary)) {
    return JOURNEY_STAGES.SEEKING_HELP;
  }

  // Purchase intent
  if (primary === INTENTS.PURCHASE) {
    return JOURNEY_STAGES.READY_TO_BUY;
  }

  // Comparison stage
  if (primary === INTENTS.COMPARE) {
    return JOURNEY_STAGES.COMPARING;
  }

  // Decision help
  if (primary === INTENTS.DECISION_HELP) {
    return JOURNEY_STAGES.DECIDING;
  }

  // If we have product context and they're asking about specific products
  if (
    extractedContext.lastProducts.length > 0 &&
    [INTENTS.PRODUCT_INFO, INTENTS.PRICE_CHECK, INTENTS.AVAILABILITY].includes(
      primary
    )
  ) {
    return JOURNEY_STAGES.COMPARING;
  }

  // Affirmative after product discussion suggests ready to buy
  if (
    primary === INTENTS.AFFIRMATIVE &&
    extractedContext.lastProducts.length > 0
  ) {
    return JOURNEY_STAGES.READY_TO_BUY;
  }

  // Searching or asking for recommendations with some context
  if (
    [INTENTS.SEARCH, INTENTS.RECOMMENDATION].includes(primary) &&
    turnCount >= 1
  ) {
    return extractedContext.hasExpressedNeeds
      ? JOURNEY_STAGES.DECIDING
      : JOURNEY_STAGES.INTERESTED;
  }

  // Early conversation or browsing
  if (
    turnCount < 2 ||
    [INTENTS.GREETING, INTENTS.BROWSE, INTENTS.UNCLEAR].includes(primary)
  ) {
    return JOURNEY_STAGES.EXPLORING;
  }

  // Default based on turn count
  if (turnCount >= 4) {
    return JOURNEY_STAGES.DECIDING;
  } else if (turnCount >= 2) {
    return JOURNEY_STAGES.INTERESTED;
  }

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
 * Check if user has expressed specific needs or preferences
 */
function hasExpressedNeeds(history, currentMessage) {
  const needIndicators = [
    // Swedish
    /letar efter/i,
    /söker/i,
    /behöver/i,
    /vill ha/i,
    /för (min|mitt|mina|en|ett)/i,
    /present/i,
    /budget/i,
    /passar för/i,
    // English
    /looking for/i,
    /searching/i,
    /need/i,
    /want/i,
    /for (my|a|an)/i,
    /gift/i,
    /budget/i,
    /suitable for/i,
  ];

  // Check current message
  for (const pattern of needIndicators) {
    if (pattern.test(currentMessage)) {
      return true;
    }
  }

  // Check history
  for (const msg of history) {
    if (msg.role === "user") {
      for (const pattern of needIndicators) {
        if (pattern.test(msg.content)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Build a context summary from the conversation
 */
function buildContextSummary(history, currentMessage, extractedContext) {
  const parts = [];

  if (extractedContext.lastProducts.length > 0) {
    parts.push(
      `Products discussed: ${extractedContext.lastProducts.slice(-3).join(", ")}`
    );
  }

  if (extractedContext.lastQuestion) {
    parts.push(`Last question asked: "${extractedContext.lastQuestion}"`);
  }

  if (extractedContext.hasExpressedNeeds) {
    parts.push("Customer has expressed specific needs/preferences");
  }

  const turnCount = Math.floor(history.length / 2);
  if (turnCount > 0) {
    parts.push(`Conversation turn: ${turnCount + 1}`);
  }

  return parts.length > 0 ? parts.join(" | ") : null;
}

/**
 * Build comprehensive conversation state from history and current message
 *
 * @param {Array} history - Conversation history [{role, content}, ...]
 * @param {string} currentMessage - The current user message
 * @param {Object} currentIntent - The classified intent for current message
 * @returns {Object} Conversation state object
 */
function buildConversationState(history = [], currentMessage = "", currentIntent = {}) {
  // Extract context from history
  const lastProducts = extractProductsFromHistory(history);
  const lastQuestion = extractLastQuestion(history);
  const expressedNeeds = hasExpressedNeeds(history, currentMessage);

  const extractedContext = {
    lastProducts,
    lastQuestion,
    hasExpressedNeeds: expressedNeeds,
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
        explanation: `User confirmed interest in: ${lastProducts[lastProducts.length - 1]}`,
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
      explanation: `User asking about previously mentioned product(s): ${lastProducts.slice(-2).join(", ")}`,
      type: "product_followup",
      referent: lastProducts[lastProducts.length - 1],
    };
  }

  // Check for follow-up intent
  if (primary === INTENTS.FOLLOWUP) {
    if (lastProducts.length > 0) {
      return {
        hasContext: true,
        explanation: `User wants more info after discussing: ${lastProducts.slice(-2).join(", ")}`,
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
};
