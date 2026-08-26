import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, firebaseProjectId } from "./firebase-config.js";
import { BENCH_PASSWORD, benchAuthEmail, importClaimId } from "./jobs.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);

export async function createAccount(email, password) {
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function loginWithEmail(email, password) {
  const credential = await signInWithEmailAndPassword(auth, email, password);
  return credential.user;
}

export async function logoutCurrentUser() {
  await signOut(auth);
}

// Sign in as a bench: reuse the bench's shared account, creating it the first
// time it's tapped. Workers never type credentials — the bench is the login.
export async function signInBench(benchNumber) {
  const email = benchAuthEmail(benchNumber);
  try {
    const credential = await signInWithEmailAndPassword(auth, email, BENCH_PASSWORD);
    return credential.user;
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "";
    if (code.includes("user-not-found") || code.includes("invalid-credential")) {
      try {
        const created = await createUserWithEmailAndPassword(auth, email, BENCH_PASSWORD);
        return created.user;
      } catch (createError) {
        // Another device created it first — sign in to the now-existing account.
        if (typeof createError?.code === "string" && createError.code.includes("email-already-in-use")) {
          const retry = await signInWithEmailAndPassword(auth, email, BENCH_PASSWORD);
          return retry.user;
        }
        throw createError;
      }
    }
    throw error;
  }
}

export function subscribeToAuthChanges(callback) {
  return onAuthStateChanged(auth, callback);
}

export async function saveJobRecord(job, user) {
  const docRef = await addDoc(collection(db, "jobs"), {
    ...job,
    userId: user.uid,
    userEmail: user.email ?? "",
    createdAt: serverTimestamp()
  });

  return {
    id: docRef.id,
    ...job,
    userId: user.uid,
    userEmail: user.email ?? ""
  };
}

// Admins load the whole shared pool (no owner filter); everyone else only their
// own jobs. The rules only permit the unfiltered query for admins.
export async function loadJobRecords(user, { all = false } = {}) {
  const jobsCollection = collection(db, "jobs");
  const jobsQuery = all ? jobsCollection : query(jobsCollection, where("userId", "==", user.uid));
  const snapshot = await getDocs(jobsQuery);

  return snapshot.docs.map((docSnapshot) => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
}

export async function deleteJobRecord(jobId) {
  await deleteDoc(doc(db, "jobs", jobId));
}

export async function setJobHiddenRecord(jobId, hidden) {
  await updateDoc(doc(db, "jobs", jobId), { hidden });
}

// Overwrites a job's editable fields (times, amounts, crew, etc.) in place.
// Fields not present in `job` (e.g. hidden, userId, createdAt) are left as-is.
export async function updateJobRecord(jobId, job) {
  await updateDoc(doc(db, "jobs", jobId), job);
}

export async function addWorkerRecord(name, user) {
  const docRef = await addDoc(collection(db, "workers"), {
    name,
    userId: user.uid,
    userEmail: user.email ?? "",
    createdAt: serverTimestamp()
  });

  return { id: docRef.id, name };
}

export async function loadWorkerRecords(user, { all = false } = {}) {
  const workersCollection = collection(db, "workers");
  const workersQuery = all
    ? workersCollection
    : query(workersCollection, where("userId", "==", user.uid));
  const snapshot = await getDocs(workersQuery);

  return snapshot.docs.map((docSnapshot) => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
}

export async function deleteWorkerRecord(workerId) {
  await deleteDoc(doc(db, "workers", workerId));
}

// --- Shared import claims (live ticking across benches) ---
//
// When two benches load the same cut list, a ticked row is "claimed" by one
// document per row. The rules make `create` the only way to take a free row, so
// Firestore decides the winner if both benches tick at the same moment — the
// loser gets permission-denied and we tell them who has it.

// Thrown when the row was already taken, so the caller can show who has it
// rather than a raw Firestore error.
export class RowAlreadyClaimedError extends Error {
  constructor() {
    super("That one is already ticked by another bench.");
    this.name = "RowAlreadyClaimedError";
  }
}

export async function claimImportRow(jobKey, row, user, label) {
  const claimId = importClaimId(jobKey, row.no);
  try {
    await setDoc(
      doc(db, "importClaims", claimId),
      {
        jobKey,
        no: row.no,
        number: row.number ?? "",
        by: user.uid,
        byLabel: label,
        // A plain number (not serverTimestamp) so the rules can compare it when
        // deciding whether an abandoned claim may be taken over.
        at: Date.now()
      },
      // merge:false — this must land as a create so an existing claim rejects it.
      { merge: false }
    );
  } catch (error) {
    if (error?.code === "permission-denied") {
      throw new RowAlreadyClaimedError();
    }
    throw error;
  }
}

// Untick: only the bench that claimed the row may release it.
export async function releaseImportRow(jobKey, rowNo) {
  await deleteDoc(doc(db, "importClaims", importClaimId(jobKey, rowNo)));
}

// Once the job holding these rows is saved, the rows are finished: mark each
// claim logged. A logged row stays ticked and locked for every bench — its work
// is already recorded against a job, so it must not be counted or logged twice —
// but it no longer belongs to anyone's job in progress.
export async function markImportRowsLogged(jobKey, rows, user, label) {
  await Promise.all(
    rows.map(async (row) => {
      try {
        await setDoc(
          doc(db, "importClaims", importClaimId(jobKey, row.no)),
          {
            jobKey,
            no: row.no,
            number: row.number ?? "",
            by: user.uid,
            byLabel: label,
            at: Date.now(),
            logged: true
          },
          { merge: false }
        );
      } catch (error) {
        // Already logged by whoever owns it, or the row was never claimed
        // (offline tick). Neither should fail the save that just happened.
        if (error?.code !== "permission-denied") {
          throw error;
        }
      }
    })
  );
}

// Live claims for one shared list. Calls back with { [rowNo]: claim } on every
// change, so a tick on one bench shows up on the other without a refresh.
// Returns the unsubscribe function.
export function subscribeToImportClaims(jobKey, onChange, onError) {
  const claimsQuery = query(collection(db, "importClaims"), where("jobKey", "==", jobKey));
  return onSnapshot(
    claimsQuery,
    (snapshot) => {
      const claims = {};
      snapshot.docs.forEach((docSnapshot) => {
        const data = docSnapshot.data();
        claims[String(data.no)] = data;
      });
      onChange(claims);
    },
    (error) => {
      console.error(error);
      if (onError) {
        onError(error);
      }
    }
  );
}

// --- Admin roster (the `admins` collection, keyed by lowercased email) ---

function adminEmailKey(email) {
  return String(email).trim().toLowerCase();
}

// Whether a specific email is currently granted admin via the roster. Each user
// is allowed to read their own admin doc, so this works before we know they're
// an admin.
export async function isEmailAdmin(email) {
  const key = adminEmailKey(email);
  if (!key) {
    return false;
  }
  const snapshot = await getDoc(doc(db, "admins", key));
  return snapshot.exists();
}

// The full admin roster — admin-only (the rules block a non-admin list).
export async function loadAdminRecords() {
  const snapshot = await getDocs(collection(db, "admins"));
  return snapshot.docs.map((docSnapshot) => ({
    email: docSnapshot.data().email ?? docSnapshot.id,
    ...docSnapshot.data()
  }));
}

export async function addAdminRecord(email, user) {
  const key = adminEmailKey(email);
  await setDoc(doc(db, "admins", key), {
    email: key,
    addedBy: user?.email ?? "",
    addedAt: serverTimestamp()
  });
  return { email: key };
}

export async function removeAdminRecord(email) {
  await deleteDoc(doc(db, "admins", adminEmailKey(email)));
}

export function formatFirestoreError(error) {
  const errorCode = typeof error?.code === "string" ? error.code.replace("firestore/", "") : "";

  if (errorCode === "permission-denied") {
    return "Firestore blocked the request. Deploy the new rules first, or check that the `jobs` collection allows create/read.";
  }

  if (errorCode === "failed-precondition") {
    return `Firestore is not fully set up yet. Create the database in Firebase Console and make sure Firestore is enabled for project \`${firebaseProjectId}\`.`;
  }

  if (errorCode === "unavailable") {
    return "Firestore is currently unavailable. Check your internet connection and try again.";
  }

  if (errorCode) {
    return `Firestore error: ${errorCode}.`;
  }

  if (error?.message) {
    return `Firestore error: ${error.message}`;
  }

  return "Could not connect to Firestore.";
}

export function formatAuthError(error) {
  const errorCode = typeof error?.code === "string" ? error.code.replace("auth/", "") : "";

  if (errorCode === "invalid-credential" || errorCode === "wrong-password" || errorCode === "user-not-found") {
    return "The username or password is incorrect.";
  }

  if (errorCode === "invalid-email") {
    return "Enter a valid username.";
  }

  if (errorCode === "email-already-in-use") {
    return "That username is already taken. Try logging in instead.";
  }

  if (errorCode === "weak-password") {
    return "Choose a stronger password with at least 6 characters.";
  }

  if (errorCode === "too-many-requests") {
    return "Too many attempts were made just now. Wait a moment and try again.";
  }

  if (errorCode === "operation-not-allowed") {
    return "Email/password sign-in is not enabled in Firebase Console yet.";
  }

  if (errorCode) {
    return `Authentication error: ${errorCode}.`;
  }

  if (error?.message) {
    return `Authentication error: ${error.message}`;
  }

  return "Authentication failed.";
}
