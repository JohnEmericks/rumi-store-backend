/**
 * Analytics Routes
 *
 * Handles analytics overview, conversations list, and AI queries.
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const { openai } = require("../services/embedding");

/**
 * Get analytics overview for a store
 */
router.get("/overview", async (req, res) => {
  const { store_id, api_key, days = 30 } = req.query || {};

  if (!store_id || !api_key) {
    return res
      .status(400)
      .json({ ok: false, error: "store_id and api_key are required" });
  }

  try {
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1 AND api_key = $2",
      [store_id, api_key]
    );

    if (storeRow.rowCount === 0) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const storeDbId = storeRow.rows[0].id;
    const daysInt = parseInt(days) || 30;

    // Get conversation stats
    const convStats = await pool.query(
      `
      SELECT 
        COUNT(*) as total_conversations,
        COUNT(CASE WHEN status = 'processed' THEN 1 END) as processed_conversations,
        COALESCE(AVG(message_count), 0) as avg_messages,
        COUNT(CASE WHEN device_type = 'mobile' THEN 1 END) as mobile_count,
        COUNT(CASE WHEN device_type = 'desktop' THEN 1 END) as desktop_count
      FROM conversations 
      WHERE store_id = $1 
        AND started_at > now() - interval '${daysInt} days'
    `,
      [storeDbId]
    );

    // Get top product interests
    const productInterests = await pool.query(
      `
      SELECT value, COUNT(*) as count
      FROM conv_insights
      WHERE store_id = $1 
        AND insight_type = 'product_interest'
        AND extracted_at > now() - interval '${daysInt} days'
      GROUP BY value
      ORDER BY count DESC
      LIMIT 10
    `,
      [storeDbId]
    );

    // Get top topics
    const topics = await pool.query(
      `
      SELECT value, COUNT(*) as count
      FROM conv_insights
      WHERE store_id = $1 
        AND insight_type = 'topic'
        AND extracted_at > now() - interval '${daysInt} days'
      GROUP BY value
      ORDER BY count DESC
      LIMIT 10
    `,
      [storeDbId]
    );

    // Get sentiment breakdown
    const sentiments = await pool.query(
      `
      SELECT value, COUNT(*) as count
      FROM conv_insights
      WHERE store_id = $1 
        AND insight_type = 'sentiment'
        AND extracted_at > now() - interval '${daysInt} days'
      GROUP BY value
    `,
      [storeDbId]
    );

    // Get recent unresolved questions
    const unresolved = await pool.query(
      `
      SELECT value, extracted_at
      FROM conv_insights
      WHERE store_id = $1 
        AND insight_type = 'unresolved'
        AND extracted_at > now() - interval '${daysInt} days'
      ORDER BY extracted_at DESC
      LIMIT 10
    `,
      [storeDbId]
    );

    // Get conversations per day
    const conversationsPerDay = await pool.query(
      `
      SELECT 
        DATE(started_at) as date,
        COUNT(*) as count
      FROM conversations
      WHERE store_id = $1 
        AND started_at > now() - interval '${daysInt} days'
      GROUP BY DATE(started_at)
      ORDER BY date ASC
    `,
      [storeDbId]
    );

    return res.json({
      ok: true,
      period_days: daysInt,
      stats: {
        total_conversations: parseInt(convStats.rows[0].total_conversations),
        processed_conversations: parseInt(
          convStats.rows[0].processed_conversations
        ),
        avg_messages_per_conversation: parseFloat(
          convStats.rows[0].avg_messages
        ).toFixed(1),
        mobile_percentage:
          convStats.rows[0].total_conversations > 0
            ? Math.round(
                (convStats.rows[0].mobile_count /
                  convStats.rows[0].total_conversations) *
                  100
              )
            : 0,
      },
      product_interests: productInterests.rows.map((r) => ({
        name: r.value,
        count: parseInt(r.count),
      })),
      topics: topics.rows.map((r) => ({
        name: r.value,
        count: parseInt(r.count),
      })),
      sentiment: {
        positive: parseInt(
          sentiments.rows.find((r) => r.value === "positive")?.count || 0
        ),
        neutral: parseInt(
          sentiments.rows.find((r) => r.value === "neutral")?.count || 0
        ),
        frustrated: parseInt(
          sentiments.rows.find((r) => r.value === "frustrated")?.count || 0
        ),
      },
      unresolved: unresolved.rows.map((r) => ({
        question: r.value,
        date: r.extracted_at,
      })),
      conversations_per_day: conversationsPerDay.rows.map((r) => ({
        date: r.date,
        count: parseInt(r.count),
      })),
    });
  } catch (err) {
    console.error("Error in /analytics/overview:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to get analytics" });
  }
});

