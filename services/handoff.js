/**
 * Human Handoff Service
 *
 * Detects when a conversation should be handed off to a human agent
 * and provides appropriate responses and metadata.
 *
 * Triggers:
 * - Customer explicitly asks for human
 * - Multiple low-confidence responses
 * - Detected frustration/negative sentiment
 * - Off-topic or complaint situations
 * - Repeated "I don't know" responses
 */

const { INTENTS } = require("./intent-classifier");

/**
 * Handoff reasons
 */
const HANDOFF_REASONS = {
  CUSTOMER_REQUEST: "customer_request",
  LOW_CONFIDENCE: "low_confidence",
  FRUSTRATION: "frustration",
  OFF_TOPIC: "off_topic",
  COMPLAINT: "complaint",
  REPEATED_FAILURE: "repeated_failure",
  COMPLEX_QUERY: "complex_query",
  ACCOUNT_ISSUE: "account_issue",
  URGENT: "urgent",
};

/**
 * Patterns that indicate customer wants to talk to a human
 */
const HUMAN_REQUEST_PATTERNS = {
  sv: [
    /prata med (en )?(människa|person|någon|agent|support)/i,
    /kan jag (få )?(prata|tala|snacka) med/i,
    /finns det (någon|en) (människa|person)/i,
    /riktig person/i,
    /human support/i,
    /kontakta (er|dig|support|kundtjänst)/i,
    /ring(a)? (mig|er)/i,
    /nå (en|någon) (person|människa)/i,
  ],
  en: [
    /talk to (a )?(human|person|someone|agent|representative)/i,
    /speak (to|with) (a )?(human|person|someone|real)/i,
    /can i (get|have|speak|talk)/i,
    /real person/i,
    /human (support|agent|help)/i,
    /contact (support|someone|you)/i,
    /call (me|you)/i,
    /reach (a |an )?(person|human|agent)/i,
    /customer service/i,
    /live (chat|agent|support)/i,
  ],
};

/**
 * Patterns indicating frustration or complaint
 */
