const express = require("express");
require("dotenv").config();
const OpenAI = require("openai");
const { Pool } = require("pg");
const crypto = require("crypto");

const app = express();
const PORT = 4000;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Postgres-anslutning (läser DATABASE_URL från .env)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDb() {
  try {
    // 1) stores-tabell
    await pool.query(`
      CREATE TABLE IF NOT EXISTS stores (
        id SERIAL PRIMARY KEY,
        store_id TEXT UNIQUE NOT NULL,
        api_key TEXT NOT NULL,
        site_url TEXT,
        store_name TEXT,
        admin_email TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Säkerställ att nya kolumner finns även om tabellen fanns sedan tidigare
    await pool.query(`
      ALTER TABLE stores
      ADD COLUMN IF NOT EXISTS site_url TEXT;
    `);
    await pool.query(`
      ALTER TABLE stores
      ADD COLUMN IF NOT EXISTS store_name TEXT;
    `);
    await pool.query(`
      ALTER TABLE stores
      ADD COLUMN IF NOT EXISTS admin_email TEXT;
    `);

    // Unik index på site_url så vi kan använda ON CONFLICT (site_url)
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stores_site_url
      ON stores(site_url);
    `);

    // 2) store_items-tabell
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_items (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        external_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT,
        url TEXT,
        content TEXT,
        embedding DOUBLE PRECISION[],
        UNIQUE (store_id, external_id, type)
      );
    `);

    // 3) store_facts-tabell (generiska fakta som e-post, telefon, etc.)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS store_facts (
        id SERIAL PRIMARY KEY,
        store_id INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
        source_item_id INTEGER REFERENCES store_items(id) ON DELETE CASCADE,
        fact_type TEXT NOT NULL,      -- t.ex. 'email', 'phone', 'address'
        key TEXT,                     -- t.ex. 'primary', 'support', kan vara NULL
        value TEXT NOT NULL,          -- själva värdet: e-post, telefonnummer, etc.
        created_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE (store_id, fact_type, value)
      );
    `);

    console.log("✅ Database initialized (tables ready)");
  } catch (err) {
    console.error("❌ Error initializing database:", err);
  }
}

// Very open CORS for MVP – allow all origins and handle preflight
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    // Preflight request – no body, just OK
    return res.sendStatus(200);
  }

  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// In-memory storage to simulate a DB (for development)
const storeIndexes = {}; // raw products/pages per store
const storeEmbeddings = {}; // embeddings per store

// ---------- Helpers: IDs, embeddings, text-chunks ----------

function generateStoreId() {
  return "store_" + crypto.randomBytes(8).toString("hex");
}

function generateApiKey() {
  return "rk_" + crypto.randomBytes(16).toString("hex");
}

async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });

  return response.data.map((item) => item.embedding);
}

function splitTextIntoChunks(text, maxChars = 1500, overlap = 200) {
  if (!text || typeof text !== "string") return [];

  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = start + maxChars;
    const slice = text.slice(start, end);
    chunks.push(slice.trim());
    start = end - overlap; // lite överlapp för att inte “klippa sönder” meningar helt
  }

  return chunks;
}

function buildItemsForEmbedding(products, pages) {
  const items = [];

  // --- PRODUKTER: kan oftast ligga som en chunk var ---
  (products || []).forEach((p) => {
    const textParts = [
      p.title || "",
      p.short_description || "",
      p.description || "",
      (p.categories || []).join(", "),
      JSON.stringify(p.attributes || {}),
    ];

    const text = textParts.filter(Boolean).join("\n\n");

    if (text.trim()) {
      items.push({
        type: "product",
        item_id: String(p.id), // används som external_id
        base_id: String(p.id), // original-ID, bra att ha
        text,
      });
    }
  });

  // --- PAGES: chunkas upp i flera bitar om de är långa ---
  (pages || []).forEach((pg) => {
    const fullTextParts = [pg.title || "", pg.content || ""];
    const fullText = fullTextParts.filter(Boolean).join("\n\n");

    if (!fullText.trim()) return;

    const chunks = splitTextIntoChunks(fullText, 1500, 200);

    chunks.forEach((chunkText, idx) => {
      items.push({
        type: "page",
        // Unikt ID per chunk (viktigt pga UNIQUE(store_id, external_id, type))
        item_id: `${pg.id}#${idx}`,
        base_id: String(pg.id), // “riktiga” page-ID:t
        text: chunkText,
      });
    });
  });

  return items;
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return -1;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const va = a[i];
    const vb = b[i];
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }

  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------- Facts-extraktion ----------

