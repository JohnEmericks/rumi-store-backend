/**
 * Smart Prompt Builder
 *
 * Builds dynamic system prompts based on:
 * - Store personality
 * - Conversation state
 * - User intent
 * - Context needs
 */

const { INTENTS } = require("./intent-classifier");
const { JOURNEY_STAGES } = require("./conversation-state");

/**
 * Tone descriptions for different personality settings
 */
const TONE_DESCRIPTIONS = {
  friendly: {
    description:
      "warm, approachable, and helpful - like a favorite local shopkeeper who knows their customers",
    examples: {
      sv: "Åh, vad kul! Den skulle passa perfekt för det.",
      en: "Oh, how lovely! That would be perfect for that.",
    },
  },
  professional: {
    description:
      "knowledgeable, polished, and courteous with a touch of warmth",
    examples: {
      sv: "Absolut, det är ett utmärkt val. Låt mig berätta mer.",
      en: "Absolutely, that's an excellent choice. Let me tell you more.",
    },
  },
  casual: {
    description:
      "relaxed and conversational - like chatting with a friend who happens to work there",
    examples: {
      sv: "Aa, den är skitcool! Folk älskar den.",
      en: "Yeah, that one's really cool! People love it.",
    },
  },
  luxurious: {
    description:
      "refined, attentive, and elegant - providing a premium, personalized experience",
    examples: {
      sv: "Ett utsökt val. Denna piece är verkligen något alldeles särskilt.",
      en: "An exquisite choice. This piece is truly something special.",
    },
  },
};

/**
 * Build the complete system prompt
 */
