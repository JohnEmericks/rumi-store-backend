/**
 * LLM Intent Classifier
 *
 * Fallback intent classification using GPT-4o-mini when
 * regex-based classification has low confidence.
 *
 * Use cases:
 * - Ambiguous messages
 * - Multi-intent messages
 * - Colloquial/informal language
 * - Messages the regex classifier marks as UNCLEAR
 */

const { openai } = require("./embedding");
const { INTENTS } = require("./intent-classifier");

/**
 * Threshold below which we fall back to LLM classification
 */
const CONFIDENCE_THRESHOLD = 7;

/**
 * Additional intents the LLM can detect that regex misses
 */
const EXTENDED_INTENTS = {
  ...INTENTS,
  PRICE_OBJECTION: "price_objection", // "that's expensive", "more than I wanted"
  SOFT_AFFIRMATIVE: "soft_affirmative", // "maybe", "I guess", "could work"
  SOFT_NEGATIVE: "soft_negative", // "not sure", "hmm", "I don't know"
  MULTI_INTENT: "multi_intent", // Multiple intents in one message
  OFF_TOPIC: "off_topic", // Completely unrelated to shopping
  COMPLAINT: "complaint", // Unhappy about something
  URGENCY: "urgency", // Time-sensitive request
};

/**
 * Classify intent using LLM
 *
 * @param {string} message - User's message
 * @param {Object} conversationState - Current conversation state
 * @param {string} lastAssistantMessage - Last message from assistant (for context)
 * @returns {Promise<Object>} Intent classification result
 */
