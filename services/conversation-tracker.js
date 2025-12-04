/**
 * Conversation Tracker Service
 *
 * Handles conversation storage and lifecycle.
 */

const { pool } = require("../config/database");

/**
 * Get or create a conversation for the given session
 */
async function getOrCreateConversation(
  storeDbId,
  sessionId,
  language,
  deviceType
) {
  try {
    // Try to find existing active conversation
    const existing = await pool.query(
      `SELECT id, message_count FROM conversations 
       WHERE store_id = $1 AND session_id = $2 AND status = 'active'`,
      [storeDbId, sessionId]
    );

    if (existing.rowCount > 0) {
      return existing.rows[0];
    }

    // Create new conversation
    const result = await pool.query(
      `INSERT INTO conversations (store_id, session_id, language, device_type, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING id, message_count`,
      [storeDbId, sessionId, language || null, deviceType || null]
    );

    return result.rows[0];
  } catch (err) {
    console.error("Error in getOrCreateConversation:", err);
    return null;
  }
}

/**
 * Save a message to a conversation
 */
async function saveConversationMessage(
  conversationId,
  role,
  content,
  productsShown = []
) {
  try {
    await pool.query(
      `INSERT INTO conv_messages (conversation_id, role, content, products_shown)
       VALUES ($1, $2, $3, $4)`,
      [
        conversationId,
        role,
        content,
        productsShown.length > 0 ? productsShown : null,
      ]
    );

    // Update message count
    await pool.query(
      `UPDATE conversations SET message_count = message_count + 1 WHERE id = $1`,
      [conversationId]
    );
  } catch (err) {
    console.error("Error in saveConversationMessage:", err);
  }
}

/**
 * Mark a conversation as ended
 */
async function endConversation(conversationId) {
  try {
    await pool.query(
      `UPDATE conversations SET status = 'ended', ended_at = now() WHERE id = $1`,
      [conversationId]
    );
  } catch (err) {
    console.error("Error in endConversation:", err);
  }
}

/**
 * Get the internal store database ID from the public store_id
 */
async function getStoreDbId(storeId) {
  try {
    const result = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [storeId]
    );
    return result.rowCount > 0 ? result.rows[0].id : null;
  } catch (err) {
    console.error("Error in getStoreDbId:", err);
    return null;
  }
}

/**
 * Check for inactive conversations and mark them as ended
 */
async function cleanupInactiveConversations(inactiveMinutes = 15) {
  try {
    const result = await pool.query(`
      UPDATE conversations c
      SET status = 'ended', ended_at = now()
      WHERE c.status = 'active'
        AND c.id IN (
          SELECT conversation_id 
          FROM conv_messages 
          GROUP BY conversation_id 
          HAVING MAX(created_at) < now() - interval '${inactiveMinutes} minutes'
        )
      RETURNING id, store_id, message_count
    `);

    if (result.rowCount > 0) {
      console.log(`Marked ${result.rowCount} inactive conversations as ended`);
    }

    return result.rows;
  } catch (err) {
    console.error("Error in cleanupInactiveConversations:", err);
    return [];
  }
}

module.exports = {
  getOrCreateConversation,
  saveConversationMessage,
  endConversation,
  getStoreDbId,
  cleanupInactiveConversations,
};
