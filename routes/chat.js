/**
 * Chat Routes - Simplified Version
 *
 * Philosophy: Trust the AI. Give it context, let it help.
 *
 * Keeps: License checks, usage tracking, conversation saving
 * Removes: Intent classification, discovery gates, journey stages, complex rules
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
  buildSystemPrompt,
  buildContextMessage,
} = require("../services/prompt-process");

// ============================================================================
// DATABASE HELPERS
// ============================================================================

/**
 * Load store data from database
 */
async function loadStoreData(storeId) {
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

    const itemsRow = await pool.query(
      "SELECT type, title, url, image_url, content, embedding, price, in_stock FROM store_items WHERE store_id = $1",
      [storeDbId]
    );

    return {
      id: storeDbId,
      storeId: storeId,
      storeName: store.store_name,
      personality: store.personality || {},
      licenseKeyId: store.license_key_id,
      licenseActive: store.license_active,
      plan: store.plan,
      planLimit: store.plan_limit,
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
    };
  } catch (err) {
    console.error("Error loading store data:", err);
    return null;
  }
}

/**
 * Get current usage for store
 */
async function getCurrentUsage(licenseKeyId) {
  const result = await pool.query(
    `SELECT conversations_used FROM usage_tracking 
     WHERE license_key_id = $1 AND period_start <= now() AND period_end > now()
     LIMIT 1`,
    [licenseKeyId]
  );
  return result.rows[0]?.conversations_used || 0;
}

// ============================================================================
// PRODUCT MATCHING
// ============================================================================

/**
 * Find product by tag name (fuzzy matching)
 */
function findProductByTag(tagName, items) {
  const normalizedTag = tagName.toLowerCase().trim();

  // Exact match first
  let match = items.find(
    (item) =>
      item.type === "product" && item.title.toLowerCase() === normalizedTag
  );

  // Partial match - tag contains title or title contains tag
  if (!match) {
    match = items.find(
      (item) =>
        item.type === "product" &&
        (item.title.toLowerCase().includes(normalizedTag) ||
          normalizedTag.includes(item.title.toLowerCase()))
    );
  }

  // Word-based partial match
  if (!match) {
    const tagWords = normalizedTag.split(/\s+/);
    match = items.find((item) => {
      if (item.type !== "product") return false;
      const titleLower = item.title.toLowerCase();
      return tagWords.some(
        (word) => word.length > 3 && titleLower.includes(word)
      );
    });
  }

  return match;
}

// ============================================================================
// MAIN CHAT ENDPOINT
// ============================================================================

