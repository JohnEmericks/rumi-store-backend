/**
 * Chat Routes (Refactored with Stage-Aware RAG)
 *
 * Smart conversational AI with:
 * - Intent classification
 * - Conversation state tracking
 * - Stage-aware RAG (doesn't retrieve products in discovery phase)
 * - Dynamic prompt building
 * - Context-aware responses
 * - Dynamic token limits based on journey stage
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const {
  openai,
  embedTexts,
  cosineSimilarity,
} = require("../services/embedding");
const {
  classifyIntent,
  INTENTS,
  describeIntent,
} = require("../services/intent-classifier");
const {
  buildConversationState,
  getFollowUpContext,
  JOURNEY_STAGES,
} = require("../services/conversation-state");
const {
  buildSystemPrompt,
  buildContextMessage,
} = require("../services/prompt-builder");
const {
  getOrCreateConversation,
  saveConversationMessage,
  getStoreDbId,
} = require("../services/conversation-tracker");
const {
  extractInsightsFromConversation,
} = require("../services/insight-extractor");
const {
  incrementConversation,
  incrementMessage,
} = require("../services/license");
const {
  hybridClassifyIntent,
  extractSignalsFromLLMResult,
} = require("../services/llm-intent-classifier");
const {
  evaluateHandoffNeed,
  getHandoffMessage,
  getSoftHandoffSuggestion,
  createHandoffTracker,
  restoreTracker,
  serializeTracker,
} = require("../services/handoff");

/**
 * Load store data from database
 */
async function loadStoreDataFromDb(storeId) {
  try {
    const storeRow = await pool.query(
      `SELECT s.id, s.store_name, s.personality, s.license_key_id,
              lk.is_active as license_active, lk.plan,
              pl.conversations_per_month as plan_limit
       FROM stores s
       LEFT JOIN license_keys lk ON s.license_key_id = lk.id
       LEFT JOIN plan_limits pl ON lk.plan = pl.plan_name
       WHERE s.store_id = $1`,
      [storeId]
    );

    if (storeRow.rowCount === 0) return null;

    const store = storeRow.rows[0];
    const storeDbId = store.id;
    const personality = store.personality || {};

    const itemsRow = await pool.query(
      "SELECT type, title, url, image_url, content, embedding, price, in_stock FROM store_items WHERE store_id = $1",
      [storeDbId]
    );

    return {
      items: itemsRow.rows.map((r) => ({
        type: r.type,
        title: r.title,
        url: r.url,
        image_url: r.image_url,
        content: r.content,
        embedding: r.embedding,
        price: r.price,
        in_stock: r.in_stock,
      })),
      storeName: store.store_name,
      personality,
      licenseKeyId: store.license_key_id,
      licenseActive: store.license_active,
      plan: store.plan,
      planLimit: store.plan_limit,
    };
  } catch (err) {
    console.error("Error loading store data:", err);
    return null;
  }
}

/**
 * Load store facts from database
 */
async function loadStoreFactsFromDb(storeId) {
  try {
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [storeId]
    );

    if (storeRow.rowCount === 0) return [];

    const storeDbId = storeRow.rows[0].id;
    const factsRow = await pool.query(
      "SELECT fact_type, key, value FROM store_facts WHERE store_id = $1",
      [storeDbId]
    );

    return factsRow.rows;
  } catch (err) {
    console.error("Error loading store facts:", err);
    return [];
  }
}

/**
 * Determine language from various sources
 */
function determineLanguage(language, personality) {
  if (language === "sv" || language === "Swedish") return "Swedish";
  if (language === "en" || language === "English") return "English";
  if (personality?.language === "sv") return "Swedish";
  if (personality?.language === "en") return "English";
  return "Swedish"; // Default
}

/**
 * NEW: Determine if we should retrieve products based on intent and journey stage
 *
 * Key principle: ALWAYS retrieve when the AI might need to recommend something.
 * The AI should NEVER make recommendations without product data - that leads to hallucinations.
 */
