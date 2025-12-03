const express = require("express");
require("dotenv").config();
const OpenAI = require("openai");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 4000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// =============================================================================
// DATABASE INITIALIZATION
// =============================================================================

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

    // Ensure columns exist for older tables
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

    console.log("✅ Database initialized");
  } catch (err) {
    console.error("❌ Database initialization error:", err);
  }
}

// =============================================================================
// MIDDLEWARE
// =============================================================================

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

const generateStoreId = () => "store_" + crypto.randomBytes(8).toString("hex");
const generateApiKey = () => "rk_" + crypto.randomBytes(16).toString("hex");

async function embedTexts(texts) {
  if (!texts?.length) return [];

  const BATCH_SIZE = 100;
  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: batch,
    });
    allEmbeddings.push(...response.data.map((item) => item.embedding));
    console.log(
      `Embedded ${Math.min(i + batch.length, texts.length)}/${texts.length}`
    );
  }

  return allEmbeddings;
}

function splitTextIntoChunks(text, maxChars = 1500, overlap = 200) {
  if (!text || typeof text !== "string") return [];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = start + maxChars;
    chunks.push(text.slice(start, end).trim());
    start = end - overlap;
  }

  return chunks;
}

function buildItemsForEmbedding(products, pages) {
  const items = [];

  (products || []).forEach((p) => {
    const text = [
      p.title,
      p.short_description,
      p.description,
      (p.categories || []).join(", "),
      p.price ? `Price: ${p.price}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (text.trim()) {
      items.push({
        type: "product",
        item_id: String(p.id),
        base_id: String(p.id),
        text,
        price: p.price || null,
      });
    }
  });

  (pages || []).forEach((pg) => {
    const fullText = [pg.title, pg.content].filter(Boolean).join("\n\n");
    if (!fullText.trim()) return;

    splitTextIntoChunks(fullText).forEach((chunkText, idx) => {
      items.push({
        type: "page",
        item_id: `${pg.id}#${idx}`,
        base_id: String(pg.id),
        text: chunkText,
      });
    });
  });

  return items;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;

  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : -1;
}

