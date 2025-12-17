/**
 * Customer Memory Service
 *
 * Stores and retrieves customer context across sessions.
 * Enables personalized conversations based on past interactions.
 *
 * Memory types:
 * - interest: Products/categories customer showed interest in
 * - preference: Stated preferences (colors, styles, price range)
 * - constraint: Budget, timeline, recipient info
 * - behavior: Conversation patterns (quick decision maker, browsers, etc.)
 */

const { pool } = require("../config/database");
const { openai } = require("./embedding");

/**
 * Memory types and their retention periods
 */
const MEMORY_TYPES = {
  INTEREST: "interest", // Product/category interests
  PREFERENCE: "preference", // Stated preferences
  CONSTRAINT: "constraint", // Budget, timeline, etc.
  PURCHASE_CONTEXT: "purchase_context", // Gift for, occasion, etc.
  BEHAVIOR: "behavior", // How they shop
};

const MEMORY_TTL_DAYS = {
  [MEMORY_TYPES.INTEREST]: 90,
  [MEMORY_TYPES.PREFERENCE]: 180,
  [MEMORY_TYPES.CONSTRAINT]: 30,
  [MEMORY_TYPES.PURCHASE_CONTEXT]: 60,
  [MEMORY_TYPES.BEHAVIOR]: 180,
};

/**
 * Initialize customer memory table
 */
