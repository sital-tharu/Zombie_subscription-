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
import type { Cancellation, StoredTransaction, UserAnswer } from "./types";

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
  /**
   * merchantKeys the user has ticked off the cancellation checklist. Optional
   * so proposals written before the checklist existed still parse.
   */
  completedItems?: string[];
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
  setProposalChecklist(id: string, completedItems: readonly string[]): Promise<void>;
}

const TRANSACTIONS = "transactions";
const VERDICTS = "verdicts";
const PROPOSALS = "proposals";
const CANCELLATIONS = "cancellations";

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
    cached = storeMode() === "firestore" ? await firestoreStore() : localStore();
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

    async setProposalChecklist(id, completedItems) {
      await db
        .collection(PROPOSALS)
        .doc(id)
        .set({ completedItems: [...completedItems] }, { merge: true });
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
}

const EMPTY: LocalShape = {
  transactions: [],
  answers: [],
  proposals: [],
  cancellations: [],
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

    async setProposalChecklist(id, completedItems) {
      const data = read();
      data.proposals = data.proposals.map((p) =>
        p.id === id ? { ...p, completedItems: [...completedItems] } : p,
      );
      write(data);
    },
  };
}