router.post("/chat", async (req, res) => {
  let {
    store_id,
    message,
    history = [],
    language = "Swedish",
    session_id,
    device_type,
  } = req.body || {};

  console.log(
    `[Chat] Request - store: ${store_id}, message: "${message?.slice(
      0,
      50
    )}..."`
  );

  // Validate input
  if (!store_id || !message) {
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
  const storeData = await loadStoreData(store_id);

  if (!storeData) {
    console.log(`[Chat] Store not found: ${store_id}`);
    return res.status(400).json({ ok: false, error: "Store not found" });
  }

  if (!storeData.items?.length) {
    return res
      .status(400)
      .json({ ok: false, error: "Store has no products indexed" });
  }

  // License check
  if (!storeData.licenseActive) {
    return res.status(403).json({
      ok: false,
      error: "license_inactive",
      message: "Store license is not active",
    });
  }

  // Usage limit check
  if (storeData.planLimit !== null) {
    const currentUsage = await getCurrentUsage(storeData.licenseKeyId);
    if (currentUsage >= storeData.planLimit) {
      return res.status(403).json({
        ok: false,
        error: "limit_reached",
        message: `Monthly limit reached (${currentUsage}/${storeData.planLimit}).`,
        show_to_customer:
          "Chatten är tillfälligt otillgänglig. Vänligen försök igen senare.",
      });
    }
  }

  try {
    // ========== CONVERSATION TRACKING ==========
    const conversation = await getOrCreateConversation(
      storeData.id,
      session_id,
      device_type
    );

    // Increment usage if new conversation
    if (conversation.isNew) {
      await incrementConversation(storeData.licenseKeyId);
    }
    await incrementMessage(storeData.licenseKeyId);

    // Save user message
    await saveConversationMessage(conversation.id, "user", message);

    // ========== RAG: Find relevant products ==========
    const [queryVector] = await embedTexts([message]);

    // Detect comparative/superlative queries that need price or size context
    const priceQuery =
      /dyrast|billigast|dyr|billig|expensive|cheap|pris|price|kostar/i.test(
        message
      );
    const sizeQuery =
      /störst|minst|större|mindre|biggest|smallest|bigger|smaller|stor|liten/i.test(
        message
      );
    const comparativeQuery = priceQuery || sizeQuery;

    const scored = storeData.items
      .filter((item) => item.type !== "product" || item.in_stock !== false)
      .map((item) => ({
        item,
        score: cosineSimilarity(queryVector, item.embedding),
      }))
      .sort((a, b) => b.score - a.score);

    let relevantProducts;

    if (comparativeQuery) {
      // For comparative queries, include ALL products so AI can reason about price/size
      relevantProducts = scored
        .filter((s) => s.item.type === "product")
        .sort((a, b) => {
          // Sort by price for price queries
          if (priceQuery) {
            const priceA =
              parseFloat(String(a.item.price || "0").replace(/[^\d]/g, "")) ||
              0;
            const priceB =
              parseFloat(String(b.item.price || "0").replace(/[^\d]/g, "")) ||
              0;
            return priceB - priceA; // Highest first
          }
          return b.score - a.score;
        });
      console.log(
        `[Chat] Comparative query detected - including all ${relevantProducts.length} products`
      );
    } else {
      relevantProducts = scored
        .filter((s) => s.item.type === "product")
        .slice(0, 8);
    }

    const relevantPages = scored
      .filter((s) => s.item.type === "page" && s.score >= 0.3)
      .slice(0, 2);

    console.log(
      `[Chat] RAG: ${relevantProducts.length} products, ${relevantPages.length} pages`
    );

    // ========== BUILD PROMPT ==========
    const productTitles = [
      ...new Set(
        storeData.items
          .filter((item) => item.type === "product")
          .map((item) => item.title)
      ),
    ];
    const storeProductSummary = productTitles.slice(0, 15).join(", ");

    const systemPrompt = buildSystemPrompt(
      storeData.storeName,
      storeProductSummary
    );

    // Build messages array
    const messages = [{ role: "system", content: systemPrompt }];

    // Add history from frontend (current session only)
    if (history && history.length > 0) {
      history.forEach((turn) => {
        messages.push({ role: turn.role, content: turn.content });
      });
    }

    // Add current message
    messages.push({ role: "user", content: message });

    // Add product context
    if (relevantProducts.length > 0 || relevantPages.length > 0) {
      const contextMessage = buildContextMessage(
        relevantProducts,
        relevantPages
      );
      messages.push({ role: "system", content: contextMessage });
    }

    // ========== CALL AI ==========
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.7,
      max_tokens: 500,
    });

    const rawAnswer =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // ========== EXTRACT PRODUCT TAGS ==========
    const tagMatches = rawAnswer.match(/\{\{([^}]+)\}\}/g) || [];
    const taggedProductNames = tagMatches.map((tag) =>
      tag.replace(/\{\{|\}\}/g, "").trim()
    );

    // Remove tags from displayed answer
    const answer = rawAnswer.replace(/\s*\{\{[^}]+\}\}/g, "").trim();

    // ========== BUILD PRODUCT CARDS ==========
    let productCards = [];

    if (taggedProductNames.length > 0) {
      // Only show first tagged product (one at a time)
      const matchedProduct = findProductByTag(
        taggedProductNames[0],
        storeData.items
      );
      if (matchedProduct) {
        productCards.push({
          title: matchedProduct.title,
          url: matchedProduct.url,
          image_url: matchedProduct.image_url,
          price: matchedProduct.price || null,
        });
      }
    }

    // ========== SAVE & RESPOND ==========
    await saveConversationMessage(
      conversation.id,
      "assistant",
      answer,
      productCards.map((p) => p.title)
    );

    console.log(`[Chat] Response ready, ${productCards.length} product cards`);

    return res.json({
      ok: true,
      answer,
      product_cards: productCards,
      debug: {
        products_in_context: relevantProducts.length,
        pages_in_context: relevantPages.length,
        tags_found: taggedProductNames,
        products_matched: productCards.length,
      },
    });
  } catch (err) {
    console.error("[Chat] Error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to generate response" });
  }
});

// ============================================================================
// END CONVERSATION ENDPOINT
// ============================================================================

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
        `[Chat] Conversation ${conv.id} ended (${conv.message_count} messages)`
      );

      // Score and extract insights asynchronously
      if (conv.message_count >= 2) {
        setImmediate(async () => {
          try {
            const {
              scoreAndUpdateConversation,
            } = require("../services/conversation-scorer");
            const scoreResult = await scoreAndUpdateConversation(conv.id);
            if (scoreResult.success) {
              console.log(
                `[Chat] Conversation ${conv.id} scored: ${scoreResult.score}/100`
              );
            }
          } catch (err) {
            console.error(`Error scoring conversation ${conv.id}:`, err);
          }

          extractInsightsFromConversation(conv.id, storeDbId);
        });
      }
    }

    return res.json({ ok: true, ended: result.rowCount > 0 });
  } catch (err) {
    console.error("[Chat] Error in /end-conversation:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to end conversation" });
  }
});

module.exports = router;
