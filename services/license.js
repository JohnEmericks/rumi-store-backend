/**
 * License Service
 *
 * Handles API key generation, validation, and usage tracking.
 */

const crypto = require("crypto");
const { pool } = require("../config/database");

// =============================================================================
// KEY GENERATION
// =============================================================================

/**
 * Generate a new license key
 * Format: rumi_[plan]_[random]
 */
function generateLicenseKey(plan = "free") {
  const planPrefix = plan.substring(0, 4).toLowerCase();
  const randomPart = crypto.randomBytes(16).toString("hex");
  return `rumi_${planPrefix}_${randomPart}`;
}

/**
 * Hash a license key for storage (we never store plain keys)
 */
function hashKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Get the prefix of a key for display (first 12 chars)
 */
function getKeyPrefix(key) {
  return key.substring(0, 16) + "...";
}

// =============================================================================
// KEY MANAGEMENT (Admin functions)
// =============================================================================

/**
 * Create a new license key
 * Returns the plain key (only time it's visible!)
 */
async function createLicenseKey(
  ownerEmail,
  ownerName,
  plan = "free",
  allowedDomains = null
) {
  const plainKey = generateLicenseKey(plan);
  const keyHash = hashKey(plainKey);
  const keyPrefix = getKeyPrefix(plainKey);

  try {
    const result = await pool.query(
      `INSERT INTO license_keys (key_hash, key_prefix, owner_email, owner_name, plan, allowed_domains, billing_cycle_start)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       RETURNING id, key_prefix, plan, created_at`,
      [keyHash, keyPrefix, ownerEmail, ownerName || null, plan, allowedDomains]
    );

    // Initialize first usage period
    const licenseKeyId = result.rows[0].id;
    await initializeUsagePeriod(licenseKeyId);

    return {
      success: true,
      license_key: plainKey, // Only returned once!
      key_prefix: keyPrefix,
      plan,
      message: "Save this key - it cannot be retrieved later!",
    };
  } catch (err) {
    console.error("Error creating license key:", err);
    return { success: false, error: "Failed to create license key" };
  }
}

/**
 * Deactivate a license key
 */
async function deactivateLicenseKey(keyPrefix) {
  try {
    const result = await pool.query(
      `UPDATE license_keys SET is_active = false WHERE key_prefix = $1 RETURNING id`,
      [keyPrefix]
    );
    return { success: result.rowCount > 0 };
  } catch (err) {
    console.error("Error deactivating license key:", err);
    return { success: false, error: "Failed to deactivate key" };
  }
}

/**
 * Change plan for a license key
 */
async function changePlan(keyPrefix, newPlan) {
  try {
    const result = await pool.query(
      `UPDATE license_keys SET plan = $1 WHERE key_prefix = $2 AND is_active = true RETURNING id`,
      [newPlan, keyPrefix]
    );
    return { success: result.rowCount > 0 };
  } catch (err) {
    console.error("Error changing plan:", err);
    return { success: false, error: "Failed to change plan" };
  }
}

/**
 * List all license keys (admin)
 */
async function listLicenseKeys(includeInactive = false) {
  try {
    const query = includeInactive
      ? `SELECT lk.*, pl.display_name as plan_display, pl.conversations_per_month as plan_limit,
           (SELECT conversations_used FROM usage_tracking WHERE license_key_id = lk.id 
            AND period_start <= now() AND period_end > now() LIMIT 1) as current_usage
         FROM license_keys lk
         LEFT JOIN plan_limits pl ON lk.plan = pl.plan_name
         ORDER BY lk.created_at DESC`
      : `SELECT lk.*, pl.display_name as plan_display, pl.conversations_per_month as plan_limit,
           (SELECT conversations_used FROM usage_tracking WHERE license_key_id = lk.id 
            AND period_start <= now() AND period_end > now() LIMIT 1) as current_usage
         FROM license_keys lk
         LEFT JOIN plan_limits pl ON lk.plan = pl.plan_name
         WHERE lk.is_active = true
         ORDER BY lk.created_at DESC`;

    const result = await pool.query(query);
    return { success: true, keys: result.rows };
  } catch (err) {
    console.error("Error listing license keys:", err);
    return { success: false, error: "Failed to list keys" };
  }
}

// =============================================================================
// KEY VALIDATION
// =============================================================================

/**
 * Validate a license key and check usage limits
 * Returns validation result with license info
 */
