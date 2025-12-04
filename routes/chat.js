/**
 * Chat Routes
 *
 * Handles the main chat endpoint and conversation lifecycle.
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const {
  openai,
  embedTexts,
  cosineSimilarity,
} = require("../services/embedding");
const { analyzeQuery } = require("../utils/helpers");
const {
  getOrCreateConversation,
  saveConversationMessage,
  getStoreDbId,
} = require("../services/conversation-tracker");
const {
  extractInsightsFromConversation,
} = require("../services/insight-extractor");

/**
 * Load store data from database
 */
async function loadStoreDataFromDb(storeId) {
  try {
    const storeRow = await pool.query(
      "SELECT id, store_name, personality FROM stores WHERE store_id = $1",
      [storeId]
    );

    if (storeRow.rowCount === 0) return null;

    const storeDbId = storeRow.rows[0].id;
    const personality = storeRow.rows[0].personality || {};

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
      storeName: storeRow.rows[0].store_name,
      personality,
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
  const storeData = await loadStoreDataFromDb(store_id);
  const storeFacts = await loadStoreFactsFromDb(store_id);

  if (!storeData?.items?.length) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "No data found for this store. Please index the store first.",
      });
  }

  // Get store database ID for conversation tracking
  const storeDbId = await getStoreDbId(store_id);

  // Determine language
  let userLanguage = "Swedish";

  if (language === "sv" || language === "Swedish") {
    userLanguage = "Swedish";
  } else if (language === "en" || language === "English") {
    userLanguage = "English";
  } else if (storeData.personality?.language === "sv") {
    userLanguage = "Swedish";
  } else if (storeData.personality?.language === "en") {
    userLanguage = "English";
  }

  // Track conversation
  let conversation = null;
  if (storeDbId && session_id) {
    conversation = await getOrCreateConversation(
      storeDbId,
      session_id,
      language,
      device_type
    );
    if (conversation) {
      await saveConversationMessage(conversation.id, "user", message, []);
    }
  }

  try {
    const queryContext = analyzeQuery(message, history, userLanguage);

    // Handle greetings
    if (queryContext.isGreeting) {
      const greetings = {
        Swedish: [
          "Hej! 👋 Vad kan jag hjälpa dig med idag?",
          "Hej hej! Vad letar du efter?",
          "Hallå! Hur kan jag hjälpa dig?",
        ],
        English: [
          "Hey there! 👋 What can I help you find today?",
          "Hi! What are you looking for?",
          "Hello! How can I help you?",
        ],
      };
      const options = greetings[userLanguage];
      const greetingResponse =
        options[Math.floor(Math.random() * options.length)];

      if (conversation) {
        await saveConversationMessage(
          conversation.id,
          "assistant",
          greetingResponse,
          []
        );
      }

      return res.json({
        ok: true,
        store_id,
        answer: greetingResponse,
        product_cards: [],
      });
    }

    // Embed the query
    const [queryVector] = await embedTexts([message]);

    // Score all items (filter out out-of-stock products)
    const scored = storeData.items
      .filter((item) => {
        if (item.type !== "product") return true;
        return item.in_stock !== false;
      })
      .map((item) => ({
        item,
        score: cosineSimilarity(queryVector, item.embedding),
      }));
    scored.sort((a, b) => b.score - a.score);

    // Separate products and pages
    const scoredProducts = scored.filter((s) => s.item.type === "product");
    const scoredPages = scored.filter((s) => s.item.type === "page");

    // Dynamic thresholds
    const productThreshold = queryContext.isVisual ? 0.32 : 0.38;
    const pageThreshold = 0.45;

    const relevantProducts = scoredProducts
      .filter((s) => s.score >= productThreshold)
      .slice(0, 5);
    const relevantPages = scoredPages
      .filter((s) => s.score >= pageThreshold)
      .slice(0, 2);

    // Build context for AI
    let context = "";

    if (relevantProducts.length > 0) {
      context += "## PRODUCTS (all in stock)\n\n";
      relevantProducts.forEach((e) => {
        context += `**${e.item.title}**\n`;
        if (e.item.price) context += `Price: ${e.item.price}\n`;
        if (e.item.content) {
          const desc =
            e.item.content.length > 400
              ? e.item.content.slice(0, 400) + "..."
              : e.item.content;
          context += `${desc}\n`;
        }
        context += `URL: ${e.item.url}\n\n`;
      });
    }

    if (relevantPages.length > 0) {
      context += "## STORE INFORMATION\n\n";
      relevantPages.forEach((e) => {
        context += `### ${e.item.title}\n${
          e.item.content?.slice(0, 500) || ""
        }\n\n`;
      });
    }

    // Add store facts
    if (storeFacts.length > 0) {
      context += "## CONTACT INFO\n";
      storeFacts.forEach((f) => {
        context += `${f.fact_type}: ${f.value}\n`;
      });
      context += "\n";
    }

    // Build messages for AI
    const personality = storeData.personality || {};
    const toneDescriptions = {
      friendly:
        "warm, approachable, and helpful, like a favorite local shopkeeper",
      professional:
        "knowledgeable, polished, and courteous with a touch of warmth",
      casual: "relaxed and conversational, like chatting with a friend",
      luxurious:
        "refined, attentive, and elegant, providing a premium experience",
    };

    const systemPrompt = `You are a helpful store assistant for ${
      storeData.storeName || "this store"
    }.

## LANGUAGE - CRITICAL
You MUST respond in ${userLanguage}. Always. Every single response must be in ${userLanguage}.
Even if the user writes short words like "ok", "ja", "nej" - still respond in ${userLanguage}.
Never switch to English unless the user explicitly asks for English.

## YOUR PERSONALITY
Tone: ${toneDescriptions[personality.tone] || toneDescriptions.friendly}
${personality.brand_voice ? `Brand voice: ${personality.brand_voice}` : ""}
${
  personality.special_instructions
    ? `Special instructions: ${personality.special_instructions}`
    : ""
}

## RULES
- Answer based on the store data provided below
- Keep responses concise (2-3 short paragraphs max)
- If recommending a product, mention its name clearly
- If you don't know something, say so politely
- Never make up information about products`;

    const messages = [{ role: "system", content: systemPrompt }];

    // Add conversation history
    if (history.length > 0) {
      history.slice(-6).forEach((h) => {
        messages.push({ role: h.role, content: h.content });
      });
    }

    messages.push({ role: "user", content: message });

    // Add RAG context
    const bestProductScore = relevantProducts[0]?.score || 0;
    const confidenceNote =
      bestProductScore < 0.45 && queryContext.isProductQuery
        ? "\n\n⚠️ Note: These results aren't a strong match. Be honest if nothing fits well."
        : "";

    messages.push({
      role: "user",
      content: `[STORE DATA - use this to answer the customer's question]\n\n${context}${confidenceNote}`,
    });

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.4,
      max_tokens: 400,
    });

    const answer =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // Determine product cards
    const cardThreshold = queryContext.isVisual ? 0.32 : 0.45;
    const productCandidates = relevantProducts.filter(
      (e) => e.score >= cardThreshold && e.item.url && e.item.image_url
    );

    let productCards = [];

    if (queryContext.isVisual && productCandidates.length > 0) {
      productCards = [productCandidates[0]].map((e) => ({
        title: e.item.title,
        url: e.item.url,
        image_url: e.item.image_url,
        price: e.item.price || null,
      }));
    } else if (productCandidates.length > 0) {
      const answerLower = answer.toLowerCase();
      productCards = productCandidates
        .slice(0, 2)
        .filter((e) => {
          const words = e.item.title
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 3);
          return words.some((w) => answerLower.includes(w));
        })
        .slice(0, 1)
        .map((e) => ({
          title: e.item.title,
          url: e.item.url,
          image_url: e.item.image_url,
          price: e.item.price || null,
        }));
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
        query: queryContext,
        products_found: relevantProducts.length,
        pages_found: relevantPages.length,
        best_product_score: bestProductScore.toFixed(3),
        top_products: relevantProducts.slice(0, 3).map((e) => ({
          title: e.item.title,
          score: e.score.toFixed(3),
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
        `Conversation ${conv.id} ended (chat closed, ${conv.message_count} messages)`
      );

      // Trigger insight extraction asynchronously
      if (conv.message_count >= 2) {
        setImmediate(() => {
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