function extractFactsFromText(text) {
  const facts = [];
  if (!text || typeof text !== "string") return facts;

  // Dela upp i rader för att kunna se block som "Kontakt", "Adress" osv.
  const lines = text
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fullText = text; // behåller originalet för vissa regexar

  // 1) E-postadresser (i hela texten)
  {
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

    const emails = new Set();
    let match;

    while ((match = emailRegex.exec(fullText)) !== null) {
      emails.add(match[0]);
    }

    for (const email of emails) {
      facts.push({
        fact_type: "email",
        key: null,
        value: email,
      });
    }
  }

  // 2) Telefonnummer (i hela texten)
  {
    const phoneRegex = /(\+?\d[\d\s\-]{7,}\d)/g;
    const phones = new Set();
    let match;

    while ((match = phoneRegex.exec(fullText)) !== null) {
      phones.add(match[1].trim());
    }

    for (const phone of phones) {
      facts.push({
        fact_type: "phone",
        key: null,
        value: phone,
      });
    }
  }

  // 3) Adresser (svensk-orienterad heuristik, mer specificerad)
  {
    const addresses = new Set();

    // Försök fånga mönster som:
    // "Täljö Ringväg 40, 184 92 Åkersberga"
    const addressRegex =
      /([A-ZÅÄÖ][A-Za-zÅÄÖåäö .'\-]{1,60}?\d+\w?)\s*,?\s*(\d{3}\s?\d{2})\s+([A-ZÅÄÖ][A-Za-zÅÄÖåäö .'\-]{1,40})/g;

    let match;
    while ((match = addressRegex.exec(fullText)) !== null) {
      let streetPart = match[1].trim(); // t.ex. "Täljö Ringväg 40"
      let postalCode = match[2].trim(); // t.ex. "184 92" eller "18492"
      let cityRaw = match[3].trim(); // t.ex. "Åkersberga Öppettider Mån-Fre"

      // Normalisera postnummer till "123 45"
      postalCode = postalCode.replace(/\s+/, " ");
      if (postalCode.length === 5) {
        postalCode = postalCode.slice(0, 3) + " " + postalCode.slice(3);
      }

      // Ta bara första 1–2 orden som stad
      const cityTokens = cityRaw.split(/\s+/);
      let city = cityTokens[0] || "";
      if (
        cityTokens.length > 1 &&
        !/^öppettider$/i.test(cityTokens[1]) // skydda mot "Åkersberga Öppettider"
      ) {
        city = city + " " + cityTokens[1];
      }
      city = city.trim();

      // Extra safeguard: kräver att gatudelen faktiskt innehåller en siffra (husnummer)
      if (!/\d/.test(streetPart)) continue;

      const candidate = `${streetPart}, ${postalCode} ${city}`.trim();

      addresses.add(candidate);
    }

    for (const addr of addresses) {
      facts.push({
        fact_type: "address",
        key: null,
        value: addr,
      });
    }
  }

  return facts;
}

// ---------- Helpers: ladda data/fakta från DB ----------

async function loadStoreFactsFromDb(storeIdString) {
  try {
    // Hämta interna store-id
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [storeIdString]
    );

    if (storeRow.rowCount === 0) {
      console.warn(
        "No DB store row found for store_id in facts:",
        storeIdString
      );
      return [];
    }

    const storeDbId = storeRow.rows[0].id;

    // Hämta alla facts
    const factsRes = await pool.query(
      `
      SELECT fact_type, value
      FROM store_facts
      WHERE store_id = $1
      ORDER BY fact_type, id
      `,
      [storeDbId]
    );

    return factsRes.rows; // [{ fact_type: 'email', value: '...' }, ...]
  } catch (err) {
    console.error("Error loading store facts from DB:", err);
    return [];
  }
}