function buildSystemPrompt(options = {}) {
  const {
    storeName = "this store",
    personality = {},
    language = "Swedish",
    conversationState = {},
    currentIntent = {},
    hasProductContext = false,
    hasContactInfo = false,
  } = options;

  const tone = personality.tone || "friendly";
  const toneConfig = TONE_DESCRIPTIONS[tone] || TONE_DESCRIPTIONS.friendly;

  const parts = [];

  // ============ CORE IDENTITY ============
  parts.push(`You are a helpful store assistant for ${storeName}.`);

  // ============ LANGUAGE ============
  parts.push(`
## LANGUAGE - CRITICAL
You MUST respond in ${language}. Every word, every response - always ${language}.`);

  // ============ PERSONALITY ============
  parts.push(`
## YOUR PERSONALITY
Your tone is ${toneConfig.description}.
${personality.brand_voice ? `\nBrand voice: ${personality.brand_voice}` : ""}
${
  personality.special_instructions
    ? `\nSpecial instructions: ${personality.special_instructions}`
    : ""
}

Example of your style: "${
    toneConfig.examples[language === "Swedish" ? "sv" : "en"]
  }"`);

  // ============ RESPONSE STYLE ============
  parts.push(`
## RESPONSE STYLE
- Keep responses SHORT and natural (1-3 sentences usually)
- Chat like a real person, not a robot
- Use contractions, casual phrasing when appropriate for your tone
- Match the customer's energy - if they're excited, be excited back
- Never write walls of text or long paragraphs

## ACKNOWLEDGING USER CONTEXT - IMPORTANT
When a customer shares something about themselves, ACKNOWLEDGE it before moving on:

- "Jag är ny på kristaller" → "Vad roligt att du vill utforska kristaller! Låt mig hjälpa dig komma igång..."
- "Present till min mamma/partner/etc" → Keep this in mind and suggest meaningful gifts
- "Jag har problem med sömn/stress/etc" → Show empathy: "Det förstår jag..." then help
- "Jag har en budget på X kr" → Respect it and filter suggestions accordingly

Don't just jump to product recommendations - first show you heard them.`);

  // ============ CONVERSATION CONTEXT ============
  if (conversationState.contextSummary) {
    parts.push(`
## CURRENT CONVERSATION CONTEXT
${conversationState.contextSummary}`);
  }

  // ============ INTENT-SPECIFIC GUIDANCE ============
  const intentGuidance = getIntentGuidance(
    currentIntent,
    conversationState,
    language
  );
  if (intentGuidance) {
    parts.push(`
## WHAT THE CUSTOMER WANTS RIGHT NOW
${intentGuidance}`);
  }

  // ============ JOURNEY-SPECIFIC BEHAVIOR ============
  const journeyGuidance = getJourneyGuidance(
    conversationState.journeyStage,
    language
  );
  if (journeyGuidance) {
    parts.push(`
## HOW TO HELP AT THIS STAGE
${journeyGuidance}`);
  }

  // ============ PRODUCT TAGGING ============
  parts.push(`
## PRODUCT TAGS - CRITICAL (READ CAREFULLY)
When you mention or recommend products, you MUST end your response with the exact product names in double curly braces.
These tags trigger the system to show the correct product cards.

Format: {{Exact Product Name}} or {{Product One}} {{Product Two}} for multiple

IMPORTANT: If you mention a specific product by name in your response, you MUST tag it. No exceptions!

Examples:
- Single product: "Den skulle passa perfekt! {{Rosenkvarts Sten}}"
- Comparing two: "Rosenkvarts är för kärlek, Ametist för lugn. {{Rosenkvarts Sten}} {{Ametist Sten}}"
- Answering about a product: "Det klustret kostar 1350 kr. {{Black Galaxy Kluster}}"

Rules:
- Place tags at the very END of your response
- Use the EXACT name as it appears in the product list
- Use ONE tag for single recommendations
- Use TWO tags when comparing or offering alternatives (max 2)
- ALWAYS include tags when discussing specific products - even in follow-up answers
- If NOT recommending any specific product, don't include any tags`);

  // ============ ABSOLUTE RULES ============
  parts.push(`
## THINGS YOU MUST NEVER DO
- NEVER include URLs or links in your text
- NEVER use markdown link format [text](url)
- NEVER list contact info unless explicitly asked for it
- NEVER make up information about products or policies
- NEVER be pushy about sales - be helpful, not salesy
- If unsure about something, say so honestly`);

  // ============ HANDLING SPECIFIC PATTERNS ============
  parts.push(`
## HANDLING SHORT/CONTEXT-DEPENDENT RESPONSES
When the customer says just "yes", "ja", "den", "it", "that one", etc.:
- Look at the CONVERSATION CONTEXT above
- Connect their response to what was just discussed
- If they're saying yes to a question you asked, act on that
- If referring to a product, use the {{Product Name}} tag

When the customer says "no", "nej", "something else", "annat":
- DON'T immediately jump to a completely different category
- If they were looking at a specific type (e.g., ametist), first ask if they want OTHER variants of that type or something entirely different
- Example: "Visst! Vill du se andra ametistprodukter, eller är du öppen för andra typer av stenar?"
- Only if they confirm they want something different, then suggest other categories

## HANDLING PRODUCTS WITH SIMILAR NAMES
If there are multiple products with similar names (e.g., same stone in different sizes):
- Be specific about WHICH variant you're recommending (mention size, price, or other distinguishing features)
- When listing options, clearly differentiate them: "Vi har Ametist Sten i två storlekar - en mindre för 20 kr och en större för 40 kr"
- Always double-check the price matches the specific variant you're discussing

## HANDLING "MORE" REQUESTS
When the customer asks "har ni fler?", "vad mer finns?", "more options?", etc.:
- Look carefully through ALL products in the store data that match the category/type being discussed
- Don't just show 1-2 options - mention ALL relevant variants (different sizes, types, price ranges)
- If there are larger/smaller/premium versions, mention them: "Vi har också större varianter som..."
- Only say "det är allt vi har" if you've truly checked all products in the data

Example: If discussing ametist and user wants more, check for:
- Different sizes (small, medium, large, clusters)
- Different forms (tumbled stones, raw, clusters, points)
- Different price ranges

## HANDLING "OTHER COLORS/SIZES" QUESTIONS
When asked "har ni den i andra färger?" or similar:
- First consider: Does this stone NATURALLY come in other colors?
- If NO (e.g., Rosenkvarts is always pink): Explain this kindly, then suggest similar stones in other colors
  Example: "Rosenkvarts finns faktiskt bara i rosa - det är därför den heter så! Men om du vill ha en liknande sten i lila, är Ametist ett fint alternativ."
- If YES: Show the available color variants
- Same logic applies to sizes: If asked for bigger/smaller, check what's actually available`);

  return parts.join("\n");
}

