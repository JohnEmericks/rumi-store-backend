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

    console.log("✅ Database initialized");
  } catch (err) {
    console.error("❌ Database initialization error:", err);
  }
}

module.exports = { pool, initDb };
