/**
 * Conversation State Manager
 *
 * Tracks the state of a conversation including:
 * - What products have been discussed
 * - What questions have been asked
 * - Where the user is in their journey
 * - Context for follow-up responses
 */

/**
 * Conversation journey stages
 */
const JOURNEY_STAGES = {
  EXPLORING: "exploring", // Just looking around, no specific need
  INTERESTED: "interested", // Showing interest in specific products
  COMPARING: "comparing", // Comparing multiple options
  DECIDING: "deciding", // Ready to make a decision
  READY_TO_BUY: "ready_to_buy", // Expressed purchase intent
  SEEKING_HELP: "seeking_help", // Asking for contact/support
  CLOSING: "closing", // Saying thanks/goodbye
};

/**
 * Build conversation state from history
 *
 * @param {Array} history - Conversation history [{role, content, products_shown}]
 * @param {string} currentMessage - The current user message
 * @param {Object} currentIntent - The classified intent of current message
 * @returns {Object} - Conversation state
 */
function buildConversationState(
  history = [],
  currentMessage = "",
  currentIntent = {}
) {
  const state = {
    // Journey tracking
    journeyStage: JOURNEY_STAGES.EXPLORING,
    turnCount: history.length,

    // Product context
    allProductsDiscussed: [], // All products mentioned in conversation
    lastProducts: [], // Products from the last assistant response
    lastProductMentioned: null, // Single most recent product
    productMentionCount: {}, // How many times each product was mentioned

    // Question context
    lastQuestion: null, // What did the assistant last ask?
    lastQuestionType: null, // Type of question (recommendation, comparison, etc.)
    pendingQuestion: false, // Is there an unanswered question?

    // User preferences gathered
    preferences: {
      priceRange: null, // If user mentioned budget
      interests: [], // Topics/categories user showed interest in
      forWhom: null, // Gift for someone? Personal use?
    },

    // Conversation flow
    topicsDiscussed: [], // What topics have come up
    userSentiment: "neutral", // positive, neutral, negative

    // Context for AI
    contextSummary: "", // Human-readable summary for the AI
  };

  // Process history to extract state
  let lastAssistantMessage = null;
  let lastUserMessage = null;

  for (let i = 0; i < history.length; i++) {
    const turn = history[i];

    if (turn.role === "assistant") {
      lastAssistantMessage = turn;

      // Track products shown
      if (turn.products_shown && turn.products_shown.length > 0) {
        state.lastProducts = turn.products_shown;
        state.lastProductMentioned = turn.products_shown[0];

        turn.products_shown.forEach((product) => {
          if (!state.allProductsDiscussed.includes(product)) {
            state.allProductsDiscussed.push(product);
          }
          state.productMentionCount[product] =
            (state.productMentionCount[product] || 0) + 1;
        });
      }

      // Detect if assistant asked a question
      if (
        turn.content &&
        (turn.content.includes("?") ||
          /vill du|ska jag|would you|shall i|can i/i.test(turn.content))
      ) {
        state.pendingQuestion = true;
        state.lastQuestion = extractQuestion(turn.content);
        state.lastQuestionType = detectQuestionType(turn.content);
      }
    }

    if (turn.role === "user") {
      lastUserMessage = turn;
      state.pendingQuestion = false; // User responded

      // Extract preferences from user messages
      extractPreferences(turn.content, state.preferences);

      // Track sentiment
      updateSentiment(turn.content, state);
    }
  }

  // Determine journey stage based on conversation flow and current intent
  state.journeyStage = determineJourneyStage(state, currentIntent, history);

  // Build context summary for AI
  state.contextSummary = buildContextSummary(
    state,
    lastAssistantMessage,
    currentIntent
  );

  return state;
}

/**
 * Extract the question from an assistant message
 */
function extractQuestion(message) {
  // Find sentences ending with ?
  const questions = message.match(/[^.!?]*\?/g);
  if (questions && questions.length > 0) {
    return questions[questions.length - 1].trim();
  }
  return null;
}

/**
 * Detect what type of question the assistant asked
 */
function detectQuestionType(message) {
  const lower = message.toLowerCase();

  if (/vill du (veta|se|ha)|would you (like|want)/i.test(lower)) {
    return "offer";
  }
  if (/ska jag (visa|berätta)|shall i (show|tell)/i.test(lower)) {
    return "offer";
  }
  if (/vilken|which|vad föredrar|what do you prefer/i.test(lower)) {
    return "preference";
  }
  if (/letar du efter|looking for|söker du/i.test(lower)) {
    return "need_clarification";
  }
  if (/budget|pris|price|spend/i.test(lower)) {
    return "budget";
  }
  if (/(present|gift|till någon|for someone)/i.test(lower)) {
    return "gift_inquiry";
  }

  return "general";
}

