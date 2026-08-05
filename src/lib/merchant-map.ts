/**
 * Layer 2: which merchants are subscriptions, and what genuine use of each one
 * looks like in a transaction history.
 *
 * THE SELF-VALIDATION TRAP, which this file exists to defuse:
 *
 * An "Amazon Prime" charge matches the usage pattern `amazon`. Without
 * precedence, every subscription cites its own monthly bill as proof that it is
 * being used, every verdict comes back "used", and the app reports zero zombies
 * -- with no error, no exception, and a perfectly reasonable-looking screen.
 * It fails silently and it fails completely.
 *
 * The defence has two independent halves. Here: `subscriptionPatterns` are
 * checked across the WHOLE map before any usage pattern is consulted, and they
 * always win. In correlate.ts: subscription charges are additionally excluded
 * by transaction id. Belt and braces, because either one alone has a gap.
 *
 * Never weaken this. It is pinned by tests.
 */

interface MerchantBase {
  /** Stable slug. Doubles as the Firestore doc id for verdicts/{merchantKey}. */
  key: string;
  displayName: string;
  /**
   * Payee-name variants for the SUBSCRIPTION charge itself. Checked first,
   * globally, and they always beat usage patterns.
   */
  subscriptionPatterns: readonly string[];
  /**
   * Where to go to cancel. Prose, not a URL, because most Indian services
   * cancel in-app with no stable web page -- and a hint that is always right
   * beats a link that is sometimes dead.
   */
  cancelHint?: string;
  /**
   * A direct cancellation page, ONLY where it is well known and stable. Absent
   * is the correct value for anything in-app; an invented URL that 404s on
   * stage is worse than no link at all.
   */
  cancelUrl?: string;
  /**
   * Layer 2b: what a transactional email from this service looks like when it
   * proves USE.
   *
   * Both halves must match. The sender establishes it really is them; the
   * subject establishes it is a confirmation of something you did, not an
   * announcement of something they charged you. Order confirmations, dispatch
   * notices and trip receipts are only ever sent because the user acted --
   * which is exactly the property Layer 2 needs, and one that marketing mail
   * conspicuously lacks.
   *
   * Absent means this service has no observable email footprint, and no email
   * can ever be evidence for it. Netflix does not write to you when you watch
   * something, so leaving this off Netflix is the honest answer, not an
   * oversight.
   */
  emailUsage?: {
    /** Substrings matched against the raw From header, lowercased. */
    senders: readonly [string, ...string[]];
    /** Contiguous token sequences in the subject. */
    subjectPatterns: readonly [string, ...string[]];
  };
}

/** A service whose genuine use leaves a separate financial footprint. */
export interface TrackedMerchant extends MerchantBase {
  footprint: "transaction";
  /** Non-empty by construction -- an empty list here would mean "never used". */
  usagePatterns: readonly [string, ...string[]];
  /** Human phrasing for the evidence chain: "Amazon orders". */
  usageLabel: string;
}

/**
 * A recognised service that leaves NO transaction footprint. Watching Netflix
 * costs nothing extra, so silence in the transaction history is not evidence of
 * disuse -- it is the expected state. These route to the Evidence Gap Handler.
 *
 * Structurally distinct from an unmapped merchant, and deliberately so: here we
 * know exactly who this is and we know we cannot observe it, which earns
 * confidence "low". An unmapped merchant earns "none".
 */
export interface OpaqueMerchant extends MerchantBase {
  footprint: "none";
  /** Unrepresentable rather than merely empty -- you cannot pass [] by mistake. */
  usagePatterns?: never;
  /** Required by the type, so a footprint-less entry with no question won't compile. */
  question: string;
}

export type MerchantEntry = TrackedMerchant | OpaqueMerchant;