async function loadStoreDataFromDb(storeIdString) {
  try {
    // 1) Hämta interna store-id (PK) från stores-tabellen
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [storeIdString]
    );

    if (storeRow.rowCount === 0) {
      console.warn("No DB store row found for store_id=", storeIdString);
      return null;
    }

    const storeDbId = storeRow.rows[0].id;

    // 2) Hämta alla items för den butiken
    const itemsRes = await pool.query(
      `
      SELECT external_id, type, title, url, content, embedding
      FROM store_items
      WHERE store_id = $1
      `,
      [storeDbId]
    );

    if (itemsRes.rowCount === 0) {
      console.warn("No store_items rows found for store_id=", storeIdString);
      return null;
    }

    const items = itemsRes.rows.map((row) => ({
      type: row.type,
      item_id: row.external_id,
      text: row.content || row.title || "",
      embedding: row.embedding, // DOUBLE PRECISION[] -> JS-array
    }));

    return { items };
  } catch (err) {
    console.error("Error loading store data from DB:", err);
    return null;
  }
}

// ---------- ROUTES ----------

// POST /register-store
app.post("/register-store", async (req, res) => {
  console.log("register-store body:", req.body);

  const { site_url, store_name, admin_email } = req.body || {};

  if (!site_url || !admin_email) {
    return res
      .status(400)
      .json({ ok: false, error: "site_url and admin_email are required" });
  }

  // Generera förslag på nytt storeId/apiKey – används vid första insert
  // eller när ingen rad finns för denna site_url.
  const newStoreId = generateStoreId();
  const newApiKey = generateApiKey();

  try {
    // Använd site_url som unik "nyckel" för butiken.
    // Vid första gången skapas raden; vid nästa gång uppdateras api_key + metadata,
    // men store_id behålls.
    const result = await pool.query(
      `
      INSERT INTO stores (store_id, api_key, site_url, store_name, admin_email)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (site_url)
      DO UPDATE SET
        api_key = EXCLUDED.api_key,
        store_name = EXCLUDED.store_name,
        admin_email = EXCLUDED.admin_email
      RETURNING id, store_id, api_key;
      `,
      [newStoreId, newApiKey, site_url, store_name || null, admin_email]
    );

    const row = result.rows[0];
    console.log("Store registered/updated in DB with id:", row.id);

    return res.json({
      ok: true,
      store_id: row.store_id,
      api_key: row.api_key,
      message: "Store registered/updated and stored in DB.",
    });
  } catch (err) {
    console.error("Error in /register-store:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to register store in DB",
    });
  }
});

