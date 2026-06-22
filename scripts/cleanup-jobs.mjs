// One-off maintenance: list (and optionally delete) saved jobs on or after a
// cutoff day. Runs in GitHub Actions with the Firebase service account, which
// has admin access and bypasses Firestore security rules.
//
// Env:
//   GOOGLE_APPLICATION_CREDENTIALS - path to the service-account JSON
//   CUTOFF_DAYKEY                  - inclusive cutoff, e.g. "2026-06-15"
//   DRY_RUN                        - "true" to only report, "false" to delete
import { readFileSync } from "node:fs";
import admin from "firebase-admin";

const cutoff = process.env.CUTOFF_DAYKEY || "2026-06-15";
const dryRun = process.env.DRY_RUN !== "false";

const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const serviceAccount = JSON.parse(readFileSync(credentialsPath, "utf8"));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

function jobDayKey(data) {
  if (typeof data.dayKey === "string" && data.dayKey) {
    return data.dayKey;
  }
  if (typeof data.endedAt === "string" && data.endedAt) {
    return data.endedAt.slice(0, 10);
  }
  return "";
}

const snapshot = await db.collection("jobs").get();
const matches = [];

snapshot.forEach((doc) => {
  const data = doc.data();
  const dayKey = jobDayKey(data);
  if (dayKey && dayKey >= cutoff) {
    matches.push({
      id: doc.id,
      dayKey,
      jobType: data.jobType || "?",
      who: data.assignedToLabel || "(no worker)",
      units: data.totalUnits ?? "?"
    });
  }
});

matches.sort((a, b) => a.dayKey.localeCompare(b.dayKey));

console.log(`Total jobs in collection: ${snapshot.size}`);
console.log(`Jobs on or after ${cutoff}: ${matches.length}`);
matches.forEach((job) => {
  console.log(` - ${job.dayKey} | ${job.jobType} | ${job.who} | ${job.units}`);
});

if (dryRun) {
  console.log("\nDRY RUN — nothing was deleted. Re-run with DRY_RUN=false to delete.");
  process.exit(0);
}

if (matches.length === 0) {
  console.log("Nothing to delete.");
  process.exit(0);
}

let batch = db.batch();
let pending = 0;
for (const job of matches) {
  batch.delete(db.collection("jobs").doc(job.id));
  pending += 1;
  if (pending === 400) {
    await batch.commit();
    batch = db.batch();
    pending = 0;
  }
}
if (pending > 0) {
  await batch.commit();
}

console.log(`\nDeleted ${matches.length} jobs on or after ${cutoff}.`);
