import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  addDoc,
  collection,
  getDocs,
  getFirestore,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { firebaseConfig, firebaseProjectId } from "./firebase-config.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

export async function saveJobRecord(job) {
  const docRef = await addDoc(collection(db, "jobs"), {
    ...job,
    createdAt: serverTimestamp()
  });

  return {
    id: docRef.id,
    ...job
  };
}

export async function loadJobRecords() {
  const snapshot = await getDocs(collection(db, "jobs"));

  return snapshot.docs.map((docSnapshot) => ({
    id: docSnapshot.id,
    ...docSnapshot.data()
  }));
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
