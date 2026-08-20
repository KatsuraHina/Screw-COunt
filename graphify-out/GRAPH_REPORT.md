# Graph Report - Screw COunt  (2026-08-20)

## Corpus Check
- Corpus is ~11,572 words - fits in a single context window. You may not need a graph.

## Summary
- 212 nodes · 530 edges · 9 communities
- Extraction: 93% EXTRACTED · 7% INFERRED · 0% AMBIGUOUS · INFERRED: 38 edges (avg confidence: 0.88)
- Token cost: 74,503 input · 0 output

## Community Hubs (Navigation)
- App Shell & State Orchestration
- Job Domain & Time Math
- Page Markup & CI Deployment
- Draft Entry & Smart Time Input
- History Aggregation & Charts
- Firebase Auth & Login
- PDF Cut-List Parsing
- NPM Manifest & Deploy Scripts
- Firestore Job Cleanup Script

## God Nodes (most connected - your core abstractions)
1. `getActiveDraft()` - 22 edges
2. `renderApp()` - 17 edges
3. `bindEvents()` - 17 edges
4. `createPendingJob()` - 13 edges
5. `renderCalculatorSection()` - 12 edges
6. `renderImportSection()` - 12 edges
7. `renderHistorySection()` - 11 edges
8. `handleImportFile()` - 11 edges
9. `renderWorkerHistory()` - 11 edges
10. `saveJob()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `node scripts/cleanup-jobs.mjs invocation` --shares_data_with--> `Job history panel with daily total and rate charts`  [INFERRED]
  .github/workflows/cleanup-jobs.yml → public/index.html
- `node scripts/cleanup-jobs.mjs invocation` --shares_data_with--> `Worker history dashboard (per-worker, per-bench charts)`  [INFERRED]
  .github/workflows/cleanup-jobs.yml → public/index.html
- `firebase deploy --only hosting,firestore:rules (project bbs-count-2)` --shares_data_with--> `Screw Count Calculator page shell`  [INFERRED]
  .github/workflows/deploy.yml → public/index.html
- `firebase deploy --only hosting,firestore:rules (project bbs-count-2)` --shares_data_with--> `Log In | Screw Count Calculator page`  [INFERRED]
  .github/workflows/deploy.yml → public/login.html
- `loadSavedJobs()` --indirect_call--> `normalizeJob()`  [INFERRED]
  public/app.js → public/jobs.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Firebase service-account credential flow in CI** — _github_workflows_deploy_deploy, _github_workflows_deploy_service_account_credential_handling, _github_workflows_cleanup_jobs_cleanup, _github_workflows_cleanup_jobs_service_account_credential_handling [INFERRED 0.85]
- **Account-scoped authentication flow across pages** — public_login_auth_form, public_login_login_js_entry, public_login_account_scoped_data, public_index_signed_in_panel [EXTRACTED 1.00]
- **Job entry to analytics pipeline** — public_index_worker_picker, public_index_bench_number_select, public_index_truss_import, public_index_summary_panel, public_index_job_history_panel, public_index_worker_history_panel [INFERRED 0.85]

## Communities (9 total, 0 thin omitted)

### Community 0 - "App Shell & State Orchestration"
Cohesion: 0.09
Nodes (51): addEntry(), addWorker(), elements, formatAddedAmount(), getActiveConfig(), getHistoryJobs(), handleAuthChanged(), handleLogout() (+43 more)

### Community 1 - "Job Domain & Time Math"
Cohesion: 0.09
Nodes (37): createPendingJob(), getBreakMinutes(), getCalculatorViewModel(), getStrapMinutes(), getTickedImportMetres(), meridiemNowContext(), resolveAssignedWorkers(), ADMIN_EMAIL (+29 more)

### Community 2 - "Page Markup & CI Deployment"
Cohesion: 0.09
Nodes (30): Cleanup jobs workflow (cleanup job), node scripts/cleanup-jobs.mjs invocation, Dry-run-by-default destructive maintenance, Ephemeral Firebase service-account credential handling (cleanup), Single-flight firebase-deploy concurrency group, Deploy to Firebase workflow (deploy job), firebase deploy --only hosting,firestore:rules (project bbs-count-2), Ephemeral Firebase service-account credential handling (deploy) (+22 more)

### Community 3 - "Draft Entry & Smart Time Input"
Cohesion: 0.19
Nodes (25): applySmartTimeInput(), bindEvents(), clearImport(), getActiveDraft(), getCombinedEntries(), getImportConfig(), getTickedImportEntries(), handleImportFile() (+17 more)

### Community 4 - "History Aggregation & Charts"
Cohesion: 0.14
Nodes (23): aggregateBenchTotals(), aggregateHistorySeriesByDay(), aggregateShiftSeriesByDay(), formatDateLabel(), formatMinutes(), getShiftDayKey(), getWorkerCount(), summarizeWorkerJobs() (+15 more)

### Community 5 - "Firebase Auth & Login"
Cohesion: 0.21
Nodes (17): firebaseConfig, firebaseProjectId, auth, createAccount(), db, firebaseApp, formatAuthError(), loginWithEmail() (+9 more)

### Community 6 - "PDF Cut-List Parsing"
Cohesion: 0.42
Nodes (8): detectJobTypeFromName(), detectJobTypeFromText(), groupIntoRows(), isHeaderRow(), loadPdfjs(), parseCutListPdf(), parseDataRow(), rowText()

### Community 7 - "NPM Manifest & Deploy Scripts"
Cohesion: 0.25
Nodes (7): firebase, dependencies, firebase, scripts, deploy:firestore, deploy:hosting, deploy:rules

### Community 8 - "Firestore Job Cleanup Script"
Cohesion: 0.33
Nodes (4): batch, db, matches, serviceAccount

## Ambiguous Edges - Review These
- `Work Details entry form` → `Email/password log in and create account form`  [AMBIGUOUS]
  public/index.html · relation: conceptually_related_to

## Knowledge Gaps
- **30 isolated node(s):** `deploy:firestore`, `deploy:rules`, `deploy:hosting`, `firebase`, `elements` (+25 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Work Details entry form` and `Email/password log in and create account form`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `subscribeToAuthChanges()` connect `Firebase Auth & Login` to `App Shell & State Orchestration`?**
  _High betweenness centrality (0.032) - this node is a cross-community bridge._
- **Why does `parseCutListPdf()` connect `PDF Cut-List Parsing` to `App Shell & State Orchestration`, `Draft Entry & Smart Time Input`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `renderWorkerHistory()` connect `History Aggregation & Charts` to `App Shell & State Orchestration`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `bindEvents()` (e.g. with `addEntry()` and `addWorker()`) actually correct?**
  _`bindEvents()` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `deploy:firestore`, `deploy:rules`, `deploy:hosting` to the rest of the system?**
  _30 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `App Shell & State Orchestration` be split into smaller, more focused modules?**
  _Cohesion score 0.08974358974358974 - nodes in this community are weakly interconnected._