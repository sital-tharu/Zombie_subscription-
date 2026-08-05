/**
 * Persistence, behind one interface with two implementations.
 *
 * Firestore is the deployment target and what the architecture diagram
 * describes. The JSON-file adapter exists so that a clean clone runs -- and the
 * demo works -- before anyone has visited the Firebase console. The selection
 * is automatic: credentials present means Firestore, absent means local.
 *
 * This matters more than it looks. The engine, the seed and the dashboard all
 * work on day one; a missing service account degrades the app to a local file
 * instead of a stack trace fifteen minutes before a submission deadline.
 *
 * Nothing here is reachable from Layers 1-3 -- an ESLint rule forbids the
 * import -- so `npm run test:logic` never needs any of it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Cancellation, EmailEvent, StoredTransaction, UserAnswer } from "./types";

export type StoreMode = "firestore" | "local";

export interface StoredProposal {
  id: string;
  planText: string;
  items: { merchantKey: string; action: string; rationale: string }[];
  /** Computed in code and copied in, never requested from a model. */
  annualSavings: number;
  totalWasted: number;
  status: "pending" | "accepted" | "rejected";
  /** Whether Gemini wrote the prose or the deterministic fallback did. */
  generatedBy: "gemini" | "template";
  createdAt: string;
}

export interface Store {
  mode: StoreMode;
  listTransactions(limit?: number): Promise<StoredTransaction[]>;
  addTransactions(txns: readonly StoredTransaction[]): Promise<number>;
  /** Wipe previously seeded rows, then insert. Re-seeding must not duplicate. */
  replaceSeeded(txns: readonly StoredTransaction[]): Promise<number>;
  /** Remove specific transactions by id. Used to purge real data from a public deployment. */
  deleteTransactions(ids: readonly string[]): Promise<number>;
  listAnswers(): Promise<UserAnswer[]>;
  saveAnswer(answer: UserAnswer): Promise<void>;
  /** Remove an answer entirely, so inference applies again. */
  clearAnswer(merchantKey: string): Promise<void>;
  listCancellations(): Promise<Cancellation[]>;
  saveCancellation(cancellation: Cancellation): Promise<void>;
  /** Undo a declared cancellation. */
  clearCancellation(merchantKey: string): Promise<void>;
  saveProposal(proposal: StoredProposal): Promise<void>;
  latestProposal(): Promise<StoredProposal | null>;
  setProposalStatus(id: string, status: StoredProposal["status"]): Promise<void>;
  /** Discard every stored proposal. Demo tooling; nothing in the app calls it. */
  clearProposals(): Promise<number>;

  /** Layer 2b: message headers synced from Gmail. */
  listEmails(): Promise<EmailEvent[]>;
  /** Upsert by Gmail message id, so resyncing the same label cannot double up. */
  saveEmails(emails: readonly EmailEvent[]): Promise<number>;
  clearEmails(): Promise<number>;

  /**
   * Spend one unit of a daily allowance. False when it is already gone.
   *
   * A floor under cost, NOT rate limiting -- worth saying plainly, because the
   * shape invites the wrong assumption. It is one global counter, so a single
   * caller can drain the day and lock everyone else out. That is an acceptable
   * failure for a single-owner demo whose alternative is an unbounded bill; it
   * would not be acceptable as a security control.
   */
  consumeQuota(kind: string, limit: number): Promise<boolean>;

  /**
   * The Gmail refresh token. Stored server-side and never sent to a browser;
   * kept behind this interface rather than reached for directly so that local
   * dogfooding does not need Firestore at all.
   */
  getGmailToken(): Promise<string | null>;
  saveGmailToken(refreshToken: string): Promise<void>;
  clearGmailToken(): Promise<void>;
}

const TRANSACTIONS = "transactions";
const VERDICTS = "verdicts";
const PROPOSALS = "proposals";
const CANCELLATIONS = "cancellations";
const EMAILS = "emails";
const CONFIG = "config";
const GMAIL_TOKEN_DOC = "gmailToken";
const USAGE = "usage";

