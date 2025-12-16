/**
 * Chat Routes (Refactored)
 *
 * Smart conversational AI with:
 * - Intent classification
 * - Conversation state tracking
 * - Dynamic prompt building
 * - Context-aware responses
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

  // ============ INTENT CLASSIFICATION ============
  // Build preliminary conversation state for intent classification
  const preliminaryState = buildConversationState(history, message, {});
  const currentIntent = classifyIntent(message, preliminaryState);

  // Now build full state with intent
  const conversationState = buildConversationState(
    history,
    message,
    currentIntent
  );
  const followUpContext = getFollowUpContext(conversationState, currentIntent);

  console.log(
    `[Chat] Intent: ${currentIntent.primary} (${currentIntent.confidence}), Stage: ${conversationState.journeyStage}`
  );
  if (followUpContext.hasContext) {
    console.log(`[Chat] Follow-up context:`, followUpContext.explanation);
  }

  // Track conversation
  const storeDbId = await getStoreDbId(store_id);
  let conversation = null;
  let isNewConversation = false;

  if (storeDbId && session_id) {
    const existingConv = await pool.query(
      `SELECT id FROM conversations WHERE store_id = $1 AND session_id = $2`,
      [storeDbId, session_id]
    );
    isNewConversation = existingConv.rowCount === 0;

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
    // ============ RAG SEARCH ============
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

    // Dynamic thresholds based on intent
    let productThreshold = 0.38;
    let pageThreshold = 0.45;

    if (
      currentIntent.primary === INTENTS.BROWSE ||
      currentIntent.primary === INTENTS.RECOMMENDATION
    ) {
      productThreshold = 0.32; // More lenient for browsing
    }
    if (
      currentIntent.primary === INTENTS.PRODUCT_INFO &&
      conversationState.lastProducts.length > 0
    ) {
      productThreshold = 0.3; // Very lenient if following up on a product
    }

    let relevantProducts = scoredProducts
      .filter((s) => s.score >= productThreshold)
      .slice(0, 5);
    let relevantPages = scoredPages
      .filter((s) => s.score >= pageThreshold)
      .slice(0, 2);

    // ============ "MORE" REQUEST HANDLING ============
    // If user asks for "more" of something, include more products from the same category
    const isMoreRequest =
      /\b(fler|mer|more|annat|andra|other|alternatives)\b/i.test(message);

    if (isMoreRequest && conversationState.lastProducts.length > 0) {
      // Extract key words from last products to find related items
      const lastProductNames = conversationState.lastProducts.map((p) =>
        p.toLowerCase()
      );
      const keyWords = [];

      for (const name of lastProductNames) {
        // Extract significant words (likely product type/category)
        const words = name.split(/[\s\-–—\|,]+/).filter((w) => w.length >= 4);
        keyWords.push(...words);
      }

      // Find more products matching these keywords
      for (const item of storeData.items) {
        if (item.type !== "product") continue;
        if (!item.url || !item.image_url) continue;

        const titleLower = item.title.toLowerCase();
        const alreadyIncluded = relevantProducts.some(
          (p) => p.item.title.toLowerCase() === titleLower
        );

        if (!alreadyIncluded) {
          // Check if this product matches any key words
          const matches = keyWords.some((kw) => titleLower.includes(kw));
          if (matches) {
            relevantProducts.push({
              item,
              score: 0.7,
              boosted: true,
              reason: "category_match",
            });
          }
        }
      }

      // Limit to 8 products for "more" requests
      relevantProducts = relevantProducts.slice(0, 8);
    }

    // ============ CONTEXT-AWARE PRODUCT BOOSTING ============
    // If user is following up on a product, ensure it's in the context
    if (
      conversationState.lastProducts.length > 0 &&
      [
        INTENTS.AFFIRMATIVE,
        INTENTS.PRODUCT_INFO,
        INTENTS.PRICE_CHECK,
        INTENTS.PURCHASE,
      ].includes(currentIntent.primary)
    ) {
      for (const productName of conversationState.lastProducts) {
        const alreadyIncluded = relevantProducts.some(
          (p) => p.item.title.toLowerCase() === productName.toLowerCase()
        );

        if (!alreadyIncluded) {
          const productData = storeData.items.find(
            (item) =>
              item.type === "product" &&
              item.title.toLowerCase() === productName.toLowerCase()
          );

          if (productData) {
            relevantProducts.unshift({
              item: productData,
              score: 1.0,
              boosted: true,
            });
          }
        }
      }
    }

    // ============ BUILD PROMPT ============
    const systemPrompt = buildSystemPrompt({
      storeName: storeData.storeName,
      personality: storeData.personality,
      language: userLanguage,
      conversationState,
      currentIntent,
      hasProductContext: relevantProducts.length > 0,
      hasContactInfo: storeFacts.length > 0,
    });

    const messages = [{ role: "system", content: systemPrompt }];

    // Add conversation history with product context
    if (history.length > 0) {
      history.slice(-8).forEach((h) => {
        if (h.role === "assistant" && h.products_shown?.length > 0) {
          messages.push({
            role: h.role,
            content: `${h.content}\n[Products shown: ${h.products_shown.join(
              ", "
            )}]`,
          });
        } else {
          messages.push({ role: h.role, content: h.content });
        }
      });
    }

    // Add current message
    messages.push({ role: "user", content: message });

    // Add RAG context
    const bestProductScore = relevantProducts[0]?.score || 0;
    const confidenceNote =
      bestProductScore < 0.45 &&
      [INTENTS.SEARCH, INTENTS.PRODUCT_INFO].includes(currentIntent.primary)
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

    // ============ CALL AI ============
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.6, // Slightly higher for more natural responses
      max_tokens: 300,
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
    if (productCards.length === 0) {
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
          /* const commonWords = [
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
          ]; */
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
    }

    return res.json({
      ok: true,
      store_id,
      answer,
      product_cards: productCards,
      debug: {
        intent: currentIntent.primary,
        intent_confidence: currentIntent.confidence,
        intent_description: describeIntent(currentIntent.primary),
        journey_stage: conversationState.journeyStage,
        context_summary: conversationState.contextSummary,
        follow_up: followUpContext.hasContext
          ? followUpContext.explanation
          : null,
        products_found: relevantProducts.length,
        pages_found: relevantPages.length,
        product_tags: taggedProductNames.length > 0 ? taggedProductNames : null,
        products_matched: productCards.length,
        best_score: bestProductScore.toFixed(3),
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
