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
import type { StoredTransaction, UserAnswer } from "./types";

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
  listAnswers(): Promise<UserAnswer[]>;
  saveAnswer(answer: UserAnswer): Promise<void>;
  saveProposal(proposal: StoredProposal): Promise<void>;
  latestProposal(): Promise<StoredProposal | null>;
  setProposalStatus(id: string, status: StoredProposal["status"]): Promise<void>;
}

const TRANSACTIONS = "transactions";
const VERDICTS = "verdicts";
const PROPOSALS = "proposals";

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
  return Boolean(path && existsSync(resolve(process.cwd(), path)));
}

let cached: Store | null = null;

/**
 * Async because the Firestore adapter is imported dynamically: a local-mode run
 * must never load firebase-admin at all, and a static import would pull it into
 * every bundle whether or not credentials exist. Every caller is already async.
 */
export async function getStore(): Promise<Store> {
  if (!cached) {
    cached = hasFirebaseCredentials() ? await firestoreStore() : localStore();
  }
  return cached;
}

export function storeMode(): StoreMode {
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
        readFileSync(resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_PATH!), "utf8"),
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

    async listTransactions(limit = 500) {
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
  };
}

// ---------------------------------------------------------------------------
// Local JSON files
// ---------------------------------------------------------------------------

interface LocalShape {
  transactions: StoredTransaction[];
  answers: UserAnswer[];
  proposals: StoredProposal[];
}

const EMPTY: LocalShape = { transactions: [], answers: [], proposals: [] };

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

    async listTransactions(limit = 500) {
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
  };
}