async function initCustomerMemoryTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_memory (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        key TEXT,
        value TEXT NOT NULL,
        confidence FLOAT DEFAULT 0.8,
        source_conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        last_seen TIMESTAMPTZ DEFAULT now(),
        mention_count INTEGER DEFAULT 1,
        UNIQUE (store_id, customer_id, memory_type, key, value)
      );
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_memory_lookup 
      ON customer_memory(store_id, customer_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_customer_memory_type 
      ON customer_memory(memory_type);
    `);

    console.log("✅ Customer memory table initialized");
  } catch (err) {
    console.error("Error initializing customer memory table:", err);
  }
}

/**
 * Get or create a customer identifier
 * Uses session fingerprint, user email, or generated ID
 */
function getCustomerId(sessionId, userEmail = null, fingerprint = null) {
  // Prefer email (most stable)
  if (userEmail) {
    return `email:${userEmail.toLowerCase()}`;
  }

  // Then fingerprint if available
  if (fingerprint) {
    return `fp:${fingerprint}`;
  }

  // Fall back to session-based (least reliable for returning customers)
  // In production, you'd want to implement proper fingerprinting
  return `session:${sessionId}`;
}

/**
 * Load customer memories for a session
 *
 * @param {number} storeDbId - Store database ID
 * @param {string} customerId - Customer identifier
 * @param {number} limit - Max memories to return
 * @returns {Promise<Array>} Customer memories
 */
async function loadCustomerMemories(storeDbId, customerId, limit = 10) {
  try {
    const result = await pool.query(
      `
      SELECT 
        memory_type,
        key,
        value,
        confidence,
        mention_count,
        last_seen,
        created_at
      FROM customer_memory
      WHERE store_id = $1 
        AND customer_id = $2
        AND last_seen > now() - interval '180 days'
      ORDER BY 
        confidence DESC,
        mention_count DESC,
        last_seen DESC
      LIMIT $3
    `,
      [storeDbId, customerId, limit]
    );

    return result.rows;
  } catch (err) {
    console.error("Error loading customer memories:", err);
    return [];
  }
}

/**
 * Format memories for injection into system prompt
 */
function formatMemoriesForPrompt(memories, language = "Swedish") {
  if (!memories || memories.length === 0) {
    return null;
  }

  const sv = language === "Swedish";

  // Group by type
  const grouped = {
    interests: [],
    preferences: [],
    constraints: [],
    context: [],
  };

  for (const memory of memories) {
    const daysAgo = Math.floor(
      (Date.now() - new Date(memory.last_seen).getTime()) /
        (1000 * 60 * 60 * 24)
    );

    const timeLabel =
      daysAgo === 0
        ? sv
          ? "idag"
          : "today"
        : daysAgo === 1
        ? sv
          ? "igår"
          : "yesterday"
        : sv
        ? `${daysAgo} dagar sedan`
        : `${daysAgo} days ago`;

    const entry = {
      value: memory.value,
      key: memory.key,
      time: timeLabel,
      mentions: memory.mention_count,
    };

    switch (memory.memory_type) {
      case MEMORY_TYPES.INTEREST:
        grouped.interests.push(entry);
        break;
      case MEMORY_TYPES.PREFERENCE:
        grouped.preferences.push(entry);
        break;
      case MEMORY_TYPES.CONSTRAINT:
        grouped.constraints.push(entry);
        break;
      case MEMORY_TYPES.PURCHASE_CONTEXT:
        grouped.context.push(entry);
        break;
    }
  }

  const parts = [];

  if (sv) {
    parts.push("## ÅTERVÄNDANDE KUND - TIDIGARE KONTEXT");
    parts.push(
      "Denna kund har besökt tidigare. Använd denna info för att personalisera konversationen:\n"
    );
  } else {
    parts.push("## RETURNING CUSTOMER - PREVIOUS CONTEXT");
    parts.push(
      "This customer has visited before. Use this info to personalize the conversation:\n"
    );
  }

  if (grouped.interests.length > 0) {
    parts.push(sv ? "**Tidigare intressen:**" : "**Previous interests:**");
    grouped.interests.slice(0, 5).forEach((i) => {
      const mentions =
        i.mentions > 1 ? ` (${sv ? "nämnt" : "mentioned"} ${i.mentions}x)` : "";
      parts.push(`- ${i.value}${mentions} - ${i.time}`);
    });
    parts.push("");
  }

  if (grouped.preferences.length > 0) {
    parts.push(sv ? "**Uttryckta preferenser:**" : "**Stated preferences:**");
    grouped.preferences.slice(0, 3).forEach((p) => {
      parts.push(`- ${p.key ? `${p.key}: ` : ""}${p.value}`);
    });
    parts.push("");
  }

  if (grouped.constraints.length > 0) {
    parts.push(sv ? "**Kända begränsningar:**" : "**Known constraints:**");
    grouped.constraints.slice(0, 3).forEach((c) => {
      parts.push(`- ${c.key ? `${c.key}: ` : ""}${c.value}`);
    });
    parts.push("");
  }

  if (grouped.context.length > 0) {
    parts.push(sv ? "**Köpkontext:**" : "**Purchase context:**");
    grouped.context.slice(0, 2).forEach((c) => {
      parts.push(`- ${c.value}`);
    });
    parts.push("");
  }

  if (sv) {
    parts.push(
      "**Tips:** Referera tillbaka till deras tidigare intressen naturligt, t.ex. 'Förra gången tittade du på X - hittade du något du gillade?'"
    );
  } else {
    parts.push(
      "**Tip:** Reference their previous interests naturally, e.g. 'Last time you were looking at X - did you find something you liked?'"
    );
  }

  return parts.join("\n");
}

/**
 * Save a memory for a customer
 */
async function saveCustomerMemory(
  storeDbId,
  customerId,
  memoryType,
  key,
  value,
  confidence = 0.8,
  conversationId = null
) {
  try {
    // Upsert - if exists, update confidence and mention count
    const result = await pool.query(
      `
      INSERT INTO customer_memory (store_id, customer_id, memory_type, key, value, confidence, source_conversation_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (store_id, customer_id, memory_type, key, value) 
      DO UPDATE SET
        confidence = GREATEST(customer_memory.confidence, EXCLUDED.confidence),
        mention_count = customer_memory.mention_count + 1,
        last_seen = now(),
        source_conversation_id = COALESCE(EXCLUDED.source_conversation_id, customer_memory.source_conversation_id)
      RETURNING id, mention_count
    `,
      [
        storeDbId,
        customerId,
        memoryType,
        key,
        value,
        confidence,
        conversationId,
      ]
    );

    return result.rows[0];
  } catch (err) {
    console.error("Error saving customer memory:", err);
    return null;
  }
}

/**
 * Extract memories from a completed conversation using AI
 */
async function extractMemoriesFromConversation(
  conversationId,
  storeDbId,
  customerId
) {
  try {
    // Get conversation messages
    const messagesResult = await pool.query(
      `
      SELECT role, content, products_shown
      FROM conv_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `,
      [conversationId]
    );

    if (messagesResult.rowCount < 2) {
      return [];
    }

    const conversationText = messagesResult.rows
      .map(
        (m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${m.content}`
      )
      .join("\n\n");

    // Get products shown
    const productsShown = messagesResult.rows
      .filter((m) => m.products_shown && m.products_shown.length > 0)
      .flatMap((m) => m.products_shown);

    const extractionPrompt = `Analyze this conversation and extract customer memories for future personalization.

CONVERSATION:
${conversationText}

PRODUCTS SHOWN: ${productsShown.join(", ") || "None"}

Extract structured memories in JSON format:
{
  "interests": [
    // Products or categories they showed interest in
    // e.g., "meditation crystals", "amethyst", "gift items"
  ],
  "preferences": [
    // Stated preferences with optional key
    // e.g., {"key": "color", "value": "purple"}, {"key": "style", "value": "natural"}
  ],
  "constraints": [
    // Budget, timeline, or other constraints
    // e.g., {"key": "budget", "value": "under 500kr"}, {"key": "timeline", "value": "need by Friday"}
  ],
  "purchase_context": [
    // Who they're shopping for, occasion, etc.
    // e.g., "gift for mom", "for meditation practice", "birthday present"
  ]
}

Rules:
- Only extract what was explicitly stated or clearly implied
- Be specific but not overly detailed
- Ignore generic browsing - only capture genuine interest signals
- For preferences, use consistent keys (color, style, size, material, price_range)
- Return ONLY valid JSON, no markdown

JSON:`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You extract customer preferences and interests from conversations for future personalization. Always respond with valid JSON only.",
        },
        { role: "user", content: extractionPrompt },
      ],
      temperature: 0.2,
      max_tokens: 500,
    });

    const responseText = completion.choices[0]?.message?.content || "{}";

    let extracted;
    try {
      const cleanJson = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      extracted = JSON.parse(cleanJson);
    } catch (parseErr) {
      console.error("Failed to parse memory extraction:", responseText);
      return [];
    }

    const savedMemories = [];

    // Save interests
    if (Array.isArray(extracted.interests)) {
      for (const interest of extracted.interests.slice(0, 5)) {
        if (interest && typeof interest === "string" && interest.length > 2) {
          const saved = await saveCustomerMemory(
            storeDbId,
            customerId,
            MEMORY_TYPES.INTEREST,
            null,
            interest.trim(),
            0.8,
            conversationId
          );
          if (saved) savedMemories.push(saved);
        }
      }
    }

    // Save preferences
    if (Array.isArray(extracted.preferences)) {
      for (const pref of extracted.preferences.slice(0, 5)) {
        const key = typeof pref === "object" ? pref.key : null;
        const value = typeof pref === "object" ? pref.value : pref;
        if (value && typeof value === "string" && value.length > 1) {
          const saved = await saveCustomerMemory(
            storeDbId,
            customerId,
            MEMORY_TYPES.PREFERENCE,
            key,
            value.trim(),
            0.75,
            conversationId
          );
          if (saved) savedMemories.push(saved);
        }
      }
    }

    // Save constraints
    if (Array.isArray(extracted.constraints)) {
      for (const constraint of extracted.constraints.slice(0, 3)) {
        const key = typeof constraint === "object" ? constraint.key : null;
        const value =
          typeof constraint === "object" ? constraint.value : constraint;
        if (value && typeof value === "string" && value.length > 1) {
          const saved = await saveCustomerMemory(
            storeDbId,
            customerId,
            MEMORY_TYPES.CONSTRAINT,
            key,
            value.trim(),
            0.7,
            conversationId
          );
          if (saved) savedMemories.push(saved);
        }
      }
    }

    // Save purchase context
    if (Array.isArray(extracted.purchase_context)) {
      for (const context of extracted.purchase_context.slice(0, 2)) {
        if (context && typeof context === "string" && context.length > 3) {
          const saved = await saveCustomerMemory(
            storeDbId,
            customerId,
            MEMORY_TYPES.PURCHASE_CONTEXT,
            null,
            context.trim(),
            0.85,
            conversationId
          );
          if (saved) savedMemories.push(saved);
        }
      }
    }

    // Also save products that were shown (implicit interest)
    const uniqueProducts = [...new Set(productsShown)];
    for (const product of uniqueProducts.slice(0, 3)) {
      if (product && product.length > 2) {
        const saved = await saveCustomerMemory(
          storeDbId,
          customerId,
          MEMORY_TYPES.INTEREST,
          "product",
          product,
          0.6, // Lower confidence - shown doesn't mean interested
          conversationId
        );
        if (saved) savedMemories.push(saved);
      }
    }

    console.log(
      `Extracted ${savedMemories.length} memories for customer ${customerId}`
    );
    return savedMemories;
  } catch (err) {
    console.error("Error extracting memories from conversation:", err);
    return [];
  }
}

