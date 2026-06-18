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
  getDocs,
  getFirestore,
  query,
  serverTimestamp,
  where
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, firebaseProjectId } from "./firebase-config.js";

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

export async function loadJobRecords(user) {
  const jobsQuery = query(collection(db, "jobs"), where("userId", "==", user.uid));
  const snapshot = await getDocs(jobsQuery);

  return snapshot.docs.map((docSnapshot) => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
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

export async function loadWorkerRecords(user) {
  const workersQuery = query(collection(db, "workers"), where("userId", "==", user.uid));
  const snapshot = await getDocs(workersQuery);

  return snapshot.docs.map((docSnapshot) => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
}

export async function deleteWorkerRecord(workerId) {
  await deleteDoc(doc(db, "workers", workerId));
}

export async function addPairRecord(pair, user) {
  const docRef = await addDoc(collection(db, "workerPairs"), {
    ...pair,
    userId: user.uid,
    userEmail: user.email ?? "",
    createdAt: serverTimestamp()
  });

  return { id: docRef.id, ...pair };
}

export async function loadPairRecords(user) {
  const pairsQuery = query(collection(db, "workerPairs"), where("userId", "==", user.uid));
  const snapshot = await getDocs(pairsQuery);

  return snapshot.docs.map((docSnapshot) => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
}

export async function deletePairRecord(pairId) {
  await deleteDoc(doc(db, "workerPairs", pairId));
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
    return "The email or password is incorrect.";
  }

  if (errorCode === "invalid-email") {
    return "Enter a valid email address.";
  }

  if (errorCode === "email-already-in-use") {
    return "That email already has an account. Try logging in instead.";
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
