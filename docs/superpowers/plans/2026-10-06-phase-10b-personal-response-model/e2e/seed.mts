// Phase 10b E2E seed (Task 10). Run from apps/web with tsx:
//   ../../services/browser-worker/node_modules/.bin/tsx ../../docs/superpowers/plans/2026-10-06-phase-10b-personal-response-model/e2e/seed.mts [wipe]
// Seeds the synthetic user ...000000000a08 in career_intel_test: 40 decided applications whose responses follow the
// skills factor (the response model becomes active) plus two eligible matches -- weak skills / overall 80 and strong
// skills / overall 75. With "wipe" it only deletes that user's rows.
import { openAdminDb, wipeMatchingData, insertModelHistory, insertCareerGoal, insertJob, insertMatch } from "../../../../../apps/web/src/test/jobsDb";

const USER = "00000000-0000-0000-0000-000000000a08";
const admin = await openAdminDb();
await wipeMatchingData(admin, USER);
if (process.argv[2] !== "wipe") {
  await insertModelHistory(admin, USER, 40);
  const goal = await insertCareerGoal(admin, USER);
  const weak = await insertJob(admin, USER, { title: "Weak Skills Role" });
  const strong = await insertJob(admin, USER, { title: "Strong Skills Role" });
  await insertMatch(admin, USER, weak, goal, { overallScore: 80, skillsScore: 0.1 });
  await insertMatch(admin, USER, strong, goal, { overallScore: 75, skillsScore: 0.95 });
  console.log(JSON.stringify({ seeded: USER, weak, strong }));
} else {
  console.log(JSON.stringify({ wiped: USER }));
}
await admin.end();
