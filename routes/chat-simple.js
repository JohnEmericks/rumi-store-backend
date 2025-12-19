/**
 * SIMPLIFIED CHAT ROUTE
 *
 * Philosophy: Load products, give them to the AI, let it help.
 * No gates. No intent classification. No journey stages.
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
  buildSystemPrompt,
  buildContextMessage,
} = require("../services/prompt-simple");

/**
 * Load store data from database
 */
async function loadStoreData(storeId) {
  try {
    const storeRow = await pool.query(
      `SELECT s.id, s.store_name, s.personality, s.license_key_id,
              lk.is_active as license_active, lk.plan
       FROM stores s
       LEFT JOIN license_keys lk ON s.license_key_id = lk.id
       WHERE s.store_id = $1`,
      [storeId]
    );

    if (storeRow.rowCount === 0) return null;

    const store = storeRow.rows[0];
    const storeDbId = store.id;

    // Load items using internal DB id
    const itemsRow = await pool.query(
      "SELECT type, title, url, image_url, content, embedding, price, in_stock FROM store_items WHERE store_id = $1",
      [storeDbId]
    );

    return {
      id: store.id,
      storeName: store.store_name,
      personality: store.personality || {},
      licenseActive: store.license_active,
      plan: store.plan,
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
  } catch (error) {
    console.error("Error loading store data:", error);
    return null;
  }
}

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

  // Partial match
  if (!match) {
    match = items.find(
      (item) =>
        item.type === "product" &&
        (item.title.toLowerCase().includes(normalizedTag) ||
          normalizedTag.includes(item.title.toLowerCase()))
    );
  }

  return match;
}

/**
 * Simple chat endpoint
 */
router.post("/chat-simple", async (req, res) => {
  const {
    store_id,
    message,
    history = [],
    language = "Swedish",
  } = req.body || {};

  console.log(
    `[Simple Chat] Request - store: ${store_id}, message: "${message?.slice(
      0,
      50
    )}..."`
  );

  if (!store_id || !message) {
    return res
      .status(400)
      .json({ ok: false, error: "store_id and message are required" });
  }

  // Load store
  const storeData = await loadStoreData(store_id);

  if (!storeData) {
    console.log(`[Simple Chat] Store not found: ${store_id}`);
    return res.status(400).json({ ok: false, error: "Store not found" });
  }

  if (!storeData.items?.length) {
    console.log(`[Simple Chat] No items for store: ${store_id}`);
    return res.status(400).json({ ok: false, error: "No products in store" });
  }

  if (!storeData.licenseActive) {
    return res.status(403).json({ ok: false, error: "License inactive" });
  }

  try {
    // ============ SIMPLE RAG: Always retrieve relevant products ============
    const [queryVector] = await embedTexts([message]);

    // Score all items
    const scored = storeData.items
      .filter((item) => item.type !== "product" || item.in_stock !== false)
      .map((item) => ({
        item,
        score: cosineSimilarity(queryVector, item.embedding),
      }))
      .sort((a, b) => b.score - a.score);

    // Get top products and pages
    const relevantProducts = scored
      .filter((s) => s.item.type === "product")
      .slice(0, 8);

    const relevantPages = scored
      .filter((s) => s.item.type === "page" && s.score >= 0.3)
      .slice(0, 2);

    console.log(
      `[Simple Chat] Found ${relevantProducts.length} products, ${relevantPages.length} pages`
    );

    // ============ BUILD PROMPT ============
    const productTypes = [
      ...new Set(
        storeData.items
          .filter((item) => item.type === "product")
          .map((item) => item.title)
      ),
    ];
    const storeProductSummary = productTypes.slice(0, 15).join(", ");

    const systemPrompt = buildSystemPrompt({
      storeName: storeData.storeName,
      personality: storeData.personality,
      language,
      storeProductSummary,
    });

    // Build messages
    const messages = [{ role: "system", content: systemPrompt }];

    // Add history
    if (history.length > 0) {
      history.forEach((turn) => {
        messages.push({ role: turn.role, content: turn.content });
      });
    }

    // Add current message
    messages.push({ role: "user", content: message });

    // Add product context
    if (relevantProducts.length > 0 || relevantPages.length > 0) {
      const contextMessage = buildContextMessage({
        products: relevantProducts,
        pages: relevantPages,
        language,
      });
      messages.push({ role: "system", content: contextMessage });
    }

    // ============ CALL AI ============
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    });

    const rawAnswer =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // ============ EXTRACT PRODUCT TAGS ============
    const tagMatches = rawAnswer.match(/\{\{([^}]+)\}\}/g) || [];
    const taggedNames = tagMatches.map((tag) =>
      tag.replace(/\{\{|\}\}/g, "").trim()
    );

    // Remove tags from displayed answer
    const answer = rawAnswer.replace(/\s*\{\{[^}]+\}\}/g, "").trim();

    // ============ BUILD PRODUCT CARDS ============
    let productCards = [];

    if (taggedNames.length > 0) {
      // Only show first tagged product (one at a time)
      const matchedProduct = findProductByTag(taggedNames[0], storeData.items);
      if (matchedProduct) {
        productCards.push({
          title: matchedProduct.title,
          url: matchedProduct.url,
          image_url: matchedProduct.image_url,
          price: matchedProduct.price || null,
        });
      }
    }

    console.log(
      `[Simple Chat] Response ready, ${productCards.length} product cards`
    );

    // ============ RESPOND ============
    return res.json({
      ok: true,
      answer,
      product_cards: productCards,
      debug: {
        mode: "simple",
        products_in_context: relevantProducts.length,
        pages_in_context: relevantPages.length,
        tags_found: taggedNames,
      },
    });
  } catch (error) {
    console.error("[Simple Chat] Error:", error);
    return res.status(500).json({ ok: false, error: "Internal error" });
  }
});

module.exports = router;