/**
 * Real-time memory extraction from current message
 * For capturing signals during the conversation
 */
function extractRealTimeMemories(message, conversationState) {
  const memories = [];

  // Budget mentions
  const budgetMatch = message.match(/(\d+)\s*(kr|sek|kronor|\$|€|dollar)/i);
  if (budgetMatch) {
    memories.push({
      type: MEMORY_TYPES.CONSTRAINT,
      key: "budget",
      value: budgetMatch[0],
      confidence: 0.9,
    });
  }

  // Recipient mentions
  const recipientPatterns = [
    {
      pattern:
        /(present|gåva|gift)\s+(till|för|to|for)\s+(min|mitt|my)\s+(\w+)/i,
      group: 4,
    },
    {
      pattern:
        /(för|to|for)\s+(min|mitt|my)\s+(mamma|pappa|fru|man|vän|mom|dad|wife|husband|friend)/i,
      group: 3,
    },
    {
      pattern:
        /(shoppar|shopping|köper|buying)\s+(åt|for)\s+(mig själv|myself)/i,
      value: "self",
    },
  ];

  for (const rp of recipientPatterns) {
    const match = message.match(rp.pattern);
    if (match) {
      memories.push({
        type: MEMORY_TYPES.PURCHASE_CONTEXT,
        key: "recipient",
        value: rp.value || match[rp.group],
        confidence: 0.85,
      });
      break;
    }
  }

  // Color preferences
  const colorMatch = message.match(
    /\b(gillar|älskar|vill ha|likes?|loves?|wants?)\s+(\w+)\s*(färg|color)?/i
  );
  if (colorMatch) {
    const colors = [
      "lila",
      "rosa",
      "blå",
      "grön",
      "svart",
      "vit",
      "röd",
      "purple",
      "pink",
      "blue",
      "green",
      "black",
      "white",
      "red",
    ];
    const mentionedColor = colors.find((c) =>
      message.toLowerCase().includes(c)
    );
    if (mentionedColor) {
      memories.push({
        type: MEMORY_TYPES.PREFERENCE,
        key: "color",
        value: mentionedColor,
        confidence: 0.8,
      });
    }
  }

  // Timeline mentions
  const timelinePatterns = [
    {
      pattern:
        /(behöver|need|want)\s+(det|it|this)\s+(innan|before|by)\s+(.+)/i,
      group: 4,
    },
    {
      pattern:
        /(till|for|by)\s+(fredag|måndag|imorgon|friday|monday|tomorrow|this weekend|helgen)/i,
      group: 2,
    },
  ];

  for (const tp of timelinePatterns) {
    const match = message.match(tp.pattern);
    if (match) {
      memories.push({
        type: MEMORY_TYPES.CONSTRAINT,
        key: "timeline",
        value: match[tp.group],
        confidence: 0.85,
      });
      break;
    }
  }

  return memories;
}