function shouldRetrieveProducts(currentIntent, conversationState) {
  const { primary } = currentIntent;
  const { journeyStage, turnCount } = conversationState;

  // Terminal intents - no products needed
  const terminalIntents = [INTENTS.THANKS, INTENTS.GOODBYE];
  if (terminalIntents.includes(primary)) {
    return false;
  }

  // Pure greeting with no substance - no products needed
  if (primary === INTENTS.GREETING && turnCount === 0) {
    console.log(`[RAG] Skipping - pure greeting`);
    return false;
  }

  // ALWAYS retrieve for these intents - AI needs product data to respond properly
  const alwaysRetrieveIntents = [
    INTENTS.SEARCH, // "Do you have X?"
    INTENTS.PRODUCT_INFO, // "Tell me about this"
    INTENTS.PRICE_CHECK, // "How much is X?"
    INTENTS.AVAILABILITY, // "Is X in stock?"
    INTENTS.COMPARE, // "Compare X and Y"
    INTENTS.RECOMMENDATION, // "What do you recommend?" - CRITICAL: always need products!
    INTENTS.BROWSE, // "What do you have?" - need to show actual inventory
    INTENTS.DECISION_HELP, // "Which should I get?"
    INTENTS.PURCHASE, // Ready to buy
  ];

  if (alwaysRetrieveIntents.includes(primary)) {
    console.log(`[RAG] Retrieving - ${primary} requires product data`);
    return true;
  }

  // For AFFIRMATIVE/NEGATIVE: retrieve if discussing products OR if we might need alternatives
  if (primary === INTENTS.AFFIRMATIVE || primary === INTENTS.NEGATIVE) {
    // Always retrieve for NEGATIVE - we need alternatives to suggest
    if (primary === INTENTS.NEGATIVE) {
      console.log(`[RAG] Retrieving - NEGATIVE needs alternatives`);
      return true;
    }
    const hasProductContext = conversationState.lastProducts.length > 0;
    if (hasProductContext) {
      console.log(`[RAG] Retrieving - AFFIRMATIVE with product context`);
      return true;
    }
  }

  // For CONTACT/SHIPPING/RETURNS: retrieve store info pages
  if ([INTENTS.CONTACT, INTENTS.SHIPPING, INTENTS.RETURNS].includes(primary)) {
    console.log(`[RAG] Retrieving - info intent: ${primary}`);
    return true;
  }

  // For FOLLOWUP: usually needs context
  if (primary === INTENTS.FOLLOWUP) {
    console.log(`[RAG] Retrieving - followup needs context`);
    return true;
  }

  // For UNCLEAR: retrieve so AI has something to work with
  if (primary === INTENTS.UNCLEAR && turnCount > 0) {
    console.log(`[RAG] Retrieving - UNCLEAR but not first message`);
    return true;
  }

  // Default: retrieve if past first turn (safer to have data than hallucinate)
  if (turnCount > 0) {
    console.log(`[RAG] Retrieving - default for turn ${turnCount}`);
    return true;
  }

  console.log(`[RAG] Skipping - first turn exploration`);
  return false;
}

/**
 * NEW: Get max tokens based on journey stage
 * Discovery phase needs short responses, later stages can be longer
 */
function getMaxTokensForStage(journeyStage) {
  const tokenLimits = {
    [JOURNEY_STAGES.EXPLORING]: 150, // ~40 words - KEEP IT SHORT
    [JOURNEY_STAGES.INTERESTED]: 200, // ~50 words - still concise
    [JOURNEY_STAGES.COMPARING]: 300, // ~75 words - comparisons need space
    [JOURNEY_STAGES.DECIDING]: 250, // ~60 words - clear recommendation
    [JOURNEY_STAGES.READY_TO_BUY]: 150, // ~40 words - just confirm
    [JOURNEY_STAGES.SEEKING_HELP]: 300, // ~75 words - helpful info
    [JOURNEY_STAGES.CLOSING]: 100, // ~25 words - goodbye
  };

  return tokenLimits[journeyStage] || 200;
}

/**
 * Check if we should skip RAG search for this intent
 * Only skip for pure terminal intents (short messages that are just greetings/thanks/bye)
 */