/**
 * Subject signatures that mean BILLING, checked before anything else and across
 * the whole map. The self-validation trap, in the email domain.
 *
 * Amazon writes to you when your order ships, and Amazon writes to you when
 * your Prime membership renews. Both are from Amazon, both mention Prime, and
 * only one is evidence that you used anything. Without this list the renewal
 * notice for a subscription becomes proof that the subscription is in use --
 * the same silent, self-confirming failure that `isSubscriptionCharge` exists
 * to prevent for charges.
 *
 * Deliberately NOT in this list: "receipt" and "payment". Uber's "Your Thursday
 * trip receipt" and Ola's ride receipts are usage, and blocking them here would
 * quietly delete the strongest email signal two services have.
 */
export const EMAIL_BILLING_PATTERNS: readonly string[] = [
  "invoice",
  "membership",
  "subscription",
  "renewed",
  "renewal",
  "auto renew",
  "autorenew",
  "your plan",
  "billing",
];

/**
 * Payment-rail prefixes that appear in front of the real payee on UPI and card
 * statements. Stripped only from the FRONT, and never to the point of leaving
 * nothing -- "PAYTM" on its own is a real merchant.
 */
const RAIL_PREFIXES = new Set([
  "upi",
  "razorpay",
  "payu",
  "paytm",
  "phonepe",
  "gpay",
  "googlepay",
  "bharatpe",
  "billdesk",
  "ccavenue",
  "cashfree",
  "instamojo",
  "pinelabs",
  "easebuzz",
  "worldline",
  "nbupi",
  "ach",
  "enach",
  "achdr",
  "mandate",
]);

/**
 * Tokens too generic to identify anything. A bare `premium` pattern would
 * swallow "Kuku FM Premium", "Spotify Premium" and "YouTube Premium" alike --
 * and in this build it would specifically destroy the unmapped-merchant demo
 * case. Enforced by validateMerchantMap for single-token patterns.
 */
const GENERIC_TOKENS = new Set([
  "premium", "plus", "pro", "one", "gold", "pass", "max", "lite",
  "india", "in", "com", "app", "store", "online", "digital", "entertainment",
  "pvt", "ltd", "limited", "private", "technologies", "services", "solutions",
  "subscription", "recharge", "bill", "payment", "autopay", "renewal",
]);

/**
 * The map. 32 services an Indian user is likely to be billed by.
 *
 * TWENTY-FOUR of the thirty-two have no observable footprint. That is not a gap
 * in the research -- it is the honest shape of the domain, and it is exactly why
 * the Evidence Gap Handler is a headline feature rather than a fallback. The
 * ratio got worse, not better, as the map grew: AI assistants, cloud storage
 * and creative tools are all pay-once-then-use-invisibly, so every service
 * added since the first draft has been one the bank statement cannot judge.
 *
 * Two rules that look like nitpicks and are not:
 *
 * 1. Bare brand names (`zomato`, `swiggy`, `uber`, `bigbasket`, `zepto`) are
 *    usage patterns ONLY, never subscription patterns. Make `bigbasket` a
 *    subscription pattern and every grocery order gets classified as a
 *    subscription charge, excluded from usage evidence, and -- because Layer 1
 *    happily chains regular weekly shopping -- surfaces as a phantom zombie.
 *
 * 2. Legal entity names that bill for BOTH the subscription and the usage
 *    (kiranakart for Zepto) belong in usagePatterns only. Put one in
 *    subscriptionPatterns and every real order is excluded from its own
 *    evidence, so the subscription can never look used.
 */
