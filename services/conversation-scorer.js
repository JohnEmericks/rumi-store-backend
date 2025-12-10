/**
 * Conversation Scorer
 *
 * Calculates quality scores for conversations based on various signals.
 * Used to track AI performance over time and flag problematic conversations.
 */

const { pool } = require("../config/database");

/**
 * Scoring configuration
 */
const SCORING_CONFIG = {
  BASE_SCORE: 50,

  // Positive signals
  PURCHASE_INTENT: 20, // User wants to buy
  USER_SATISFACTION: 15, // "tack", "perfekt", etc.
  GOOD_LENGTH: 10, // 4-10 messages (engaged)
  PRODUCTS_SHOWN: 5, // Products were displayed
  NATURAL_ENDING: 5, // Thanks/goodbye

  // Negative signals
  REPEATED_QUESTION: -15, // User asked same thing twice
  MULTIPLE_REJECTIONS: -10, // 2+ rejections
  ABANDONED: -10, // Ended abruptly
  CONTACT_FALLBACK: -10, // Asked for human contact
  VERY_SHORT: -5, // 1-2 messages, no resolution

  // Thresholds
  FLAG_THRESHOLD: 50, // Score below this gets flagged
  GOOD_LENGTH_MIN: 4,
  GOOD_LENGTH_MAX: 10,
};

/**
 * Patterns for detecting signals in messages
 */