/**
 * Get recent conversations
 */
router.get("/conversations", async (req, res) => {
  const { store_id, api_key, limit = 20, offset = 0 } = req.query || {};

  if (!store_id || !api_key) {
    return res
      .status(400)
      .json({ ok: false, error: "store_id and api_key are required" });
  }

  try {
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1 AND api_key = $2",
      [store_id, api_key]
    );

    if (storeRow.rowCount === 0) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const storeDbId = storeRow.rows[0].id;
    const limitInt = Math.min(parseInt(limit) || 20, 100);
    const offsetInt = parseInt(offset) || 0;

    const conversations = await pool.query(
      `
      SELECT 
        c.id, c.session_id, c.started_at, c.ended_at, 
        c.message_count, c.language, c.device_type, c.status
      FROM conversations c
      WHERE c.store_id = $1
      ORDER BY c.started_at DESC
      LIMIT $2 OFFSET $3
    `,
      [storeDbId, limitInt, offsetInt]
    );

    const result = [];
    for (const conv of conversations.rows) {
      const messages = await pool.query(
        `SELECT role, content, products_shown, created_at 
         FROM conv_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [conv.id]
      );

      const insights = await pool.query(
        `SELECT insight_type, value, confidence 
         FROM conv_insights WHERE conversation_id = $1`,
        [conv.id]
      );

      result.push({
        id: conv.id,
        started_at: conv.started_at,
        ended_at: conv.ended_at,
        message_count: conv.message_count,
        language: conv.language,
        device_type: conv.device_type,
        status: conv.status,
        messages: messages.rows,
        insights: insights.rows.map((i) => ({
          type: i.insight_type,
          value: i.value,
        })),
      });
    }

    const totalCount = await pool.query(
      "SELECT COUNT(*) FROM conversations WHERE store_id = $1",
      [storeDbId]
    );

    return res.json({
      ok: true,
      conversations: result,
      total: parseInt(totalCount.rows[0].count),
      limit: limitInt,
      offset: offsetInt,
    });
  } catch (err) {
    console.error("Error in /analytics/conversations:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to get conversations" });
  }
});

/**
 * Ask AI about customer insights
 */
router.post("/ask", async (req, res) => {
  const { store_id, api_key, question } = req.body || {};

  if (!store_id || !api_key || !question) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "store_id, api_key, and question are required",
      });
  }

  try {
    const storeRow = await pool.query(
      "SELECT id, store_name FROM stores WHERE store_id = $1 AND api_key = $2",
      [store_id, api_key]
    );

    if (storeRow.rowCount === 0) {
      return res.status(401).json({ ok: false, error: "Invalid credentials" });
    }

    const storeDbId = storeRow.rows[0].id;
    const storeName = storeRow.rows[0].store_name || "the store";

    // Gather data for AI analysis
    const productInterests = await pool.query(
      `
      SELECT value, COUNT(*) as count
      FROM conv_insights
      WHERE store_id = $1 AND insight_type = 'product_interest'
        AND extracted_at > now() - interval '90 days'
      GROUP BY value ORDER BY count DESC LIMIT 20
    `,
      [storeDbId]
    );

    const topics = await pool.query(
      `
      SELECT value, COUNT(*) as count
      FROM conv_insights
      WHERE store_id = $1 AND insight_type = 'topic'
        AND extracted_at > now() - interval '90 days'
      GROUP BY value ORDER BY count DESC LIMIT 20
    `,
      [storeDbId]
    );

    const sentiments = await pool.query(
      `
      SELECT value, COUNT(*) as count
      FROM conv_insights
      WHERE store_id = $1 AND insight_type = 'sentiment'
        AND extracted_at > now() - interval '90 days'
      GROUP BY value
    `,
      [storeDbId]
    );

    const unresolvedQuestions = await pool.query(
      `
      SELECT value, extracted_at
      FROM conv_insights
      WHERE store_id = $1 AND insight_type = 'unresolved'
        AND extracted_at > now() - interval '90 days'
      ORDER BY extracted_at DESC LIMIT 20
    `,
      [storeDbId]
    );

    const convStats = await pool.query(
      `
      SELECT 
        COUNT(*) as total,
        AVG(message_count) as avg_messages,
        COUNT(CASE WHEN device_type = 'mobile' THEN 1 END) as mobile_count
      FROM conversations 
      WHERE store_id = $1 AND started_at > now() - interval '90 days'
    `,
      [storeDbId]
    );

    // Get sample conversations
    const recentConversations = await pool.query(
      `
      SELECT c.id, c.started_at, c.message_count
      FROM conversations c
      WHERE c.store_id = $1 AND c.status = 'processed'
      ORDER BY c.started_at DESC LIMIT 10
    `,
      [storeDbId]
    );

    let conversationSamples = [];
    for (const conv of recentConversations.rows.slice(0, 5)) {
      const messages = await pool.query(
        `SELECT role, content FROM conv_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [conv.id]
      );
      conversationSamples.push({
        date: conv.started_at,
        messages: messages.rows
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n"),
      });
    }

    // Build context
    const dataContext = `
## CUSTOMER ANALYTICS DATA (Last 90 days)

### Conversation Statistics
- Total conversations: ${convStats.rows[0]?.total || 0}
- Average messages per conversation: ${parseFloat(
      convStats.rows[0]?.avg_messages || 0
    ).toFixed(1)}
- Mobile users: ${
      convStats.rows[0]?.total > 0
        ? Math.round(
            (convStats.rows[0]?.mobile_count / convStats.rows[0]?.total) * 100
          )
        : 0
    }%

### Product Interests
${
  productInterests.rows.length > 0
    ? productInterests.rows
        .map((r) => `- ${r.value}: ${r.count} times`)
        .join("\n")
    : "- No product interest data yet"
}

### Common Topics
${
  topics.rows.length > 0
    ? topics.rows.map((r) => `- ${r.value}: ${r.count} times`).join("\n")
    : "- No topic data yet"
}

### Customer Sentiment
${
  sentiments.rows.length > 0
    ? sentiments.rows
        .map((r) => `- ${r.value}: ${r.count} conversations`)
        .join("\n")
    : "- No sentiment data yet"
}

### Unresolved Questions
${
  unresolvedQuestions.rows.length > 0
    ? unresolvedQuestions.rows
        .map(
          (r) =>
            `- "${r.value}" (${new Date(r.extracted_at).toLocaleDateString()})`
        )
        .join("\n")
    : "- No unresolved questions recorded"
}

### Sample Recent Conversations
${
  conversationSamples.length > 0
    ? conversationSamples
        .map(
          (c, i) => `
**Conversation ${i + 1}** (${new Date(c.date).toLocaleDateString()}):
${c.messages}
`
        )
        .join("\n---\n")
    : "No conversation samples available yet"
}
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert business analyst helping a store owner understand their customer conversations. 
You have access to aggregated insights and sample conversations from their AI chat assistant.

Your role:
- Answer questions about customer behavior, interests, and feedback
- Provide actionable insights based on the data
- Be specific and reference the actual data when possible
- If there's not enough data to answer confidently, say so
- Be concise but thorough
- Use bullet points and clear formatting for readability
- Focus on business-relevant insights

The store is called "${storeName}".`,
        },
        {
          role: "user",
          content: `Here is the customer analytics data:\n${dataContext}\n\n---\n\nStore owner's question: ${question}`,
        },
      ],
      temperature: 0.4,
      max_tokens: 1000,
    });

    const answer =
      completion.choices[0]?.message?.content ||
      "I couldn't generate an analysis. Please try again.";

    return res.json({
      ok: true,
      answer,
      data_summary: {
        conversations_analyzed: parseInt(convStats.rows[0]?.total || 0),
        product_interests_found: productInterests.rows.length,
        topics_found: topics.rows.length,
      },
    });
  } catch (err) {
    console.error("Error in /analytics/ask:", err);
    return res.status(500).json({ ok: false, error: "Failed to analyze data" });
  }
});

module.exports = router;
