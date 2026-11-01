import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { dashboardResponse } from "../.tmp-test/dashboard.js";
import { createWorkspaceModel } from "../.tmp-test/workspace-model.js";
const html = await dashboardResponse().text();
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const between = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
const makeMember = (id, tracking, recordedDays) => ({id,name:id,email:id+"@example.test",tracking,role:"member",days:[],enteredSessions:0,stats:{recordedDays,workedMinutes:recordedDays*60,breakMinutes:0,breaksPerDay:0,avgBreakMinutes:0}});
function harness(members) {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, {innerHTML:"",textContent:"",listeners:{},addEventListener(type, listener){this.listeners[type]=listener;}}); return elements.get(id); };
  const requests = [];
  const context = { $, document:{querySelectorAll:()=>[]}, ws:{version:1,period:"2026-09",overview:{members},sort:"name",year:2026,policy:undefined}, orgId:"team", wsModel:createWorkspaceModel(), wsEsc:String, wsMembers:()=>members, wsDialogHead:()=>"", wsPeriodNotice:()=>"", wsOpenDialog(){},wsLoadRecipients:async()=>["payroll@example.test"],wsFeedback(){},api:async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return {json:async()=>({results:[],period:"2026-09",recipients:["payroll@example.test"]})};} };
  runInNewContext(between("function wsReportMembers()", "function wsOpenPersonalSend("),context);
  return {context,$,requests};
}
test("report review and submission use only recorded timesheets while retaining nontracking history", async () => {
  const members=[makeMember("tracked","tracking",2),makeMember("past-manager","disabled",3),makeMember("unconnected-history","no_device",1),makeMember("no-history","no_device",0)];
  const h=harness(members);
  h.context.wsOpenSendAll();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(Array.from(h.context.ws.send.selected),["tracked","past-manager","unconnected-history"]);
  assert.equal(h.$("sendCount").textContent,"3 of 3 selected");
  assert.match(h.$("dlgSendBody").innerHTML,/1 member has no recorded time/);
  assert.doesNotMatch(h.$("dlgSendBody").innerHTML,/data-send-member='no-history'/);
  assert.match(h.$("dlgSendBody").innerHTML,/data-send-member='past-manager'/);
  h.$("sendAll").listeners.change({target:{checked:false}});
  assert.equal(h.context.ws.send.selected.size,0);
  assert.equal(h.$("sendConfirm").disabled,true);
  h.$("sendAll").listeners.change({target:{checked:true}});
  assert.equal(h.context.ws.send.selected.size,3);
  await h.context.wsSubmitSendAll({preventDefault(){}});
  assert.deepEqual(h.requests[0].body.userIds,["tracked","past-manager","unconnected-history"]);
});
test("an empty report period has no selected timesheets and cannot send", async () => {
  const h=harness([makeMember("no-history","disabled",0)]);
  h.context.wsOpenSendAll();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.$("sendCount").textContent,"0 of 0 selected");
  assert.equal(h.$("sendConfirm").disabled,true);
  assert.equal(h.$("teamPreviewConfirm").disabled,true);
  assert.match(h.$("dlgSendBody").innerHTML,/No timesheets with recorded time/);
});
test("Stats keeps historical nontracking records and separates nontracking people without records", () => {
  const members=[makeMember("tracked","tracking",1),makeMember("past-manager","disabled",2),makeMember("no-history","no_device",0)];
  const h=harness(members);
  h.context.wsStatsMembers=()=>members;
  h.context.wsPolicyNote=()=>"";
  runInNewContext(between("function wsComparisonHtml()", "function wsPolicyNote()"),h.context);
  const html=h.context.wsComparisonHtml();
  assert.match(html,/data-id='past-manager'/);
  assert.match(html,/Not tracking now: tracking off/);
  assert.doesNotMatch(html,/data-id='no-history'/);
  assert.match(html,/<summary>Not tracking now: 1 member with no recorded time in this view/);
  assert.match(html,/<li>no-history <small>No device connected<\/small><\/li>/);
});