export const MERCHANTS: readonly MerchantEntry[] = [
  {
    key: "amazon-prime",
    displayName: "Amazon Prime",
    footprint: "transaction",
    subscriptionPatterns: ["amazon prime", "amazonprime", "prime video"],
    usagePatterns: ["amazon", "amzn"],
    usageLabel: "Amazon orders",
    emailUsage: {
      senders: ["amazon.in", "amazon.com"],
      subjectPatterns: ["has shipped", "out for delivery", "has been delivered", "order placed"],
    },
    cancelHint: "Amazon → Account → Prime membership → End membership",
    cancelUrl: "https://www.amazon.in/gp/primecentral",
  },
  {
    key: "swiggy-one",
    displayName: "Swiggy One",
    footprint: "transaction",
    subscriptionPatterns: ["swiggy one", "swiggyone", "swiggy super"],
    usagePatterns: ["swiggy", "instamart", "bundl"],
    usageLabel: "Swiggy orders",
    emailUsage: {
      senders: ["swiggy.in", "swiggy.com"],
      subjectPatterns: ["order", "delivered", "on the way"],
    },
    cancelHint: "Swiggy app → Account → Swiggy One → Manage plan. Autopay also cancels from your UPI app.",
  },
  {
    key: "zomato-gold",
    displayName: "Zomato Gold",
    footprint: "transaction",
    subscriptionPatterns: ["zomato gold", "zomatogold", "zomato pro"],
    usagePatterns: ["zomato"],
    usageLabel: "Zomato orders",
    emailUsage: {
      senders: ["zomato.com"],
      subjectPatterns: ["order", "delivered", "on the way"],
    },
    cancelHint: "Zomato app → Profile → Gold → Manage. Stop the UPI autopay mandate as well.",
  },
  {
    key: "zepto-pass",
    displayName: "Zepto Pass",
    footprint: "transaction",
    subscriptionPatterns: ["zepto pass", "zepto daily"],
    // kiranakart is Zepto's legal payee and bills for orders too -- usage only.
    usagePatterns: ["zepto", "kiranakart"],
    usageLabel: "Zepto orders",
    emailUsage: {
      senders: ["zepto.co.in", "zeptonow.com"],
      subjectPatterns: ["order", "delivered"],
    },
    cancelHint: "Zepto app → Profile → Zepto Pass → Manage subscription",
  },
  {
    key: "bigbasket-star",
    displayName: "BB Star",
    footprint: "transaction",
    subscriptionPatterns: ["bbstar", "bb star", "bigbasket star"],
    usagePatterns: ["bigbasket", "bbdaily", "bb daily", "bbnow", "supermarket grocery"],
    usageLabel: "BigBasket orders",
    emailUsage: {
      senders: ["bigbasket.com"],
      subjectPatterns: ["order", "delivered", "out for delivery"],
    },
    cancelHint: "BigBasket app → Account → bbstar membership → Manage",
  },
  {
    key: "uber-one",
    displayName: "Uber One",
    footprint: "transaction",
    subscriptionPatterns: ["uber one", "uberone"],
    usagePatterns: ["uber"],
    usageLabel: "Uber rides",
    emailUsage: {
      senders: ["uber.com"],
      subjectPatterns: ["trip with", "ride with", "trip receipt"],
    },
    cancelHint: "Uber app → Account → Uber One → Manage membership → End membership",
  },
  {
    key: "ola-select",
    displayName: "Ola Select",
    footprint: "transaction",
    subscriptionPatterns: ["ola select", "ola pass", "olaselect"],
    usagePatterns: ["ola", "ani technologies"],
    usageLabel: "Ola rides",
    emailUsage: {
      senders: ["olacabs.com", "olamoney.com"],
      subjectPatterns: ["ride receipt", "trip receipt", "your ride"],
    },
    cancelHint: "Ola app → Menu → Ola Select → Manage subscription",
  },
  {
    key: "cultfit-elite",
    displayName: "Cult.fit Elite",
    footprint: "transaction",
    subscriptionPatterns: ["cult pass", "cultfit elite", "cult fit elite"],
    usagePatterns: ["cultfit", "cult fit", "curefit", "cure fit"],
    usageLabel: "Cult.fit bookings",
    emailUsage: {
      senders: ["cult.fit", "curefit.com"],
      subjectPatterns: ["class booked", "booking confirmed", "session booked", "see you at"],
    },
    cancelHint: "Cult.fit app → Profile → Memberships → Cancel or pause",
  },

  // --- No observable footprint. Watching, listening or storing costs nothing
  //     extra, so transaction silence is the expected state, not evidence. ---
  {
    key: "netflix",
    displayName: "Netflix",
    footprint: "none",
    subscriptionPatterns: ["netflix"],
    question: "Have you watched anything on Netflix in the last {days} days?",
    cancelHint: "Netflix → Account → Cancel Membership",
    cancelUrl: "https://www.netflix.com/cancelplan",
  },
  {
    key: "spotify",
    displayName: "Spotify Premium",
    footprint: "none",
    subscriptionPatterns: ["spotify"],
    question: "Have you listened to anything on Spotify in the last {days} days?",
    cancelHint: "Spotify → Account → Your plan → Change or cancel",
    cancelUrl: "https://www.spotify.com/account/subscription/",
  },
  {
    key: "hotstar",
    displayName: "JioHotstar",
    footprint: "none",
    subscriptionPatterns: ["hotstar", "jiohotstar", "novi digital"],
    question: "Have you watched anything on JioHotstar in the last {days} days?",
    cancelHint: "JioHotstar → My Account → Subscription → Cancel. If billed via Jio, cancel from the Jio app instead.",
  },
  {
    key: "zee5",
    displayName: "ZEE5",
    footprint: "none",
    subscriptionPatterns: ["zee5"],
    question: "Have you watched anything on ZEE5 in the last {days} days?",
    cancelHint: "ZEE5 → My Subscriptions → Cancel auto-renewal",
  },
  {
    key: "sonyliv",
    displayName: "SonyLIV",
    footprint: "none",
    subscriptionPatterns: ["sonyliv", "sony liv", "culver max"],
    question: "Have you watched anything on SonyLIV in the last {days} days?",
    cancelHint: "SonyLIV → My Account → Manage Subscription → Cancel",
  },
  {
    key: "jiosaavn",
    displayName: "JioSaavn Pro",
    footprint: "none",
    // "jiosaavn" and "saavn" are different tokens -- matching is per-token, not
    // substring, so both spellings have to be listed.
    subscriptionPatterns: ["jiosaavn", "jio saavn", "saavn"],
    question: "Have you listened to anything on JioSaavn in the last {days} days?",
    cancelHint: "JioSaavn → Settings → Manage Subscription → Cancel renewal",
  },
  {
    key: "gaana",
    displayName: "Gaana Plus",
    footprint: "none",
    // NOT "times internet" -- that legal name bills for Times Prime too, and a
    // pattern owned by two entries makes both verdicts unreliable.
    subscriptionPatterns: ["gaana"],
    question: "Have you listened to anything on Gaana in the last {days} days?",
    cancelHint: "Gaana → Settings → Gaana Plus → Cancel subscription",
  },
  {
    key: "audible",
    displayName: "Audible",
    footprint: "none",
    subscriptionPatterns: ["audible"],
    question: "Have you listened to an Audible title in the last {days} days?",
    cancelHint: "Audible → Account Details → Cancel membership. Credits you already own stay yours.",
  },
  {
    key: "youtube-premium",
    displayName: "YouTube Premium",
    footprint: "none",
    // Both tokens required. A bare "google" would collide with Google One.
    subscriptionPatterns: ["youtube premium", "yt premium"],
    question: "Have you used YouTube Premium in the last {days} days?",
    cancelHint: "YouTube → Purchases and memberships → Manage → Cancel",
    cancelUrl: "https://www.youtube.com/paid_memberships",
  },
  {
    key: "google-one",
    displayName: "Google One",
    footprint: "none",
    subscriptionPatterns: ["google one", "google storage"],
    question: "Are you still relying on the extra Google One storage?",
    cancelHint: "Google One → Settings → Cancel membership. Check your storage use first — cancelling reverts you to 15 GB.",
    cancelUrl: "https://one.google.com/settings",
  },
  {
    key: "apple-icloud",
    displayName: "iCloud+",
    footprint: "none",
    // NOT "apple com bill" -- that covers iCloud, Apple Music and the App Store
    // indiscriminately. An ambiguous Apple charge should reach the gap handler,
    // which is what the gap handler is for.
    subscriptionPatterns: ["icloud", "apple icloud"],
    question: "Are you still relying on the extra iCloud+ storage?",
    cancelHint: "iPhone → Settings → your name → Subscriptions → iCloud+ → Cancel. Free up storage first, or photos may stop backing up.",
  },
  {
    key: "times-prime",
    displayName: "Times Prime",
    footprint: "none",
    subscriptionPatterns: ["times prime", "timesprime"],
    question: "Have you used any Times Prime benefit in the last {days} days?",
    cancelHint: "Times Prime app → Profile → Membership → Cancel auto-renewal",
  },
  {
    key: "airtel-xstream",
    displayName: "Airtel Xstream Play",
    footprint: "none",
    subscriptionPatterns: ["airtel xstream", "xstream play"],
    question: "Have you watched anything on Airtel Xstream Play in the last {days} days?",
    cancelHint: "Airtel Thanks app → Manage Services → Xstream Play → Cancel",
  },

  // --- AI assistants -----------------------------------------------------
  //
  // The purest form of the problem this product exists for. You pay once a
  // month and then use it, or don't, entirely invisibly: no order, no booking,
  // no second charge. Nothing in a bank statement can ever separate a daily
  // user from someone who signed up in January and forgot. Only the user knows,
  // so only the user is asked.
  {
    key: "openai-chatgpt",
    displayName: "ChatGPT Plus",
    footprint: "none",
    subscriptionPatterns: ["chatgpt", "openai"],
    question: "Have you used ChatGPT in the last {days} days?",
    cancelHint: "ChatGPT → Settings → Subscription → Manage → Cancel plan",
    cancelUrl: "https://chatgpt.com/#settings/Subscription",
  },
  {
    key: "anthropic-claude",
    displayName: "Claude Pro",
    footprint: "none",
    // "claude ai" rather than a bare "claude": the single token is a common
    // given name and would key any payee containing it to this entry.
    subscriptionPatterns: ["claude ai", "anthropic"],
    question: "Have you used Claude in the last {days} days?",
    cancelHint: "Claude → Settings → Billing → Cancel plan",
  },
  {
    key: "google-gemini",
    displayName: "Google AI Premium",
    footprint: "none",
    // Never a bare "gemini". It collides with nothing in this map today, which
    // is exactly the condition under which someone later adds a merchant that
    // does.
    subscriptionPatterns: ["gemini advanced", "google ai premium", "google ai pro"],
    question: "Have you used Gemini in the last {days} days?",
    cancelHint: "Google One → Settings → Manage membership → downgrade from the AI plan",
    cancelUrl: "https://one.google.com/settings",
  },
  {
    key: "perplexity",
    displayName: "Perplexity Pro",
    footprint: "none",
    subscriptionPatterns: ["perplexity"],
    question: "Have you used Perplexity in the last {days} days?",
    cancelHint: "Perplexity → Settings → Account → Manage subscription → Cancel",
  },

  // --- Cloud storage and photos ------------------------------------------
  //
  // Storage has a failure mode the others don't: cancelling can DELETE things.
  // Every hint here says so, because "you haven't opened it in 90 days" is a
  // terrible reason to lose a photo library.
  {
    key: "google-photos",
    displayName: "Google Photos storage",
    footprint: "none",
    // Two tokens, so it cannot shadow or be shadowed by "google one" --
    // lookupSubscription takes the longest match and validateMerchantMap's
    // round-trip check fails loudly if that ever stops being true.
    subscriptionPatterns: ["google photos"],
    question: "Are you still relying on Google Photos for backup?",
    cancelHint:
      "Google One → Settings → Cancel. Your photos stay, but new backups stop and you drop to 15 GB shared across Gmail and Drive.",
    cancelUrl: "https://one.google.com/settings",
  },
  {
    key: "dropbox",
    displayName: "Dropbox",
    footprint: "none",
    subscriptionPatterns: ["dropbox"],
    question: "Have you opened anything in Dropbox in the last {days} days?",
    cancelHint:
      "Dropbox → Settings → Plan → Cancel plan. Bring your files under 2 GB first or they become read-only.",
  },
  {
    key: "microsoft-onedrive",
    displayName: "OneDrive",
    footprint: "none",
    subscriptionPatterns: ["onedrive", "one drive"],
    question: "Are you still relying on OneDrive for storage?",
    cancelHint:
      "Microsoft account → Services & subscriptions → Manage → Cancel. Files over the free 5 GB become read-only.",
  },

  // --- Productivity and creative -----------------------------------------
  {
    key: "microsoft-365",
    displayName: "Microsoft 365",
    footprint: "none",
    subscriptionPatterns: ["microsoft 365", "office 365", "msft 365"],
    question: "Have you used Word, Excel or Outlook in the last {days} days?",
    cancelHint:
      "Microsoft account → Services & subscriptions → Manage → Turn off recurring billing",
    cancelUrl: "https://account.microsoft.com/services",
  },
  {
    key: "adobe-cc",
    displayName: "Adobe Creative Cloud",
    footprint: "none",
    subscriptionPatterns: ["adobe", "creative cloud"],
    question: "Have you opened an Adobe app in the last {days} days?",
    cancelHint:
      "Adobe account → Plans → Manage plan → Cancel. Annual plans charge an early-termination fee — check the date before you cancel.",
    cancelUrl: "https://account.adobe.com/plans",
  },
  {
    key: "canva",
    displayName: "Canva Pro",
    footprint: "none",
    subscriptionPatterns: ["canva"],
    question: "Have you designed anything in Canva in the last {days} days?",
    cancelHint:
      "Canva → Settings → Billing & plans → Cancel subscription. Pro assets in existing designs get watermarked.",
  },
  {
    key: "notion",
    displayName: "Notion",
    footprint: "none",
    subscriptionPatterns: ["notion"],
    question: "Have you opened Notion in the last {days} days?",
    cancelHint: "Notion → Settings → Plans → Downgrade to Free. Your pages stay.",
  },
];

