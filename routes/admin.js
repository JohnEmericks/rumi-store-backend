/**
 * Admin Routes
 *
 * Protected routes for managing license keys and viewing system stats.
 * These routes require an admin secret key.
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const {
  createLicenseKey,
  deactivateLicenseKey,
  changePlan,
  listLicenseKeys,
  getUsageStats,
} = require("../services/license");
const {
  getQualityStats,
  getFlaggedConversations,
  getConversationForReview,
  markAsReviewed,
} = require("../services/conversation-scorer");

// Admin authentication middleware
const ADMIN_SECRET =
  process.env.RUMI_ADMIN_SECRET || "change-this-secret-in-production";

function adminAuth(req, res, next) {
  const adminKey =
    req.headers["x-admin-key"] || req.body.admin_key || req.query.admin_key;

  if (!adminKey || adminKey !== ADMIN_SECRET) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  next();
}

// Apply admin auth to all routes
router.use(adminAuth);

// =============================================================================
// LICENSE KEY MANAGEMENT
// =============================================================================

/**
 * Create a new license key
 * POST /admin/keys/create
 */
router.post("/keys/create", async (req, res) => {
  const { owner_email, owner_name, plan = "free", allowed_domains } = req.body;

  if (!owner_email) {
    return res
      .status(400)
      .json({ ok: false, error: "owner_email is required" });
  }

  const validPlans = ["free", "starter", "pro", "business", "unlimited"];
  if (!validPlans.includes(plan)) {
    return res
      .status(400)
      .json({
        ok: false,
        error: `Invalid plan. Must be one of: ${validPlans.join(", ")}`,
      });
  }

  const result = await createLicenseKey(
    owner_email,
    owner_name,
    plan,
    allowed_domains
  );

  if (result.success) {
    return res.json({
      ok: true,
      ...result,
      warning: "⚠️ Save this license key now! It cannot be retrieved later.",
    });
  } else {
    return res.status(500).json({ ok: false, error: result.error });
  }
});

/**
 * List all license keys
 * GET /admin/keys
 */
router.get("/keys", async (req, res) => {
  const includeInactive = req.query.include_inactive === "true";
  const result = await listLicenseKeys(includeInactive);

  if (result.success) {
    return res.json({ ok: true, keys: result.keys });
  } else {
    return res.status(500).json({ ok: false, error: result.error });
  }
});

/**
 * Deactivate a license key
 * POST /admin/keys/deactivate
 */
router.post("/keys/deactivate", async (req, res) => {
  const { key_prefix } = req.body;

  if (!key_prefix) {
    return res.status(400).json({ ok: false, error: "key_prefix is required" });
  }

  const result = await deactivateLicenseKey(key_prefix);

  if (result.success) {
    return res.json({ ok: true, message: "License key deactivated" });
  } else {
    return res.status(500).json({ ok: false, error: result.error });
  }
});

/**
 * Change plan for a license key
 * POST /admin/keys/change-plan
 */
router.post("/keys/change-plan", async (req, res) => {
  const { key_prefix, new_plan } = req.body;

  if (!key_prefix || !new_plan) {
    return res
      .status(400)
      .json({ ok: false, error: "key_prefix and new_plan are required" });
  }

  const validPlans = ["free", "starter", "pro", "business", "unlimited"];
  if (!validPlans.includes(new_plan)) {
    return res
      .status(400)
      .json({
        ok: false,
        error: `Invalid plan. Must be one of: ${validPlans.join(", ")}`,
      });
  }

  const result = await changePlan(key_prefix, new_plan);

  if (result.success) {
    return res.json({ ok: true, message: `Plan changed to ${new_plan}` });
  } else {
    return res.status(500).json({ ok: false, error: result.error });
  }
});

/**
 * Get detailed usage for a specific key
 * GET /admin/keys/:keyPrefix/usage
 */
