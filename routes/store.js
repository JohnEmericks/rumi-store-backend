/**
 * Store Routes
 *
 * Handles store registration, indexing, and settings.
 */

const express = require("express");
const router = express.Router();
const { pool } = require("../config/database");
const { generateStoreId, generateApiKey } = require("../utils/helpers");
const {
  embedTexts,
  buildItemsForEmbedding,
  extractFactsFromText,
} = require("../services/embedding");

/**
 * Register a new store
 */
router.post("/register-store", async (req, res) => {
  const {
    site_url,
    store_name,
    admin_email,
    personality = {},
  } = req.body || {};

  if (!site_url || !admin_email) {
    return res
      .status(400)
      .json({ ok: false, error: "site_url and admin_email are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO stores (store_id, api_key, site_url, store_name, admin_email, personality)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (site_url)
       DO UPDATE SET
         api_key = EXCLUDED.api_key,
         store_name = EXCLUDED.store_name,
         admin_email = EXCLUDED.admin_email,
         personality = EXCLUDED.personality
       RETURNING id, store_id, api_key`,
      [
        generateStoreId(),
        generateApiKey(),
        site_url,
        store_name || null,
        admin_email,
        personality,
      ]
    );

    const row = result.rows[0];
    return res.json({
      ok: true,
      store_id: row.store_id,
      api_key: row.api_key,
      message: "Store registered successfully",
    });
  } catch (err) {
    console.error("Error in /register-store:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to register store" });
  }
});

/**
 * Update store personality
 */
router.post("/update-personality", async (req, res) => {
  const { store_id, api_key, personality } = req.body || {};

  if (!store_id || !api_key || !personality) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "store_id, api_key, and personality are required",
      });
  }

  try {
    const result = await pool.query(
      `UPDATE stores SET personality = $1 WHERE store_id = $2 AND api_key = $3 RETURNING id`,
      [personality, store_id, api_key]
    );

    if (result.rowCount === 0) {
      return res
        .status(401)
        .json({ ok: false, error: "Invalid store_id or api_key" });
    }

    return res.json({ ok: true, message: "Personality updated" });
  } catch (err) {
    console.error("Error in /update-personality:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to update personality" });
  }
});

/**
 * Index store products and pages
 */
router.post("/index-store", async (req, res) => {
  const {
    store_id,
    api_key,
    products = [],
    pages = [],
    contact_info = {},
  } = req.body || {};

  if (!store_id || !api_key) {
    return res
      .status(400)
      .json({ ok: false, error: "store_id and api_key are required" });
  }

  const items = buildItemsForEmbedding(products, pages);
  const texts = items.map((item) => item.text);

  console.log(`Embedding ${items.length} items for store_id=${store_id}`);

  try {
    const vectors = await embedTexts(texts);

    const embeddedItems = items.map((item, idx) => {
      let title = "",
        url = "",
        imageUrl = "",
        price = "",
        stockStatus = "instock",
        inStock = true;

      if (item.type === "product") {
        const p = products.find((prod) => String(prod.id) === item.base_id);
        if (p) {
          title = p.title || "";
          url = p.url || "";
          imageUrl = p.image_url || "";
          price = p.price || "";
          stockStatus = p.stock_status || "instock";
          inStock = p.in_stock !== false;
        }
      } else {
        const pg = pages.find((page) => String(page.id) === item.base_id);
        if (pg) {
          title = pg.title || "";
          url = pg.url || "";
        }
      }

      return {
        ...item,
        embedding: vectors[idx],
        title,
        url,
        image_url: imageUrl,
        price,
        stock_status: stockStatus,
        in_stock: inStock,
      };
    });

    // Persist to database
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [store_id]
    );

    if (storeRow.rowCount > 0) {
      const storeDbId = storeRow.rows[0].id;

      // Clear existing items and facts
      await pool.query("DELETE FROM store_items WHERE store_id = $1", [
        storeDbId,
      ]);
      await pool.query("DELETE FROM store_facts WHERE store_id = $1", [
        storeDbId,
      ]);

      console.log(
        `Cleared existing items for store_id=${store_id}, inserting ${embeddedItems.length} new items`
      );

      // Add manual contact info
      if (contact_info.email) {
        await pool.query(
          `INSERT INTO store_facts (store_id, fact_type, key, value)
           VALUES ($1, 'email', 'manual', $2)
           ON CONFLICT (store_id, fact_type, value) DO NOTHING`,
          [storeDbId, contact_info.email]
        );
      }
      if (contact_info.phone) {
        await pool.query(
          `INSERT INTO store_facts (store_id, fact_type, key, value)
           VALUES ($1, 'phone', 'manual', $2)
           ON CONFLICT (store_id, fact_type, value) DO NOTHING`,
          [storeDbId, contact_info.phone]
        );
      }
      if (contact_info.address) {
        await pool.query(
          `INSERT INTO store_facts (store_id, fact_type, key, value)
           VALUES ($1, 'address', 'manual', $2)
           ON CONFLICT (store_id, fact_type, value) DO NOTHING`,
          [storeDbId, contact_info.address]
        );
      }

      const hasManualEmail = !!contact_info.email;
      const hasManualPhone = !!contact_info.phone;

      for (const item of embeddedItems) {
        const itemRes = await pool.query(
          `INSERT INTO store_items (store_id, external_id, type, title, url, image_url, content, embedding, price, stock_status, in_stock)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            storeDbId,
            item.item_id,
            item.type,
            item.title,
            item.url,
            item.image_url,
            item.text,
            item.embedding,
            item.price,
            item.stock_status,
            item.in_stock,
          ]
        );

        const storeItemId = itemRes.rows[0].id;

        // Extract contact facts from content if no manual ones
        if (!hasManualEmail || !hasManualPhone) {
          const facts = extractFactsFromText(item.text);

          for (const fact of facts) {
            if (fact.fact_type === "email" && hasManualEmail) continue;
            if (fact.fact_type === "phone" && hasManualPhone) continue;

            await pool.query(
              `INSERT INTO store_facts (store_id, source_item_id, fact_type, key, value)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (store_id, fact_type, value) DO NOTHING`,
              [storeDbId, storeItemId, fact.fact_type, fact.key, fact.value]
            );
          }
        }
      }

      console.log(
        `Persisted ${embeddedItems.length} items for store_id=${store_id}`
      );
    }

    return res.json({
      ok: true,
      message: "Store indexed successfully",
      received: {
        products: products.length,
        pages: pages.length,
        embedded_items: embeddedItems.length,
      },
    });
  } catch (err) {
    console.error("Error in /index-store:", err);
    return res.status(500).json({ ok: false, error: "Failed to index store" });
  }
});