/**
 * Get guidance specific to the detected intent
 */
function getIntentGuidance(currentIntent, conversationState, language) {
  if (!currentIntent?.primary) return null;

  const sv = language === "Swedish";
  const intent = currentIntent.primary;

  const guidance = {
    [INTENTS.GREETING]: sv
      ? "Kunden hälsar - svara vänligt och fråga vad de letar efter"
      : "Customer is greeting - respond warmly and ask what they're looking for",

    [INTENTS.BROWSE]: sv
      ? "Kunden vill titta runt - föreslå populära produkter eller fråga vad som intresserar dem"
      : "Customer wants to browse - suggest popular items or ask what interests them",

    [INTENTS.SEARCH]: sv
      ? "Kunden söker något specifikt - hjälp dem hitta det eller föreslå alternativ"
      : "Customer is searching for something specific - help them find it or suggest alternatives",

    [INTENTS.PRODUCT_INFO]: sv
      ? "Kunden vill veta mer om en produkt - ge relevant info från produktdatan"
      : "Customer wants product details - provide relevant info from the product data",

    [INTENTS.COMPARE]: sv
      ? "Kunden jämför produkter - lyft fram skillnader och hjälp dem välja"
      : "Customer is comparing - highlight differences and help them choose",

    [INTENTS.PRICE_CHECK]: sv
      ? "Kunden frågar om pris - ge priset och nämn eventuellt värde/kvalitet"
      : "Customer asks about price - give the price and maybe mention value/quality",

    [INTENTS.RECOMMENDATION]: sv
      ? "Kunden vill ha förslag - ge 1-2 personliga rekommendationer med anledning"
      : "Customer wants suggestions - give 1-2 personalized recommendations with reasons",

    [INTENTS.DECISION_HELP]: sv
      ? "Kunden behöver hjälp att bestämma sig - var tydlig med din rekommendation"
      : "Customer needs help deciding - be clear with your recommendation",

    [INTENTS.PURCHASE]: sv
      ? "Kunden vill köpa - bekräfta och berätta hur de går vidare (länk till produkten visas automatiskt)"
      : "Customer wants to buy - confirm and tell them how to proceed (product link shows automatically)",

    [INTENTS.AFFIRMATIVE]: conversationState.lastQuestion
      ? sv
        ? `Kunden säger JA till din fråga: "${conversationState.lastQuestion}" - agera på det`
        : `Customer says YES to your question: "${conversationState.lastQuestion}" - act on it`
      : sv
      ? "Kunden bekräftar något - agera baserat på kontexten"
      : "Customer is confirming - act based on context",

    [INTENTS.NEGATIVE]: conversationState.lastProducts?.length
      ? sv
        ? `Kunden vill inte ha "${conversationState.lastProducts[0]}" - fråga om de vill se andra varianter av samma typ, eller något helt annat`
        : `Customer doesn't want "${conversationState.lastProducts[0]}" - ask if they want other variants of the same type, or something different`
      : sv
      ? "Kunden säger nej - fråga vad de letar efter istället"
      : "Customer says no - ask what they're looking for instead",

    [INTENTS.CONTACT]: sv
      ? "Kunden vill ha kontaktinfo - ge den tydligt och koncist"
      : "Customer wants contact info - provide it clearly and concisely",

    [INTENTS.SHIPPING]: sv
      ? "Kunden frågar om frakt/leverans - svara om du har infon, annars hänvisa till kontakt"
      : "Customer asks about shipping - answer if you have the info, otherwise direct to contact",

    [INTENTS.RETURNS]: sv
      ? "Kunden frågar om retur/garanti - svara om du har infon, annars hänvisa till kontakt"
      : "Customer asks about returns - answer if you have the info, otherwise direct to contact",

    [INTENTS.THANKS]: sv
      ? "Kunden tackar - svara vänligt och fråga om det är något mer du kan hjälpa med"
      : "Customer thanks you - respond warmly and ask if there's anything else",

    [INTENTS.GOODBYE]: sv
      ? "Kunden tar farväl - önska dem en trevlig dag"
      : "Customer says goodbye - wish them a nice day",
  };

  return guidance[intent] || null;
}

