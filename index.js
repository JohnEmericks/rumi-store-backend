/**
 * RUMI Backend Server
 *
 * AI-powered store assistant backend.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");

// Import configuration
const { initDb } = require("./config/database");

// Import routes
const storeRoutes = require("./routes/store");
const chatRoutes = require("./routes/chat");
const analyticsRoutes = require("./routes/analytics");
const adminRoutes = require("./routes/admin");

// Import services for scheduled tasks
const {
  cleanupInactiveConversations,
} = require("./services/conversation-tracker");
const {
  processEndedConversations,
  extractInsightsFromConversation,
} = require("./services/insight-extractor");

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// =============================================================================
// ROUTES
// =============================================================================

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Store routes (register, index, personality, etc.)
app.use("/", storeRoutes);

// Chat routes (chat, end-conversation)
app.use("/", chatRoutes);

// Analytics routes (overview, conversations, ask)
app.use("/analytics", analyticsRoutes);

// Admin routes (license key management) - protected by admin secret
app.use("/admin", adminRoutes);

// =============================================================================
// SCHEDULED TASKS
// =============================================================================

// Cleanup inactive conversations every 5 minutes
setInterval(async () => {
  const endedConversations = await cleanupInactiveConversations(15);

  // Trigger insight extraction for newly ended conversations
  for (const conv of endedConversations) {
    if (conv.message_count >= 2) {
      setImmediate(() => {
        extractInsightsFromConversation(conv.id, conv.store_id);
      });
    }
  }
}, 5 * 60 * 1000);

// Process any pending conversations every 2 minutes
setInterval(processEndedConversations, 2 * 60 * 1000);

// Run once on startup (after a short delay)
setTimeout(processEndedConversations, 30 * 1000);

// =============================================================================
// START SERVER
// =============================================================================

initDb();

app.listen(PORT, () => {
  console.log(`🚀 RUMI Backend running on http://localhost:${PORT}`);
  console.log(`📊 Admin API available at /admin (requires X-Admin-Key header)`);
});