function shouldSkipRag(intent, message) {
  // Only skip RAG for these intents
  if (![INTENTS.GREETING, INTENTS.GOODBYE, INTENTS.THANKS].includes(intent)) {
    return false;
  }

  // Only skip if the message is short (pure greeting/thanks/bye)
  // If the message is longer, it likely contains more content we should process
  const wordCount = message.trim().split(/\s+/).length;
  return wordCount <= 4; // "Hej" = 1, "Hej på dig!" = 3, but "Hej, jag är ny på kristaller" = 6
}

/**
 * Get quick response for terminal intents (greetings, etc.)
 */
function getQuickResponse(intent, language, personality) {
  const tone = personality?.tone || "friendly";

  const responses = {
    [INTENTS.GREETING]: {
      Swedish: {
        friendly: [
          "Hej! 👋 Vad kan jag hjälpa dig med idag?",
          "Hejsan! Vad letar du efter?",
          "Hej! Kul att du tittar in, vad kan jag hjälpa dig hitta?",
        ],
        professional: [
          "Välkommen! Hur kan jag vara till hjälp?",
          "God dag! Vad kan jag assistera dig med?",
        ],
        casual: [
          "Tjena! 👋 Vad kan jag göra för dig?",
          "Tja! Vad letar du efter?",
        ],
        luxurious: [
          "Välkommen! Det är ett nöje att assistera dig. Vad söker du?",
          "God dag! Hur kan jag hjälpa dig idag?",
        ],
      },
      English: {
        friendly: [
          "Hey there! 👋 What can I help you find today?",
          "Hi! What are you looking for?",
          "Hello! Great to see you, what can I help with?",
        ],
        professional: [
          "Welcome! How may I assist you?",
          "Good day! What can I help you with?",
        ],
        casual: [
          "Hey! 👋 What's up? What can I do for you?",
          "Hi! What are you looking for?",
        ],
        luxurious: [
          "Welcome! It's my pleasure to assist you. What are you looking for?",
          "Good day! How may I help you today?",
        ],
      },
    },
    [INTENTS.THANKS]: {
      Swedish: {
        friendly: [
          "Så lite så! 😊 Är det något mer jag kan hjälpa dig med?",
          "Ingen orsak! Hör av dig om du har fler frågor!",
        ],
        professional: [
          "Tack själv! Tveka inte att höra av dig om du har fler frågor.",
          "Det var så lite! Finns det något mer jag kan hjälpa dig med?",
        ],
        casual: [
          "Inga problem! Säg till om det är något mer!",
          "Lugnt! Hojta till om du undrar något mer!",
        ],
        luxurious: [
          "Det är jag som tackar! Tveka inte att återkomma.",
          "Tack själv! Det har varit ett nöje att hjälpa dig.",
        ],
      },
      English: {
        friendly: [
          "You're welcome! 😊 Anything else I can help with?",
          "No problem! Let me know if you have more questions!",
        ],
        professional: [
          "You're welcome! Don't hesitate to reach out if you have more questions.",
          "My pleasure! Is there anything else I can assist you with?",
        ],
        casual: [
          "No worries! Holler if you need anything else!",
          "Sure thing! Let me know if you need more help!",
        ],
        luxurious: [
          "It's my pleasure! Don't hesitate to return anytime.",
          "You're most welcome! It's been a pleasure assisting you.",
        ],
      },
    },
    [INTENTS.GOODBYE]: {
      Swedish: {
        friendly: [
          "Hejdå! 👋 Ha en fin dag!",
          "Ha det så bra! Välkommen tillbaka!",
        ],
        professional: [
          "Tack för besöket! Ha en fortsatt trevlig dag.",
          "På återseende! Välkommen tillbaka.",
        ],
        casual: ["Ha de! 👋 Ses!", "Hejdå! Ta hand om dig!"],
        luxurious: [
          "Tack för ditt besök! Önskar dig en underbar dag.",
          "På återseende! Det har varit ett nöje.",
        ],
      },
      English: {
        friendly: [
          "Bye! 👋 Have a great day!",
          "Take care! Come back anytime!",
        ],
        professional: [
          "Thank you for visiting! Have a wonderful day.",
          "Goodbye! We look forward to seeing you again.",
        ],
        casual: ["Later! 👋 Take care!", "Bye! See ya!"],
        luxurious: [
          "Thank you for visiting! Wishing you a wonderful day.",
          "Farewell! It's been a pleasure serving you.",
        ],
      },
    },
  };

  const intentResponses = responses[intent];
  if (!intentResponses) return null;

  const langResponses = intentResponses[language];
  if (!langResponses) return null;

  const toneResponses = langResponses[tone] || langResponses.friendly;
  return toneResponses[Math.floor(Math.random() * toneResponses.length)];
}

