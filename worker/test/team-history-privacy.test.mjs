import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTimesheet } from "../.tmp-test/report.js";
import { getTeamSessionScope, getEffectiveSessionScope } from "../.tmp-test/team-scope.js";
import { handleManualSession } from "../.tmp-test/manual-session.js";
import { buildTeamOverview, sendTeamTimesheets } from "../.tmp-test/team-overview.js";
import { buildAndSendReport, sendMonthlyReports } from "../.tmp-test/email.js";
import { testDatabase } from "./helpers/database.mjs";

function fixture(t) {
  const { DB, sqlite } = testDatabase();
  t.after(() => sqlite.close());
  sqlite.exec(`INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt) VALUES
    ('worker','Worker','worker@example.test',1,1,1), ('boss','Boss','boss@example.test',1,1,1), ('outsider','Outsider','outsider@example.test',1,1,1);
    INSERT INTO organization (id,name,slug,metadata,createdAt) VALUES
    ('legacy','Personal','personal','{"plan":"single"}',1), ('team','Team','team','{"plan":"team"}',1);
    INSERT INTO member (id,organizationId,userId,role,createdAt) VALUES
    ('legacy-member','legacy','worker','owner',1), ('team-worker','team','worker','member',1790078400000), ('team-boss','team','boss','owner',1);
    INSERT INTO sessions (id,user_id,start_utc,end_utc,timezone) VALUES
    ('private-session','worker','2026-09-01T09:00:00Z','2026-09-01T17:00:00Z','UTC'),
    ('crossing-session','worker','2026-09-22T11:00:00Z','2026-09-22T13:00:00Z','UTC'),
    ('shared-session','worker','2026-09-22T12:00:00Z','2026-09-22T14:00:00Z','UTC'),
    ('later-session','worker','2026-09-23T09:00:00Z','2026-09-23T10:00:00Z','UTC');`);
  // Membership starts 2026-09-22 at noon, midway through a session.
  sqlite.prepare("UPDATE member SET createdAt=? WHERE id='team-worker'").run(Date.parse('2026-09-22T12:00:00Z'));
  sqlite.exec("INSERT INTO activity_day (user_id,day,app,project,secs,updated_at) VALUES ('worker','2026-09-22','editor','Private project',3600,'2026-09-22T14:00:00Z')");
  const messages = [];
  const env = { DB, REPORT_TZ:'UTC', MAIL_FROM:'reports@example.test', EMAIL_PROVIDER:'cloudflare', EMAIL:{async send(message){messages.push(message);return {messageId:'ok'};}} };
  return { env, sqlite, messages };
}

const csvOf = message => Buffer.from(message.attachments[0].content).toString('utf8');
const request = (method,body) => new Request('https://clocked.test/api/team/manual-session',{method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});

test('team hours, CSV and overview omit earlier and crossing sessions while personal history survives', async t => {
  const {env} = fixture(t);
  const scope = await getTeamSessionScope(env,'worker','team');
  assert.deepEqual(scope,{kind:'team',since:'2026-09-22T12:00:00.000Z'});
  const team = await buildTimesheet({env,period:'2026-09',userId:'worker',scope});
  assert.deepEqual(team.sessions.map(s=>s.id),['shared-session','later-session']);
  assert.equal(team.report.totalMinutes,180);
  assert.deepEqual(team.recordedDays.map(d=>[d.date,d.start]),[['2026-09-22','12:00'],['2026-09-23','09:00']]);
  assert.ok(team.report.days.every(d=>d.date >= '2026-09-22'));
  assert.doesNotMatch(team.csv,/September 1,|11:00/);
  assert.deepEqual(team.projects,[]);
  const personal = await buildTimesheet({ scope: { kind: "personal" },env,period:'2026-09',userId:'worker'});
  assert.equal(personal.sessions.length,4);
  assert.deepEqual(personal.projects,[{project:"Private project",minutes:60}]);
  const overview = await buildTeamOverview(env,'team','2026-09','UTC');
  assert.equal(overview.members.find(m=>m.id==='worker').stats.workedMinutes,180);
  assert.deepEqual(await getTeamSessionScope(env,'worker','legacy'),{kind:'personal'});
  assert.equal(await getTeamSessionScope(env,'outsider','team'),null);
});

test('manager cannot delete, replace or add private history by guessing a session id', async t => {
  const {env,sqlite} = fixture(t);
  const scope = await getTeamSessionScope(env,'worker','team');
  async function edit(method,body) { const req=request(method,body); return handleManualSession(req,new URL(req.url),env,'worker','boss','UTC',scope); }
  for (const id of ['private-session','crossing-session']) {
    assert.equal((await edit('DELETE',{id})).status,404);
    assert.equal((await edit('PATCH',{id,date:'2026-09-23',start:'09:00',end:'10:00'})).status,404);
  }
  assert.equal((await edit('POST',{date:'2026-09-22',start:'11:00',end:'13:00'})).status,403);
  assert.equal((await edit('PATCH',{id:'shared-session',date:'2026-09-01',start:'09:00',end:'10:00'})).status,403);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM sessions').get().n,4);
  assert.equal((await edit('DELETE',{id:'shared-session'})).status,200);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE id='private-session'").get().n,1);
});

test('manual and bulk team email attachments use current membership scope and reject outsiders', async t => {
  const {env,messages,sqlite} = fixture(t);
  assert.deepEqual(await getEffectiveSessionScope(env,'worker'),{kind:'team',since:'2026-09-22T12:00:00.000Z'});
  assert.equal((await buildAndSendReport(env,'2026-09',{force:true,userId:'worker',to:['boss@example.test']})).ok,true);
  assert.match(csvOf(messages[0]),/Total,3:00/);
  assert.doesNotMatch(csvOf(messages[0]),/September 1,|11:00|Private project/);
  assert.equal((await sendTeamTimesheets(env,'team','2026-09',['worker'])).ok,true);
  assert.match(csvOf(messages[1]),/Total,3:00/);
  assert.equal((await sendTeamTimesheets(env,'team','2026-09',['outsider'])).ok,false);
  sqlite.exec("DELETE FROM member WHERE id='team-worker'");
  assert.equal((await buildAndSendReport(env,'2026-09',{force:true,userId:'worker',organizationId:'team',to:['boss@example.test']})).ok,false);
  assert.equal(messages.length,2);
});

test('scheduled primary-team delivery excludes history even with an older personal workspace', async t => {
  const {env,messages} = fixture(t);
  await sendMonthlyReports(env,new Date('2026-10-01T06:00:00Z'));
  const workerMessage = messages.find(m=>m.attachments);
  assert.ok(workerMessage);
  assert.match(csvOf(workerMessage),/Total,3:00/);
  assert.doesNotMatch(csvOf(workerMessage),/September 1,|11:00/);
});