/**
 * Get index status
 */
router.get("/index-status", async (req, res) => {
  const { store_id, api_key } = req.query || {};

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
      return res
        .status(401)
        .json({ ok: false, error: "Invalid store_id or api_key" });
    }

    const storeDbId = storeRow.rows[0].id;

    const productCount = await pool.query(
      "SELECT COUNT(*) FROM store_items WHERE store_id = $1 AND type = 'product'",
      [storeDbId]
    );
    const pageCount = await pool.query(
      "SELECT COUNT(*) FROM store_items WHERE store_id = $1 AND type = 'page'",
      [storeDbId]
    );
    const embeddingCount = await pool.query(
      "SELECT COUNT(*) FROM store_items WHERE store_id = $1 AND embedding IS NOT NULL",
      [storeDbId]
    );
    const factCount = await pool.query(
      "SELECT COUNT(*) FROM store_facts WHERE store_id = $1",
      [storeDbId]
    );

    const factsResult = await pool.query(
      "SELECT fact_type, key, value FROM store_facts WHERE store_id = $1 ORDER BY fact_type, id",
      [storeDbId]
    );

    const facts = factsResult.rows.map((row) => ({
      type: row.fact_type,
      value: row.value,
      source: row.key === "manual" ? "Manual entry" : "Auto-detected",
    }));

    return res.json({
      ok: true,
      counts: {
        products: parseInt(productCount.rows[0].count),
        pages: parseInt(pageCount.rows[0].count),
        embeddings: parseInt(embeddingCount.rows[0].count),
        facts: parseInt(factCount.rows[0].count),
      },
      facts,
    });
  } catch (err) {
    console.error("Error in /index-status:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to get index status" });
  }
});

module.exports = router;