/**
 * Find products matching a tag or name
 */
function findProductByTag(taggedName, items) {
  if (!taggedName) return null;

  const tagLower = taggedName.toLowerCase();

  // Exact match first
  let match = items.find(
    (item) =>
      item.type === "product" &&
      item.url &&
      item.image_url &&
      item.title.toLowerCase() === tagLower
  );

  // Partial match fallback
  if (!match) {
    match = items.find(
      (item) =>
        item.type === "product" &&
        item.url &&
        item.image_url &&
        (item.title.toLowerCase().includes(tagLower) ||
          tagLower.includes(item.title.toLowerCase()))
    );
  }

  return match;
}

/**
 * Main chat endpoint
 */
router.post("/chat", async (req, res) => {
  let {
    store_id,
    message,
    history = [],
    language,
    session_id,
    device_type,
  } = req.body || {};

  console.log(
    `[Chat] Request received - store_id: ${store_id}, message length: ${
      message?.length || 0
    }`
  );

  if (!store_id || !message) {
    console.log(
      `[Chat] Missing required fields - store_id: ${!!store_id}, message: ${!!message}`
    );
    return res
      .status(400)
      .json({ ok: false, error: "store_id and message are required" });
  }

  message = String(message).trim();
  if (!message) {
    return res
      .status(400)
      .json({ ok: false, error: "message cannot be empty" });
  }

  // Load store data
  const storeData = await loadStoreDataFromDb(store_id);
  const storeFacts = await loadStoreFactsFromDb(store_id);

  console.log(
    `[Chat] Store data loaded - found: ${!!storeData}, items: ${
      storeData?.items?.length || 0
    }`
  );

  if (!storeData?.items?.length) {
    console.log(`[Chat] No store data found for store_id: ${store_id}`);
    return res.status(400).json({
      ok: false,
      error: "No data found for this store. Please index the store first.",
    });
  }

  // License checks
  if (storeData.licenseKeyId) {
    if (!storeData.licenseActive) {
      return res.status(403).json({
        ok: false,
        error: "license_deactivated",
        message: "This store's license has been deactivated.",
        show_to_customer:
          "Chatten är tillfälligt otillgänglig. Vänligen försök igen senare.",
      });
    }

    if (storeData.planLimit !== null) {
      const usageResult = await pool.query(
        `SELECT conversations_used FROM usage_tracking 
         WHERE license_key_id = $1 AND period_start <= now() AND period_end > now()
         LIMIT 1`,
        [storeData.licenseKeyId]
      );

      const currentUsage = usageResult.rows[0]?.conversations_used || 0;

      if (currentUsage >= storeData.planLimit) {
        return res.status(403).json({
          ok: false,
          error: "limit_reached",
          message: `Monthly limit reached (${currentUsage}/${storeData.planLimit}).`,
          show_to_customer:
            "Chatten är tillfälligt otillgänglig. Vänligen försök igen senare.",
          upgrade_needed: true,
        });
      }
    }
  }

  // Determine language
  const userLanguage = determineLanguage(language, storeData.personality);

  // ============ GET STORE DB ID ============
  const storeDbId = await getStoreDbId(store_id);

  // ============ INTENT CLASSIFICATION (Hybrid: Regex + LLM fallback) ============
  // Build preliminary conversation state for intent classification
  const preliminaryState = buildConversationState(history, message, {});

  // Get last assistant message for context
  const lastAssistantMessage =
    history.filter((h) => h.role === "assistant").pop()?.content || "";

  // Use hybrid classifier (regex with LLM fallback)
  const currentIntent = await hybridClassifyIntent(
    message,
    preliminaryState,
    classifyIntent,
    lastAssistantMessage
  );

  // Extract additional signals from LLM classification
  const llmSignals = extractSignalsFromLLMResult(currentIntent);

  // Now build full state with intent
  const conversationState = buildConversationState(
    history,
    message,
    currentIntent
  );

  // Enrich conversation state with LLM signals
  if (llmSignals.sentiment) {
    conversationState.currentSentiment = llmSignals.sentiment;
  }
  if (llmSignals.priceObjection) {
    conversationState.priceObjection = true;
  }
  if (llmSignals.urgency) {
    conversationState.urgency = llmSignals.urgency;
  }

  const followUpContext = getFollowUpContext(conversationState, currentIntent);

  console.log(
    `[Chat] Intent: ${currentIntent.primary} (confidence: ${
      currentIntent.confidence
    }, source: ${currentIntent.source || "regex"}), Stage: ${
      conversationState.journeyStage
    }, Turn: ${conversationState.turnCount}`
  );
  if (followUpContext.hasContext) {
    console.log(`[Chat] Follow-up context:`, followUpContext.explanation);
  }

  // ============ HANDOFF TRACKING ============
  let handoffTracker = createHandoffTracker();

  // Track conversation
  let conversation = null;
  let isNewConversation = false;

  if (storeDbId && session_id) {
    const existingConv = await pool.query(
      `SELECT id, handoff_tracker FROM conversations WHERE store_id = $1 AND session_id = $2`,
      [storeDbId, session_id]
    );
    isNewConversation = existingConv.rowCount === 0;

    // Restore handoff tracker state if conversation exists
    if (!isNewConversation && existingConv.rows[0]?.handoff_tracker) {
      handoffTracker = restoreTracker(existingConv.rows[0].handoff_tracker);
    }

    conversation = await getOrCreateConversation(
      storeDbId,
      session_id,
      language,
      device_type
    );
    if (conversation) {
      await saveConversationMessage(conversation.id, "user", message, []);
    }

    if (isNewConversation && storeData.licenseKeyId) {
      await incrementConversation(storeData.licenseKeyId, storeDbId);
    }
  }

  if (storeData.licenseKeyId) {
    await incrementMessage(storeData.licenseKeyId);
  }

  // ============ HANDOFF EVALUATION ============
  // Record intent confidence for handoff tracking
  handoffTracker.recordConfidence(currentIntent.confidence);

  // Record sentiment if available
  if (currentIntent.sentiment) {
    handoffTracker.recordSentiment(currentIntent.sentiment);
  } else if (llmSignals.sentiment) {
    handoffTracker.recordSentiment(llmSignals.sentiment);
  }

  // Evaluate if handoff is needed
  const handoffEval = evaluateHandoffNeed(
    message,
    conversationState,
    currentIntent,
    handoffTracker
  );

  // If handoff is triggered, return handoff response
  if (handoffEval.needed) {
    console.log(
      `[Handoff] Triggered: ${handoffEval.reason} - ${handoffEval.message}`
    );

    const handoffResponse = getHandoffMessage(
      handoffEval.reason,
      userLanguage,
      storeFacts
    );

    // Save handoff state
    if (conversation) {
      await saveConversationMessage(
        conversation.id,
        "assistant",
        handoffResponse,
        []
      );
      await pool.query(
        `UPDATE conversations 
         SET handoff_triggered = true, 
             handoff_reason = $1,
             handoff_tracker = $2
         WHERE id = $3`,
        [
          handoffEval.reason,
          JSON.stringify(serializeTracker(handoffTracker)),
          conversation.id,
        ]
      );
    }

    return res.json({
      ok: true,
      store_id,
      answer: handoffResponse,
      product_cards: [],
      handoff: {
        triggered: true,
        reason: handoffEval.reason,
        message: handoffEval.message,
      },
      debug: {
        intent: currentIntent.primary,
        intent_confidence: currentIntent.confidence,
        intent_source: currentIntent.source || "regex",
        journey_stage: conversationState.journeyStage,
        handoff_reason: handoffEval.reason,
      },
    });
  }

  // ============ QUICK RESPONSES FOR TERMINAL INTENTS ============
  if (shouldSkipRag(currentIntent.primary, message)) {
    const quickResponse = getQuickResponse(
      currentIntent.primary,
      userLanguage,
      storeData.personality
    );

    if (quickResponse) {
      if (conversation) {
        await saveConversationMessage(
          conversation.id,
          "assistant",
          quickResponse,
          []
        );
      }

      return res.json({
        ok: true,
        store_id,
        answer: quickResponse,
        product_cards: [],
        debug: {
          intent: currentIntent.primary,
          intent_confidence: currentIntent.confidence,
          journey_stage: conversationState.journeyStage,
          quick_response: true,
        },
      });
    }
  }

  try {
    // ============ STAGE-AWARE RAG: Only retrieve if appropriate ============
    const shouldFetchProducts = shouldRetrieveProducts(
      currentIntent,
      conversationState
    );

    let relevantProducts = [];
    let relevantPages = [];
    let bestProductScore = 0;

    if (shouldFetchProducts) {
      console.log(
        `[RAG] Retrieving products/pages for query: "${message.substring(
          0,
          50
        )}..."`
      );

      const [queryVector] = await embedTexts([message]);

      // Score all items
      const scored = storeData.items
        .filter((item) => item.type !== "product" || item.in_stock !== false)
        .map((item) => ({
          item,
          score: cosineSimilarity(queryVector, item.embedding),
        }))
        .sort((a, b) => b.score - a.score);

      const scoredProducts = scored.filter((s) => s.item.type === "product");
      const scoredPages = scored.filter((s) => s.item.type === "page");

      // Context-aware boosting (boost products from ongoing conversation)
      if (conversationState.lastProducts.length > 0) {
        scoredProducts.forEach((s) => {
          if (conversationState.lastProducts.includes(s.item.title)) {
            s.score *= 1.3;
            s.boosted = true;
          }
        });
        scoredProducts.sort((a, b) => b.score - a.score);
      }

      // For info intents (CONTACT, SHIPPING, RETURNS), prioritize pages
      if (
        [INTENTS.CONTACT, INTENTS.SHIPPING, INTENTS.RETURNS].includes(
          currentIntent.primary
        )
      ) {
        relevantPages = scoredPages.slice(0, 3).filter((s) => s.score >= 0.3);
        relevantProducts = []; // Don't show products for info queries
        console.log(
          `[RAG] Info intent - retrieved ${relevantPages.length} pages, 0 products`
        );
      } else {
        // Normal product retrieval - RAISED THRESHOLD from 0.35 to 0.45
        relevantProducts = scoredProducts
          .slice(0, 8)
          .filter((s) => s.score >= 0.45);
        relevantPages = scoredPages.slice(0, 2).filter((s) => s.score >= 0.3);
        bestProductScore = scoredProducts[0]?.score || 0;
        console.log(
          `[RAG] Retrieved ${relevantProducts.length} products, ${
            relevantPages.length
          } pages (best score: ${bestProductScore.toFixed(3)})`
        );
      }
    } else {
      console.log(
        `[RAG] Skipped retrieval - discovery phase or inappropriate intent`
      );
    }

    // ============ BUILD CONTEXT & SYSTEM PROMPT ============
    let systemPrompt = buildSystemPrompt({
      storeName: storeData.storeName || "this store",
      personality: storeData.personality,
      language: userLanguage,
      conversationState,
      currentIntent,
      hasProductContext: relevantProducts.length > 0,
      hasContactInfo: storeFacts.length > 0,
    });

    // Add soft handoff suggestion if recommended but not required
    if (handoffEval.suggestHandoff && !handoffEval.needed) {
      const softSuggestion = getSoftHandoffSuggestion(userLanguage);
      systemPrompt =
        systemPrompt +
        `\n\n**Note:** Customer may benefit from human assistance. Consider naturally offering: "${softSuggestion}"`;
    }

    const messages = [{ role: "system", content: systemPrompt }];

    // Add conversation history
    const historyRows = await pool.query(
      "SELECT role, content, products_shown FROM conv_messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversation?.id]
    );

    const conversationHistory = historyRows.rows.map((row) => ({
      role: row.role,
      content: row.content,
      products_shown: row.products_shown,
    }));

    conversationHistory.forEach((turn) => {
      messages.push({ role: turn.role, content: turn.content });
    });

    // Add current user message
    messages.push({ role: "user", content: message });

    // Add context ONLY if we have products/pages
    if (
      relevantProducts.length > 0 ||
      relevantPages.length > 0 ||
      [INTENTS.CONTACT, INTENTS.SHIPPING, INTENTS.RETURNS].includes(
        currentIntent.primary
      )
    ) {
      const confidenceNote =
        bestProductScore < 0.5 && relevantProducts.length > 0
          ? "\n\n⚠️ Note: These results aren't a strong match. Be honest if nothing fits well."
          : "";

      const contextMessage = buildContextMessage({
        products: relevantProducts,
        pages: relevantPages,
        facts: storeFacts,
        conversationState,
        currentIntent,
        confidenceNote,
      });

      messages.push({ role: "user", content: contextMessage });
    }

    // ============ CALL AI WITH DYNAMIC TOKEN LIMIT ============
    const maxTokens = getMaxTokensForStage(conversationState.journeyStage);
    console.log(
      `[AI] Calling with max_tokens: ${maxTokens} (stage: ${conversationState.journeyStage})`
    );

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.6,
      max_tokens: maxTokens,
    });

    const rawAnswer =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // Extract all product tags (supports multiple: {{Product1}} {{Product2}})
    const productTagMatches = rawAnswer.match(/\{\{([^}]+)\}\}/g) || [];
    const taggedProductNames = productTagMatches.map((tag) =>
      tag.replace(/\{\{|\}\}/g, "").trim()
    );

    // Remove all tags from the displayed answer
    const answer = rawAnswer.replace(/\s*\{\{[^}]+\}\}/g, "").trim();

    // ============ PRODUCT CARD SELECTION ============
    let productCards = [];

    // Find all tagged products (max 2 cards)
    if (taggedProductNames.length > 0) {
      for (const taggedName of taggedProductNames.slice(0, 2)) {
        const matchedProduct = findProductByTag(taggedName, storeData.items);
        if (matchedProduct) {
          // Avoid duplicates
          const alreadyAdded = productCards.some(
            (p) => p.title === matchedProduct.title
          );
          if (!alreadyAdded) {
            productCards.push({
              title: matchedProduct.title,
              url: matchedProduct.url,
              image_url: matchedProduct.image_url,
              price: matchedProduct.price || null,
            });
          }
        }
      }
    }

    // Fallback: If affirmative response about a known product, show that product
    if (
      productCards.length === 0 &&
      currentIntent.primary === INTENTS.AFFIRMATIVE &&
      conversationState.lastProducts.length > 0
    ) {
      const lastProduct = findProductByTag(
        conversationState.lastProducts[0],
        storeData.items
      );
      if (lastProduct) {
        productCards = [
          {
            title: lastProduct.title,
            url: lastProduct.url,
            image_url: lastProduct.image_url,
            price: lastProduct.price || null,
          },
        ];
      }
    }

    // Fallback 2: If still no cards but AI mentioned products, try to find them in the response
    if (productCards.length === 0 && relevantProducts.length > 0) {
      const answerLower = answer.toLowerCase();

      // Look for products mentioned in the answer
      for (const item of storeData.items) {
        if (item.type !== "product") continue;
        if (!item.url || !item.image_url) continue;

        // Check if the product title appears in the answer
        const titleLower = item.title.toLowerCase();

        // For longer titles, check if they appear in the answer
        if (titleLower.length >= 8 && answerLower.includes(titleLower)) {
          productCards.push({
            title: item.title,
            url: item.url,
            image_url: item.image_url,
            price: item.price || null,
          });
          if (productCards.length >= 2) break;
        }
      }

      // If still nothing, try matching significant words from product titles
      if (productCards.length === 0) {
        for (const item of storeData.items) {
          if (item.type !== "product") continue;
          if (!item.url || !item.image_url) continue;

          // Extract significant words (4+ chars, not common words)
          const commonWords = [
            "sten",
            "stone",
            "crystal",
            "kristall",
            "stor",
            "liten",
            "lila",
            "svart",
            "vit",
            "blå",
            "rosa",
            "grön",
          ];
          const titleWords = item.title
            .toLowerCase()
            .split(/[\s\-–—\|,]+/)
            .filter((w) => w.length >= 4 && !commonWords.includes(w));

          // If any significant word from the title appears in the answer
          if (
            titleWords.length > 0 &&
            titleWords.some((w) => answerLower.includes(w))
          ) {
            productCards.push({
              title: item.title,
              url: item.url,
              image_url: item.image_url,
              price: item.price || null,
            });
            if (productCards.length >= 2) break;
          }
        }
      }
    }

    // Save assistant response
    if (conversation) {
      const productsShown = productCards.map((p) => p.title);
      await saveConversationMessage(
        conversation.id,
        "assistant",
        answer,
        productsShown
      );

      // Record uncertain response for handoff tracking
      handoffTracker.recordUncertainResponse(answer);

      // Save handoff tracker state
      await pool.query(
        `UPDATE conversations SET handoff_tracker = $1 WHERE id = $2`,
        [JSON.stringify(serializeTracker(handoffTracker)), conversation.id]
      );
    }

    return res.json({
      ok: true,
      store_id,
      answer,
      product_cards: productCards,
      debug: {
        intent: currentIntent.primary,
        intent_confidence: currentIntent.confidence,
        intent_source: currentIntent.source || "regex",
        intent_description: describeIntent(currentIntent.primary),
        journey_stage: conversationState.journeyStage,
        context_summary: conversationState.contextSummary,
        follow_up: followUpContext.hasContext
          ? followUpContext.explanation
          : null,
        rag_triggered: shouldFetchProducts,
        products_found: relevantProducts.length,
        pages_found: relevantPages.length,
        product_tags: taggedProductNames.length > 0 ? taggedProductNames : null,
        products_matched: productCards.length,
        best_score: bestProductScore.toFixed(3),
        max_tokens: maxTokens,
        handoff_risk: handoffTracker.getRiskLevel(),
        sentiment: currentIntent.sentiment || llmSignals.sentiment || null,
        top_products: relevantProducts.slice(0, 3).map((e) => ({
          title: e.item.title,
          score: e.score.toFixed(3),
          boosted: e.boosted || false,
        })),
      },
    });
  } catch (err) {
    console.error("Error in /chat:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to generate response" });
  }
});