/**
 * How many transactions a single read returns.
 *
 * This is not a cosmetic limit. Reads are ordered newest-first, so truncation
 * silently removes the OLDEST transactions -- the far end of every charge
 * chain. A chain cut short reports fewer charges, a smaller totalPaid and a
 * smaller zombieScore, all of them internally consistent and all of them wrong.
 * Exactly the kind of quietly incorrect number this product exists to avoid.
 *
 * Hence the generous ceiling, and hence `readWasTruncated` below: when the
 * result fills the limit, the dashboard says so rather than presenting a
 * partial history as a complete one.
 */
export const TRANSACTION_READ_LIMIT = 2000;

/** True when a read probably hit the ceiling and older rows are missing. */
export function readWasTruncated(returned: number, limit = TRANSACTION_READ_LIMIT): boolean {
  return returned >= limit;
}

/**
 * Firestore is used only when a service account is actually reachable.
 *
 * The path check is the important half: .env.example ships with
 * FIREBASE_SERVICE_ACCOUNT_PATH already filled in, so testing "is the variable
 * set" would send every fresh clone down the Firestore path and fail on a file
 * that does not exist.
 */
export function hasFirebaseCredentials(): boolean {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return true;
  const path = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  return Boolean(path && existsSync(serviceAccountPath(path)));
}

/**
 * `ZOMBIE_STORE=local` forces the JSON store even when Firebase credentials are
 * present. This is what makes the PRD's two-track data strategy actually
 * workable: the deployed Firestore holds only the scripted demo, while real
 * GPay history is dogfooded locally and never leaves the machine.
 *
 * The alternative was moving the service account file around to change
 * behaviour, which is the kind of manual step that eventually gets forgotten
 * with real financial data on the wrong side of it.
 */
function forcedLocal(): boolean {
  return process.env.ZOMBIE_STORE === "local";
}

/**
 * The service account path comes from an environment variable, so the bundler
 * cannot trace it statically. Left unannotated, Turbopack assumes the whole
 * project is reachable and pulls every file into the serverless bundle.
 */
function serviceAccountPath(path: string): string {
  return resolve(/* turbopackIgnore: true */ process.cwd(), path);
}

/**
 * How long a read may be reused.
 *
 * The dashboard is force-dynamic, so every render re-reads everything: roughly
 * a hundred Firestore documents for one page view. A dev server hot-reloading
 * on save, or a demo being clicked through, gets through the free tier's daily
 * read quota alarmingly fast -- and when it runs out, every page 500s.
 *
 * Ten seconds is chosen to be shorter than a human notices and longer than a
 * burst of re-renders. It is not a correctness risk, because every write on
 * this Store clears the cache before it returns: answer a question and the next
 * render reads fresh. The only staleness window is another PROCESS writing --
 * `npm run seed` while the dev server is up -- and that self-heals in ten
 * seconds.
 */
const READ_TTL_MS = 10_000;

/**
 * Read-through cache in front of any Store, invalidated by every write.
 *
 * Caches the promise rather than the resolved value, so concurrent callers
 * share one round trip. A rejected promise is evicted immediately -- caching a
 * failure for ten seconds would turn one transient error into a stuck page.
 */