const PATTERNS = {
  // Swedish and English
  purchase_intent: [
    /\b(köp|köpa|beställ|beställa|ta den|tar den|tar det|jag tar|vill ha)\b/i,
    /\b(buy|purchase|order|i'll take|i want|add to cart)\b/i,
  ],
  satisfaction: [
    /\b(tack|tackar|perfekt|jättebra|toppen|underbart|fantastiskt|bra|fint|härligt)\b/i,
    /\b(thanks|thank you|perfect|great|awesome|wonderful|excellent|amazing)\b/i,
  ],
  rejection: [
    /\b(nej|nope|inte|inget|något annat|annan|andra|fel)\b/i,
    /\b(no|nope|not|none|something else|different|other|wrong)\b/i,
  ],
  contact_request: [
    /\b(kontakt|telefon|ring|maila|email|prata med|människa)\b/i,
    /\b(contact|phone|call|email|speak to|human|person|someone)\b/i,
  ],
  goodbye: [/\b(hejdå|adjö|vi ses|ha det|bye|goodbye|see you|take care)\b/i],
};

/**
 * Calculate similarity between two messages (for detecting repeated questions)
 */
function messageSimilarity(msg1, msg2) {
  const words1 = msg1
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  const words2 = msg2
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (words1.length === 0 || words2.length === 0) return 0;

  const set1 = new Set(words1);
  const set2 = new Set(words2);
  const intersection = [...set1].filter((w) => set2.has(w));
  const union = new Set([...words1, ...words2]);

  return intersection.length / union.size;
}

/**
 * Check if a message matches any pattern in a list
 */
function matchesPatterns(message, patterns) {
  return patterns.some((pattern) => pattern.test(message));
}

/**
 * Score a conversation
 *
 * @param {Array} messages - Array of {role, content, products_shown}
 * @returns {Object} - {score, breakdown, flagged, flag_reasons}
 */
function scoreConversation(messages) {
  const breakdown = {
    base_score: SCORING_CONFIG.BASE_SCORE,
    purchase_intent: false,
    user_satisfaction: false,
    good_length: false,
    products_shown: false,
    natural_ending: false,
    repeated_question: false,
    multiple_rejections: false,
    abandoned: false,
    contact_fallback: false,
    very_short: false,
  };

  let score = SCORING_CONFIG.BASE_SCORE;
  const flag_reasons = [];

  // Filter user and assistant messages
  const userMessages = messages.filter((m) => m.role === "user");
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const totalMessages = messages.length;

  // === POSITIVE SIGNALS ===

  // Purchase intent
  for (const msg of userMessages) {
    if (matchesPatterns(msg.content, PATTERNS.purchase_intent)) {
      breakdown.purchase_intent = true;
      score += SCORING_CONFIG.PURCHASE_INTENT;
      break;
    }
  }

  // User satisfaction
  for (const msg of userMessages) {
    if (matchesPatterns(msg.content, PATTERNS.satisfaction)) {
      breakdown.user_satisfaction = true;
      score += SCORING_CONFIG.USER_SATISFACTION;
      break;
    }
  }

  // Good conversation length
  if (
    totalMessages >= SCORING_CONFIG.GOOD_LENGTH_MIN &&
    totalMessages <= SCORING_CONFIG.GOOD_LENGTH_MAX
  ) {
    breakdown.good_length = true;
    score += SCORING_CONFIG.GOOD_LENGTH;
  }

  // Products were shown
  const productsShown = assistantMessages.some(
    (m) => m.products_shown && m.products_shown.length > 0
  );
  if (productsShown) {
    breakdown.products_shown = true;
    score += SCORING_CONFIG.PRODUCTS_SHOWN;
  }

  // Natural ending (last user message was thanks/goodbye)
  if (userMessages.length > 0) {
    const lastUserMsg = userMessages[userMessages.length - 1];
    if (
      matchesPatterns(lastUserMsg.content, PATTERNS.goodbye) ||
      matchesPatterns(lastUserMsg.content, PATTERNS.satisfaction)
    ) {
      breakdown.natural_ending = true;
      score += SCORING_CONFIG.NATURAL_ENDING;
    }
  }

  // === NEGATIVE SIGNALS ===

  // Repeated question (user asked similar thing twice)
  for (let i = 1; i < userMessages.length; i++) {
    for (let j = 0; j < i; j++) {
      const similarity = messageSimilarity(
        userMessages[i].content,
        userMessages[j].content
      );
      if (similarity > 0.6) {
        breakdown.repeated_question = true;
        score += SCORING_CONFIG.REPEATED_QUESTION;
        flag_reasons.push("User repeated a similar question");
        break;
      }
    }
    if (breakdown.repeated_question) break;
  }

  // Multiple rejections
  let rejectionCount = 0;
  for (const msg of userMessages) {
    if (matchesPatterns(msg.content, PATTERNS.rejection)) {
      rejectionCount++;
    }
  }
  if (rejectionCount >= 2) {
    breakdown.multiple_rejections = true;
    score += SCORING_CONFIG.MULTIPLE_REJECTIONS;
    flag_reasons.push(`User rejected suggestions ${rejectionCount} times`);
  }

  // Contact fallback (user gave up and asked for human)
  for (const msg of userMessages) {
    if (matchesPatterns(msg.content, PATTERNS.contact_request)) {
      breakdown.contact_fallback = true;
      score += SCORING_CONFIG.CONTACT_FALLBACK;
      flag_reasons.push("User asked for human contact");
      break;
    }
  }

  // Very short conversation (possible failure)
  // Only flag if it's not just a greeting exchange
  if (totalMessages <= 2 && !breakdown.natural_ending) {
    const isJustGreeting =
      userMessages.length === 1 &&
      /^(hej|hi|hello|hey)[\s!.,?]*$/i.test(userMessages[0].content.trim());

    if (!isJustGreeting) {
      breakdown.very_short = true;
      score += SCORING_CONFIG.VERY_SHORT;
      flag_reasons.push("Very short conversation without resolution");
    }
  }

  // Abandoned (no natural ending and not very engaged)
  if (
    !breakdown.natural_ending &&
    !breakdown.purchase_intent &&
    !breakdown.user_satisfaction &&
    totalMessages >= 3
  ) {
    // Check if last message was from user (they left without AI resolution)
    if (messages.length > 0 && messages[messages.length - 1].role === "user") {
      breakdown.abandoned = true;
      score += SCORING_CONFIG.ABANDONED;
      flag_reasons.push("Conversation ended abruptly");
    }
  }

  // Clamp score to 0-100
  score = Math.max(0, Math.min(100, score));

  // Determine if flagged
  const flagged = score < SCORING_CONFIG.FLAG_THRESHOLD;

  return {
    score: Math.round(score),
    breakdown,
    flagged,
    flag_reasons,
    message_count: totalMessages,
    user_message_count: userMessages.length,
  };
}

/**
 * Score and update a conversation in the database
 *
 * @param {number} conversationId - The conversation ID
 * @returns {Object} - The scoring result
 */
async function scoreAndUpdateConversation(conversationId) {
  try {
    // Get conversation messages
    const messagesResult = await pool.query(
      `SELECT role, content, products_shown 
       FROM conversation_messages 
       WHERE conversation_id = $1 
       ORDER BY created_at ASC`,
      [conversationId]
    );

    if (messagesResult.rowCount === 0) {
      return { success: false, error: "No messages found" };
    }

    const messages = messagesResult.rows;
    const result = scoreConversation(messages);

    // Update conversation with score
    await pool.query(
      `UPDATE conversations 
       SET quality_score = $1, 
           score_breakdown = $2, 
           flagged = $3,
           flag_reasons = $4
       WHERE id = $5`,
      [
        result.score,
        JSON.stringify(result.breakdown),
        result.flagged,
        JSON.stringify(result.flag_reasons),
        conversationId,
      ]
    );

    return { success: true, ...result };
  } catch (err) {
    console.error("Error scoring conversation:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get quality statistics for a time period
 *
 * @param {string} period - 'today', 'week', 'month', 'all'
 * @param {number} storeId - Optional store ID filter
 * @returns {Object} - Statistics
 */
async function getQualityStats(period = "week", storeId = null) {
  try {
    let dateFilter = "";
    switch (period) {
      case "today":
        dateFilter = "AND c.started_at >= CURRENT_DATE";
        break;
      case "week":
        dateFilter = "AND c.started_at >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case "month":
        dateFilter = "AND c.started_at >= CURRENT_DATE - INTERVAL '30 days'";
        break;
      default:
        dateFilter = "";
    }

    const storeFilter = storeId ? `AND c.store_id = ${parseInt(storeId)}` : "";

    // Overall stats
    const statsResult = await pool.query(`
      SELECT 
        COUNT(*) as total_conversations,
        AVG(quality_score) as avg_score,
        COUNT(CASE WHEN flagged = true THEN 1 END) as flagged_count,
        COUNT(CASE WHEN quality_score >= 80 THEN 1 END) as excellent_count,
        COUNT(CASE WHEN quality_score >= 60 AND quality_score < 80 THEN 1 END) as good_count,
        COUNT(CASE WHEN quality_score >= 40 AND quality_score < 60 THEN 1 END) as okay_count,
        COUNT(CASE WHEN quality_score < 40 THEN 1 END) as poor_count
      FROM conversations c
      WHERE quality_score IS NOT NULL
      ${dateFilter}
      ${storeFilter}
    `);

    // Previous period for comparison
    let prevDateFilter = "";
    switch (period) {
      case "today":
        prevDateFilter =
          "AND c.started_at >= CURRENT_DATE - INTERVAL '1 day' AND c.started_at < CURRENT_DATE";
        break;
      case "week":
        prevDateFilter =
          "AND c.started_at >= CURRENT_DATE - INTERVAL '14 days' AND c.started_at < CURRENT_DATE - INTERVAL '7 days'";
        break;
      case "month":
        prevDateFilter =
          "AND c.started_at >= CURRENT_DATE - INTERVAL '60 days' AND c.started_at < CURRENT_DATE - INTERVAL '30 days'";
        break;
      default:
        prevDateFilter = "";
    }

    const prevStatsResult = await pool.query(`
      SELECT AVG(quality_score) as avg_score
      FROM conversations c
      WHERE quality_score IS NOT NULL
      ${prevDateFilter}
      ${storeFilter}
    `);

    const stats = statsResult.rows[0];
    const prevStats = prevStatsResult.rows[0];

    const currentAvg = parseFloat(stats.avg_score) || 0;
    const prevAvg = parseFloat(prevStats.avg_score) || 0;
    const trend = prevAvg > 0 ? currentAvg - prevAvg : 0;

    return {
      success: true,
      period,
      total_conversations: parseInt(stats.total_conversations) || 0,
      avg_score: Math.round(currentAvg),
      trend: Math.round(trend * 10) / 10,
      flagged_count: parseInt(stats.flagged_count) || 0,
      distribution: {
        excellent: parseInt(stats.excellent_count) || 0, // 80-100
        good: parseInt(stats.good_count) || 0, // 60-79
        okay: parseInt(stats.okay_count) || 0, // 40-59
        poor: parseInt(stats.poor_count) || 0, // 0-39
      },
    };
  } catch (err) {
    console.error("Error getting quality stats:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get flagged conversations for review
 *
 * @param {number} limit - Max number to return
 * @param {boolean} includeReviewed - Include already reviewed
 * @returns {Array} - Flagged conversations
 */
async function getFlaggedConversations(limit = 20, includeReviewed = false) {
  try {
    const reviewedFilter = includeReviewed
      ? ""
      : "AND (c.reviewed = false OR c.reviewed IS NULL)";

    const result = await pool.query(
      `
      SELECT 
        c.id,
        c.session_id,
        c.quality_score,
        c.flag_reasons,
        c.message_count,
        c.started_at,
        c.ended_at,
        c.reviewed,
        s.store_name,
        s.store_id as store_identifier
      FROM conversations c
      JOIN stores s ON c.store_id = s.id
      WHERE c.flagged = true
      ${reviewedFilter}
      ORDER BY c.started_at DESC
      LIMIT $1
    `,
      [limit]
    );

    return { success: true, conversations: result.rows };
  } catch (err) {
    console.error("Error getting flagged conversations:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Get full conversation with messages for review
 *
 * @param {number} conversationId - The conversation ID
 * @returns {Object} - Conversation with messages
 */
async function getConversationForReview(conversationId) {
  try {
    // Get conversation
    const convResult = await pool.query(
      `
      SELECT 
        c.*,
        s.store_name,
        s.store_id as store_identifier
      FROM conversations c
      JOIN stores s ON c.store_id = s.id
      WHERE c.id = $1
    `,
      [conversationId]
    );

    if (convResult.rowCount === 0) {
      return { success: false, error: "Conversation not found" };
    }

    // Get messages
    const messagesResult = await pool.query(
      `
      SELECT role, content, products_shown, created_at
      FROM conversation_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `,
      [conversationId]
    );

    return {
      success: true,
      conversation: convResult.rows[0],
      messages: messagesResult.rows,
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
 * @returns {Object} - Result
 */
async function markAsReviewed(conversationId) {
  try {
    await pool.query(`UPDATE conversations SET reviewed = true WHERE id = $1`, [
      conversationId,
    ]);
    return { success: true };
  } catch (err) {
    console.error("Error marking as reviewed:", err);
    return { success: false, error: err.message };
  }
}

module.exports = {
  scoreConversation,
  scoreAndUpdateConversation,
  getQualityStats,
  getFlaggedConversations,
  getConversationForReview,
  markAsReviewed,
  SCORING_CONFIG,
};
