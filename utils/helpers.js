/**
 * Utility Functions
 */

const crypto = require("crypto");

/**
 * Generate a unique store ID
 */
function generateStoreId() {
  return "store_" + crypto.randomBytes(8).toString("hex");
}

/**
 * Generate an API key
 */
function generateApiKey() {
  return "rk_" + crypto.randomBytes(16).toString("hex");
}

/**
 * Analyze a user query to determine its type
 */
function analyzeQuery(message, history = [], userLanguage = "Swedish") {
  const lowerMsg = message.toLowerCase();

  // Greeting detection
  const greetingPatterns = [
    /^(hej|hallå|tjena|tja|god\s*(dag|morgon|kväll)|hi|hello|hey|good\s*(morning|evening|day))[\s!.,?]*$/i,
    /^(hejsan|tack|tack\s*så\s*mycket|thanks|thank\s*you)[\s!.,?]*$/i,
  ];
  const isGreeting = greetingPatterns.some((p) => p.test(lowerMsg));

  // Visual/product query detection
  const visualWords = [
    "visa",
    "visar",
    "titta",
    "se",
    "bild",
    "bilder",
    "kolla",
    "show",
    "see",
    "look",
    "view",
    "picture",
    "image",
    "photo",
  ];
  const isVisual = visualWords.some((w) => lowerMsg.includes(w));

  // Product query detection
  const productIndicators = [
    "produkt",
    "vara",
    "artikel",
    "köpa",
    "pris",
    "kosta",
    "product",
    "item",
    "buy",
    "purchase",
    "price",
    "cost",
    "har ni",
    "finns det",
    "do you have",
    "is there",
  ];
  const isProductQuery = productIndicators.some((w) => lowerMsg.includes(w));

  // Follow-up detection
  const followUpWords = [
    "den",
    "det",
    "denna",
    "dessa",
    "de",
    "dom",
    "mer",
    "annan",
    "annat",
    "andra",
    "fler",
    "it",
    "this",
    "that",
    "these",
    "those",
    "them",
    "more",
    "another",
    "other",
    "others",
    "ja",
    "jo",
    "nej",
    "ok",
    "okej",
    "tack",
    "bra",
    "fint",
    "perfekt",
    "jättebra",
    "yes",
    "no",
    "yeah",
    "nope",
    "sure",
    "great",
    "fine",
  ];
  const isFollowUp =
    followUpWords.some((w) => {
      const regex = new RegExp(`\\b${w}\\b`, "i");
      return regex.test(lowerMsg);
    }) && history.length > 0;

  return {
    isGreeting,
    isVisual,
    isProductQuery,
    isFollowUp,
    userLanguage,
  };
}

module.exports = {
  generateStoreId,
  generateApiKey,
  analyzeQuery,
};