function withReadCache(inner: Store): Store {
  const hits = new Map<string, { at: number; value: Promise<unknown> }>();
  const bust = () => hits.clear();

  const read = <T>(key: string, load: () => Promise<T>): Promise<T> => {
    const hit = hits.get(key);
    if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.value as Promise<T>;
    const value = load();
    hits.set(key, { at: Date.now(), value });
    value.catch(() => hits.delete(key));
    return value;
  };

  /** Wrap a write so it clears the cache, whether it succeeds or throws. */
  const write = <A extends unknown[], T>(fn: (...args: A) => Promise<T>) => {
    return async (...args: A): Promise<T> => {
      try {
        return await fn(...args);
      } finally {
        bust();
      }
    };
  };

  return {
    mode: inner.mode,

    listTransactions: (limit) =>
      read(`txns:${limit ?? "default"}`, () => inner.listTransactions(limit)),
    listAnswers: () => read("answers", () => inner.listAnswers()),
    listCancellations: () => read("cancellations", () => inner.listCancellations()),
    listEmails: () => read("emails", () => inner.listEmails()),
    latestProposal: () => read("proposal", () => inner.latestProposal()),
    getGmailToken: () => read("gmailToken", () => inner.getGmailToken()),

    addTransactions: write(inner.addTransactions.bind(inner)),
    replaceSeeded: write(inner.replaceSeeded.bind(inner)),
    deleteTransactions: write(inner.deleteTransactions.bind(inner)),
    saveAnswer: write(inner.saveAnswer.bind(inner)),
    clearAnswer: write(inner.clearAnswer.bind(inner)),
    saveCancellation: write(inner.saveCancellation.bind(inner)),
    clearCancellation: write(inner.clearCancellation.bind(inner)),
    saveProposal: write(inner.saveProposal.bind(inner)),
    setProposalStatus: write(inner.setProposalStatus.bind(inner)),
    clearProposals: write(inner.clearProposals.bind(inner)),
    saveEmails: write(inner.saveEmails.bind(inner)),
    // Deliberately uncached and cache-busting: a quota check is a write, and
    // serving a memoised "yes" would let ten messages spend one unit.
    consumeQuota: write(inner.consumeQuota.bind(inner)),
    clearEmails: write(inner.clearEmails.bind(inner)),
    saveGmailToken: write(inner.saveGmailToken.bind(inner)),
    clearGmailToken: write(inner.clearGmailToken.bind(inner)),
  };
}

/**
 * True when the store refused because a quota ran out, rather than because
 * anything is wrong with the code or the data. Worth telling apart: one is
 * "wait, or upgrade the plan" and the other is "something is broken".
 */
export function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /RESOURCE_EXHAUSTED|Quota exceeded/i.test(message);
}

let cached: Store | null = null;

/**
 * Async because the Firestore adapter is imported dynamically: a local-mode run
 * must never load firebase-admin at all, and a static import would pull it into
 * every bundle whether or not credentials exist. Every caller is already async.
 */
export async function getStore(): Promise<Store> {
  if (!cached) {
    if (storeMode() === "local" && process.env.VERCEL) {
      // The local adapter writes to ./data, and a serverless filesystem is
      // read-only. Falling back there on Vercel produces a dashboard that
      // renders an empty state and silently discards every write -- which
      // looks like an empty account rather than a misconfiguration. Fail loudly
      // instead.
      //
      // Keyed on VERCEL rather than NODE_ENV on purpose: `npm run build` sets
      // NODE_ENV=production locally, and a clean clone must still build without
      // any Firebase setup.
      throw new Error(
        forcedLocal()
          ? "ZOMBIE_STORE=local is set in a Vercel deployment. The local store writes to " +
            "./data and a serverless filesystem is read-only. Unset it."
          : "No Firebase credentials in a Vercel deployment. Set FIREBASE_SERVICE_ACCOUNT_JSON " +
            "to the full service account JSON — the file-path variable cannot work here, " +
            "because secrets/ is gitignored and never deployed.",
      );
    }
    const mode = storeMode();
    const base = mode === "firestore" ? await firestoreStore() : localStore();

    /*
     * Say which database this process is about to use, once.
     *
     * Firestore's free tier allows 50,000 document reads a day and one
     * dashboard render costs roughly 110 of them, so a dev server pointed at
     * the deployment's database drains it in an afternoon -- and the first
     * symptom is the *public site* returning "out of quota" to visitors while
     * nothing locally looks wrong. Nothing on screen distinguished "dev is
     * safely local" from "dev is spending production's budget", which is
     * exactly how that went unnoticed until the live site fell over.
     *
     * Once per process, not per call: a line on every render is noise, and
     * noise is what gets tuned out.
     */
    console.log(
      mode === "firestore"
        ? "Store: firestore (shared with the deployment -- reads count against its daily quota)"
        : "Store: local (./data/zombie.json)",
    );

    // The local adapter reads a file that the OS already caches, so the wrapper
    // buys it little -- but applying it uniformly keeps the two modes behaving
    // identically, which is worth more than the saved microseconds.
    cached = withReadCache(base);
  }
  return cached;
}