async function validateLicenseKey(plainKey, domain = null) {
  if (!plainKey || typeof plainKey !== "string") {
    return {
      valid: false,
      error: "invalid_key",
      message: "No license key provided",
    };
  }

  const keyHash = hashKey(plainKey);

  try {
    // Get license key with plan info
    const result = await pool.query(
      `SELECT lk.*, pl.conversations_per_month as plan_limit, pl.display_name as plan_display, pl.features
       FROM license_keys lk
       LEFT JOIN plan_limits pl ON lk.plan = pl.plan_name
       WHERE lk.key_hash = $1`,
      [keyHash]
    );

    if (result.rowCount === 0) {
      return {
        valid: false,
        error: "invalid_key",
        message: "Invalid license key",
      };
    }

    const license = result.rows[0];

    // Check if active
    if (!license.is_active) {
      return {
        valid: false,
        error: "key_deactivated",
        message: "This license key has been deactivated",
      };
    }

    // Check domain restriction (if set)
    if (
      license.allowed_domains &&
      license.allowed_domains.length > 0 &&
      domain
    ) {
      const domainAllowed = license.allowed_domains.some((d) =>
        domain.toLowerCase().includes(d.toLowerCase())
      );
      if (!domainAllowed) {
        return {
          valid: false,
          error: "domain_not_allowed",
          message: "This license key is not valid for this domain",
        };
      }
    }

    // Get current usage
    const usage = await getCurrentUsage(license.id);

    // Check usage limit (null = unlimited)
    if (
      license.plan_limit !== null &&
      usage.conversations_used >= license.plan_limit
    ) {
      return {
        valid: false,
        error: "limit_reached",
        message: "Monthly conversation limit reached",
        license: {
          plan: license.plan,
          plan_display: license.plan_display,
          limit: license.plan_limit,
          used: usage.conversations_used,
          resets_at: usage.period_end,
        },
      };
    }

    // Update last used
    await pool.query(
      `UPDATE license_keys SET last_used_at = now() WHERE id = $1`,
      [license.id]
    );

    return {
      valid: true,
      license: {
        id: license.id,
        plan: license.plan,
        plan_display: license.plan_display,
        limit: license.plan_limit,
        used: usage.conversations_used,
        remaining: license.plan_limit
          ? license.plan_limit - usage.conversations_used
          : null,
        resets_at: usage.period_end,
        features: license.features || {},
      },
    };
  } catch (err) {
    console.error("Error validating license key:", err);
    return {
      valid: false,
      error: "validation_error",
      message: "Failed to validate license key",
    };
  }
}

/**
 * Quick validation (just check if key is valid, no usage check)
 */
async function quickValidate(plainKey) {
  if (!plainKey) return false;

  const keyHash = hashKey(plainKey);
  try {
    const result = await pool.query(
      `SELECT id FROM license_keys WHERE key_hash = $1 AND is_active = true`,
      [keyHash]
    );
    return result.rowCount > 0;
  } catch {
    return false;
  }
}

// =============================================================================
// USAGE TRACKING
// =============================================================================

/**
 * Initialize usage period for a license key
 */
async function initializeUsagePeriod(licenseKeyId) {
  const periodStart = new Date();
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  try {
    await pool.query(
      `INSERT INTO usage_tracking (license_key_id, period_start, period_end)
       VALUES ($1, $2, $3)
       ON CONFLICT (license_key_id, period_start) DO NOTHING`,
      [licenseKeyId, periodStart, periodEnd]
    );
  } catch (err) {
    console.error("Error initializing usage period:", err);
  }
}

/**
 * Get current usage for a license key
 */
async function getCurrentUsage(licenseKeyId) {
  try {
    // Check for current period
    let result = await pool.query(
      `SELECT * FROM usage_tracking 
       WHERE license_key_id = $1 AND period_start <= now() AND period_end > now()
       ORDER BY period_start DESC LIMIT 1`,
      [licenseKeyId]
    );

    // If no current period, create one based on billing cycle
    if (result.rowCount === 0) {
      const licenseResult = await pool.query(
        `SELECT billing_cycle_start FROM license_keys WHERE id = $1`,
        [licenseKeyId]
      );

      if (licenseResult.rowCount > 0) {
        const billingStart = new Date(
          licenseResult.rows[0].billing_cycle_start
        );
        const now = new Date();

        // Calculate current period based on billing cycle
        let periodStart = new Date(billingStart);
        while (periodStart <= now) {
          const nextPeriod = new Date(periodStart);
          nextPeriod.setMonth(nextPeriod.getMonth() + 1);
          if (nextPeriod > now) break;
          periodStart = nextPeriod;
        }

        const periodEnd = new Date(periodStart);
        periodEnd.setMonth(periodEnd.getMonth() + 1);

        await pool.query(
          `INSERT INTO usage_tracking (license_key_id, period_start, period_end)
           VALUES ($1, $2, $3)
           ON CONFLICT (license_key_id, period_start) DO NOTHING`,
          [licenseKeyId, periodStart, periodEnd]
        );

        result = await pool.query(
          `SELECT * FROM usage_tracking 
           WHERE license_key_id = $1 AND period_start <= now() AND period_end > now()
           LIMIT 1`,
          [licenseKeyId]
        );
      }
    }

    if (result.rowCount > 0) {
      return result.rows[0];
    }

    return { conversations_used: 0, messages_sent: 0, api_calls: 0 };
  } catch (err) {
    console.error("Error getting current usage:", err);
    return { conversations_used: 0, messages_sent: 0, api_calls: 0 };
  }
}