function extractFactsFromText(text) {
  const facts = [];
  if (!text) return facts;

  // Email addresses
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = new Set(text.match(emailRegex) || []);
  emails.forEach((email) =>
    facts.push({ fact_type: "email", key: null, value: email })
  );

  // Phone numbers
  const phoneRegex = /(\+?\d[\d\s\-]{7,}\d)/g;
  const phones = new Set((text.match(phoneRegex) || []).map((p) => p.trim()));
  phones.forEach((phone) =>
    facts.push({ fact_type: "phone", key: null, value: phone })
  );

  // Swedish addresses
  const addressRegex =
    /([A-ZÅÄÖ][A-Za-zÅÄÖåäö .'\-]{1,60}?\d+\w?)\s*,?\s*(\d{3}\s?\d{2})\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö]{1,40})/g;
  let match;
  while ((match = addressRegex.exec(text)) !== null) {
    let [, street, postal, city] = match;
    postal = postal.replace(/\s+/, " ");
    if (postal.length === 5)
      postal = postal.slice(0, 3) + " " + postal.slice(3);
    if (/\d/.test(street)) {
      facts.push({
        fact_type: "address",
        key: null,
        value: `${street}, ${postal} ${city}`.trim(),
      });
    }
  }

  return facts;
}

// =============================================================================
// DATABASE LOADERS
// =============================================================================

async function loadStoreDataFromDb(storeIdString) {
  try {
    const storeRow = await pool.query(
      "SELECT id, store_name, personality FROM stores WHERE store_id = $1",
      [storeIdString]
    );

    if (storeRow.rowCount === 0) return null;

    const { id: storeDbId, store_name, personality } = storeRow.rows[0];

    const itemsRes = await pool.query(
      `SELECT external_id, type, title, url, image_url, content, embedding, price, stock_status, in_stock
       FROM store_items WHERE store_id = $1`,
      [storeDbId]
    );

    if (itemsRes.rowCount === 0) return null;

    return {
      store_name,
      personality: personality || {},
      items: itemsRes.rows.map((row) => ({
        type: row.type,
        item_id: row.external_id,
        text: row.content || row.title || "",
        embedding: row.embedding,
        title: row.title || "",
        url: row.url || "",
        image_url: row.image_url || "",
        price: row.price || "",
        stock_status: row.stock_status || "instock",
        in_stock: row.in_stock !== false,
      })),
    };
  } catch (err) {
    console.error("Error loading store data:", err);
    return null;
  }
}

async function loadStoreFactsFromDb(storeIdString) {
  try {
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [storeIdString]
    );
    if (storeRow.rowCount === 0) return [];

    const factsRes = await pool.query(
      `SELECT fact_type, value FROM store_facts WHERE store_id = $1 ORDER BY fact_type, id`,
      [storeRow.rows[0].id]
    );

    return factsRes.rows;
  } catch (err) {
    console.error("Error loading store facts:", err);
    return [];
  }
}

// =============================================================================
// SYSTEM PROMPT BUILDER - THE HEART OF THE STORE CLERK PERSONALITY
// =============================================================================

function buildSystemPrompt(storeName, personality, userLanguage, queryContext) {
  const {
    tone = "friendly", // friendly, professional, casual, luxurious
    greeting_style = "warm", // warm, brief, enthusiastic
    expertise_level = "helpful", // helpful, expert, casual
    brand_voice = "", // Custom brand voice description
    special_instructions = "", // Any store-specific instructions
  } = personality;

  const toneDescriptions = {
    friendly:
      "warm, approachable, and genuinely helpful—like a favorite local shopkeeper who remembers your preferences",
    professional:
      "knowledgeable and polished, providing clear and accurate information with a touch of warmth",
    casual:
      "relaxed and conversational, like chatting with a friend who happens to work at a cool store",
    luxurious:
      "refined and attentive, providing a premium experience with elegant language and personalized attention",
  };

  const languageInstructions =
    userLanguage === "Swedish"
      ? `## LANGUAGE - CRITICAL
You MUST respond in Swedish. Always. Every single response must be in Swedish.
- Use natural, conversational Swedish—not stiff or formal
- Use Swedish phrases like "Visst!", "Absolut!", "Självklart!", "Vad kul!", "Toppen!"
- Even if the user writes short words like "ok", "ja", "nej" - still respond in Swedish
- Never switch to English unless the user explicitly asks for English`
      : `## LANGUAGE - CRITICAL
You MUST respond in English. Always. Every single response must be in English.
- Keep it natural and conversational
- Use friendly phrases like "Sure!", "Absolutely!", "Of course!", "Great choice!"
- Never switch to Swedish unless the user explicitly asks for Swedish`;

  return `You are a store assistant for ${storeName || "this store"}.

${languageInstructions}

## YOUR PERSONALITY
${toneDescriptions[tone] || toneDescriptions.friendly}
${brand_voice ? `\nBrand voice: ${brand_voice}` : ""}

## HOW YOU COMMUNICATE
- Keep responses concise—2-3 sentences for simple questions, a bit more for complex ones
- Use **bold** for product names when recommending them
- Sound like a real person, not a robot
- Match the customer's energy—if they're excited, share that enthusiasm
- If you're not sure about something, say so naturally

## YOUR KNOWLEDGE
You know about:
- The products in the store (from the data provided below)
- Store policies, shipping, returns (if mentioned in the data)
- Contact information (from verified facts)

You DON'T know about:
- Real-time inventory levels (suggest they check the website or contact the store)
- Information not in the provided data
- Other stores or unrelated topics

## HOW TO HELP CUSTOMERS

**When they're browsing or exploring:**
- Share what makes products special, not just specs
- Notice patterns: "I see you're drawn to the blue stones—we have some beautiful lapis lazuli too"
- Suggest related items naturally, not pushily

**When they ask about specific products:**
- Lead with what makes it great, then details
- If you have multiple options, briefly describe 2-3 and ask what matters most to them
- Include price if available

**When they want to see something:**
- The product image will appear automatically if available
- Describe the product's appearance and qualities based on the description
- Don't apologize for "not having images"—just describe it well

**When they ask something you can't answer:**
- Be honest: "I don't have that specific info, but you can reach us at [contact]"
- Don't make things up—ever

**When they ask about something unrelated to the store:**
- Gently redirect back to the store

## THINGS TO AVOID
- Don't sound scripted or robotic
- Don't over-apologize or be excessively polite
- Don't use corporate jargon
- Don't repeat the same phrases
- Don't recommend products that aren't in the PRODUCTS section below
- Don't mention URLs, image paths, or technical details
- DON'T SWITCH LANGUAGES - stick to ${userLanguage}

${
  special_instructions ? `## STORE-SPECIFIC NOTES\n${special_instructions}` : ""
}

${
  queryContext.isFollowUp
    ? "## CONVERSATION CONTEXT\nThis is a follow-up message. Build on what you've already discussed—don't repeat yourself."
    : ""
}`;
}

// =============================================================================
// QUERY ANALYSIS
// =============================================================================

function analyzeQuery(message, history = [], userLanguage = "Swedish") {
  const messageLower = message.toLowerCase();

  // Check if this seems like a follow-up
  const isFollowUp =
    history.length > 0 &&
    (/^(ja|jo|nej|ok|okej|sure|yes|no|that|the|and|also|what about|how about|vilken|den|det|denna|dessa|tack|bra|fint|perfekt|jättebra)/i.test(
      message
    ) ||
      message.length < 30);

  // Check for recent product discussion in history
  let recentProductContext = null;
  if (history.length > 0) {
    const recentMessages = history
      .slice(-4)
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();
    // Could extract product names mentioned recently
  }

  return {
    isVisual:
      /\b(visa|se|ser|titta|bild|foto|image|show|see|look|picture|looks? like|hur ser|visar)\b/i.test(
        message
      ),
    isAvailability:
      /\b(har ni|finns|säljer|tillgänglig|i lager|available|have|stock|sell|got)\b/i.test(
        message
      ),
    isProductQuery:
      /\b(produkt|sten|kristall|mineral|product|stone|crystal|item|buy|köpa|price|pris|cost|kosta)\b/i.test(
        message
      ),
    isGeneralInfo:
      /\b(vad|vilka|expert|specialisera|sortiment|what|specialize|sell|offer|about|om er|berätta)\b/i.test(
        message
      ),
    isContact:
      /\b(kontakt|email|telefon|contact|phone|reach|address|adress|öppet|hours|öppettider)\b/i.test(
        message
      ),
    isGreeting:
      /^(hej|hello|hi|hey|tjena|hallå|god dag|good morning|good afternoon|tja|hejsan|hejhej)[\s!?.]*$/i.test(
        message
      ),
    isFollowUp,
    recentProductContext,
    userLanguage, // Use the passed language, don't detect
  };
}

// =============================================================================
// ROUTES
// =============================================================================

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Register store
app.post("/register-store", async (req, res) => {
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

// Update store personality
app.post("/update-personality", async (req, res) => {
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

// Index store
app.post("/index-store", async (req, res) => {
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

      await pool.query("DELETE FROM store_facts WHERE store_id = $1", [
        storeDbId,
      ]);

      // First, add manual contact info if provided (these take priority)
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

      // Track if we already have manual contact info
      const hasManualEmail = !!contact_info.email;
      const hasManualPhone = !!contact_info.phone;

      for (const item of embeddedItems) {
        const itemRes = await pool.query(
          `INSERT INTO store_items (store_id, external_id, type, title, url, image_url, content, embedding, price, stock_status, in_stock)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (store_id, external_id, type)
           DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url, image_url = EXCLUDED.image_url,
                         content = EXCLUDED.content, embedding = EXCLUDED.embedding, price = EXCLUDED.price,
                         stock_status = EXCLUDED.stock_status, in_stock = EXCLUDED.in_stock
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

        // Only extract contact facts from content if we don't have manual ones
        if (!hasManualEmail || !hasManualPhone) {
          const facts = extractFactsFromText(item.text);

          for (const fact of facts) {
            // Skip if we already have manual contact info of this type
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

// Chat endpoint
app.post("/chat", async (req, res) => {
  let { store_id, message, history = [], language } = req.body || {};

  if (!store_id || !message) {
    return res
      .status(400)
      .json({ ok: false, error: "store_id and message are required" });
  }

  message = String(message).trim();
  if (!message) {
    return res
      .status(400)
      .json({ ok: false, error: "message cannot be empty" });
  }

  // Load store data
  const storeData = await loadStoreDataFromDb(store_id);
  const storeFacts = await loadStoreFactsFromDb(store_id);

  if (!storeData?.items?.length) {
    return res
      .status(400)
      .json({
        ok: false,
        error: "No data found for this store. Please index the store first.",
      });
  }

  // Determine language: use frontend config, fallback to store personality, then detection
  let userLanguage = "Swedish"; // Default to Swedish

  if (language === "sv" || language === "Swedish") {
    userLanguage = "Swedish";
  } else if (language === "en" || language === "English") {
    userLanguage = "English";
  } else if (storeData.personality?.language === "sv") {
    userLanguage = "Swedish";
  } else if (storeData.personality?.language === "en") {
    userLanguage = "English";
  }
  // Note: We no longer try to detect from message content - we trust the configured language

  try {
    // Analyze the query (pass the determined language)
    const queryContext = analyzeQuery(message, history, userLanguage);

    // Handle simple greetings without RAG
    if (queryContext.isGreeting) {
      const greetings = {
        Swedish: [
          "Hej! 👋 Vad kan jag hjälpa dig med idag?",
          "Hej hej! Vad letar du efter?",
          "Hallå! Hur kan jag hjälpa dig?",
        ],
        English: [
          "Hey there! 👋 What can I help you find today?",
          "Hi! What are you looking for?",
          "Hello! How can I help you?",
        ],
      };
      const options = greetings[userLanguage];
      return res.json({
        ok: true,
        store_id,
        answer: options[Math.floor(Math.random() * options.length)],
        product_cards: [],
      });
    }

    // Embed the query
    const [queryVector] = await embedTexts([message]);

    // Score all items (filter out out-of-stock products)
    const scored = storeData.items
      .filter((item) => {
        // Keep all pages
        if (item.type !== "product") return true;
        // Filter out out-of-stock products
        return item.in_stock !== false;
      })
      .map((item) => ({
        item,
        score: cosineSimilarity(queryVector, item.embedding),
      }));
    scored.sort((a, b) => b.score - a.score);

    // Separate products and pages
    const scoredProducts = scored.filter((s) => s.item.type === "product");
    const scoredPages = scored.filter((s) => s.item.type === "page");

    // Dynamic thresholds based on query type
    const productThreshold = queryContext.isVisual ? 0.32 : 0.38;
    const pageThreshold = 0.45;
    const topProductCount = queryContext.isGeneralInfo
      ? 12
      : queryContext.isVisual
      ? 3
      : 6;

    const relevantProducts = scoredProducts
      .filter((s) => s.score >= productThreshold)
      .slice(0, topProductCount);
    const relevantPages = scoredPages
      .filter((s) => s.score >= pageThreshold)
      .slice(0, 3);

    // Build context for the LLM
    const MAX_SNIPPET = 600;

    let contextParts = [];

    if (relevantProducts.length > 0) {
      contextParts.push("## PRODUCTS (all in stock)");
      relevantProducts.forEach((entry, idx) => {
        const { item, score } = entry;
        let snippet =
          item.text.length > MAX_SNIPPET
            ? item.text.slice(0, MAX_SNIPPET) + "..."
            : item.text;
        contextParts.push(
          `\n**${item.title}**${item.price ? ` — ${item.price}` : ""}`,
          `Relevance: ${score.toFixed(2)}`,
          item.image_url ? `[Image available]` : "",
          snippet
        );
      });
    }

    if (relevantPages.length > 0) {
      contextParts.push("\n## STORE INFO (not products)");
      relevantPages.forEach((entry) => {
        const { item, score } = entry;
        let snippet =
          item.text.length > MAX_SNIPPET
            ? item.text.slice(0, MAX_SNIPPET) + "..."
            : item.text;
        contextParts.push(
          `\n**${item.title}** (Relevance: ${score.toFixed(2)})`,
          snippet
        );
      });
    }

    // Add contact info
    if (storeFacts.length > 0) {
      const emails = [
        ...new Set(
          storeFacts.filter((f) => f.fact_type === "email").map((f) => f.value)
        ),
      ];
      const phones = [
        ...new Set(
          storeFacts.filter((f) => f.fact_type === "phone").map((f) => f.value)
        ),
      ];
      const addresses = [
        ...new Set(
          storeFacts
            .filter((f) => f.fact_type === "address")
            .map((f) => f.value)
        ),
      ];

      if (emails.length || phones.length || addresses.length) {
        contextParts.push("\n## CONTACT INFO");
        if (emails.length) contextParts.push(`Email: ${emails.join(", ")}`);
        if (phones.length) contextParts.push(`Phone: ${phones.join(", ")}`);
        if (addresses.length)
          contextParts.push(`Address: ${addresses.join(" | ")}`);
      }
    }

    const context = contextParts.join("\n");

    // Build messages
    const messages = [
      {
        role: "system",
        content: buildSystemPrompt(
          storeData.store_name,
          storeData.personality,
          queryContext.userLanguage,
          queryContext
        ),
      },
    ];

    // Add conversation history (last 12 messages)
    const recentHistory = (history || []).slice(-12);
    recentHistory.forEach((msg) => {
      if (
        (msg.role === "user" || msg.role === "assistant") &&
        msg.content?.trim()
      ) {
        messages.push({ role: msg.role, content: msg.content.trim() });
      }
    });

    // Add current message if not already there
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== "user" || lastMsg.content !== message) {
      messages.push({ role: "user", content: message });
    }

    // Add RAG context
    const bestProductScore = relevantProducts[0]?.score || 0;
    const confidenceNote =
      bestProductScore < 0.45 && queryContext.isProductQuery
        ? "\n\n⚠️ Note: These results aren't a strong match. Be honest if nothing fits well."
        : "";

    messages.push({
      role: "user",
      content: `[STORE DATA - use this to answer the customer's question]\n\n${context}${confidenceNote}`,
    });

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages,
      temperature: 0.4,
      max_tokens: 400,
    });

    const answer =
      completion.choices[0]?.message?.content ||
      "Sorry, I couldn't generate a response.";

    // Determine product cards to show
    const cardThreshold = queryContext.isVisual ? 0.32 : 0.45;
    const productCandidates = relevantProducts.filter(
      (e) => e.score >= cardThreshold && e.item.url && e.item.image_url
    );

    let productCards = [];

    if (queryContext.isVisual && productCandidates.length > 0) {
      // Visual query: show top match
      productCards = [productCandidates[0]].map((e) => ({
        title: e.item.title,
        url: e.item.url,
        image_url: e.item.image_url,
        price: e.item.price || null,
      }));
    } else if (productCandidates.length > 0) {
      // Check if product mentioned in answer
      const answerLower = answer.toLowerCase();
      productCards = productCandidates
        .slice(0, 2)
        .filter((e) => {
          const words = e.item.title
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length >= 3);
          return words.some((w) => answerLower.includes(w));
        })
        .slice(0, 1)
        .map((e) => ({
          title: e.item.title,
          url: e.item.url,
          image_url: e.item.image_url,
          price: e.item.price || null,
        }));
    }

    return res.json({
      ok: true,
      store_id,
      answer,
      product_cards: productCards,
      debug: {
        query: queryContext,
        products_found: relevantProducts.length,
        pages_found: relevantPages.length,
        best_product_score: bestProductScore.toFixed(3),
        top_products: relevantProducts.slice(0, 3).map((e) => ({
          title: e.item.title,
          score: e.score.toFixed(3),
        })),
      },
    });
  } catch (err) {
    console.error("Error in /chat:", err);
    return res
      .status(500)
      .json({ ok: false, error: "Failed to generate response" });
  }
});

// =============================================================================
// START SERVER
// =============================================================================

initDb();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