const BY_KEY = new Map(MERCHANTS.map((m) => [m.key, m]));

/**
 * Lowercase, split on anything non-alphanumeric, drop leading payment-rail
 * tokens. "RAZORPAY*ZOMATO GOLD" -> ["zomato", "gold"].
 *
 * Note what this does NOT do: split on "*" and keep only the tail. That naive
 * rule turns "Amazon Prime*IN" into "IN" and loses the merchant entirely.
 */
export function tokenize(raw: string): string[] {
  const tokens = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  let start = 0;
  // Never strip away the whole string: "PAYTM" alone is a merchant in its own right.
  while (start < tokens.length - 1 && RAIL_PREFIXES.has(tokens[start])) start++;
  return tokens.slice(start);
}

/** The normalised, rail-stripped merchant string. */
export function normalizeMerchant(raw: string): string {
  return tokenize(raw).join(" ");
}

/**
 * True iff the pattern's tokens appear as a CONTIGUOUS run anywhere in `tokens`.
 *
 * Token-sequence matching rather than substring matching, because substring
 * matching is a live bug: `ola` is inside "Choc-ola-te Room", and `in` is inside
 * almost everything. "OLA CABS" matches `ola`; "Chocolate Room" does not.
 */
export function matchesPattern(tokens: readonly string[], pattern: string): boolean {
  const needle = pattern.split(" ").filter(Boolean);
  if (needle.length === 0 || needle.length > tokens.length) return false;
  for (let i = 0; i + needle.length <= tokens.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (tokens[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Resolve a merchant string to a subscription entry, consulting
 * subscriptionPatterns ONLY. Usage patterns are never used for identity --
 * that is the trap-precedence rule applied at the keying layer, and it is why a
 * plain "Amazon" shopping charge keys to `amazon`, not to `amazon-prime`.
 *
 * Longest matching pattern wins, so "amazon prime" beats a hypothetical "amazon".
 */
export function lookupSubscription(merchant: string): MerchantEntry | undefined {
  const tokens = tokenize(merchant);
  let best: MerchantEntry | undefined;
  let bestTokens = 0;
  let bestChars = 0;

  for (const entry of MERCHANTS) {
    for (const pattern of entry.subscriptionPatterns) {
      if (!matchesPattern(tokens, pattern)) continue;
      const patternTokens = pattern.split(" ").length;
      const better =
        patternTokens > bestTokens ||
        (patternTokens === bestTokens && pattern.length > bestChars) ||
        // Final tie-break on key so the result never depends on array order.
        (patternTokens === bestTokens &&
          pattern.length === bestChars &&
          best !== undefined &&
          entry.key < best.key);
      if (better) {
        best = entry;
        bestTokens = patternTokens;
        bestChars = pattern.length;
      }
    }
  }
  return best;
}

export function lookupByKey(key: string): MerchantEntry | undefined {
  return BY_KEY.get(key);
}

/**
 * How to cancel this service. Falls back to honest generic guidance for
 * merchants we do not recognise -- the alternative is a blank row on the
 * checklist, which reads as "we forgot" rather than "we don't know".
 */
export function cancelGuidance(merchantKey: string): {
  hint: string;
  url?: string;
} {
  const entry = BY_KEY.get(merchantKey);
  if (entry?.cancelHint) {
    return { hint: entry.cancelHint, url: entry.cancelUrl };
  }
  return {
    hint: "Cancel in the service's own app or website. If it bills by UPI autopay, you can also stop the mandate from your UPI app.",
  };
}

/** Mapped entries missing cancellation guidance. Reported by tests as a warning. */
export function merchantsWithoutCancelHint(): string[] {
  return MERCHANTS.filter((m) => !m.cancelHint).map((m) => m.key);
}

/**
 * True if this merchant string looks like ANY subscription charge in the map --
 * not just one entry's. The global scope is the point: an "Amazon Music" charge
 * would otherwise satisfy Amazon Prime's `amazon` usage pattern.
 */
export function isSubscriptionCharge(merchant: string): boolean {
  return lookupSubscription(merchant) !== undefined;
}

/** Firestore-safe slug. Never empty, never "." or "..". */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/g, "");
  return slug === "" || slug === "." || slug === ".." ? "unknown-merchant" : slug;
}

/**
 * The grouping key for Layer 1, the Firestore doc id, and the verdict cache key
 * -- deliberately all the same value. Real GPay payee strings drift
 * ("AMAZON PRIME" in February, "Amazon Prime*IN" in May); grouping on the raw
 * string splits one seven-charge chain into two three-charge chains and puts
 * two Prime cards on stage instead of one.
 */
export function merchantKeyOf(merchant: string): string {
  return lookupSubscription(merchant)?.key ?? slugify(normalizeMerchant(merchant));
}

/** Canonical display name, falling back to the raw payee for unmapped merchants. */
/**
 * Is this email evidence that `entry` is being used?
 *
 * THE ORDER OF THESE STEPS IS THE CONTRACT, exactly as it is for transactions
 * in `isUsageEvidence`. The failure mode is identical and just as quiet: a
 * subscription's own renewal notice becomes proof that the subscription is
 * being used, and every verdict comes back "used" with no error anywhere.
 */
export function isEmailUsageEvidence(
  email: { from: string; subject: string },
  entry: MerchantEntry,
): boolean {
  // 1. Does this service leave any email footprint at all? Netflix does not
  //    write to you when you watch something, so nothing can be evidence for
  //    it and no amount of matching should invent some.
  if (!entry.emailUsage) return false;

  const subjectTokens = tokenize(email.subject);

  // 2. Braces: does this look like ANY subscription's billing mail? Checked
  //    globally and before the positive test, so "Your Prime membership has
  //    renewed" is disqualified as billing before it ever gets the chance to
  //    match Amazon's sender and be counted as an order.
  if (EMAIL_BILLING_PATTERNS.some((p) => matchesPattern(subjectTokens, p))) {
    return false;
  }

  // 3. Is it really from them? A subject line alone is anyone's to write.
  const from = email.from.toLowerCase();
  if (!entry.emailUsage.senders.some((sender) => from.includes(sender))) return false;

  // 4. Finally: does the subject describe something the USER did?
  return entry.emailUsage.subjectPatterns.some((p) => matchesPattern(subjectTokens, p));
}

/** Every entry this email is usage evidence for. Normally one, sometimes none. */
export function emailUsageMatches(email: { from: string; subject: string }): MerchantEntry[] {
  return MERCHANTS.filter((entry) => isEmailUsageEvidence(email, entry));
}

export function displayNameOf(merchant: string): string {
  return lookupSubscription(merchant)?.displayName ?? merchant.trim();
}

/**
 * Structural health check for the map. Returns a list of problems; [] is
 * healthy. Called from test-logic.ts, so a bad map fails the suite rather than
 * the demo.
 *
 * The cross-entry pattern check is the one that earns its keep: a pattern owned
 * by two entries (say "times internet", which is the legal payee for both Gaana
 * and Times Prime) makes both verdicts depend on array order.
 */
export function validateMerchantMap(): string[] {
  const problems: string[] = [];
  const seenKeys = new Set<string>();
  const patternOwner = new Map<string, string>();

  if (MERCHANTS.length !== 32) {
    problems.push(`expected 32 entries, found ${MERCHANTS.length}`);
  }

  for (const entry of MERCHANTS) {
    if (seenKeys.has(entry.key)) problems.push(`duplicate key: ${entry.key}`);
    seenKeys.add(entry.key);

    if (slugify(entry.key) !== entry.key) {
      problems.push(`key is not slug-shaped: ${entry.key}`);
    }
    if (entry.displayName.trim() === "") {
      problems.push(`${entry.key}: empty displayName`);
    }
    if (entry.subscriptionPatterns.length === 0) {
      problems.push(`${entry.key}: no subscriptionPatterns`);
    }

    const allPatterns: string[] = [
      ...entry.subscriptionPatterns,
      ...(entry.footprint === "transaction" ? entry.usagePatterns : []),
    ];

    for (const pattern of allPatterns) {
      if (pattern !== pattern.toLowerCase() || pattern.trim() !== pattern) {
        problems.push(`${entry.key}: pattern not normalised: "${pattern}"`);
      }
      if (normalizeMerchant(pattern) !== pattern) {
        problems.push(
          `${entry.key}: pattern does not survive normalisation: "${pattern}"`,
        );
      }
      const tokens = pattern.split(" ").filter(Boolean);
      if (tokens.length === 1) {
        if (tokens[0].length < 3) {
          problems.push(`${entry.key}: single-token pattern too short: "${pattern}"`);
        }
        if (GENERIC_TOKENS.has(tokens[0])) {
          problems.push(`${entry.key}: generic single-token pattern: "${pattern}"`);
        }
      }
    }

    // Cross-entry ownership is only checked for subscription patterns: two
    // services can legitimately share a usage merchant, but not an identity.
    for (const pattern of entry.subscriptionPatterns) {
      const owner = patternOwner.get(pattern);
      if (owner !== undefined && owner !== entry.key) {
        problems.push(`pattern "${pattern}" claimed by both ${owner} and ${entry.key}`);
      }
      patternOwner.set(pattern, entry.key);
    }

    if (entry.footprint === "none" && entry.question.trim() === "") {
      problems.push(`${entry.key}: footprint "none" requires a question`);
    }
    if (entry.footprint === "transaction") {
      if (entry.usagePatterns.length === 0) {
        problems.push(`${entry.key}: tracked merchant with no usagePatterns`);
      }
      if (entry.usageLabel.trim() === "") {
        problems.push(`${entry.key}: tracked merchant with no usageLabel`);
      }
    }
  }

  // Every subscription pattern in the map must resolve back to its own entry.
  // Catches a new pattern that is accidentally shadowed by a longer existing one.
  for (const entry of MERCHANTS) {
    for (const pattern of entry.subscriptionPatterns) {
      const resolved = lookupSubscription(pattern);
      if (resolved?.key !== entry.key) {
        problems.push(
          `pattern "${pattern}" belongs to ${entry.key} but resolves to ${resolved?.key ?? "nothing"}`,
        );
      }
    }
  }

  return problems;
}