async function classifyIntentWithLLM(
  message,
  conversationState = {},
  lastAssistantMessage = ""
) {
  const contextInfo = [];

  if (lastAssistantMessage) {
    contextInfo.push(
      `Assistant just said: "${lastAssistantMessage.slice(0, 200)}"`
    );
  }

  if (conversationState.lastProducts?.length > 0) {
    contextInfo.push(
      `Products discussed: ${conversationState.lastProducts
        .slice(-3)
        .join(", ")}`
    );
  }

  if (conversationState.lastQuestion) {
    contextInfo.push(
      `Last question asked: "${conversationState.lastQuestion}"`
    );
  }

  if (conversationState.turnCount) {
    contextInfo.push(`Conversation turn: ${conversationState.turnCount}`);
  }

  const contextString =
    contextInfo.length > 0
      ? `\nCONVERSATION CONTEXT:\n${contextInfo.join("\n")}`
      : "";

  const prompt = `Classify this customer message from an e-commerce chat.
${contextString}

CUSTOMER MESSAGE: "${message}"

Available intents:
- greeting: Hello, hi, hey
- browse: Want to look around, see what's available
- search: Looking for something specific
- product_info: Asking about product details
- compare: Comparing products
- price_check: Asking about price
- availability: Asking if something is in stock
- recommendation: Want suggestions
- decision_help: Need help choosing
- purchase: Ready to buy
- contact: Want contact information
- shipping: Asking about delivery
- returns: Asking about returns/refunds
- affirmative: Yes, confirming something
- negative: No, declining something
- soft_affirmative: Maybe, possibly interested
- soft_negative: Uncertain, hesitant
- price_objection: Finding something too expensive
- followup: Want more information
- thanks: Thanking
- goodbye: Leaving
- off_topic: Not related to shopping
- complaint: Unhappy about something
- urgency: Time-sensitive need
- unclear: Cannot determine intent

Respond with JSON only:
{
  "primary_intent": "intent_name",
  "secondary_intent": "intent_name_or_null",
  "confidence": 0.0-1.0,
  "entities": {
    "product_mentioned": "product name or null",
    "price_mentioned": "price or null",
    "time_constraint": "deadline or null"
  },
  "sentiment": "positive|neutral|negative|frustrated",
  "reasoning": "brief explanation"
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert at understanding customer intent in e-commerce conversations. Always respond with valid JSON only, no markdown.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 200,
    });

    const responseText = completion.choices[0]?.message?.content || "{}";

    // Parse JSON response
    let result;
    try {
      const cleanJson = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      result = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error("[LLM Intent] Failed to parse response:", responseText);
      return null;
    }

    // Map LLM intent to our intent system
    const mappedIntent = mapLLMIntent(result.primary_intent);
    const mappedSecondary = result.secondary_intent
      ? mapLLMIntent(result.secondary_intent)
      : null;

    return {
      primary: mappedIntent,
      secondary: mappedSecondary,
      confidence: Math.round((result.confidence || 0.5) * 15), // Scale to match regex scoring
      llmConfidence: result.confidence,
      entities: result.entities || {},
      sentiment: result.sentiment || "neutral",
      reasoning: result.reasoning || "",
      source: "llm",
      allMatches: [
        {
          intent: mappedIntent,
          score: Math.round((result.confidence || 0.5) * 15),
        },
      ],
      requiresContext: [
        "affirmative",
        "negative",
        "soft_affirmative",
        "soft_negative",
      ].includes(result.primary_intent),
      isTerminal: ["thanks", "goodbye"].includes(result.primary_intent),
    };
  } catch (err) {
    console.error("[LLM Intent] Classification error:", err.message);
    return null;
  }
}

/**
 * Map LLM intent names to our INTENTS constants
 */
function mapLLMIntent(llmIntent) {
  if (!llmIntent) return INTENTS.UNCLEAR;

  const intentMap = {
    greeting: INTENTS.GREETING,
    browse: INTENTS.BROWSE,
    search: INTENTS.SEARCH,
    product_info: INTENTS.PRODUCT_INFO,
    compare: INTENTS.COMPARE,
    price_check: INTENTS.PRICE_CHECK,
    availability: INTENTS.AVAILABILITY,
    recommendation: INTENTS.RECOMMENDATION,
    decision_help: INTENTS.DECISION_HELP,
    purchase: INTENTS.PURCHASE,
    contact: INTENTS.CONTACT,
    shipping: INTENTS.SHIPPING,
    returns: INTENTS.RETURNS,
    affirmative: INTENTS.AFFIRMATIVE,
    negative: INTENTS.NEGATIVE,
    soft_affirmative: INTENTS.AFFIRMATIVE, // Map to standard affirmative
    soft_negative: INTENTS.NEGATIVE, // Map to standard negative
    price_objection: INTENTS.PRICE_CHECK, // Handle in conversation state
    followup: INTENTS.FOLLOWUP,
    thanks: INTENTS.THANKS,
    goodbye: INTENTS.GOODBYE,
    off_topic: INTENTS.UNCLEAR,
    complaint: INTENTS.CONTACT, // Route complaints to contact/handoff
    urgency: INTENTS.SEARCH, // Treat urgent as search with flag
    unclear: INTENTS.UNCLEAR,
  };

  return intentMap[llmIntent.toLowerCase()] || INTENTS.UNCLEAR;
}

/**
 * Determine if we should use LLM classification
 *
 * @param {Object} regexResult - Result from regex classifier
 * @param {string} message - Original message
 * @returns {boolean}
 */
function shouldUseLLMClassifier(regexResult, message) {
  // Always use LLM for UNCLEAR intent
  if (regexResult.primary === INTENTS.UNCLEAR) {
    return true;
  }

  // Use LLM for low confidence
  if (regexResult.confidence < CONFIDENCE_THRESHOLD) {
    return true;
  }

  // Use LLM for very short ambiguous messages (could be anything)
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount <= 2 && regexResult.confidence < 10) {
    return true;
  }

  // Use LLM for messages with multiple potential intents
  if (regexResult.allMatches && regexResult.allMatches.length >= 3) {
    const topScores = regexResult.allMatches.slice(0, 3).map((m) => m.score);
    // If top 3 intents have similar scores, it's ambiguous
    if (topScores[0] - topScores[2] < 3) {
      return true;
    }
  }

  // Use LLM for longer messages that might contain multiple intents
  if (wordCount > 15 && message.includes("?") && message.includes("and")) {
    return true;
  }

  return false;
}

/**
 * Hybrid classification: try regex first, fall back to LLM if needed
 *
 * @param {string} message - User's message
 * @param {Object} conversationState - Conversation state
 * @param {function} regexClassifier - The original classifyIntent function
 * @param {string} lastAssistantMessage - Last assistant message for context
 * @returns {Promise<Object>} Classification result
 */
async function hybridClassifyIntent(
  message,
  conversationState,
  regexClassifier,
  lastAssistantMessage = ""
) {
  // First try regex classification
  const regexResult = regexClassifier(message, conversationState);

  // Check if we need LLM fallback
  if (!shouldUseLLMClassifier(regexResult, message)) {
    return {
      ...regexResult,
      source: "regex",
    };
  }

  console.log(
    `[Intent] Regex confidence ${regexResult.confidence} < ${CONFIDENCE_THRESHOLD}, trying LLM...`
  );

  // Try LLM classification
  const llmResult = await classifyIntentWithLLM(
    message,
    conversationState,
    lastAssistantMessage
  );

  if (llmResult && llmResult.confidence >= 5) {
    console.log(
      `[Intent] LLM classified as ${llmResult.primary} (confidence: ${llmResult.llmConfidence})`
    );

    // Merge useful info from both
    return {
      ...llmResult,
      regexFallback: regexResult, // Keep regex result for debugging
    };
  }

  // LLM failed or low confidence, fall back to regex
  console.log(`[Intent] LLM failed or low confidence, using regex result`);
  return {
    ...regexResult,
    source: "regex_fallback",
  };
}

/**
 * Extract additional signals from LLM classification
 * These can be used to enrich conversation state
 */
function extractSignalsFromLLMResult(llmResult) {
  if (!llmResult || llmResult.source !== "llm") {
    return {};
  }

  const signals = {};

  // Price objection signal
  if (
    llmResult.reasoning?.toLowerCase().includes("expensive") ||
    llmResult.reasoning?.toLowerCase().includes("price")
  ) {
    signals.priceObjection = true;
  }

  // Urgency signal
  if (llmResult.entities?.time_constraint) {
    signals.urgency = llmResult.entities.time_constraint;
  }

  // Sentiment signal
  if (llmResult.sentiment) {
    signals.sentiment = llmResult.sentiment;
  }

  // Product mention signal
  if (llmResult.entities?.product_mentioned) {
    signals.productMentioned = llmResult.entities.product_mentioned;
  }

  return signals;
}

module.exports = {
  classifyIntentWithLLM,
  hybridClassifyIntent,
  shouldUseLLMClassifier,
  extractSignalsFromLLMResult,
  EXTENDED_INTENTS,
  CONFIDENCE_THRESHOLD,
};
