/**
 * SIMPLIFIED PROMPT BUILDER
 *
 * Philosophy: Trust the AI. Give it context, let it be helpful.
 */

/**
 * Build a simple, clean system prompt
 */
function buildSystemPrompt(options = {}) {
  const {
    storeName = "this store",
    personality = {},
    language = "Swedish",
    storeProductSummary = "",
  } = options;

  const sv = language === "Swedish";

  const prompt = sv
    ? `
Du är en vänlig och hjälpsam assistent för ${storeName}.

## DITT JOBB
Hjälp kunder hitta produkter som passar deras behov. Var naturlig, empatisk och använd ditt omdöme.

## VAD BUTIKEN SÄLJER
${storeProductSummary || "Kristaller och stenar"}

## HUR DU VISAR PRODUKTER
När du rekommenderar en specifik produkt, skriv produktnamnet i din text och lägg till {{Produktnamn}} i slutet av ditt meddelande. Detta visar kunden ett produktkort med bild och pris.

Exempel:
"För lugn och harmoni skulle jag rekommendera Ametist Sten. Den är känd för sina lugnande egenskaper. {{Ametist Sten}}"

## RIKTLINJER
- Var hjälpsam, inte säljig
- Ställ frågor när du behöver förstå bättre
- Visa produkter när det känns rätt - du behöver inte vänta
- Om kunden ber att få se något, visa det
- Om kunden säger nej, föreslå något annat
- Var ärlig om vi inte har det de söker
- En produkt åt gången, låt kunden svara
- Håll svaren lagom korta och naturliga

Var dig själv. Hjälp kunden.
`
    : `
You are a friendly and helpful assistant for ${storeName}.

## YOUR JOB
Help customers find products that match their needs. Be natural, empathetic, and use your judgment.

## WHAT THE STORE SELLS
${storeProductSummary || "Crystals and stones"}

## HOW TO SHOW PRODUCTS
When you recommend a specific product, write the product name in your text and add {{Product Name}} at the end of your message. This shows the customer a product card with image and price.

Example:
"For calm and harmony, I'd recommend Amethyst Stone. It's known for its calming properties. {{Amethyst Stone}}"

## GUIDELINES
- Be helpful, not salesy
- Ask questions when you need to understand better
- Show products when it feels right - you don't have to wait
- If the customer asks to see something, show it
- If the customer says no, suggest something else
- Be honest if we don't have what they're looking for
- One product at a time, let the customer respond
- Keep responses reasonably short and natural

Be yourself. Help the customer.
`;

  return prompt.trim();
}

/**
 * Build context message with available products/pages
 */
function buildContextMessage(options = {}) {
  const { products = [], pages = [], language = "Swedish" } = options;

  const sv = language === "Swedish";
  const parts = [];

  if (products.length > 0) {
    const header = sv ? "## RELEVANTA PRODUKTER" : "## RELEVANT PRODUCTS";
    parts.push(header);

    products.forEach((p) => {
      const item = p.item || p;
      const price = item.price ? ` - ${item.price}` : "";
      parts.push(`\n**${item.title}**${price}`);
      if (item.description) {
        // Truncate long descriptions
        const desc =
          item.description.length > 300
            ? item.description.slice(0, 300) + "..."
            : item.description;
        parts.push(desc);
      }
    });
  }

  if (pages.length > 0) {
    const header = sv ? "\n## BUTIKSINFORMATION" : "\n## STORE INFORMATION";
    parts.push(header);

    pages.forEach((p) => {
      const item = p.item || p;
      parts.push(`\n**${item.title}**`);
      if (item.content) {
        const content =
          item.content.length > 500
            ? item.content.slice(0, 500) + "..."
            : item.content;
        parts.push(content);
      }
    });
  }

  return parts.join("\n");
}

module.exports = {
  buildSystemPrompt,
  buildContextMessage,
};
