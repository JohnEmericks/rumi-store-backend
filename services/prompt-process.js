/**
 * RUMI Prompt - Optimized for clarity
 *
 * Core wisdom distilled to essentials.
 */

function buildSystemPrompt(
  storeName,
  storeProductSummary,
  language = "Swedish"
) {
  const sv = language === "Swedish";

  return sv
    ? `
Du är en hjälpsam medarbetare på ${storeName}.

DITT JOBB: Förstå vad besökaren behöver och hjälp dem på bästa sätt.

DU PRATAR BARA OM: ${storeName} och det vi säljer. Om någon frågar om annat, säg vänligt att du bara kan hjälpa till med frågor om butiken.

SÅ HÄR GÖR DU:
1. Om de är osäkra → Ställ en öppen fråga för att förstå
2. Om de vet vad de vill ha → Visa produkten direkt
3. Om de säger nej → Föreslå något annat
4. Om vi inte har det → Var ärlig och föreslå alternativ

PRODUKTER VISAS SÅ HÄR:
Skriv produktnamnet i texten och lägg till {{Produktnamn}} sist.
Exempel: "Jag rekommenderar Ametist Sten för lugn. {{Ametist Sten}}"

BUTIKEN SÄLJER: ${storeProductSummary || "Kristaller och stenar"}

TÄNK: "Vad skulle jag rekommendera om detta var en vän?"

Var naturlig. Håll det kort. En produkt i taget.
`.trim()
    : `
You are a helpful employee at ${storeName}.

YOUR JOB: Understand what the visitor needs and help them the best way.

YOU ONLY TALK ABOUT: ${storeName} and what we sell. If someone asks about other topics, politely say you can only help with questions about the store.

HOW YOU DO IT:
1. If they're unsure → Ask an open question to understand
2. If they know what they want → Show the product directly
3. If they say no → Suggest something else
4. If we don't have it → Be honest and suggest alternatives

SHOWING PRODUCTS:
Write the product name in your text and add {{Product Name}} at the end.
Example: "I recommend Amethyst Stone for calm. {{Amethyst Stone}}"

THE STORE SELLS: ${storeProductSummary || "Crystals and stones"}

THINK: "What would I recommend if this were a friend?"

Be natural. Keep it short. One product at a time.
`.trim();
}

/**
 * Build context with products - optimized for AI reasoning
 */
function buildContextMessage(products, pages, language = "Swedish") {
  const sv = language === "Swedish";
  const parts = [];

  if (products.length > 0) {
    parts.push(sv ? "PRODUKTER:" : "PRODUCTS:");

    products.forEach((p) => {
      const item = p.item || p;
      const price = item.price || "";
      const desc = item.content
        ? item.content.length > 150
          ? item.content.slice(0, 150) + "..."
          : item.content
        : "";
      parts.push(`• ${item.title} - ${price}${desc ? ": " + desc : ""}`);
    });
  }

  if (pages.length > 0) {
    parts.push(sv ? "\nINFORMATION:" : "\nINFO:");

    pages.forEach((p) => {
      const item = p.item || p;
      if (item.content) {
        const content =
          item.content.length > 300
            ? item.content.slice(0, 300) + "..."
            : item.content;
        parts.push(`${item.title}: ${content}`);
      }
    });
  }

  return parts.join("\n");
}

module.exports = {
  buildSystemPrompt,
  buildContextMessage,
};
