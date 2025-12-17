/**
 * Insight Extractor Service
 *
 * Extracts insights from completed conversations using AI.
 */

const { pool } = require("../config/database");
const { openai } = require("./embedding");

/**
 * Extract insights from a completed conversation using AI
 */
async function extractInsightsFromConversation(conversationId, storeDbId) {
  try {
    // Get all messages from the conversation
    const messagesResult = await pool.query(
      `SELECT role, content, products_shown, created_at 
       FROM conv_messages 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC`,
      [conversationId]
    );

    if (messagesResult.rowCount < 2) {
      console.log(
        `Conversation ${conversationId}: Too few messages for insight extraction`
      );
      return;
    }

    // Format conversation for the AI
    const conversationText = messagesResult.rows
      .map(
        (m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`
      )
      .join("\n\n");

    // Get store's product list for context
    const productsResult = await pool.query(
      `SELECT title FROM store_items WHERE store_id = $1 AND type = 'product' LIMIT 100`,
      [storeDbId]
    );
    const productNames = productsResult.rows.map((r) => r.title).join(", ");

    const extractionPrompt = `Analyze this customer service conversation and extract structured insights.

CONVERSATION:
${conversationText}

STORE'S PRODUCTS (for reference):
${productNames || "No product list available"}

Extract the following insights in JSON format:

{
  "product_interests": [
    // Products the customer showed interest in or asked about
    // Include both specific products AND general product categories/types
  ],
  "topics": [
    // Main topics discussed (not products)
    // Example: ["shipping", "returns", "gift recommendations", "pricing"]
  ],
  "sentiment": "positive" | "neutral" | "frustrated",
  // Overall customer sentiment based on their messages
  
  "unresolved": [
    // Questions or requests the assistant couldn't fully answer
  ]
}

Rules:
- Only include product_interests if the customer actually showed interest
- Topics should be general themes, not specific products
- Be conservative with "frustrated" sentiment - only use if clearly negative
- Return ONLY valid JSON, no markdown or explanation

JSON:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content:
            "You are an expert at analyzing customer conversations and extracting actionable insights. Always respond with valid JSON only.",
        },
        { role: "user", content: extractionPrompt },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    const responseText = completion.choices[0]?.message?.content || "{}";

    // Parse the JSON response
    let insights;
    try {
      const cleanJson = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      insights = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error(
        `Conversation ${conversationId}: Failed to parse insights JSON:`,
        responseText
      );
      return;
    }

    // Store extracted insights
    const insightsToStore = [];

    // Product interests (priority 1)
    if (Array.isArray(insights.product_interests)) {
      for (const product of insights.product_interests) {
        if (product && typeof product === "string") {
          insightsToStore.push({
            type: "product_interest",
            value: product.trim(),
            confidence: 0.9,
          });
        }
      }
    }

    // Topics (priority 2)
    if (Array.isArray(insights.topics)) {
      for (const topic of insights.topics) {
        if (topic && typeof topic === "string") {
          insightsToStore.push({
            type: "topic",
            value: topic.trim().toLowerCase(),
            confidence: 0.85,
          });
        }
      }
    }

    // Sentiment (priority 3)
    if (
      insights.sentiment &&
      ["positive", "neutral", "frustrated"].includes(insights.sentiment)
    ) {
      insightsToStore.push({
        type: "sentiment",
        value: insights.sentiment,
        confidence: 0.8,
      });
    }

    // Unresolved questions (priority 4)
    if (Array.isArray(insights.unresolved)) {
      for (const question of insights.unresolved) {
        if (question && typeof question === "string") {
          insightsToStore.push({
            type: "unresolved",
            value: question.trim(),
            confidence: 0.75,
          });
        }
      }
    }

    // Insert all insights
    for (const insight of insightsToStore) {
      await pool.query(
        `INSERT INTO conv_insights (conversation_id, store_id, insight_type, value, confidence)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          conversationId,
          storeDbId,
          insight.type,
          insight.value,
          insight.confidence,
        ]
      );
    }

    console.log(
      `Conversation ${conversationId}: Extracted ${insightsToStore.length} insights`
    );

    // Mark conversation as processed
    await pool.query(
      `UPDATE conversations SET status = 'processed' WHERE id = $1`,
      [conversationId]
    );
  } catch (err) {
    console.error(
      `Error extracting insights from conversation ${conversationId}:`,
      err
    );
  }
}

/**
 * Process all ended conversations that haven't been analyzed yet
 */
async function processEndedConversations() {
  try {
    const result = await pool.query(`
      SELECT c.id, c.store_id 
      FROM conversations c
      WHERE c.status = 'ended'
        AND c.message_count >= 2
      ORDER BY c.ended_at ASC
      LIMIT 10
    `);

    if (result.rowCount > 0) {
      console.log(
        `Processing ${result.rowCount} ended conversations for insights...`
      );

      for (const row of result.rows) {
        await extractInsightsFromConversation(row.id, row.store_id);
      }
    }
  } catch (err) {
    console.error("Error in processEndedConversations:", err);
  }
}

module.exports = {
  extractInsightsFromConversation,
  processEndedConversations,
};
