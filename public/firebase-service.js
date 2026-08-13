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
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, firebaseProjectId } from "./firebase-config.js";
import { BENCH_PASSWORD, benchAuthEmail } from "./jobs.js";

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