// POST /index-store
app.post("/index-store", async (req, res) => {
  console.log("index-store body:", req.body);

  const body = req.body || {};
  const { store_id, api_key, products = [], pages = [] } = body;

  if (!store_id || !api_key) {
    return res
      .status(400)
      .json({ ok: false, error: "store_id and api_key are required" });
  }

  // (Framtid: validera api_key mot stores-tabellen här)

  // 1) Store raw data (like before)
  storeIndexes[store_id] = {
    api_key,
    products,
    pages,
    receivedAt: new Date().toISOString(),
  };

  // 2) Build items we want to embed
  const items = buildItemsForEmbedding(products, pages);
  const texts = items.map((item) => item.text);

  console.log(
    `Preparing to embed ${items.length} items for store_id=${store_id}`
  );

  try {
    // 3) Call OpenAI embeddings
    const vectors = await embedTexts(texts);

    // 4) Combine items + vectors into embedding records
    const embeddedItems = items.map((item, idx) => ({
      type: item.type,
      item_id: item.item_id,
      base_id: item.base_id || null,
      text: item.text,
      embedding: vectors[idx],
    }));

    // 5) Store in memory as our "vector DB"
    storeEmbeddings[store_id] = {
      api_key,
      items: embeddedItems,
      embeddedAt: new Date().toISOString(),
    };

    console.log(
      `Stored ${embeddedItems.length} embedded items for store_id=${store_id} (in memory)`
    );

    // 6) Also persist to Postgres
    try {
      // 6a. Hämta interna store-id
      const storeRow = await pool.query(
        "SELECT id FROM stores WHERE store_id = $1",
        [store_id]
      );

      if (storeRow.rowCount === 0) {
        console.warn(
          "No DB store row found for store_id=",
          store_id,
          "Skipping DB embedding & facts save."
        );
      } else {
        const storeDbId = storeRow.rows[0].id;

        // Rensa gamla facts för den här butiken (vi bygger upp dem igen)
        await pool.query("DELETE FROM store_facts WHERE store_id = $1", [
          storeDbId,
        ]);

        // 6b. Upsert varje item i store_items + extrahera fakta
        // Håll koll på om vi redan har sparat email/phone för den här butiken
        const seenSingleFacts = {
          email: false,
          phone: false,
        };

        for (const item of embeddedItems) {
          let title = "";
          let url = "";

          if (item.type === "product") {
            const lookupId = item.base_id || item.item_id;
            const p = (products || []).find(
              (prod) => String(prod.id) === String(lookupId)
            );
            if (p) {
              title = p.title || "";
              url = p.url || "";
            }
          } else if (item.type === "page") {
            const lookupId = item.base_id || item.item_id;
            const pg = (pages || []).find(
              (page) => String(page.id) === String(lookupId)
            );
            if (pg) {
              title = pg.title || "";
              url = pg.url || "";
            }
          }

          const itemRes = await pool.query(
            `
            INSERT INTO store_items (store_id, external_id, type, title, url, content, embedding)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (store_id, external_id, type)
            DO UPDATE SET
              title = EXCLUDED.title,
              url = EXCLUDED.url,
              content = EXCLUDED.content,
              embedding = EXCLUDED.embedding
            RETURNING id
            `,
            [
              storeDbId,
              String(item.item_id), // unika chunk-ID:t, t.ex. "768#1"
              item.type,
              title,
              url,
              item.text,
              item.embedding,
            ]
          );

          const storeItemId = itemRes.rows[0].id;

          // 6c. Extrahera fakta ur item.text (e-post, telefon, m.m.)
          const facts = extractFactsFromText(item.text);

          for (const fact of facts) {
            const type = fact.fact_type;

            // Vi vill bara ha MAX 1 email och MAX 1 phone per butik
            if (type === "email" || type === "phone") {
              if (seenSingleFacts[type]) {
                // Hoppa över fler av samma typ
                continue;
              }
            }

            await pool.query(
              `
              INSERT INTO store_facts (store_id, source_item_id, fact_type, key, value)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (store_id, fact_type, value)
              DO NOTHING
              `,
              [storeDbId, storeItemId, type, fact.key, fact.value]
            );

            // Markera att vi nu har sparat en sådan här typ
            if (type === "email" || type === "phone") {
              seenSingleFacts[type] = true;
            }
          }
        }

        console.log(
          `Persisted ${embeddedItems.length} embedded items and extracted facts to DB for store_id=${store_id}`
        );
      }
    } catch (dbErr) {
      console.error("Error saving embeddings/facts to DB:", dbErr);
    }

    return res.json({
      ok: true,
      message:
        "Index request received and embeddings created (in-memory and DB).",
      received: {
        products: products.length,
        pages: pages.length,
        embedded_items: embeddedItems.length,
      },
    });
  } catch (err) {
    console.error("Error generating embeddings:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate embeddings",
    });
  }
});

// Explicit CORS preflight handler for /chat
app.options("/chat", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  return res.sendStatus(200);
});

