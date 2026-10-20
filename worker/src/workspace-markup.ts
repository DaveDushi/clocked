// Signed-in workspace: Timesheets and Stats pages, plus its dialogs. Settings keeps
// the existing device, privacy, delivery, working-hours and inactivity controls and
// their element ids, so their established handlers still drive them.
const SETTINGS_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.8v2.4M12 18.8v2.4M4.2 7.5l2.1 1.2M17.7 15.3l2.1 1.2M4.2 16.5l2.1-1.2M17.7 8.7l2.1-1.2M7 12a5 5 0 1 0 10 0 5 5 0 0 0-10 0"/></svg>`;

export const WORKSPACE_MARKUP = /* html */ `
<div id="workspace" class="ws hidden">
  <header class="ws-header">
    <div class="ws-brand">
      <div class="logo" aria-hidden="true"></div>
      <div class="wordmark">clocked<small>.</small></div>
      <span id="wsName" class="ws-name"></span>
    </div>
    <div class="ws-actions">
      <button id="wsSettings" class="text-button" type="button" aria-haspopup="dialog">${SETTINGS_ICON}<span class="settings-label">Settings</span></button>
      <button id="wsAccount" class="ws-avatar" type="button" aria-haspopup="dialog" aria-label="Your account"></button>
    </div>
  </header>
  <nav class="ws-nav" aria-label="Workspace pages">
    <button type="button" data-page="timesheets">Timesheets</button>
    <button type="button" data-page="stats">Stats</button>
  </nav>
  <main id="wsMain" class="ws-main" tabindex="-1"></main>

  <dialog id="dlgDay" aria-labelledby="dlgDayTitle"><div class="ws-dialog" id="dlgDayBody"></div></dialog>
  <dialog id="dlgEdit" aria-labelledby="dlgEditTitle"><div class="ws-dialog" id="dlgEditBody"></div></dialog>
  <dialog id="dlgSheet" class="ws-sheet" aria-labelledby="dlgSheetTitle"><div class="ws-dialog sheet" id="dlgSheetBody"></div></dialog>
  <dialog id="dlgSend" aria-labelledby="dlgSendTitle"><div class="ws-dialog wide" id="dlgSendBody"></div></dialog>
  <dialog id="dlgPreview" aria-labelledby="dlgPreviewTitle"><div class="ws-dialog wide" id="dlgPreviewBody"></div></dialog>
  <dialog id="dlgAccount" aria-labelledby="dlgAccountTitle"><div class="ws-dialog" id="dlgAccountBody"></div></dialog>
  <dialog id="dlgMember" aria-labelledby="dlgMemberTitle">
    <div class="ws-dialog ws-settings">
      <div class="ws-dialog-head"><h2 id="dlgMemberTitle">Member</h2><button type="button" class="text-button" data-close aria-label="Close">&times;</button></div>
      <p id="memberSettingsSub" class="sub"></p>
      <details open><summary><span>Working hours<small id="memberHoursSummary">Team default unless you set hours for this person</small></span></summary><div class="body" id="memberHoursSlot"></div></details>
      <details id="memberRemoveSection"><summary><span>Remove from team<small>They keep their account and recorded time</small></span></summary>
        <div class="body"><p class="hint">Removing someone stops their timesheets from appearing here and in team delivery.</p>
          <button type="button" id="memberRemove" class="danger">Remove from team</button><div id="memberRemoveMsg" class="ws-feedback" role="status"></div></div></details>
    </div>
  </dialog>
  <dialog id="dlgInvite" aria-labelledby="dlgInviteTitle">
    <div class="ws-dialog">
      <div class="ws-dialog-head"><h2 id="dlgInviteTitle">Invite member</h2><button type="button" class="text-button" data-close aria-label="Close">&times;</button></div>
      <form id="inviteForm">
        <label for="inviteEmail">Email</label>
        <input id="inviteEmail" type="email" placeholder="name@company.com" required autocomplete="off" />
        <label for="inviteRole">Role</label>
        <select id="inviteRole"><option value="member">Worker</option><option value="admin">Manager</option></select>
        <p class="sub" style="margin-top:10px">Workers see only their own hours. Managers can review and adjust everyone's hours.</p>
        <div id="inviteMsg" class="ws-feedback" role="status"></div>
        <div id="inviteLinkBox" class="invitelink hidden">
          <input id="inviteLink" type="text" readonly aria-label="Invite link" />
          <button id="copyInvite" type="button">Copy invite link</button>
        </div>
        <div class="ws-actions-row"><button type="button" data-close>Close</button><button id="inviteBtn" class="primary" type="submit">Send invitation</button></div>
      </form>
      <h3 style="margin-top:24px">Pending invitations</h3>
      <div id="pendingInvites" class="ws-pending"></div>
    </div>
  </dialog>

  <dialog id="dlgSettings" aria-labelledby="dlgSettingsTitle">
    <div class="ws-dialog wide ws-settings">
      <div class="ws-dialog-head"><h2 id="dlgSettingsTitle">Settings</h2><button type="button" class="text-button" data-close aria-label="Close">&times;</button></div>

      <details id="setDelivery">
        <summary><span id="emailTitle">Timesheet delivery</span></summary>
        <div class="body">
          <p class="hint" id="emailHint"></p>
          <div id="emailReadonly" class="hidden"></div>
          <div id="emailEdit">
            <div id="recipients" class="recipients"></div>
            <div class="schedule">
              <label class="check"><input type="checkbox" id="autoSend"> Email automatically each month</label>
              <div id="sendDayWrap" class="sendday">
                <span>Send on the</span>
                <select id="sendDay" aria-label="Day of month"></select>
                <span>at</span>
                <input id="sendTime" type="time" step="60" aria-label="Delivery time" />
                <span>in</span>
                <input id="sendTimezone" type="text" list="sendTimezones" maxlength="100" placeholder="Timezone" aria-label="Delivery timezone" autocomplete="off" />
                <datalist id="sendTimezones"></datalist>
              </div>
            </div>
            <div class="ws-actions-row split">
              <button id="addRecipient" type="button">+ Recipient</button>
              <button id="saveEmail" class="primary" type="button">Save delivery</button>
            </div>
          </div>
          <div id="emailMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setWorkingHours" class="hidden">
        <summary><span>Default working hours<small>Team default, or override it for one person from their timesheet</small></span></summary>
        <div class="body" id="teamHoursSlot">
          <div id="workingHoursEditor">
            <p class="hint">Hours use each computer's local time and control the after-hours prompt. They do not stop tracking at shift end. Updated desktop apps apply changes on their next sync.</p>
            <div id="hoursTargetField"><label for="hoursTarget">Schedule for</label>
            <select id="hoursTarget"><option value="">Team default</option></select></div>
            <label for="hoursMode">Working-hours policy</label>
            <select id="hoursMode" disabled>
              <option value="inherit">Use personal settings</option>
              <option value="scheduled">Set working hours</option>
              <option value="disabled">Turn off the after-hours prompt</option>
            </select>
            <fieldset id="hoursFields" disabled style="border:0;padding:0;margin:12px 0">
              <div class="row">
                <div><label for="hoursStart">Shift starts</label><input id="hoursStart" type="time" step="60" value="09:00" /></div>
                <div><label for="hoursEnd">Shift ends</label><input id="hoursEnd" type="time" step="60" value="17:00" /></div>
              </div>
              <div id="hoursDays" style="display:flex;flex-wrap:wrap;gap:12px;margin-top:12px" role="group" aria-label="Shift start days"></div>
              <p class="hint">Choose the days a shift starts. For overnight hours, Friday 22:00 to 06:00 includes Saturday morning.</p>
            </fieldset>
            <button id="saveWorkingHours" class="primary" type="button" disabled>Save working hours</button>
            <div id="workingHoursMsg" class="msg" role="status"></div>
          </div>
        </div>
      </details>

      <details id="setInactivity" class="hidden">
        <summary><span>Inactivity limit<small id="inactivitySummary">Loading team policy</small></span></summary>
        <div class="body">
          <p class="hint">Apply one inactivity limit to everyone on this team so idle gaps mean the same thing on every computer. Updated desktop apps apply it on their next sync and keep it while offline. Clock-out time is backdated to the last input. Calls suppress the warning and delay clock-out.</p>
          <label for="inactivityMode">Team inactivity policy</label>
          <select id="inactivityMode" disabled>
            <option value="personal">Use personal desktop settings</option>
            <option value="team">Set team limit and warning</option>
          </select>
          <fieldset id="inactivityFields" disabled style="border:0;padding:0;margin:12px 0">
            <div class="row">
              <div><label for="inactivityLimit">Clock out after idle minutes</label><input id="inactivityLimit" type="number" min="1" max="1440" step="1" value="15" required /></div>
              <div><label for="inactivityWarning">Warn minutes before clock-out</label><input id="inactivityWarning" type="number" min="0" max="1439" step="1" value="2" required /></div>
            </div>
            <p class="hint">The warning must be shorter than the limit. Set it to 0 to turn off the warning.</p>
          </fieldset>
          <p class="hint">Changes apply going forward. Recorded sessions do not store the limit that was in effect, so earlier idle gaps may reflect each computer's own setting.</p>
          <button id="saveInactivity" class="primary" type="button" disabled>Save inactivity policy</button>
          <div id="inactivityMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setMyHours">
        <summary><span>Working hours<small>The after-hours prompt on your computers</small></span></summary>
        <div class="body"><p id="workingHoursSummary" class="hint" role="status"></p></div>
      </details>

      <details id="setDesktop">
        <summary><span>Desktop app and devices<small>Connect the tray or menu-bar app</small></span></summary>
        <div class="body">
          <div id="verifyBanner" class="msg err hidden" role="status">
            Verify your email to create a sync token.
            <button id="resendVerify" type="button" style="margin-left:8px">Resend</button>
          </div>
          <div class="setupbox">
            <a class="btn" href="/download/mac">Download for macOS</a>
            <a class="btn" href="/download/win">Download for Windows</a>
            <a class="btn" href="/download/extension">Chrome extension</a>
          </div>
          <p class="hint">Install the tray app, add a token for this device, and paste it into the app's Settings. The browser extension on that computer uses the same device token.</p>
          <label>Newly created token</label>
          <div class="tokenbox">
            <div id="token" class="token" title="Your Bearer token">&middot;&middot;&middot;&middot;&middot;&middot;&middot;&middot;</div>
            <button id="copyToken" type="button" disabled>Copy</button>
          </div>
          <p class="token-help">Shown in full only once. Treat it like a password: it can sync sessions and open your dashboard from the tray app.</p>
          <div class="token-create">
            <input id="tokenName" type="text" maxlength="64" placeholder="Device name, e.g. Personal laptop" autocomplete="off" aria-label="Device name" />
            <button id="mintToken" class="primary" type="button">Add device</button>
          </div>
          <div id="tokenList" class="token-list" aria-label="Connected devices"></div>
          <div id="tokenMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setPrivacy">
        <summary><span>Privacy<small>Export or delete your cloud data</small></span></summary>
        <div class="body">
          <p class="hint">Download a copy of your cloud sessions and project totals, or erase them from this host.</p>
          <div class="inline-actions">
            <button id="exportData" type="button">Export my data</button>
            <button id="deleteData" class="danger" type="button">Delete cloud data</button>
          </div>
          <div id="privacyMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setTeamCreate" class="hidden">
        <summary><span>Start a team<small>Invite people and review their hours in one place</small></span></summary>
        <div class="body">
          <p class="hint">Free for up to 50 members. Your own timesheet moves into the team.</p>
          <label for="teamCreateName">Team name</label>
          <input id="teamCreateName" type="text" placeholder="Acme Inc." autocomplete="organization" maxlength="80" />
          <div class="ws-actions-row"><button type="button" id="teamCreateBtn" class="primary">Create team</button></div>
          <div id="teamCreateMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setOperator" class="hidden">
        <summary><span>Invitations<small>Invite individuals and new team managers</small></span></summary>
        <div class="body" id="operatorSlot"></div>
      </details>

      <div id="setPlan" class="ws-plan hidden"><span>Team plan</span><small id="planSummary"></small></div>
    </div>
  </dialog>
</div>`;