router.get("/keys/:keyPrefix/usage", async (req, res) => {
  const { keyPrefix } = req.params;

  try {
    const result = await pool.query(
      `SELECT lk.*, pl.display_name as plan_display, pl.conversations_per_month as plan_limit
       FROM license_keys lk
       LEFT JOIN plan_limits pl ON lk.plan = pl.plan_name
       WHERE lk.key_prefix = $1`,
      [keyPrefix]
    );

    if (result.rowCount === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "License key not found" });
    }

    const license = result.rows[0];

    // Get all usage history
    const usageResult = await pool.query(
      `SELECT * FROM usage_tracking WHERE license_key_id = $1 ORDER BY period_start DESC`,
      [license.id]
    );

    // Get linked stores
    const storesResult = await pool.query(
      `SELECT store_id, store_name, site_url, created_at FROM stores WHERE license_key_id = $1`,
      [license.id]
    );

    return res.json({
      ok: true,
      license: {
        key_prefix: license.key_prefix,
        owner_email: license.owner_email,
        owner_name: license.owner_name,
        plan: license.plan,
        plan_display: license.plan_display,
        plan_limit: license.plan_limit,
        is_active: license.is_active,
        created_at: license.created_at,
        last_used_at: license.last_used_at,
        allowed_domains: license.allowed_domains,
      },
      usage_history: usageResult.rows,
      linked_stores: storesResult.rows,
    });
  } catch (err) {
    console.error("Error getting key usage:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to get usage data" });
  }
});

// =============================================================================
// SYSTEM STATS
// =============================================================================

/**
 * Get overall system statistics
 * GET /admin/stats
 */
router.get("/stats", async (req, res) => {
  try {
    // License key stats
    const keyStats = await pool.query(`
      SELECT 
        COUNT(*) as total_keys,
        COUNT(CASE WHEN is_active THEN 1 END) as active_keys,
        COUNT(CASE WHEN plan = 'free' THEN 1 END) as free_keys,
        COUNT(CASE WHEN plan = 'starter' THEN 1 END) as starter_keys,
        COUNT(CASE WHEN plan = 'pro' THEN 1 END) as pro_keys,
        COUNT(CASE WHEN plan = 'business' THEN 1 END) as business_keys,
        COUNT(CASE WHEN plan = 'unlimited' THEN 1 END) as unlimited_keys
      FROM license_keys
    `);

    // Store stats
    const storeStats = await pool.query(`
      SELECT COUNT(*) as total_stores FROM stores
    `);

    // Current month usage
    const usageStats = await pool.query(`
      SELECT 
        SUM(conversations_used) as total_conversations,
        SUM(messages_sent) as total_messages,
        SUM(estimated_cost) as total_cost
      FROM usage_tracking
      WHERE period_start <= now() AND period_end > now()
    `);

    // Conversations today
    const todayStats = await pool.query(`
      SELECT COUNT(*) as conversations_today
      FROM conversations
      WHERE started_at >= CURRENT_DATE
    `);

    return res.json({
      ok: true,
      keys: keyStats.rows[0],
      stores: storeStats.rows[0],
      current_month: {
        conversations: parseInt(usageStats.rows[0].total_conversations) || 0,
        messages: parseInt(usageStats.rows[0].total_messages) || 0,
        estimated_cost: parseFloat(usageStats.rows[0].total_cost) || 0,
      },
      today: {
        conversations: parseInt(todayStats.rows[0].conversations_today) || 0,
      },
    });
  } catch (err) {
    console.error("Error getting system stats:", err);
    return res.status(500).json({ ok: false, error: "Failed to get stats" });
  }
});

/**
 * Get plan limits configuration
 * GET /admin/plans
 */