/**
 * Increment conversation count
 */
async function incrementConversation(
  licenseKeyId,
  storeId = null,
  estimatedCost = 0.024
) {
  try {
    await pool.query(
      `UPDATE usage_tracking 
       SET conversations_used = conversations_used + 1,
           estimated_cost = estimated_cost + $2
       WHERE license_key_id = $1 
         AND period_start <= now() 
         AND period_end > now()`,
      [licenseKeyId, estimatedCost]
    );
  } catch (err) {
    console.error("Error incrementing conversation:", err);
  }
}

/**
 * Increment message count
 */
async function incrementMessage(licenseKeyId, estimatedCost = 0.0035) {
  try {
    await pool.query(
      `UPDATE usage_tracking 
       SET messages_sent = messages_sent + 1,
           api_calls = api_calls + 1,
           estimated_cost = estimated_cost + $2
       WHERE license_key_id = $1 
         AND period_start <= now() 
         AND period_end > now()`,
      [licenseKeyId, estimatedCost]
    );
  } catch (err) {
    console.error("Error incrementing message:", err);
  }
}

/**
 * Get usage stats for a license key (for store owner dashboard)
 */
async function getUsageStats(plainKey) {
  const keyHash = hashKey(plainKey);

  try {
    const licenseResult = await pool.query(
      `SELECT lk.id, lk.plan, lk.billing_cycle_start, pl.conversations_per_month as plan_limit, pl.display_name
       FROM license_keys lk
       LEFT JOIN plan_limits pl ON lk.plan = pl.plan_name
       WHERE lk.key_hash = $1 AND lk.is_active = true`,
      [keyHash]
    );

    if (licenseResult.rowCount === 0) {
      return { success: false, error: "Invalid license key" };
    }

    const license = licenseResult.rows[0];
    const usage = await getCurrentUsage(license.id);

    // Get historical usage (last 6 months)
    const historyResult = await pool.query(
      `SELECT period_start, period_end, conversations_used, messages_sent
       FROM usage_tracking
       WHERE license_key_id = $1
       ORDER BY period_start DESC
       LIMIT 6`,
      [license.id]
    );

    return {
      success: true,
      plan: license.plan,
      plan_display: license.display_name,
      limit: license.plan_limit,
      current_period: {
        used: usage.conversations_used || 0,
        remaining: license.plan_limit
          ? Math.max(0, license.plan_limit - (usage.conversations_used || 0))
          : null,
        period_start: usage.period_start,
        period_end: usage.period_end,
      },
      history: historyResult.rows,
    };
  } catch (err) {
    console.error("Error getting usage stats:", err);
    return { success: false, error: "Failed to get usage stats" };
  }
}

// =============================================================================
// LICENSE KEY LOOKUP FOR STORES
// =============================================================================

/**
 * Get license key ID from plain key
 */
async function getLicenseKeyId(plainKey) {
  if (!plainKey) return null;

  const keyHash = hashKey(plainKey);
  try {
    const result = await pool.query(
      `SELECT id FROM license_keys WHERE key_hash = $1 AND is_active = true`,
      [keyHash]
    );
    return result.rowCount > 0 ? result.rows[0].id : null;
  } catch {
    return null;
  }
}

/**
 * Link a store to a license key
 */
async function linkStoreToLicense(storeId, licenseKeyId) {
  try {
    await pool.query(`UPDATE stores SET license_key_id = $1 WHERE id = $2`, [
      licenseKeyId,
      storeId,
    ]);
    return true;
  } catch (err) {
    console.error("Error linking store to license:", err);
    return false;
  }
}

module.exports = {
  // Key management (admin)
  createLicenseKey,
  deactivateLicenseKey,
  changePlan,
  listLicenseKeys,

  // Validation
  validateLicenseKey,
  quickValidate,
  getLicenseKeyId,

  // Usage tracking
  getCurrentUsage,
  incrementConversation,
  incrementMessage,
  getUsageStats,

  // Store linking
  linkStoreToLicense,

  // Utilities
  hashKey,
  getKeyPrefix,
};