/**
 * Save real-time extracted memories
 */
async function saveRealTimeMemories(
  storeDbId,
  customerId,
  memories,
  conversationId = null
) {
  const saved = [];

  for (const memory of memories) {
    const result = await saveCustomerMemory(
      storeDbId,
      customerId,
      memory.type,
      memory.key,
      memory.value,
      memory.confidence,
      conversationId
    );
    if (result) saved.push(result);
  }

  return saved;
}

/**
 * Clear customer memory (for privacy/GDPR)
 */
async function clearCustomerMemory(storeDbId, customerId) {
  try {
    const result = await pool.query(
      `
      DELETE FROM customer_memory
      WHERE store_id = $1 AND customer_id = $2
      RETURNING id
    `,
      [storeDbId, customerId]
    );

    return {
      success: true,
      deleted: result.rowCount,
    };
  } catch (err) {
    console.error("Error clearing customer memory:", err);
    return { success: false, error: err.message };
  }
}

/**
 * Cleanup old memories (run periodically)
 */
async function cleanupOldMemories() {
  try {
    // Delete memories older than their TTL
    for (const [memoryType, ttlDays] of Object.entries(MEMORY_TTL_DAYS)) {
      await pool.query(
        `
        DELETE FROM customer_memory
        WHERE memory_type = $1
          AND last_seen < now() - interval '${ttlDays} days'
      `,
        [memoryType]
      );
    }

    // Delete low-confidence memories that haven't been reinforced
    await pool.query(`
      DELETE FROM customer_memory
      WHERE confidence < 0.5
        AND mention_count = 1
        AND last_seen < now() - interval '7 days'
    `);

    console.log("Customer memory cleanup completed");
  } catch (err) {
    console.error("Error cleaning up old memories:", err);
  }
}

module.exports = {
  MEMORY_TYPES,
  initCustomerMemoryTable,
  getCustomerId,
  loadCustomerMemories,
  formatMemoriesForPrompt,
  saveCustomerMemory,
  extractMemoriesFromConversation,
  extractRealTimeMemories,
  saveRealTimeMemories,
  clearCustomerMemory,
  cleanupOldMemories,
};