// POST /chat
app.post("/chat", async (req, res) => {
  const body = req.body || {};
  let { store_id, message, history = [], session_id } = body;

  console.log("chat body:", body);
  if (session_id) {
    console.log("session_id:", session_id);
  }

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

  // 1) Försök först använda embeddings i minnet
  let storeData = storeEmbeddings[store_id];

  if (
    !storeData ||
    !Array.isArray(storeData.items) ||
    storeData.items.length === 0
  ) {
    storeData = await loadStoreDataFromDb(store_id);
  }

  // Ladda även strukturerade facts från DB (adress, telefon, email)
  const storeFacts = await loadStoreFactsFromDb(store_id);
  let factsContext = "";

  if (Array.isArray(storeFacts) && storeFacts.length > 0) {
    const emails = [
      ...new Set(
        storeFacts
          .filter((f) => f.fact_type === "email")
          .map((f) => f.value.trim())
      ),
    ];
    const phones = [
      ...new Set(
        storeFacts
          .filter((f) => f.fact_type === "phone")
          .map((f) => f.value.trim())
      ),
    ];
    const addresses = [
      ...new Set(
        storeFacts
          .filter((f) => f.fact_type === "address")
          .map((f) => f.value.trim())
      ),
    ];

    const lines = [];
    if (emails.length > 0) {
      lines.push(`Verified store emails: ${emails.join(", ")}`);
    }
    if (phones.length > 0) {
      lines.push(`Verified store phone numbers: ${phones.join(", ")}`);
    }
    if (addresses.length > 0) {
      lines.push(`Verified store addresses: ${addresses.join(" | ")}`);
    }

    if (lines.length > 0) {
      factsContext =
        "Here are verified contact facts for this store. " +
        "Only use them when the user asks for contact details (email, phone, address) " +
        "or when you cannot answer a question and need to refer the user to the store:\n" +
        lines.join("\n");
    }
  }

  // Om vi fortfarande inte har embeddings -> fel som tidigare
  if (
    !storeData ||
    !Array.isArray(storeData.items) ||
    storeData.items.length === 0
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "No embeddings found for this store_id (memory or DB). Make sure you have indexed the store first.",
    });
  }

  try {
    // 2) Embed the user message
    const queryEmbeddings = await embedTexts([message]);
    const queryVector = queryEmbeddings[0];

    // 3) Compute similarity to each item
    const scored = storeData.items.map((item) => ({
      item,
      score: cosineSimilarity(queryVector, item.embedding),
    }));

    // 4) Sort by similarity (descending) and take top N
    const TOP_N = 5;
    const MAX_SNIPPET_CHARS = 1000;
    const RELEVANCE_THRESHOLD = 0.3;

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, TOP_N);

    let maxScore = -1;
    for (const entry of top) {
      if (entry.score > maxScore) {
        maxScore = entry.score;
      }
    }
    const lowConfidence = maxScore < RELEVANCE_THRESHOLD;

    // 5) Build a context string from the top items (med trimming)
    const contextParts = top.map((entry, index) => {
      const { item, score } = entry;

      let snippet = item.text || "";
      if (snippet.length > MAX_SNIPPET_CHARS) {
        snippet = snippet.slice(0, MAX_SNIPPET_CHARS) + " ...";
      }

      return [
        `# Result ${index + 1}`,
        `Type: ${item.type}`,
        `Item ID: ${item.item_id}`,
        `Relevance score: ${score.toFixed(4)}`,
        ``,
        snippet,
        ``,
      ].join("\n");
    });

    const context = contextParts.join("\n-------------------------\n\n");

    const messages = [];

    // 1) System – den korta prompten ovan
    messages.push({
      role: "system",
      content:
        "You are RUMI, an AI assistant embedded on an online store's website. " +
        "Act like a friendly, human-like support agent. " +
        "You can use both the store data provided in this conversation and your general world knowledge to help the user. " +
        "Always answer in the same language as the user. " +
        "If you truly cannot find an answer to a store-specific question (like an exact price or opening hours), be honest about that instead of guessing.\n\n" +
        "STYLE:\n" +
        "- Keep answers short and easy to scan in a small chat window.\n" +
        "- Prefer 1–2 short sentences followed by a simple bullet list when it makes sense.\n" +
        "- Use Markdown: **bold** for important words or product names, and line breaks between paragraphs or list items.\n" +
        "- Avoid long blocks of text; split information into multiple lines.",
    });

    // 2) Tidigare chatt-historik – sanera och undvik dubletter
    const sanitizedHistory = [];
    if (Array.isArray(history)) {
      history.forEach((msg) => {
        if (
          msg &&
          (msg.role === "user" || msg.role === "assistant") &&
          typeof msg.content === "string"
        ) {
          const cleanContent = msg.content.trim();
          if (!cleanContent) return;
          sanitizedHistory.push({
            role: msg.role,
            content: cleanContent,
          });
          messages.push({
            role: msg.role,
            content: cleanContent,
          });
        }
      });
    }

    // 3) Lägg in verified facts (adress / telefon / email) som ett helt vanligt assistant-svar
    if (factsContext) {
      messages.push({
        role: "assistant",
        content: factsContext,
      });
    }

    // 4) Lägg in RAG-contexten, med en liten hint om hur säker matchningen är
    let ragIntro;
    if (!top.length || lowConfidence) {
      ragIntro =
        "Jag hittade inga starka matchningar i butikens indexerade innehåll. " +
        "Här är det som verkar mest relevant, men svara hellre mer allmänt och var tydlig om osäkerheten:";
    } else {
      ragIntro =
        "Här är information från butikens produkter, tjänster och sidor som verkar relevant:";
    }

    messages.push({
      role: "assistant",
      content: ragIntro + "\n\n" + (context || "(ingen ytterligare kontext)"),
    });

    // 5) Till sist: användarens fråga – men undvik att lägga till den två gånger
    let shouldAppendUserMessage = true;
    if (sanitizedHistory.length > 0) {
      const last = sanitizedHistory[sanitizedHistory.length - 1];
      if (last.role === "user" && last.content === message) {
        shouldAppendUserMessage = false;
      }
    }

    if (shouldAppendUserMessage) {
      messages.push({
        role: "user",
        content: message,
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages,
      temperature: 0.3,
    });

    const answer =
      completion.choices[0]?.message?.content ||
      "Sorry, I could not generate a response.";

    return res.json({
      ok: true,
      store_id,
      answer,
      used_items: top.map((entry) => ({
        type: entry.item.type,
        item_id: entry.item.item_id,
        score: entry.score,
      })),
      max_relevance_score: maxScore,
      low_confidence: lowConfidence,
    });
  } catch (err) {
    console.error("Error in /chat:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to generate chat response",
    });
  }
});

