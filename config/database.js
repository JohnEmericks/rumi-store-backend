/**
 * Database Configuration and Initialization
 */

const { Pool } = require("pg");

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || "postgres://localhost:5432/rumi",
});

/**
 * Initialize database tables
 */
async function initDb() {
  try {
    // Stores table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        store_id TEXT UNIQUE NOT NULL,
        api_key TEXT NOT NULL,
        site_url TEXT UNIQUE,
        store_name TEXT,
        admin_email TEXT,
        personality JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await pool.query(
      `ALTER TABLE stores ADD COLUMN IF NOT EXISTS site_url TEXT;`
    );
    await pool.query(
      `ALTER TABLE stores ADD COLUMN IF NOT EXISTS store_name TEXT;`
    );
    await pool.query(
      `ALTER TABLE stores ADD COLUMN IF NOT EXISTS admin_email TEXT;`
    );
    await pool.query(
      `ALTER TABLE stores ADD COLUMN IF NOT EXISTS personality JSONB DEFAULT '{}';`
    );
    await pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_site_url ON stores(site_url);`
    );

    // Store items table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_items (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT,
        url TEXT,
        image_url TEXT,
        content TEXT,
        price TEXT,
        stock_status TEXT DEFAULT 'instock',
        in_stock BOOLEAN DEFAULT true,
        embedding DOUBLE PRECISION[],
        UNIQUE (store_id, external_id, type)
      );
    `);

    await pool.query(
      `ALTER TABLE store_items ADD COLUMN IF NOT EXISTS image_url TEXT;`
    );
    await pool.query(
      `ALTER TABLE store_items ADD COLUMN IF NOT EXISTS price TEXT;`
    );
    await pool.query(
      `ALTER TABLE store_items ADD COLUMN IF NOT EXISTS stock_status TEXT DEFAULT 'instock';`
    );
    await pool.query(
      `ALTER TABLE store_items ADD COLUMN IF NOT EXISTS in_stock BOOLEAN DEFAULT true;`
    );

    // Store facts table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_facts (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        source_item_id INTEGER REFERENCES store_items(id) ON DELETE CASCADE,
        fact_type TEXT NOT NULL,
        key TEXT,
        value TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (store_id, fact_type, value)
      );
    `);

    // Conversations table (Phase 2)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        started_at TIMESTAMPTZ DEFAULT now(),
        ended_at TIMESTAMPTZ,
        message_count INTEGER DEFAULT 0,
        language TEXT,
        device_type TEXT,
        status TEXT DEFAULT 'active',
        UNIQUE (store_id, session_id)
      );
    `);

    // Conversation messages (Phase 2)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conv_messages (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        products_shown TEXT[],
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Conversation insights (Phase 2)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conv_insights (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        insight_type TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence FLOAT DEFAULT 1.0,
        extracted_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Create indexes
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conversations_store_id ON conversations(store_id);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conversations_started_at ON conversations(started_at);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conv_messages_conversation_id ON conv_messages(conversation_id);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conv_insights_store_id ON conv_insights(store_id);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conv_insights_type ON conv_insights(insight_type);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_conv_insights_extracted_at ON conv_insights(extracted_at);`
    );

    // Store settings table (Phase 2)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_settings (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        setting_key TEXT NOT NULL,
        setting_value TEXT,
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (store_id, setting_key)
      );
    `);

    // =============================================================================
    // API KEYS & LICENSING SYSTEM
    // =============================================================================

    // License keys table (provider-level keys)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS license_keys (
        id SERIAL PRIMARY KEY,
        key_hash TEXT UNIQUE NOT NULL,
        key_prefix TEXT NOT NULL,
        owner_email TEXT NOT NULL,
        owner_name TEXT,
        plan TEXT NOT NULL DEFAULT 'free',
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT now(),
        billing_cycle_start TIMESTAMPTZ DEFAULT now(),
        last_used_at TIMESTAMPTZ,
        allowed_domains TEXT[],
        metadata JSONB DEFAULT '{}'
      );
    `);

    // Add indexes for license_keys
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_license_keys_key_hash ON license_keys(key_hash);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_license_keys_owner_email ON license_keys(owner_email);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_license_keys_plan ON license_keys(plan);`
    );

    // Plan limits configuration
    await pool.query(`
      CREATE TABLE IF NOT EXISTS plan_limits (
        id SERIAL PRIMARY KEY,
        plan_name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        conversations_per_month INTEGER,
        price_monthly DECIMAL(10,2),
        features JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true
      );
    `);

    // Insert default plans (upsert)
    await pool.query(`
      INSERT INTO plan_limits (plan_name, display_name, conversations_per_month, price_monthly, features) VALUES
        ('free', 'Free', 10, 0, '{"analytics": false, "priority_support": false}'),
        ('starter', 'Starter', 75, 9.00, '{"analytics": true, "priority_support": false}'),
        ('pro', 'Pro', 500, 29.00, '{"analytics": true, "priority_support": false}'),
        ('business', 'Business', 1000, 49.00, '{"analytics": true, "priority_support": true}'),
        ('unlimited', 'Unlimited', NULL, 149.00, '{"analytics": true, "priority_support": true}')
      ON CONFLICT (plan_name) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        conversations_per_month = EXCLUDED.conversations_per_month,
        price_monthly = EXCLUDED.price_monthly,
        features = EXCLUDED.features;
    `);

    // Usage tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS usage_tracking (
        id SERIAL PRIMARY KEY,
        license_key_id INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
        store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        conversations_used INTEGER DEFAULT 0,
        messages_sent INTEGER DEFAULT 0,
        api_calls INTEGER DEFAULT 0,
        estimated_cost DECIMAL(10,4) DEFAULT 0,
        UNIQUE (license_key_id, period_start)
      );
    `);

    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_tracking_license_key_id ON usage_tracking(license_key_id);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_usage_tracking_period ON usage_tracking(period_start, period_end);`
    );

    // Link stores to license keys
    await pool.query(
      `ALTER TABLE stores ADD COLUMN IF NOT EXISTS license_key_id INTEGER REFERENCES license_keys(id);`
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_stores_license_key_id ON stores(license_key_id);`
    );

    console.log("✅ Database initialized");
  } catch (err) {
    console.error("❌ Database initialization error:", err);
  }
}

module.exports = { pool, initDb };
