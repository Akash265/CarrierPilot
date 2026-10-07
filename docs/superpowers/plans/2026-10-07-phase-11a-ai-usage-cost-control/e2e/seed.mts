// Phase 11a E2E seed. Run from apps/web with tsx:
//   ../../services/browser-worker/node_modules/.bin/tsx <this file> [wipe]
// Seeds the synthetic user ...000000000b06 in career_intel_test: a confirmed career goal with constraints, a
// candidate profile with one resume bullet, and one open "Data Engineer" job -- enough for "Find Matches" to
// score and explain one job. With "wipe" it only deletes that user's rows (ai_calls included).
import { openAdminDb, wipeMatchingData, insertCareerGoal, insertJob, insertProfile, insertResumeEvidence, wipeResumeEvidence } from "../../../../../apps/web/src/test/jobsDb";

const USER = "00000000-0000-0000-0000-000000000b06";
const admin = await openAdminDb();
await wipeMatchingData(admin, USER);
await wipeResumeEvidence(admin, USER);
await admin`DELETE FROM candidate_profiles WHERE user_id = ${USER}`;
if (process.argv[2] !== "wipe") {
  const goal = await insertCareerGoal(admin, USER);
  await admin`
    INSERT INTO career_goal_constraints (user_id, career_goal_id, target_roles, skills, work_mode)
    VALUES (${USER}, ${goal}, ARRAY['Data Engineer'], ARRAY['SQL'], 'any')`;
  await insertProfile(admin, USER);
  await insertResumeEvidence(admin, USER);
  const job = await insertJob(admin, USER, { title: "Data Engineer" });
  console.log(JSON.stringify({ seeded: USER, goal, job }));
} else {
  console.log(JSON.stringify({ wiped: USER }));
}
await admin.end();