router.get("/plans", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM plan_limits WHERE is_active = true ORDER BY conversations_per_month ASC NULLS LAST`
    );
    return res.json({ ok: true, plans: result.rows });
  } catch (err) {
    console.error("Error getting plans:", err);
    return res.status(500).json({ ok: false, error: "Failed to get plans" });
  }
});

// =============================================================================
// AI QUALITY MONITORING
// =============================================================================

/**
 * Get AI quality statistics
 * GET /admin/quality/stats?period=week
 */
router.get("/quality/stats", async (req, res) => {
  const period = req.query.period || "week";
  const storeId = req.query.store_id || null;

  const result = await getQualityStats(period, storeId);

  if (result.success) {
    return res.json({ ok: true, ...result });
  } else {
    return res.status(500).json({ ok: false, error: result.error });
  }
});

/**
 * Get flagged conversations for review
 * GET /admin/quality/flagged?limit=20&include_reviewed=false
 */
router.get("/quality/flagged", async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const includeReviewed = req.query.include_reviewed === "true";

  const result = await getFlaggedConversations(limit, includeReviewed);

  if (result.success) {
    return res.json({ ok: true, conversations: result.conversations });
  } else {
    return res.status(500).json({ ok: false, error: result.error });
  }
});

/**
 * Get a single conversation for review
 * GET /admin/quality/conversation/:id
 */
router.get("/quality/conversation/:id", async (req, res) => {
  const conversationId = parseInt(req.params.id);

  if (!conversationId) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid conversation ID" });
  }

  const result = await getConversationForReview(conversationId);

  if (result.success) {
    return res.json({ ok: true, ...result });
  } else {
    return res.status(404).json({ ok: false, error: result.error });
  }
});

/**
 * Mark a conversation as reviewed
 * POST /admin/quality/conversation/:id/reviewed
 */
router.post("/quality/conversation/:id/reviewed", async (req, res) => {
  const conversationId = parseInt(req.params.id);

  if (!conversationId) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid conversation ID" });
  }

  const result = await markAsReviewed(conversationId);

  if (result.success) {
    return res.json({ ok: true, message: "Marked as reviewed" });
  } else {
    return res.status(500).json({ ok: false, error: result.error });
  }
});

/**
 * Export conversations for analysis
 * GET /admin/quality/export?from=2024-01-01&to=2024-12-31&min_messages=2
 */
router.get("/quality/export", async (req, res) => {
  const { from, to, min_messages = 2 } = req.query;

  try {
    let dateFilter = "";
    const params = [];
    let paramIndex = 1;

    if (from) {
      dateFilter += ` AND c.started_at >= $${paramIndex}`;
      params.push(from);
      paramIndex++;
    }
    if (to) {
      dateFilter += ` AND c.started_at <= $${paramIndex}`;
      params.push(to);
      paramIndex++;
    }

    // Get conversations
    const conversationsResult = await pool.query(
      `
      SELECT 
        c.id,
        c.session_id,
        c.started_at,
        c.ended_at,
        c.message_count,
        c.quality_score,
        c.score_breakdown,
        c.flagged,
        c.flag_reasons,
        c.language,
        c.device_type,
        s.store_name,
        s.store_id as store_identifier
      FROM conversations c
      JOIN stores s ON c.store_id = s.id
      WHERE c.message_count >= $${paramIndex}
      ${dateFilter}
      ORDER BY c.started_at DESC
    `,
      [...params, parseInt(min_messages)]
    );

    // Get messages for each conversation
    const conversations = [];
    for (const conv of conversationsResult.rows) {
      const messagesResult = await pool.query(
        `
        SELECT role, content, products_shown, created_at
        FROM conversation_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC
      `,
        [conv.id]
      );

      conversations.push({
        ...conv,
        messages: messagesResult.rows,
      });
    }

    return res.json({
      ok: true,
      export_date: new Date().toISOString(),
      filters: { from, to, min_messages },
      total_conversations: conversations.length,
      conversations,
    });
  } catch (err) {
    console.error("Error exporting conversations:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to export conversations" });
  }
});

// =============================================================================
// DEBUG ENDPOINTS
// =============================================================================

/**
 * Get all stores with item counts
 * GET /admin/debug/stores
 */
router.get("/debug/stores", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        s.id,
        s.store_id,
        s.site_url,
        s.store_name,
        s.created_at,
        COUNT(si.id) as item_count
      FROM stores s
      LEFT JOIN store_items si ON s.id = si.store_id
      GROUP BY s.id, s.store_id, s.site_url, s.store_name, s.created_at
      ORDER BY s.created_at DESC
    `);

    return res.json({
      ok: true,
      stores: result.rows,
    });
  } catch (err) {
    console.error("Error fetching stores:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch stores" });
  }
});

/**
 * Get sample items for a store
 * GET /admin/debug/items?store_id=xxx
 */
router.get("/debug/items", async (req, res) => {
  const { store_id } = req.query;

  if (!store_id) {
    return res.status(400).json({ ok: false, error: "store_id is required" });
  }

  try {
    // First get the internal store ID
    const storeResult = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [store_id]
    );

    if (storeResult.rowCount === 0) {
      return res.json({ ok: true, items: [], message: "Store not found" });
    }

    const storeDbId = storeResult.rows[0].id;

    // Get sample items
    const itemsResult = await pool.query(
      `
      SELECT 
        id,
        external_id,
        type,
        title,
        url,
        SUBSTRING(content, 1, 200) as content,
        price,
        stock_status,
        in_stock
      FROM store_items
      WHERE store_id = $1
      ORDER BY type, id
      LIMIT 20
    `,
      [storeDbId]
    );

    return res.json({
      ok: true,
      store_db_id: storeDbId,
      items: itemsResult.rows,
    });
  } catch (err) {
    console.error("Error fetching items:", err);
    return res.status(500).json({ ok: false, error: "Failed to fetch items" });
  }
});

module.exports = router;
