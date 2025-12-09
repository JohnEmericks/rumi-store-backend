/**
 * Intent Classifier
 *
 * Determines what the user is trying to do based on their message
 * and conversation context.
 */

/**
 * Intent types with descriptions
 */
const INTENTS = {
  GREETING: "greeting", // "Hej", "Hello"
  BROWSE: "browse", // "What do you have?", "Show me something"
  SEARCH: "search", // "Do you have X?", "I'm looking for Y"
  PRODUCT_INFO: "product_info", // "Tell me more about this", "What's it made of?"
  COMPARE: "compare", // "What's the difference?", "Which is better?"
  PRICE_CHECK: "price_check", // "How much?", "What's the price?"
  AVAILABILITY: "availability", // "Is it in stock?", "Do you have it?"
  RECOMMENDATION: "recommendation", // "What do you recommend?", "What's good for X?"
  DECISION_HELP: "decision_help", // "Should I get this?", "Which one?"
  PURCHASE_INTENT: "purchase", // "I want to buy", "I'll take it"
  CONTACT: "contact", // "How do I reach you?", "Phone number?"
  SHIPPING: "shipping", // "Do you ship?", "Delivery time?"
  RETURNS: "returns", // "Return policy?", "Can I return?"
  AFFIRMATIVE: "affirmative", // "Yes", "Ja", "Sure", "Ok"
  NEGATIVE: "negative", // "No", "Nej", "Not that one"
  FOLLOWUP: "followup", // "Tell me more", "What else?"
  THANKS: "thanks", // "Thanks", "Tack"
  GOODBYE: "goodbye", // "Bye", "Hejdå"
  UNCLEAR: "unclear", // Can't determine intent
};

/**
 * Pattern definitions for intent matching
 * Each pattern has: keywords (array), patterns (regex array), weight (priority)
 */