/**
 * End conversation endpoint
 */
router.post("/end-conversation", async (req, res) => {
  const { store_id, session_id } = req.body || {};

  if (!store_id || !session_id) {
    return res
      .status(400)
      .json({ ok: false, error: "store_id and session_id are required" });
  }

  try {
    const storeDbId = await getStoreDbId(store_id);
    if (!storeDbId) {
      return res.status(404).json({ ok: false, error: "Store not found" });
    }

    const result = await pool.query(
      `UPDATE conversations 
       SET status = 'ended', ended_at = now() 
       WHERE store_id = $1 AND session_id = $2 AND status = 'active'
       RETURNING id, message_count`,
      [storeDbId, session_id]
    );

    if (result.rowCount > 0) {
      const conv = result.rows[0];
      console.log(
        `Conversation ${conv.id} ended (${conv.message_count} messages)`
      );

      // Score the conversation and extract insights asynchronously
      if (conv.message_count >= 2) {
        setImmediate(async () => {
          // Score the conversation
          try {
            const {
              scoreAndUpdateConversation,
            } = require("../services/conversation-scorer");
            const scoreResult = await scoreAndUpdateConversation(conv.id);
            if (scoreResult.success) {
              console.log(
                `Conversation ${conv.id} scored: ${scoreResult.score}/100${
                  scoreResult.flagged ? " (FLAGGED)" : ""
                }`
              );
            }
          } catch (err) {
            console.error(`Error scoring conversation ${conv.id}:`, err);
          }

          // Extract insights
          extractInsightsFromConversation(conv.id, storeDbId);
        });
      }
    }

    return res.json({ ok: true, ended: result.rowCount > 0 });
  } catch (err) {
    console.error("Error in /end-conversation:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to end conversation" });
  }
});

module.exports = router;
