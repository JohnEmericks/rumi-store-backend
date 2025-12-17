/**
 * Conversation Scorer Service
 *
 * Scores conversations for quality and flags issues.
 * Used for analytics and quality monitoring.
 */

const { pool } = require("../config/database");
const { openai } = require("./embedding");

/**
 * Score a conversation based on various quality metrics
 *
 * @param {number} conversationId - The conversation ID to score
 * @returns {Object} Scoring result with score, flags, and breakdown
 */
async function scoreAndUpdateConversation(conversationId) {
  try {
    // Get conversation messages
    const messagesResult = await pool.query(
      `SELECT role, content, products_shown, created_at 
       FROM conv_messages 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC`,
      [conversationId]
    );

    if (messagesResult.rowCount < 2) {
      return { success: false, error: "Too few messages to score" };
    }

    const messages = messagesResult.rows;
    const conversationText = messages
      .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`)
      .join("\n\n");

    // Use AI to score the conversation
    const scoringPrompt = `Analyze this customer service conversation and score it.

CONVERSATION:
${conversationText}

Score the conversation on these criteria (0-100 each):

1. **Helpfulness**: Did the assistant understand and address the customer's needs?
2. **Tone**: Was the tone appropriate, friendly, and professional?
3. **Accuracy**: Were product recommendations and information accurate based on context?
4. **Efficiency**: Was the conversation concise without being rushed?
5. **Resolution**: Was the customer's query resolved or properly handled?

Also flag any issues:
- Did the assistant make up information?
- Was there any inappropriate content?
- Did the assistant fail to understand a clear request?
- Was the customer clearly frustrated?

Respond in JSON format:
{
  "scores": {
    "helpfulness": <0-100>,
    "tone": <0-100>,
    "accuracy": <0-100>,
    "efficiency": <0-100>,
    "resolution": <0-100>
  },
  "overall_score": <0-100>,
  "flags": [<array of issue strings, empty if none>],
  "summary": "<brief 1-2 sentence summary of conversation quality>"
}

JSON:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are an expert at evaluating customer service conversations. Always respond with valid JSON only.",
        },
        { role: "user", content: scoringPrompt },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });

    const responseText = completion.choices[0]?.message?.content || "{}";

    let scoring;
    try {
      const cleanJson = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      scoring = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error(
        `Conversation ${conversationId}: Failed to parse scoring JSON:`,
        responseText
      );
      return { success: false, error: "Failed to parse scoring response" };
    }

    const overallScore = scoring.overall_score || 0;
    const isFlagged = scoring.flags && scoring.flags.length > 0;

    // Update the conversation with the score
    await pool.query(
      `UPDATE conversations 
       SET quality_score = $1, 
           quality_flags = $2,
           quality_summary = $3,
           scored_at = now()
       WHERE id = $4`,
      [
        overallScore,
        JSON.stringify(scoring.flags || []),
        scoring.summary || null,
        conversationId,
      ]
    );

    return {
      success: true,
      score: overallScore,
      flagged: isFlagged,
      flags: scoring.flags || [],
      breakdown: scoring.scores || {},
      summary: scoring.summary || null,
    };
  } catch (err) {
    console.error(`Error scoring conversation ${conversationId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Get quality statistics for a store
 *
 * @param {number} storeDbId - The store's database ID
 * @param {number} days - Number of days to analyze
 * @returns {Object} Quality statistics
 */
async function getQualityStats(storeDbId, days = 30) {
  try {
    const stats = await pool.query(
      `SELECT 
        COUNT(*) as total_scored,
        AVG(quality_score) as avg_score,
        COUNT(CASE WHEN quality_score >= 80 THEN 1 END) as excellent_count,
        COUNT(CASE WHEN quality_score >= 60 AND quality_score < 80 THEN 1 END) as good_count,
        COUNT(CASE WHEN quality_score >= 40 AND quality_score < 60 THEN 1 END) as fair_count,
        COUNT(CASE WHEN quality_score < 40 THEN 1 END) as poor_count,
        COUNT(CASE WHEN quality_flags IS NOT NULL AND quality_flags != '[]' THEN 1 END) as flagged_count
       FROM conversations 
       WHERE store_id = $1 
         AND scored_at IS NOT NULL
         AND started_at > now() - interval '${days} days'`,
      [storeDbId]
    );

    const row = stats.rows[0];

    return {
      success: true,
      period_days: days,
      total_scored: parseInt(row.total_scored) || 0,
      average_score: parseFloat(row.avg_score || 0).toFixed(1),
      distribution: {
        excellent: parseInt(row.excellent_count) || 0,
        good: parseInt(row.good_count) || 0,
        fair: parseInt(row.fair_count) || 0,
        poor: parseInt(row.poor_count) || 0,
      },
      flagged_count: parseInt(row.flagged_count) || 0,
    };
  } catch (err) {
    console.error("Error getting quality stats:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get flagged conversations for review
 *
 * @param {number} storeDbId - The store's database ID
 * @param {number} limit - Maximum number to return
 * @returns {Array} Flagged conversations
 */
async function getFlaggedConversations(storeDbId, limit = 20) {
  try {
    const result = await pool.query(
      `SELECT 
        c.id,
        c.session_id,
        c.started_at,
        c.message_count,
        c.quality_score,
        c.quality_flags,
        c.quality_summary,
        c.reviewed_at
       FROM conversations c
       WHERE c.store_id = $1 
         AND c.quality_flags IS NOT NULL 
         AND c.quality_flags != '[]'
       ORDER BY c.started_at DESC
       LIMIT $2`,
      [storeDbId, limit]
    );

    return {
      success: true,
      conversations: result.rows.map((row) => ({
        id: row.id,
        session_id: row.session_id,
        started_at: row.started_at,
        message_count: row.message_count,
        score: row.quality_score,
        flags: JSON.parse(row.quality_flags || "[]"),
        summary: row.quality_summary,
        reviewed: !!row.reviewed_at,
      })),
    };
  } catch (err) {
    console.error("Error getting flagged conversations:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get a conversation with full details for review
 *
 * @param {number} conversationId - The conversation ID
 * @param {number} storeDbId - The store's database ID (for authorization)
 * @returns {Object} Full conversation details
 */
async function getConversationForReview(conversationId, storeDbId) {
  try {
    // Verify conversation belongs to store
    const convResult = await pool.query(
      `SELECT 
        c.id,
        c.session_id,
        c.started_at,
        c.ended_at,
        c.message_count,
        c.language,
        c.device_type,
        c.quality_score,
        c.quality_flags,
        c.quality_summary,
        c.reviewed_at,
        c.reviewer_notes
       FROM conversations c
       WHERE c.id = $1 AND c.store_id = $2`,
      [conversationId, storeDbId]
    );

    if (convResult.rowCount === 0) {
      return { success: false, error: "Conversation not found" };
    }

    const conv = convResult.rows[0];

    // Get messages
    const messagesResult = await pool.query(
      `SELECT role, content, products_shown, created_at 
       FROM conv_messages 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC`,
      [conversationId]
    );

    // Get insights
    const insightsResult = await pool.query(
      `SELECT insight_type, value, confidence 
       FROM conv_insights 
       WHERE conversation_id = $1`,
      [conversationId]
    );

    return {
      success: true,
      conversation: {
        id: conv.id,
        session_id: conv.session_id,
        started_at: conv.started_at,
        ended_at: conv.ended_at,
        message_count: conv.message_count,
        language: conv.language,
        device_type: conv.device_type,
        quality: {
          score: conv.quality_score,
          flags: JSON.parse(conv.quality_flags || "[]"),
          summary: conv.quality_summary,
        },
        review: {
          reviewed_at: conv.reviewed_at,
          notes: conv.reviewer_notes,
        },
        messages: messagesResult.rows,
        insights: insightsResult.rows.map((i) => ({
          type: i.insight_type,
          value: i.value,
          confidence: i.confidence,
        })),
      },
    };
  } catch (err) {
    console.error("Error getting conversation for review:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Mark a conversation as reviewed
 *
 * @param {number} conversationId - The conversation ID
 * @param {number} storeDbId - The store's database ID
 * @param {string} notes - Optional reviewer notes
 * @returns {Object} Result
 */
async function markAsReviewed(conversationId, storeDbId, notes = null) {
  try {
    const result = await pool.query(
      `UPDATE conversations 
       SET reviewed_at = now(), reviewer_notes = $1
       WHERE id = $2 AND store_id = $3
       RETURNING id`,
      [notes, conversationId, storeDbId]
    );

    if (result.rowCount === 0) {
      return { success: false, error: "Conversation not found" };
    }

    return { success: true, conversation_id: conversationId };
  } catch (err) {
    console.error("Error marking conversation as reviewed:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Batch score unscored conversations
 *
 * @param {number} limit - Maximum number to process
 * @returns {Object} Processing result
 */
async function batchScoreConversations(limit = 10) {
  try {
    const result = await pool.query(
      `SELECT id, store_id 
       FROM conversations 
       WHERE status IN ('ended', 'processed')
         AND scored_at IS NULL
         AND message_count >= 2
       ORDER BY ended_at ASC
       LIMIT $1`,
      [limit]
    );

    if (result.rowCount === 0) {
      return { success: true, processed: 0 };
    }

    let processed = 0;
    let errors = 0;

    for (const row of result.rows) {
      const scoreResult = await scoreAndUpdateConversation(row.id);
      if (scoreResult.success) {
        processed++;
      } else {
        errors++;
      }
    }

    return {
      success: true,
      processed,
      errors,
      total: result.rowCount,
    };
  } catch (err) {
    console.error("Error batch scoring conversations:", err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  scoreAndUpdateConversation,
  getQualityStats,
  getFlaggedConversations,
  getConversationForReview,
  markAsReviewed,
  batchScoreConversations,
};