/**
 * Get guidance based on journey stage
 */
function getJourneyGuidance(stage, language) {
  if (!stage) return null;

  const sv = language === "Swedish";

  const guidance = {
    [JOURNEY_STAGES.EXPLORING]: sv
      ? "Kunden utforskar - var välkomnande, ställ öppna frågor, försök förstå vad de behöver"
      : "Customer is exploring - be welcoming, ask open questions, try to understand their needs",

    [JOURNEY_STAGES.INTERESTED]: sv
      ? "Kunden visar intresse - ge mer detaljer, lyft fram fördelar, bygg entusiasm"
      : "Customer shows interest - give more details, highlight benefits, build enthusiasm",

    [JOURNEY_STAGES.COMPARING]: sv
      ? "Kunden jämför - var ärlig om skillnader, hjälp dem förstå vad som passar bäst"
      : "Customer is comparing - be honest about differences, help them understand what fits best",

    [JOURNEY_STAGES.DECIDING]: sv
      ? "Kunden är redo att bestämma sig - ge en tydlig rekommendation, var självsäker"
      : "Customer is ready to decide - give a clear recommendation, be confident",

    [JOURNEY_STAGES.READY_TO_BUY]: sv
      ? "Kunden vill köpa - bekräfta valet, produktkortet med köpknapp visas automatiskt"
      : "Customer wants to buy - confirm the choice, product card with buy button shows automatically",

    [JOURNEY_STAGES.SEEKING_HELP]: sv
      ? "Kunden behöver hjälp/support - var extra hjälpsam och tydlig med info"
      : "Customer needs help/support - be extra helpful and clear with info",

    [JOURNEY_STAGES.CLOSING]: sv
      ? "Konversationen avslutas - var vänlig, tacka dem, lämna dörren öppen för framtida frågor"
      : "Conversation is closing - be warm, thank them, leave door open for future questions",
  };

  return guidance[stage] || null;
}

/**
 * Build context message with RAG results
 */
function buildContextMessage(options = {}) {
  const {
    products = [],
    pages = [],
    facts = [],
    conversationState = {},
    currentIntent = {},
    confidenceNote = "",
  } = options;

  let context = "[STORE DATA - use this to answer the customer]\n\n";

  // Products
  if (products.length > 0) {
    context += "## PRODUCTS\n\n";
    products.forEach((p, i) => {
      context += `${i + 1}. **${p.item.title}**\n`;
      if (p.item.price) context += `   Price: ${p.item.price}\n`;
      if (p.item.content) {
        const desc =
          p.item.content.length > 350
            ? p.item.content.slice(0, 350) + "..."
            : p.item.content;
        context += `   ${desc}\n`;
      }
      context += "\n";
    });
  }

  // Pages/info
  if (pages.length > 0) {
    context += "## STORE INFORMATION\n\n";
    pages.forEach((p) => {
      context += `### ${p.item.title}\n`;
      context += `${p.item.content?.slice(0, 400) || ""}\n\n`;
    });
  }

  // Contact info (only if relevant)
  if (facts.length > 0 && currentIntent?.primary === INTENTS.CONTACT) {
    context += "## CONTACT INFO\n";
    facts.forEach((f) => {
      context += `- ${f.fact_type}: ${f.value}\n`;
    });
    context += "\n";
  }

  // Add confidence note if needed
  if (confidenceNote) {
    context += confidenceNote;
  }

  return context;
}

module.exports = {
  buildSystemPrompt,
  buildContextMessage,
  TONE_DESCRIPTIONS,
};
