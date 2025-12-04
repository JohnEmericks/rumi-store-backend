/**
 * Embedding Service
 *
 * Handles OpenAI embeddings and text processing.
 */

const OpenAI = require("openai");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Generate embeddings for an array of texts
 */
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

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

/**
 * Split text into overlapping chunks
 */
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

/**
 * Build items for embedding from products and pages
 */
function buildItemsForEmbedding(products, pages) {
  const items = [];

  (products || []).forEach((p) => {
    const textParts = [
      p.title,
      p.short_description,
      p.description,
      (p.categories || []).join(", "),
      p.price ? `Price: ${p.price}` : "",
    ];

    if (p.rumi_supplement) {
      textParts.push("Additional info: " + p.rumi_supplement);
    }

    const text = textParts.filter(Boolean).join("\n\n");

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

/**
 * Extract facts (email, phone) from text
 */
function extractFactsFromText(text) {
  const facts = [];
  if (!text) return facts;

  // Email
  const emailMatch = text.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  );
  if (emailMatch) {
    emailMatch.forEach((e) => {
      if (!e.includes("example.") && !e.includes("test@")) {
        facts.push({
          fact_type: "email",
          key: "email",
          value: e.toLowerCase(),
        });
      }
    });
  }

  // Phone
  const phoneMatch = text.match(
    /(?:\+46|0)[\s\-]?\d{1,3}[\s\-]?\d{2,3}[\s\-]?\d{2}[\s\-]?\d{2}/g
  );
  if (phoneMatch) {
    phoneMatch.forEach((p) => {
      const normalized = p.replace(/[\s\-]/g, "");
      facts.push({ fact_type: "phone", key: "phone", value: normalized });
    });
  }

  return facts;
}

module.exports = {
  openai,
  embedTexts,
  cosineSimilarity,
  splitTextIntoChunks,
  buildItemsForEmbedding,
  extractFactsFromText,
};