//-------------------- DEBUG ----------------------//

// TEST: simple embeddings debug endpoint
app.get("/debug-embed-test", async (req, res) => {
  try {
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: "Hello from RUMI! This is a test embedding.",
    });

    const embedding = response.data[0].embedding;

    return res.json({
      ok: true,
      model: "text-embedding-3-small",
      embedding_dimensions: embedding.length,
      embedding_preview: embedding.slice(0, 5), // first 5 numbers just as a preview
    });
  } catch (err) {
    console.error("Error in /debug-embed-test:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to create embedding",
    });
  }
});

// GET /debug-index/:store_id  -> see what we stored
app.get("/debug-index/:store_id", (req, res) => {
  const storeId = req.params.store_id;
  const data = storeIndexes[storeId];

  if (!data) {
    return res
      .status(404)
      .json({ ok: false, error: "No index found for this store_id" });
  }

  return res.json({
    ok: true,
    store_id: storeId,
    index: data,
  });
});

// GET /debug-embeddings/:store_id  -> see embedded items for a store
app.get("/debug-embeddings/:store_id", (req, res) => {
  const storeId = req.params.store_id;
  const data = storeEmbeddings[storeId];

  if (!data) {
    return res
      .status(404)
      .json({ ok: false, error: "No embeddings found for this store_id" });
  }

  // To avoid huge payloads, show only a preview
  const previewItems = data.items.map((item) => ({
    type: item.type,
    item_id: item.item_id,
    text_preview:
      item.text.slice(0, 200) + (item.text.length > 200 ? "..." : ""),
    embedding_dimensions: item.embedding.length,
  }));

  return res.json({
    ok: true,
    store_id: storeId,
    embeddedAt: data.embeddedAt,
    items_preview: previewItems,
  });
});

// GET /debug-facts/:store_id  -> see extracted facts (email, phone, address, etc.)
app.get("/debug-facts/:store_id", async (req, res) => {
  const storeIdString = req.params.store_id;

  try {
    // Hitta interna store-id
    const storeRow = await pool.query(
      "SELECT id FROM stores WHERE store_id = $1",
      [storeIdString]
    );

    if (storeRow.rowCount === 0) {
      return res
        .status(404)
        .json({ ok: false, error: "No store found for this store_id" });
    }

    const storeDbId = storeRow.rows[0].id;

    // Hämta facts + koppla tillbaka till item (så vi ser var de kommer ifrån)
    const factsRes = await pool.query(
      `
      SELECT
        f.id,
        f.fact_type,
        f.key,
        f.value,
        i.external_id,
        i.type AS item_type,
        i.title AS item_title,
        i.url   AS item_url
      FROM store_facts f
      LEFT JOIN store_items i
        ON f.source_item_id = i.id
      WHERE f.store_id = $1
      ORDER BY f.fact_type, f.value;
      `,
      [storeDbId]
    );

    return res.json({
      ok: true,
      store_id: storeIdString,
      total: factsRes.rowCount,
      facts: factsRes.rows.map((row) => ({
        id: row.id,
        fact_type: row.fact_type,
        key: row.key,
        value: row.value,
        source: {
          external_id: row.external_id,
          type: row.item_type,
          title: row.item_title,
          url: row.item_url,
        },
      })),
    });
  } catch (err) {
    console.error("Error in /debug-facts:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to load facts for this store",
    });
  }
});

// Health check (nice to keep)
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Kör DB-init
initDb();

// Start server
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
