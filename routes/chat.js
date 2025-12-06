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
const {
  incrementConversation,
  incrementMessage,
} = require("../services/license");

/**
 * Load store data from database (includes license info)
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

  // Load store data (includes license info)
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

  // Check license status
  if (storeData.licenseKeyId) {
    if (!storeData.licenseActive) {
      return res.status(403).json({
        ok: false,
        error: "license_deactivated",
        message:
          "This store's license has been deactivated. Please contact support.",
        show_to_customer:
          "Chatten är tillfälligt otillgänglig. Vänligen försök igen senare.",
      });
    }

    // Check usage limits (if not unlimited)
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
          message: `Monthly conversation limit reached (${currentUsage}/${storeData.planLimit}). Please upgrade your plan.`,
          show_to_customer:
            "Chatten är tillfälligt otillgänglig. Vänligen försök igen senare.",
          upgrade_needed: true,
          plan: storeData.plan,
        });
      }
    }
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

  // Track conversation (check if this is a new conversation for billing)
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

    // Increment conversation count for billing (only for new conversations)
    if (isNewConversation && storeData.licenseKeyId) {
      await incrementConversation(storeData.licenseKeyId, storeDbId);
    }
  }

  // Track message for usage stats
  if (storeData.licenseKeyId) {
    await incrementMessage(storeData.licenseKeyId);
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

## PRODUCT TAG - CRITICAL
When you mention or recommend a product, you MUST end your response with the exact product name in double curly braces.
This tag is used by the system to show the correct product card. Use the EXACT product name from the store data.

Format: {{Exact Product Name}}

Examples:
- "Rosenkvarts Cuddle Stone skulle passa perfekt för det! Den är lugn och fin. {{Rosenkvarts Cuddle Stone}}"
- "Den har vackra glittrande kristaller inuti. {{Bergkristall Geod}}"
- "Vi har två alternativ - Malakit Sten för 150 kr eller det exklusiva Malakit Stalaktit Specimen. {{Malakit Sten}}"

Rules for the product tag:
- Always place it at the very end of your response
- Use the EXACT name as it appears in the product list
- Only include ONE product in the tag (the main/primary recommendation)
- If you're answering a follow-up about a previously discussed product, still include the tag
- If you're NOT recommending any specific product, don't include any tag

## RULES
- Answer based ONLY on the store data provided
- If you don't know something, say so briefly and politely
- Never make up information about products or policies

## HANDLING FOLLOW-UP QUESTIONS
- When the user says "it", "that one", "den", "det", etc., check the conversation history
- Look for "[You showed product cards for: ...]" notes to see what products were just discussed
- Connect their question to the most recently mentioned/shown product
- Still include the {{Product Name}} tag at the end`;

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

    const rawAnswer =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // Extract product tag from response: {{Product Name}}
    const productTagMatch = rawAnswer.match(/\{\{([^}]+)\}\}/);
    const taggedProductName = productTagMatch
      ? productTagMatch[1].trim()
      : null;

    // Remove the tag from the displayed answer
    const answer = rawAnswer.replace(/\s*\{\{[^}]+\}\}\s*$/, "").trim();

    // Find the product that matches the tag
    let productCards = [];

    if (taggedProductName) {
      // First try exact match (case-insensitive)
      let matchedProduct = storeData.items.find((item) => {
        if (item.type !== "product") return false;
        if (!item.url || !item.image_url) return false;
        return item.title.toLowerCase() === taggedProductName.toLowerCase();
      });

      // If no exact match, try partial match (tag contained in title or vice versa)
      if (!matchedProduct) {
        const tagLower = taggedProductName.toLowerCase();
        matchedProduct = storeData.items.find((item) => {
          if (item.type !== "product") return false;
          if (!item.url || !item.image_url) return false;
          const titleLower = item.title.toLowerCase();
          return titleLower.includes(tagLower) || tagLower.includes(titleLower);
        });
      }

      if (matchedProduct) {
        productCards = [
          {
            title: matchedProduct.title,
            url: matchedProduct.url,
            image_url: matchedProduct.image_url,
            price: matchedProduct.price || null,
          },
        ];
      }
    }

    // Fallback: If no tag or no match found, use the old scoring method
    if (productCards.length === 0 && !taggedProductName) {
      const answerLower = answer.toLowerCase();

      // Simple fallback: find if any product name appears in the answer
      for (const item of storeData.items) {
        if (item.type !== "product") continue;
        if (!item.url || !item.image_url) continue;

        // Check if product title words appear in answer
        const titleWords = item.title
          .toLowerCase()
          .split(/[\s\-–—\|,]+/)
          .filter((w) => w.length >= 4);
        const specificWords = titleWords.filter(
          (w) =>
            ![
              "sten",
              "stone",
              "crystal",
              "kristall",
              "cuddle",
              "cluster",
              "kluster",
            ].includes(w)
        );

        if (
          specificWords.length > 0 &&
          specificWords.some((w) => answerLower.includes(w))
        ) {
          productCards = [
            {
              title: item.title,
              url: item.url,
              image_url: item.image_url,
              price: item.price || null,
            },
          ];
          break;
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
        query: queryContext,
        products_found: relevantProducts.length,
        pages_found: relevantPages.length,
        contact_info_included: queryContext.isContactQuery,
        product_tag_found: taggedProductName || null,
        product_match_method: taggedProductName
          ? productCards.length > 0
            ? "structured_output"
            : "tag_not_matched"
          : "fallback",
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