export function storeMode(): StoreMode {
  if (forcedLocal()) return "local";
  return hasFirebaseCredentials() ? "firestore" : "local";
}

// ---------------------------------------------------------------------------
// Firestore
// ---------------------------------------------------------------------------

async function firestoreStore(): Promise<Store> {
  const { cert, getApps, initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : JSON.parse(
        readFileSync(serviceAccountPath(process.env.FIREBASE_SERVICE_ACCOUNT_PATH!), "utf8"),
      );

  // getApps() guard: Next's dev server re-evaluates modules on hot reload.
  const app =
    getApps()[0] ?? initializeApp({ credential: cert(serviceAccount) });
  const db = getFirestore(app);

  // Named rather than reached through `this`: inside an async factory the
  // object literal's `this` widens to Store | PromiseLike<Store>.
  const addAll = async (txns: readonly StoredTransaction[]): Promise<number> => {
    if (txns.length === 0) return 0;
    // Firestore caps a batch at 500 writes.
    for (let i = 0; i < txns.length; i += 400) {
      const batch = db.batch();
      for (const txn of txns.slice(i, i + 400)) {
        batch.set(db.collection(TRANSACTIONS).doc(txn.id), txn);
      }
      await batch.commit();
    }
    return txns.length;
  };

  return {
    mode: "firestore",

    async listTransactions(limit = TRANSACTION_READ_LIMIT) {
      const snap = await db
        .collection(TRANSACTIONS)
        .orderBy("date", "desc")
        .limit(limit)
        .get();
      return snap.docs.map(
        (d: { id: string; data: () => Record<string, unknown> }) =>
          ({ ...d.data(), id: d.id }) as StoredTransaction,
      );
    },

    addTransactions: addAll,

    async replaceSeeded(txns) {
      const existing = await db.collection(TRANSACTIONS).where("seeded", "==", true).get();
      for (let i = 0; i < existing.docs.length; i += 400) {
        const batch = db.batch();
        for (const doc of existing.docs.slice(i, i + 400)) batch.delete(doc.ref);
        await batch.commit();
      }
      return addAll(txns);
    },

    async deleteTransactions(ids) {
      if (ids.length === 0) return 0;
      for (let i = 0; i < ids.length; i += 400) {
        const batch = db.batch();
        for (const id of ids.slice(i, i + 400)) {
          batch.delete(db.collection(TRANSACTIONS).doc(id));
        }
        await batch.commit();
      }
      return ids.length;
    },

    async listAnswers() {
      const snap = await db.collection(VERDICTS).get();
      return snap.docs
        .map((d: { id: string; data: () => Record<string, unknown> }) => ({
          merchantKey: d.id,
          ...d.data(),
        }))
        .filter((a: Partial<UserAnswer>) => typeof a.used === "boolean") as UserAnswer[];
    },

    async saveAnswer(answer) {
      await db
        .collection(VERDICTS)
        .doc(answer.merchantKey)
        .set({ used: answer.used, answeredAt: answer.answeredAt }, { merge: true });
    },

    async clearAnswer(merchantKey) {
      await db.collection(VERDICTS).doc(merchantKey).delete();
    },

    async listCancellations() {
      const snap = await db.collection(CANCELLATIONS).get();
      return snap.docs
        .map((d: { id: string; data: () => Record<string, unknown> }) => ({
          merchantKey: d.id,
          ...d.data(),
        }))
        .filter(
          (c: Partial<Cancellation>) => typeof c.cancelledAt === "string",
        ) as Cancellation[];
    },

    async saveCancellation(cancellation) {
      await db
        .collection(CANCELLATIONS)
        .doc(cancellation.merchantKey)
        .set({ cancelledAt: cancellation.cancelledAt });
    },

    async clearCancellation(merchantKey) {
      await db.collection(CANCELLATIONS).doc(merchantKey).delete();
    },

    async saveProposal(proposal) {
      await db.collection(PROPOSALS).doc(proposal.id).set(proposal);
    },

    async latestProposal() {
      const snap = await db
        .collection(PROPOSALS)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();
      return snap.empty ? null : (snap.docs[0].data() as StoredProposal);
    },

    async setProposalStatus(id, status) {
      await db.collection(PROPOSALS).doc(id).set({ status }, { merge: true });
    },

    async clearProposals() {
      const snap = await db.collection(PROPOSALS).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = db.batch();
        for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref);
        await batch.commit();
      }
      return snap.docs.length;
    },

    async listEmails() {
      const snap = await db.collection(EMAILS).orderBy("date", "desc").limit(2000).get();
      return snap.docs.map(
        (d: { id: string; data: () => Record<string, unknown> }) =>
          ({ ...d.data(), id: d.id }) as EmailEvent,
      );
    },

    async saveEmails(emails) {
      if (emails.length === 0) return 0;
      for (let i = 0; i < emails.length; i += 400) {
        const batch = db.batch();
        for (const e of emails.slice(i, i + 400)) {
          batch.set(db.collection(EMAILS).doc(e.id), e);
        }
        await batch.commit();
      }
      return emails.length;
    },

    async clearEmails() {
      const snap = await db.collection(EMAILS).get();
      for (let i = 0; i < snap.docs.length; i += 400) {
        const batch = db.batch();
        for (const doc of snap.docs.slice(i, i + 400)) batch.delete(doc.ref);
        await batch.commit();
      }
      return snap.docs.length;
    },

    async consumeQuota(kind, limit) {
      // A transaction, not a read-then-write: serverless instances share no
      // memory, and two arriving together would both read the old count.
      const ref = db.collection(USAGE).doc(new Date().toISOString().slice(0, 10));
      return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const used = (snap.data()?.[kind] as number | undefined) ?? 0;
        if (used >= limit) return false;
        tx.set(ref, { [kind]: used + 1 }, { merge: true });
        return true;
      });
    },

    async getGmailToken() {
      const doc = await db.collection(CONFIG).doc(GMAIL_TOKEN_DOC).get();
      const stored = doc.data()?.refreshToken;
      return typeof stored === "string" && stored !== "" ? stored : null;
    },

    async saveGmailToken(refreshToken) {
      await db
        .collection(CONFIG)
        .doc(GMAIL_TOKEN_DOC)
        .set({ refreshToken, updatedAt: new Date().toISOString() });
    },

    async clearGmailToken() {
      await db.collection(CONFIG).doc(GMAIL_TOKEN_DOC).delete();
    },

  };
}

