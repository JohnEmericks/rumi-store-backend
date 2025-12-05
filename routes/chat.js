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
        // Don't include URL - the AI shouldn't output links
        context += "\n";
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

    // Only add contact info if the query seems contact-related
    if (queryContext.isContactQuery && storeFacts.length > 0) {
      context += "## CONTACT INFO (user asked about this)\n";
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

## YOUR PERSONALITY
Tone: ${toneDescriptions[personality.tone] || toneDescriptions.friendly}
${personality.brand_voice ? `Brand voice: ${personality.brand_voice}` : ""}
${
  personality.special_instructions
    ? `Special instructions: ${personality.special_instructions}`
    : ""
}

## RESPONSE STYLE - VERY IMPORTANT
Keep responses SHORT and conversational:
- 1-2 sentences for simple questions
- 3-4 sentences maximum for complex questions
- Never write long paragraphs or walls of text
- Chat like a helpful friend, not a formal assistant
- Be natural and warm, not robotic

## THINGS YOU MUST NEVER DO
- NEVER include URLs or links in your response
- NEVER use markdown link format like [text](url)
- NEVER list out contact information unless the user specifically asks for it
- NEVER output product URLs - product cards with links appear automatically
- If someone MIGHT want contact info but didn't explicitly ask, offer first: "Vill du ha våra kontaktuppgifter?" / "Would you like our contact details?"

## ABOUT PRODUCTS
When recommending products:
- Just mention the product name naturally in your response
- A clickable product card with image and link will appear automatically below your message
- Don't say "click here" or provide any URLs
- Keep the description brief - the customer can see details on the card

Example GOOD response:
"Rosenkvarts Cuddle Stone skulle passa perfekt för det! Den är en av våra mest populära lugnande stenar. ✨"

Example BAD response:
"Jag rekommenderar Rosenkvarts Cuddle Stone. Du kan hitta den här: [Rosenkvarts Cuddle Stone](https://example.com/produkt/123). Den kostar 149 kr och är känd för sina lugnande egenskaper och har använts i tusentals år för helande..."

## RULES
- Answer based ONLY on the store data provided
- If you don't know something, say so briefly and politely
- Never make up information about products or policies

## HANDLING FOLLOW-UP QUESTIONS
- When the user says "it", "that one", "den", "det", etc., check the conversation history
- Look for "[You showed product cards for: ...]" notes to see what products were just discussed
- Connect their question to the most recently mentioned/shown product`;

    const messages = [{ role: "system", content: systemPrompt }];

    // Add conversation history with product context
    if (history.length > 0) {
      history.slice(-6).forEach((h) => {
        if (
          h.role === "assistant" &&
          h.products_shown &&
          h.products_shown.length > 0
        ) {
          // Include what products were shown/discussed with this response
          const productContext = h.products_shown.join(", ");
          messages.push({
            role: h.role,
            content: `${h.content}\n[You showed product cards for: ${productContext}]`,
          });
        } else {
          messages.push({ role: h.role, content: h.content });
        }
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
      temperature: 0.5,
      max_tokens: 250,
    });

    const answer =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";
    const answerLower = answer.toLowerCase();

    /**
     * Calculate how well a product matches the AI's answer
     * Higher score = better match
     *
     * Key principle: If the AI says "Bergkristall Geod", we want to match
     * "Bergkristall Geod" not just "Bergkristall"
     */
    function calculateProductMatchScore(item, answerText) {
      const title = item.title || "";
      const titleLower = title.toLowerCase();

      // Check for exact title match (best possible match)
      if (answerText.includes(titleLower)) {
        return 1000 + titleLower.length; // Longer exact matches score higher
      }

      // Check for product code match (e.g., "A11-CL-003")
      const codeMatch = title.match(/[A-Z]{1,3}\d{1,2}-[A-Z]{1,3}-\d{3}/i);
      if (codeMatch && answerText.includes(codeMatch[0].toLowerCase())) {
        return 900;
      }

      // Split title into words
      const titleWords = titleLower
        .split(/[\s\-–—\|,]+/)
        .filter((w) => w.length >= 3);

      if (titleWords.length === 0) return 0;

      // Common/generic words worth less
      const commonWords = new Set([
        "sten",
        "stenar",
        "stone",
        "stones",
        "crystal",
        "crystals",
        "kristall",
        "kristaller",
        "cuddle",
        "kvalitet",
        "quality",
        "specimen",
        "cluster",
        "kluster",
        "aaa",
        "liten",
        "stor",
      ]);

      let matchedCount = 0;
      let specificMatchCount = 0;

      for (const word of titleWords) {
        if (answerText.includes(word)) {
          matchedCount++;
          if (!commonWords.has(word)) {
            specificMatchCount++;
          }
        }
      }

      // No matches = no score
      if (matchedCount === 0) return 0;

      // Calculate score:
      // - Base: 10 points per specific word matched
      // - Bonus: Higher percentage of title words matched = better
      // - Penalty: Unmatched words in title reduce score (prevents "Bergkristall" beating "Bergkristall Geod")

      const matchRatio = matchedCount / titleWords.length;
      const unmatchedWords = titleWords.length - matchedCount;

      let score = 0;
      score += specificMatchCount * 20; // 20 points per specific word
      score += matchedCount * 5; // 5 points per any word
      score += matchRatio * 100; // Up to 100 points for full match
      score -= unmatchedWords * 15; // Penalty for unmatched words in title

      return Math.max(0, score);
    }

    // Find the product that best matches what the AI mentioned
    let productCards = [];

    let bestMatch = null;
    let bestScore = 0;

    for (const item of storeData.items) {
      if (item.type !== "product") continue;
      if (!item.url || !item.image_url) continue;

      const score = calculateProductMatchScore(item, answerLower);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = item;
      }
    }

    // Only show card if we have a meaningful match
    if (bestMatch && bestScore >= 10) {
      productCards = [
        {
          title: bestMatch.title,
          url: bestMatch.url,
          image_url: bestMatch.image_url,
          price: bestMatch.price || null,
        },
      ];
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
        contact_info_included: queryContext.isContactQuery,
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