const FRUSTRATION_PATTERNS = {
  sv: [
    /fungerar inte/i,
    /förstår (du )?(inte|ingenting)/i,
    /hjälper (inte|mig inte)/i,
    /värdelös/i,
    /dålig/i,
    /irriterad/i,
    /frustrerad/i,
    /arg\b/i,
    /trött på/i,
    /ge upp/i,
    /meningslös/i,
    /hopplös/i,
  ],
  en: [
    /not (working|helping)/i,
    /(don't|doesn't) understand/i,
    /useless/i,
    /terrible/i,
    /frustrated/i,
    /annoyed/i,
    /angry/i,
    /giving up/i,
    /waste of time/i,
    /hopeless/i,
    /this is ridiculous/i,
    /what('s| is) wrong with/i,
  ],
};

/**
 * Patterns indicating off-topic or account issues
 */
const OFF_TOPIC_PATTERNS = {
  sv: [
    /min (beställning|order)/i,
    /var är (mitt|min|mina) (paket|order)/i,
    /leverans(problem|status)/i,
    /reklamation/i,
    /klagomål/i,
    /återbetalning/i,
    /pengarna tillbaka/i,
    /trasig|skadad|defekt/i,
    /fel (produkt|vara)/i,
  ],
  en: [
    /my (order|package|delivery)/i,
    /where is my/i,
    /delivery (problem|status|issue)/i,
    /complaint/i,
    /refund/i,
    /money back/i,
    /broken|damaged|defective/i,
    /wrong (product|item)/i,
    /cancel (my |the )?order/i,
    /tracking (number|info)/i,
  ],
};

/**
 * Track conversation state for handoff decisions
 */
class HandoffTracker {
  constructor() {
    this.lowConfidenceCount = 0;
    this.uncertainResponseCount = 0;
    this.negativeSentimentCount = 0;
    this.sentimentHistory = [];
  }

  /**
   * Record a response confidence level
   */
  recordConfidence(confidence) {
    if (confidence < 7) {
      this.lowConfidenceCount++;
    } else {
      // Reset on good confidence
      this.lowConfidenceCount = Math.max(0, this.lowConfidenceCount - 1);
    }
  }

  /**
   * Record if AI gave an uncertain response
   */
  recordUncertainResponse(responseText) {
    const uncertainPhrases = [
      /jag (vet inte|är inte säker|kan inte)/i,
      /i (don't know|'m not sure|can't|cannot)/i,
      /tyvärr (kan jag inte|vet jag inte)/i,
      /unfortunately/i,
      /outside (what i|my)/i,
      /utanför (vad jag|mitt)/i,
    ];

    if (uncertainPhrases.some((p) => p.test(responseText))) {
      this.uncertainResponseCount++;
    }
  }

  /**
   * Record sentiment
   */
  recordSentiment(sentiment) {
    this.sentimentHistory.push(sentiment);
    if (this.sentimentHistory.length > 5) {
      this.sentimentHistory.shift();
    }

    if (sentiment === "negative" || sentiment === "frustrated") {
      this.negativeSentimentCount++;
    }
  }

  /**
   * Check if sentiment is declining
   */
  isSentimentDeclining() {
    if (this.sentimentHistory.length < 3) return false;

    const sentimentScores = {
      positive: 3,
      neutral: 2,
      negative: 1,
      frustrated: 0,
    };

    const scores = this.sentimentHistory.map((s) => sentimentScores[s] || 2);
    const recent = scores.slice(-3);

    // Check if trending downward
    return recent[2] < recent[0] && recent[1] <= recent[0];
  }

  /**
   * Get current handoff risk level
   */
  getRiskLevel() {
    let risk = 0;

    if (this.lowConfidenceCount >= 2) risk += 2;
    if (this.uncertainResponseCount >= 2) risk += 3;
    if (this.negativeSentimentCount >= 2) risk += 2;
    if (this.isSentimentDeclining()) risk += 2;

    return risk;
  }
}

/**
 * Check if message explicitly requests human
 */
function isExplicitHumanRequest(message) {
  const allPatterns = [
    ...HUMAN_REQUEST_PATTERNS.sv,
    ...HUMAN_REQUEST_PATTERNS.en,
  ];

  return allPatterns.some((pattern) => pattern.test(message));
}

/**
 * Check if message indicates frustration
 */
function detectFrustration(message) {
  const allPatterns = [...FRUSTRATION_PATTERNS.sv, ...FRUSTRATION_PATTERNS.en];

  return allPatterns.some((pattern) => pattern.test(message));
}

/**
 * Check if message is off-topic (order issues, complaints, etc.)
 */
function isOffTopicOrAccountIssue(message) {
  const allPatterns = [...OFF_TOPIC_PATTERNS.sv, ...OFF_TOPIC_PATTERNS.en];

  return allPatterns.some((pattern) => pattern.test(message));
}

/**
 * Evaluate whether handoff is needed
 *
 * @param {string} message - Current user message
 * @param {Object} conversationState - Current conversation state
 * @param {Object} intentResult - Intent classification result
 * @param {HandoffTracker} tracker - Handoff tracker instance
 * @returns {Object} Handoff evaluation result
 */
function evaluateHandoffNeed(
  message,
  conversationState,
  intentResult,
  tracker
) {
  // 1. Explicit human request - highest priority
  if (isExplicitHumanRequest(message)) {
    return {
      needed: true,
      reason: HANDOFF_REASONS.CUSTOMER_REQUEST,
      confidence: 1.0,
      message: "Customer explicitly requested human assistance",
    };
  }

  // 2. Off-topic or account issues
  if (isOffTopicOrAccountIssue(message)) {
    return {
      needed: true,
      reason: HANDOFF_REASONS.ACCOUNT_ISSUE,
      confidence: 0.9,
      message: "Customer has order/account issue requiring human help",
    };
  }

  // 3. Strong frustration signals
  if (detectFrustration(message)) {
    tracker.recordSentiment("frustrated");

    // Immediate handoff on strong frustration
    if (tracker.negativeSentimentCount >= 2) {
      return {
        needed: true,
        reason: HANDOFF_REASONS.FRUSTRATION,
        confidence: 0.85,
        message: "Multiple frustration signals detected",
      };
    }

    // Soft handoff suggestion
    return {
      needed: false,
      suggestHandoff: true,
      reason: HANDOFF_REASONS.FRUSTRATION,
      confidence: 0.6,
      message: "Frustration detected - consider offering human support",
    };
  }

  // 4. LLM-detected sentiment
  if (
    intentResult?.sentiment === "frustrated" ||
    intentResult?.sentiment === "negative"
  ) {
    tracker.recordSentiment(intentResult.sentiment);
  }

  // 5. Repeated low confidence
  if (tracker.lowConfidenceCount >= 3) {
    return {
      needed: true,
      reason: HANDOFF_REASONS.LOW_CONFIDENCE,
      confidence: 0.8,
      message: "Multiple low-confidence responses",
    };
  }

  // 6. Repeated uncertain responses
  if (tracker.uncertainResponseCount >= 2) {
    return {
      needed: true,
      reason: HANDOFF_REASONS.REPEATED_FAILURE,
      confidence: 0.85,
      message: "AI has been unable to help multiple times",
    };
  }

  // 7. Declining sentiment trajectory
  if (tracker.isSentimentDeclining() && tracker.getRiskLevel() >= 5) {
    return {
      needed: false,
      suggestHandoff: true,
      reason: HANDOFF_REASONS.FRUSTRATION,
      confidence: 0.7,
      message: "Customer sentiment is declining",
    };
  }

  // 8. Off-topic intent from LLM
  if (
    intentResult?.primary === "off_topic" ||
    intentResult?.reasoning?.includes("off-topic")
  ) {
    return {
      needed: false,
      suggestHandoff: true,
      reason: HANDOFF_REASONS.OFF_TOPIC,
      confidence: 0.6,
      message: "Query appears to be off-topic",
    };
  }

  // No handoff needed
  return {
    needed: false,
    suggestHandoff: false,
    reason: null,
    confidence: 0,
    message: null,
  };
}

/**
 * Get handoff response message
 */
function getHandoffMessage(reason, language = "Swedish", storeFacts = []) {
  // Extract contact info from store facts
  const email = storeFacts.find((f) => f.fact_type === "email")?.value;
  const phone = storeFacts.find((f) => f.fact_type === "phone")?.value;

  const contactInfo = [];
  if (email)
    contactInfo.push(
      language === "Swedish" ? `mejla ${email}` : `email ${email}`
    );
  if (phone)
    contactInfo.push(
      language === "Swedish" ? `ring ${phone}` : `call ${phone}`
    );

  const contactString =
    contactInfo.length > 0
      ? contactInfo.join(language === "Swedish" ? " eller " : " or ")
      : language === "Swedish"
      ? "kontakta oss via hemsidan"
      : "contact us through our website";

  const messages = {
    [HANDOFF_REASONS.CUSTOMER_REQUEST]: {
      sv: `Självklart! Du kan ${contactString} så hjälper vårt team dig personligen. De är bäst på att hjälpa dig vidare! 😊`,
      en: `Of course! You can ${contactString} and our team will help you personally. They're best equipped to assist you! 😊`,
    },
    [HANDOFF_REASONS.FRUSTRATION]: {
      sv: `Jag förstår att det här kan vara frustrerande, och jag vill verkligen att du får rätt hjälp. Du kan ${contactString} för personlig assistans - de kan definitivt hjälpa dig bättre.`,
      en: `I understand this can be frustrating, and I really want you to get the right help. You can ${contactString} for personal assistance - they'll definitely be able to help you better.`,
    },
    [HANDOFF_REASONS.LOW_CONFIDENCE]: {
      sv: `Jag vill vara ärlig - jag är inte helt säker på att jag kan hjälpa dig med det här. För att du ska få bästa möjliga hjälp, rekommenderar jag att du ${contactString}.`,
      en: `I want to be honest - I'm not entirely sure I can help you with this. To make sure you get the best help possible, I'd recommend you ${contactString}.`,
    },
    [HANDOFF_REASONS.REPEATED_FAILURE]: {
      sv: `Det verkar som jag har svårt att hjälpa dig med det du behöver. Låt mig koppla dig till någon som kan - du kan ${contactString} så tar de hand om dig.`,
      en: `It seems like I'm having trouble helping you with what you need. Let me connect you with someone who can - you can ${contactString} and they'll take good care of you.`,
    },
    [HANDOFF_REASONS.ACCOUNT_ISSUE]: {
      sv: `För frågor om beställningar, leveranser eller ditt konto behöver du prata med vårt team direkt. Du kan ${contactString} så hjälper de dig med allt! 📦`,
      en: `For questions about orders, deliveries, or your account, you'll need to speak with our team directly. You can ${contactString} and they'll help you with everything! 📦`,
    },
    [HANDOFF_REASONS.OFF_TOPIC]: {
      sv: `Det där ligger lite utanför vad jag kan hjälpa till med, men vårt team kan säkert hjälpa dig! Du når dem via ${contactString}.`,
      en: `That's a bit outside what I can help with, but our team can surely assist you! You can reach them at ${contactString}.`,
    },
    [HANDOFF_REASONS.COMPLAINT]: {
      sv: `Jag är ledsen att du har haft problem. För att vi ska kunna lösa det här ordentligt, vänligen ${contactString} så tar vi hand om det personligen.`,
      en: `I'm sorry you've had issues. To properly resolve this, please ${contactString} and we'll take care of it personally.`,
    },
  };

  const reasonMessages =
    messages[reason] || messages[HANDOFF_REASONS.CUSTOMER_REQUEST];
  return language === "Swedish" ? reasonMessages.sv : reasonMessages.en;
}

/**
 * Get soft handoff suggestion (offer without forcing)
 */
function getSoftHandoffSuggestion(language = "Swedish") {
  const suggestions = {
    sv: "Om du hellre vill prata med någon personligen är det också helt okej - säg bara till!",
    en: "If you'd prefer to speak with someone personally, that's totally fine too - just let me know!",
  };

  return language === "Swedish" ? suggestions.sv : suggestions.en;
}

/**
 * Create handoff tracker for a session
 */
function createHandoffTracker() {
  return new HandoffTracker();
}

/**
 * Serialize tracker state for storage
 */
function serializeTracker(tracker) {
  return {
    lowConfidenceCount: tracker.lowConfidenceCount,
    uncertainResponseCount: tracker.uncertainResponseCount,
    negativeSentimentCount: tracker.negativeSentimentCount,
    sentimentHistory: tracker.sentimentHistory,
  };
}

/**
 * Restore tracker from serialized state
 */
function restoreTracker(state) {
  const tracker = new HandoffTracker();
  if (state) {
    tracker.lowConfidenceCount = state.lowConfidenceCount || 0;
    tracker.uncertainResponseCount = state.uncertainResponseCount || 0;
    tracker.negativeSentimentCount = state.negativeSentimentCount || 0;
    tracker.sentimentHistory = state.sentimentHistory || [];
  }
  return tracker;
}

module.exports = {
  HANDOFF_REASONS,
  HandoffTracker,
  evaluateHandoffNeed,
  getHandoffMessage,
  getSoftHandoffSuggestion,
  createHandoffTracker,
  serializeTracker,
  restoreTracker,
  isExplicitHumanRequest,
  detectFrustration,
  isOffTopicOrAccountIssue,
};