// ---------------------------------------------------------------------------
// Local JSON files
// ---------------------------------------------------------------------------

interface LocalShape {
  transactions: StoredTransaction[];
  answers: UserAnswer[];
  proposals: StoredProposal[];
  cancellations: Cancellation[];
  emails: EmailEvent[];
  gmailRefreshToken?: string;
  usage?: { day: string; counts: Record<string, number> };
}

const EMPTY: LocalShape = {
  transactions: [],
  answers: [],
  proposals: [],
  cancellations: [],
  emails: [],
};

function localStore(): Store {
  const file = join(process.cwd(), "data", "zombie.json");

  const read = (): LocalShape => {
    if (!existsSync(file)) return structuredClone(EMPTY);
    try {
      return { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(file, "utf8")) };
    } catch {
      // A corrupt local file is a demo-grade inconvenience, not a data loss
      // event -- everything here is reproducible with `npm run seed`.
      return structuredClone(EMPTY);
    }
  };

  const write = (data: LocalShape): void => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  };

  return {
    mode: "local",

    async listTransactions(limit = TRANSACTION_READ_LIMIT) {
      return read()
        .transactions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
        .slice(0, limit);
    },

    async addTransactions(txns) {
      const data = read();
      const byId = new Map(data.transactions.map((t) => [t.id, t]));
      for (const txn of txns) byId.set(txn.id, txn);
      data.transactions = [...byId.values()];
      write(data);
      return txns.length;
    },

    async replaceSeeded(txns) {
      const data = read();
      data.transactions = data.transactions.filter((t) => !t.seeded);
      write(data);
      return this.addTransactions(txns);
    },

    async deleteTransactions(ids) {
      const remove = new Set(ids);
      const data = read();
      const before = data.transactions.length;
      data.transactions = data.transactions.filter((t) => !remove.has(t.id));
      write(data);
      return before - data.transactions.length;
    },

    async listAnswers() {
      return read().answers;
    },

    async saveAnswer(answer) {
      const data = read();
      data.answers = [
        ...data.answers.filter((a) => a.merchantKey !== answer.merchantKey),
        answer,
      ];
      write(data);
    },

    async clearAnswer(merchantKey) {
      const data = read();
      data.answers = data.answers.filter((a) => a.merchantKey !== merchantKey);
      write(data);
    },

    async listCancellations() {
      return read().cancellations;
    },

    async saveCancellation(cancellation) {
      const data = read();
      data.cancellations = [
        ...data.cancellations.filter((c) => c.merchantKey !== cancellation.merchantKey),
        cancellation,
      ];
      write(data);
    },

    async clearCancellation(merchantKey) {
      const data = read();
      data.cancellations = data.cancellations.filter((c) => c.merchantKey !== merchantKey);
      write(data);
    },

    async saveProposal(proposal) {
      const data = read();
      data.proposals = [...data.proposals.filter((p) => p.id !== proposal.id), proposal];
      write(data);
    },

    async latestProposal() {
      const sorted = read().proposals.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : -1,
      );
      return sorted[0] ?? null;
    },

    async setProposalStatus(id, status) {
      const data = read();
      data.proposals = data.proposals.map((p) => (p.id === id ? { ...p, status } : p));
      write(data);
    },

    async clearProposals() {
      const data = read();
      const count = data.proposals.length;
      data.proposals = [];
      write(data);
      return count;
    },

    async listEmails() {
      return read().emails.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    },

    async saveEmails(emails) {
      const data = read();
      const byId = new Map(data.emails.map((e) => [e.id, e]));
      for (const e of emails) byId.set(e.id, e);
      data.emails = [...byId.values()];
      write(data);
      return emails.length;
    },

    async clearEmails() {
      const data = read();
      const count = data.emails.length;
      data.emails = [];
      write(data);
      return count;
    },

    async consumeQuota(kind, limit) {
      const data = read();
      const today = new Date().toISOString().slice(0, 10);
      const usage = data.usage?.day === today ? data.usage : { day: today, counts: {} };
      const used = usage.counts[kind] ?? 0;
      if (used >= limit) return false;
      usage.counts[kind] = used + 1;
      data.usage = usage;
      write(data);
      return true;
    },

    async getGmailToken() {
      return read().gmailRefreshToken ?? null;
    },

    async saveGmailToken(refreshToken) {
      const data = read();
      data.gmailRefreshToken = refreshToken;
      write(data);
    },

    async clearGmailToken() {
      const data = read();
      delete data.gmailRefreshToken;
      write(data);
    },

  };
}