/**
 * Extract user preferences from their message
 */
function extractPreferences(message, preferences) {
  const lower = message.toLowerCase();

  // Price/budget mentions
  const priceMatch = lower.match(/(\d+)\s*(kr|kronor|sek|\$|dollar|euro|€)/i);
  if (priceMatch) {
    preferences.priceRange = {
      mentioned: parseInt(priceMatch[1]),
      currency: priceMatch[2],
    };
  }

  // Budget keywords
  if (
    /billig|cheap|budget|inte\s*för\s*dyr|not\s*too\s*expensive/i.test(lower)
  ) {
    preferences.priceRange = preferences.priceRange || {};
    preferences.priceRange.preference = "budget";
  }
  if (/exklusiv|premium|lyxig|luxury|high.?end|dyr/i.test(lower)) {
    preferences.priceRange = preferences.priceRange || {};
    preferences.priceRange.preference = "premium";
  }

  // Gift detection
  if (/present|gift|till\s*(min|en|någon)|for\s*(my|a|someone)/i.test(lower)) {
    preferences.forWhom = "gift";

    // Try to detect recipient
    const recipientMatch = lower.match(
      /till\s*(min|en)\s*(\w+)|for\s*(my|a)\s*(\w+)/i
    );
    if (recipientMatch) {
      preferences.giftRecipient = recipientMatch[2] || recipientMatch[4];
    }
  }
}

/**
 * Update sentiment based on user message
 */
function updateSentiment(message, state) {
  const lower = message.toLowerCase();

  const positiveWords = [
    "tack",
    "bra",
    "fint",
    "perfekt",
    "underbart",
    "jättebra",
    "toppen",
    "thanks",
    "great",
    "perfect",
    "wonderful",
    "love",
    "amazing",
    "excellent",
  ];
  const negativeWords = [
    "nej",
    "inte",
    "dålig",
    "fel",
    "besviken",
    "tråkig",
    "no",
    "not",
    "bad",
    "wrong",
    "disappointed",
    "boring",
  ];

  let positiveCount = positiveWords.filter((w) => lower.includes(w)).length;
  let negativeCount = negativeWords.filter((w) => lower.includes(w)).length;

  if (positiveCount > negativeCount) {
    state.userSentiment = "positive";
  } else if (negativeCount > positiveCount) {
    state.userSentiment = "negative";
  }
}

/**
 * Determine where the user is in their journey
 */
function determineJourneyStage(state, currentIntent, history) {
  const { primary: intent } = currentIntent;
  const { INTENTS } = require("./intent-classifier");

  // Direct mappings
  if (intent === INTENTS.PURCHASE) {
    return JOURNEY_STAGES.READY_TO_BUY;
  }
  if (
    intent === INTENTS.CONTACT ||
    intent === INTENTS.SHIPPING ||
    intent === INTENTS.RETURNS
  ) {
    return JOURNEY_STAGES.SEEKING_HELP;
  }
  if (intent === INTENTS.GOODBYE || intent === INTENTS.THANKS) {
    return JOURNEY_STAGES.CLOSING;
  }
  if (intent === INTENTS.COMPARE) {
    return JOURNEY_STAGES.COMPARING;
  }
  if (intent === INTENTS.DECISION_HELP) {
    return JOURNEY_STAGES.DECIDING;
  }

  // Infer from conversation flow
  if (state.allProductsDiscussed.length === 0) {
    return JOURNEY_STAGES.EXPLORING;
  }

  if (state.allProductsDiscussed.length >= 2) {
    // Multiple products discussed - likely comparing
    return JOURNEY_STAGES.COMPARING;
  }

  if (state.allProductsDiscussed.length === 1 && state.turnCount >= 3) {
    // Deep into discussing one product
    if (intent === INTENTS.PRODUCT_INFO || intent === INTENTS.PRICE_CHECK) {
      return JOURNEY_STAGES.DECIDING;
    }
  }

  if (state.allProductsDiscussed.length > 0) {
    return JOURNEY_STAGES.INTERESTED;
  }

  return JOURNEY_STAGES.EXPLORING;
}