const INTENT_PATTERNS = {
  [INTENTS.GREETING]: {
    keywords: {
      sv: [
        "hej",
        "hallå",
        "tjena",
        "tja",
        "hejsan",
        "goddag",
        "god morgon",
        "god kväll",
      ],
      en: [
        "hi",
        "hello",
        "hey",
        "good morning",
        "good evening",
        "good day",
        "howdy",
      ],
    },
    patterns: [
      /^(hej|hi|hello|hey|hallå|tjena|tja)[\s!.,?]*$/i,
      /^god\s*(dag|morgon|kväll|eftermiddag)/i,
      /^good\s*(morning|evening|day|afternoon)/i,
    ],
    isTerminal: true, // Doesn't need product context
  },

  [INTENTS.BROWSE]: {
    keywords: {
      sv: [
        "visa",
        "vad har ni",
        "vad finns",
        "sortiment",
        "utbud",
        "kolla",
        "titta",
      ],
      en: [
        "show me",
        "what do you have",
        "browse",
        "selection",
        "catalog",
        "look around",
      ],
    },
    patterns: [
      /visa\s*(mig|något|produkter|era)/i,
      /vad\s*(har\s*ni|finns|säljer)/i,
      /show\s*me/i,
      /what\s*(do\s*you\s*have|have\s*you\s*got)/i,
    ],
  },

  [INTENTS.SEARCH]: {
    keywords: {
      sv: ["letar", "söker", "finns det", "har ni", "behöver", "vill ha"],
      en: ["looking for", "searching", "do you have", "need", "want", "find"],
    },
    patterns: [
      /letar\s*(efter|du)/i,
      /söker\s*(efter|en|ett)?/i,
      /har\s*(ni|du|er)\s+\w+/i,
      /finns\s*(det|den|de)/i,
      /looking\s*for/i,
      /do\s*you\s*(have|sell|carry)/i,
      /i\s*(need|want)\s*(a|an|some)?/i,
    ],
  },

  [INTENTS.PRODUCT_INFO]: {
    keywords: {
      sv: [
        "berätta",
        "mer om",
        "vad är",
        "hur fungerar",
        "material",
        "storlek",
        "mått",
        "detaljer",
        "info",
      ],
      en: [
        "tell me",
        "more about",
        "what is",
        "how does",
        "material",
        "size",
        "dimensions",
        "details",
        "info",
      ],
    },
    patterns: [
      /berätta\s*(mer|om)/i,
      /vad\s*(är|innehåller)/i,
      /hur\s*(fungerar|används|gör)/i,
      /tell\s*me\s*(more|about)/i,
      /what\s*(is|are)\s*(it|this|that|they)/i,
      /how\s*(does|do)\s*(it|this|that)/i,
    ],
  },

  [INTENTS.COMPARE]: {
    keywords: {
      sv: [
        "skillnad",
        "jämför",
        "eller",
        "bättre",
        "sämre",
        "vs",
        "kontra",
        "mellan",
      ],
      en: [
        "difference",
        "compare",
        "or",
        "better",
        "worse",
        "vs",
        "versus",
        "between",
      ],
    },
    patterns: [
      /skillnad(en)?\s*(mellan|på)/i,
      /jämför/i,
      /vilken\s*(är|av)\s*(bäst|bättre)/i,
      /difference\s*(between|of)/i,
      /compare/i,
      /which\s*(one|is)\s*(better|best)/i,
      /\w+\s+(eller|or)\s+\w+/i,
    ],
  },

  [INTENTS.PRICE_CHECK]: {
    keywords: {
      sv: [
        "pris",
        "kostar",
        "kosta",
        "billig",
        "dyr",
        "budget",
        "kr",
        "kronor",
      ],
      en: [
        "price",
        "cost",
        "cheap",
        "expensive",
        "budget",
        "how much",
        "dollar",
        "euro",
      ],
    },
    patterns: [
      /vad\s*(kostar|är\s*priset)/i,
      /hur\s*mycket\s*(kostar|är)/i,
      /(pris|priset)\s*(på|för)?/i,
      /how\s*much\s*(does|is|for)/i,
      /what('s|\s*is)\s*the\s*price/i,
      /\d+\s*(kr|sek|kronor|\$|€)/i,
    ],
  },

  [INTENTS.AVAILABILITY]: {
    keywords: {
      sv: ["lager", "finns", "slut", "tillgänglig", "hemma", "har kvar"],
      en: ["stock", "available", "out of", "in stock", "have any", "left"],
    },
    patterns: [
      /finns\s*(den|det|de)?\s*(i\s*lager|kvar|hemma)/i,
      /(på|i)\s*lager/i,
      /slut\s*(på|i)/i,
      /(is|are)\s*(it|they|this)\s*(in\s*stock|available)/i,
      /do\s*you\s*have\s*(any|it)\s*(in\s*stock|left)/i,
      /out\s*of\s*stock/i,
    ],
  },

  [INTENTS.RECOMMENDATION]: {
    keywords: {
      sv: [
        "rekommenderar",
        "föreslår",
        "tips",
        "råd",
        "bäst",
        "populär",
        "passar",
        "present",
        "gåva",
      ],
      en: [
        "recommend",
        "suggest",
        "tips",
        "advice",
        "best",
        "popular",
        "suit",
        "gift",
        "present",
      ],
    },
    patterns: [
      /vad\s*(rekommenderar|föreslår|tipsar)/i,
      /kan\s*du\s*(rekommendera|föreslå|tipsa)/i,
      /vad\s*(är|passar)\s*(bäst|bra)/i,
      /what\s*(do\s*you\s*)?(recommend|suggest)/i,
      /can\s*you\s*(recommend|suggest)/i,
      /what('s|\s*is)\s*(best|good)\s*(for|if)/i,
      /looking\s*for\s*(a\s*)?(gift|present)/i,
      /present\s*(till|för|to|for)/i,
    ],
  },

  [INTENTS.DECISION_HELP]: {
    keywords: {
      sv: ["vilken", "ska jag", "borde jag", "hjälp mig välja", "bestämma"],
      en: ["which one", "should i", "help me choose", "decide", "pick"],
    },
    patterns: [
      /vilken\s*(ska|bör|borde)\s*jag/i,
      /(ska|bör|borde)\s*jag\s*(ta|köpa|välja)/i,
      /hjälp\s*mig\s*(välja|bestämma)/i,
      /which\s*(one|should)/i,
      /should\s*i\s*(get|buy|take|choose)/i,
      /help\s*me\s*(choose|decide|pick)/i,
    ],
  },

  [INTENTS.PURCHASE]: {
    keywords: {
      sv: [
        "köpa",
        "beställa",
        "ta den",
        "vill ha",
        "lägg i",
        "varukorg",
        "kassa",
      ],
      en: [
        "buy",
        "order",
        "take it",
        "want it",
        "add to",
        "cart",
        "checkout",
        "purchase",
      ],
    },
    patterns: [
      /vill\s*(köpa|beställa|ha)/i,
      /(jag)?\s*tar\s*(den|det|de)/i,
      /lägg\s*(i|till)\s*(varukorg|korg)/i,
      /hur\s*(köper|beställer)\s*jag/i,
      /i('ll|\s*will)\s*(take|buy|get)\s*(it|this|that)/i,
      /i\s*want\s*(to\s*)?(buy|order|purchase)/i,
      /add\s*to\s*(cart|basket)/i,
      /how\s*(do\s*i|can\s*i)\s*(buy|order|purchase)/i,
    ],
  },

  [INTENTS.CONTACT]: {
    keywords: {
      sv: [
        "kontakt",
        "telefon",
        "mail",
        "email",
        "adress",
        "öppettider",
        "ring",
        "nå",
      ],
      en: ["contact", "phone", "email", "address", "hours", "call", "reach"],
    },
    patterns: [
      /kontakt(a|uppgifter)?/i,
      /(telefon|mail|email|e-post)/i,
      /öppet(tider)?/i,
      /(hur|kan)\s*(jag)?\s*(nå|ringa|maila)/i,
      /contact\s*(info|details|you)?/i,
      /(phone|email)\s*(number|address)?/i,
      /opening\s*(hours|times)/i,
      /how\s*(can|do)\s*i\s*(reach|contact|call)/i,
    ],
  },

  [INTENTS.SHIPPING]: {
    keywords: {
      sv: [
        "frakt",
        "leverans",
        "skicka",
        "porto",
        "leverera",
        "skickas",
        "hämta",
      ],
      en: ["shipping", "delivery", "ship", "postage", "deliver", "pickup"],
    },
    patterns: [
      /frakt(kostnad|pris)?/i,
      /hur\s*(lång|snabb)?\s*(leverans|tid)/i,
      /kan\s*(ni|du)\s*(skicka|leverera)/i,
      /shipping\s*(cost|price|time)?/i,
      /how\s*(long|fast)\s*(is\s*)?(delivery|shipping)/i,
      /do\s*you\s*(ship|deliver)/i,
    ],
  },

  [INTENTS.RETURNS]: {
    keywords: {
      sv: [
        "retur",
        "returnera",
        "ångra",
        "ångerrätt",
        "byta",
        "garanti",
        "reklamation",
      ],
      en: [
        "return",
        "refund",
        "exchange",
        "guarantee",
        "warranty",
        "money back",
      ],
    },
    patterns: [
      /retur(nera|policy)?/i,
      /ånger(rätt)?/i,
      /kan\s*(jag)?\s*(returnera|byta|ångra)/i,
      /return\s*(policy)?/i,
      /can\s*i\s*(return|exchange|get\s*a\s*refund)/i,
      /(money\s*back|refund)/i,
    ],
  },

  [INTENTS.AFFIRMATIVE]: {
    keywords: {
      sv: [
        "ja",
        "jo",
        "japp",
        "absolut",
        "visst",
        "okej",
        "ok",
        "jag tar",
        "den",
        "det",
        "gärna",
        "bra",
        "perfekt",
        "fint",
        "toppen",
      ],
      en: [
        "yes",
        "yeah",
        "yep",
        "sure",
        "absolutely",
        "ok",
        "okay",
        "great",
        "perfect",
        "fine",
        "good",
        "sounds good",
      ],
    },
    patterns: [
      /^(ja|jo|japp|yes|yeah|yep|yup)[\s!.,]*$/i,
      /^(ok|okej|okay|sure|visst|absolut)[\s!.,]*$/i,
      /^(bra|fint|perfekt|toppen|great|perfect|fine)[\s!.,]*$/i,
      /^(gärna|tack|please)[\s!.,]*$/i,
      /^(den|det|this|that|it)[\s!.,]*$/i,
      /sounds?\s*good/i,
      /^(jag)?\s*(vill|tar)\s*(det|den|gärna)[\s!.,]*$/i,
    ],
    requiresContext: true, // Needs conversation context to be meaningful
  },

  [INTENTS.NEGATIVE]: {
    keywords: {
      sv: [
        "nej",
        "nope",
        "inte",
        "inget",
        "ingen",
        "aldrig",
        "annat",
        "annan",
        "andra",
      ],
      en: [
        "no",
        "nope",
        "not",
        "none",
        "never",
        "different",
        "other",
        "something else",
      ],
    },
    patterns: [
      /^(nej|no|nope|nah)[\s!.,]*$/i,
      /^(inte?\s*(det|den|så)|not\s*(that|this|it))[\s!.,]*$/i,
      /^(något|något)\s*annat/i,
      /something\s*(else|different)/i,
      /^(annan|annat|andra|other|another)[\s!.,]*$/i,
    ],
    requiresContext: true,
  },

  [INTENTS.FOLLOWUP]: {
    keywords: {
      sv: [
        "mer",
        "berätta mer",
        "vad mer",
        "annat",
        "fler",
        "också",
        "dessutom",
      ],
      en: [
        "more",
        "tell me more",
        "what else",
        "other",
        "also",
        "anything else",
      ],
    },
    patterns: [
      /berätta\s*mer/i,
      /vad\s*mer/i,
      /(finns|har)\s*(det|ni)\s*(mer|fler|annat)/i,
      /tell\s*me\s*more/i,
      /what\s*else/i,
      /anything\s*else/i,
      /show\s*me\s*more/i,
    ],
  },

  [INTENTS.THANKS]: {
    keywords: {
      sv: ["tack", "tackar", "uppskattar", "snällt"],
      en: ["thanks", "thank you", "appreciate", "cheers"],
    },
    patterns: [
      /^tack[\s!.,]*$/i,
      /tack\s*(så\s*mycket|för)/i,
      /^thanks?[\s!.,]*$/i,
      /thank\s*you/i,
    ],
    isTerminal: true,
  },

  [INTENTS.GOODBYE]: {
    keywords: {
      sv: ["hejdå", "adjö", "ses", "vi ses", "ha det bra"],
      en: ["bye", "goodbye", "see you", "take care", "have a nice day"],
    },
    patterns: [
      /^(hejdå|adjö|bye|goodbye)[\s!.,]*$/i,
      /^(vi)?\s*ses[\s!.,]*$/i,
      /^(ha\s*det\s*(bra|så\s*bra)|take\s*care)[\s!.,]*$/i,
      /have\s*a\s*(nice|good|great)\s*day/i,
    ],
    isTerminal: true,
  },
};

/**
 * Classify the intent of a message
 *
 * @param {string} message - The user's message
 * @param {Object} conversationState - Current conversation state
 * @returns {Object} - Intent classification result
 */
function classifyIntent(message, conversationState = {}) {
  const lowerMsg = message.toLowerCase().trim();
  const results = [];

  // Check each intent pattern
  for (const [intent, config] of Object.entries(INTENT_PATTERNS)) {
    let score = 0;

    // Check regex patterns (highest weight)
    if (config.patterns) {
      for (const pattern of config.patterns) {
        if (pattern.test(lowerMsg)) {
          score += 10;
          break; // Only count pattern match once
        }
      }
    }

    // Check keywords
    if (config.keywords) {
      const allKeywords = [
        ...(config.keywords.sv || []),
        ...(config.keywords.en || []),
      ];
      for (const keyword of allKeywords) {
        if (lowerMsg.includes(keyword)) {
          score += 3;
        }
      }
    }

    if (score > 0) {
      results.push({ intent, score, config });
    }
  }

  // Sort by score
  results.sort((a, b) => b.score - a.score);

  // Get primary intent
  let primaryIntent = results[0]?.intent || INTENTS.UNCLEAR;
  let confidence = results[0]?.score || 0;
  const secondaryIntent = results[1]?.intent || null;

  // Handle context-dependent intents
  if (
    primaryIntent === INTENTS.AFFIRMATIVE ||
    primaryIntent === INTENTS.NEGATIVE
  ) {
    if (
      !conversationState.lastQuestion &&
      !conversationState.lastProducts?.length
    ) {
      // No context, treat as unclear
      confidence = Math.min(confidence, 5);
    }
  }

  // Boost confidence if we have conversation context that matches
  if (conversationState.lastProducts?.length > 0) {
    if (
      [
        INTENTS.PRODUCT_INFO,
        INTENTS.PRICE_CHECK,
        INTENTS.PURCHASE,
        INTENTS.AFFIRMATIVE,
      ].includes(primaryIntent)
    ) {
      confidence += 3;
    }
  }

  return {
    primary: primaryIntent,
    secondary: secondaryIntent,
    confidence,
    allMatches: results.map((r) => ({ intent: r.intent, score: r.score })),
    requiresContext: INTENT_PATTERNS[primaryIntent]?.requiresContext || false,
    isTerminal: INTENT_PATTERNS[primaryIntent]?.isTerminal || false,
  };
}

/**
 * Get a human-readable description of an intent
 */
function describeIntent(intent) {
  const descriptions = {
    [INTENTS.GREETING]: "User is greeting",
    [INTENTS.BROWSE]: "User wants to browse/explore products",
    [INTENTS.SEARCH]: "User is searching for something specific",
    [INTENTS.PRODUCT_INFO]: "User wants more information about a product",
    [INTENTS.COMPARE]: "User is comparing options",
    [INTENTS.PRICE_CHECK]: "User is asking about price",
    [INTENTS.AVAILABILITY]: "User is checking availability/stock",
    [INTENTS.RECOMMENDATION]: "User wants a recommendation",
    [INTENTS.DECISION_HELP]: "User needs help deciding",
    [INTENTS.PURCHASE]: "User wants to purchase",
    [INTENTS.CONTACT]: "User wants contact information",
    [INTENTS.SHIPPING]: "User is asking about shipping/delivery",
    [INTENTS.RETURNS]: "User is asking about returns/refunds",
    [INTENTS.AFFIRMATIVE]: "User is saying yes/confirming",
    [INTENTS.NEGATIVE]: "User is saying no/declining",
    [INTENTS.FOLLOWUP]: "User wants to continue/know more",
    [INTENTS.THANKS]: "User is thanking",
    [INTENTS.GOODBYE]: "User is saying goodbye",
    [INTENTS.UNCLEAR]: "Intent unclear - needs clarification",
  };
  return descriptions[intent] || "Unknown intent";
}

module.exports = {
  INTENTS,
  classifyIntent,
  describeIntent,
};