/**
 * Build a human-readable context summary for the AI
 */
function buildContextSummary(state, lastAssistantMessage, currentIntent) {
  const parts = [];

  // What was just discussed
  if (state.lastProducts.length > 0) {
    if (state.lastProducts.length === 1) {
      parts.push(`You just showed/discussed: "${state.lastProducts[0]}"`);
    } else {
      parts.push(
        `You just showed/discussed: ${state.lastProducts
          .map((p) => `"${p}"`)
          .join(", ")}`
      );
    }
  }

  // Pending question
  if (state.lastQuestion) {
    parts.push(`Your last question was: "${state.lastQuestion}"`);
  }

  // User preferences
  if (state.preferences.priceRange) {
    const pr = state.preferences.priceRange;
    if (pr.mentioned) {
      parts.push(
        `User mentioned budget around ${pr.mentioned} ${pr.currency || "kr"}`
      );
    }
    if (pr.preference) {
      parts.push(`User prefers ${pr.preference} options`);
    }
  }

  if (state.preferences.forWhom === "gift") {
    parts.push(
      `User is looking for a gift${
        state.preferences.giftRecipient
          ? ` for their ${state.preferences.giftRecipient}`
          : ""
      }`
    );
  }

  // Journey stage context
  const stageDescriptions = {
    [JOURNEY_STAGES.EXPLORING]: "User is just browsing/exploring",
    [JOURNEY_STAGES.INTERESTED]:
      "User is showing interest in specific products",
    [JOURNEY_STAGES.COMPARING]: "User is comparing options",
    [JOURNEY_STAGES.DECIDING]: "User seems ready to decide",
    [JOURNEY_STAGES.READY_TO_BUY]: "User wants to purchase",
    [JOURNEY_STAGES.SEEKING_HELP]: "User needs help/support info",
    [JOURNEY_STAGES.CLOSING]: "Conversation is wrapping up",
  };

  if (state.journeyStage !== JOURNEY_STAGES.EXPLORING) {
    parts.push(stageDescriptions[state.journeyStage] || "");
  }

  // Current intent context
  const { INTENTS } = require("./intent-classifier");
  if (currentIntent.primary === INTENTS.AFFIRMATIVE && state.lastQuestion) {
    parts.push(`User is saying YES to your question`);
  }
  if (currentIntent.primary === INTENTS.NEGATIVE && state.lastQuestion) {
    parts.push(`User is saying NO to your question`);
  }

  return parts.filter((p) => p).join(". ") + (parts.length > 0 ? "." : "");
}

/**
 * Get follow-up context when user says "yes", "it", "that one", etc.
 */
function getFollowUpContext(state, currentIntent) {
  const { INTENTS } = require("./intent-classifier");

  const context = {
    hasContext: false,
    referringTo: null,
    action: null,
    explanation: "",
  };

  if (!state.lastProducts.length && !state.lastQuestion) {
    return context;
  }

  context.hasContext = true;

  // Determine what they're referring to
  if (state.lastProducts.length === 1) {
    context.referringTo = state.lastProducts[0];
  } else if (state.lastProducts.length > 1) {
    // Multiple products - might need clarification
    context.referringTo = state.lastProducts;
    context.needsClarification = true;
  }

  // Determine what action they want
  if (currentIntent.primary === INTENTS.AFFIRMATIVE) {
    if (state.lastQuestionType === "offer") {
      context.action = "accept_offer";
      context.explanation = `User accepted your offer regarding "${context.referringTo}"`;
    } else if (state.lastQuestionType === "preference") {
      context.action = "confirm_preference";
      context.explanation = `User confirmed preference for "${context.referringTo}"`;
    } else {
      context.action = "general_yes";
      context.explanation = `User said yes - likely about "${context.referringTo}"`;
    }
  } else if (currentIntent.primary === INTENTS.NEGATIVE) {
    context.action = "decline";
    context.explanation = `User declined - show alternatives to "${context.referringTo}"`;
  } else if (currentIntent.primary === INTENTS.PRODUCT_INFO) {
    context.action = "more_info";
    context.explanation = `User wants more info about "${context.referringTo}"`;
  } else if (currentIntent.primary === INTENTS.PURCHASE) {
    context.action = "purchase";
    context.explanation = `User wants to buy "${context.referringTo}"`;
  }

  return context;
}

module.exports = {
  JOURNEY_STAGES,
  buildConversationState,
  getFollowUpContext,
};
