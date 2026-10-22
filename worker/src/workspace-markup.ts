// Signed-in workspace: Timesheets and Stats pages, plus its dialogs. Settings keeps
// the existing device, privacy, delivery, working-hours and inactivity controls and
// their element ids, so their established handlers still drive them.
const SETTINGS_ICON = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.5 3-.5 2a7.5 7.5 0 0 0-1.8 1L5.3 5.5 3 9.5 4.5 11a7.5 7.5 0 0 0 0 2L3 14.5l2.3 4 1.9-.5A7.5 7.5 0 0 0 9 19l.5 2h5l.5-2a7.5 7.5 0 0 0 1.8-1l1.9.5 2.3-4-1.5-1.5a7.5 7.5 0 0 0 0-2L21 9.5l-2.3-4-1.9.5A7.5 7.5 0 0 0 15 5l-.5-2z"/><circle cx="12" cy="12" r="3"/></svg>`;

export const WORKSPACE_MARKUP = /* html */ `
<div id="workspace" class="ws hidden">
  <header class="ws-header">
    <div class="ws-brand">
      <div class="logo" aria-hidden="true"></div>
      <div class="wordmark">clocked<small>.</small></div>
      <span id="wsName" class="ws-name"></span>
    </div>
    <label id="wsTeamSwitch" class="ws-team-switch hidden"><span class="sr-only">Team workspace</span><select id="wsTeam" aria-label="Team workspace"></select></label>
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
        <p class="sub" style="margin-top:10px">Workers see only their own hours. Managers can review and adjust everyone's hours without installing the desktop app or tracking their own time.</p>
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

      <div class="ws-settings-tabs" role="tablist" aria-label="Settings scope">
        <button id="settingsPersonalTab" type="button" role="tab" aria-controls="settingsPersonalPanel" aria-selected="true">Personal settings</button>
        <button id="settingsTeamTab" class="hidden" hidden type="button" role="tab" aria-controls="settingsTeamPanel" aria-selected="false" tabindex="-1">Team settings</button>
      </div>
      <div id="settingsPersonalPanel" role="tabpanel" aria-labelledby="settingsPersonalTab"><div id="personalDeliverySlot"></div></div>
      <div id="settingsTeamPanel" role="tabpanel" aria-labelledby="settingsTeamTab" hidden><div id="teamDeliverySlot"></div></div>
      <details id="setDelivery">
        <summary><span id="emailTitle">Timesheet delivery</span></summary>
        <div class="body">
          <p class="hint ws-settings-explainer" id="emailHint"></p>
          <div id="emailReadonly" class="hidden"></div>
          <div id="emailEdit">
            <div id="recipients" class="recipients"></div>
            <div class="schedule">
              <label class="check"><input type="checkbox" id="autoSend"> Email automatically each month</label>
              <div id="sendDayWrap" class="sendday">
                <div class="ws-settings-field"><label for="sendDay">Day of month</label><select id="sendDay" aria-label="Day of month"></select></div>
                <div class="ws-settings-field"><label for="sendTime">Delivery time</label><input id="sendTime" type="time" step="60" aria-label="Delivery time" /></div>
                <div class="ws-settings-field"><label for="sendTimezone">Timezone</label><input id="sendTimezone" type="text" list="sendTimezones" maxlength="100" placeholder="Timezone" aria-label="Delivery timezone" autocomplete="off" /></div>
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
        <summary><span>Default working hours</span></summary>
        <div class="body" id="teamHoursSlot">
          <div id="workingHoursEditor">
            <div id="hoursTargetField"><label for="hoursTarget">Schedule for</label>
            <select id="hoursTarget"><option value="">Team default</option></select></div>
            <div class="ws-settings-field"><div class="ws-settings-label"><label for="hoursMode">Working-hours policy</label><span class="ws-settings-help"><button type="button" aria-label="About working hours" aria-describedby="hoursHelp">?</button><span id="hoursHelp" role="tooltip">Uses each computer's local time. Overnight shifts belong to the day they start.</span></span></div>
            <select id="hoursMode" disabled>
              <option value="inherit">Use personal settings</option>
              <option value="scheduled">Set working hours</option>
              <option value="disabled">Turn off the after-hours prompt</option>
            </select></div>
            <fieldset id="hoursFields" disabled>
              <div class="row">
                <div><label for="hoursStart">Shift starts</label><input id="hoursStart" type="time" step="60" value="09:00" /></div>
                <div><label for="hoursEnd">Shift ends</label><input id="hoursEnd" type="time" step="60" value="17:00" /></div>
              </div>
              <div id="hoursDays" class="ws-settings-days" role="group" aria-label="Shift start days"></div>
            </fieldset>
            <button id="saveWorkingHours" class="primary" type="button" disabled>Save working hours</button>
            <div id="workingHoursMsg" class="msg" role="status"></div>
          </div>
        </div>
      </details>

      <details id="setInactivity" class="hidden">
        <summary><span>Inactivity limit<small id="inactivitySummary">Loading team policy</small></span></summary>
        <div class="body">
          <div class="ws-settings-field"><label for="inactivityMode">Team inactivity policy</label>
          <select id="inactivityMode" disabled>
            <option value="personal">Use personal desktop settings</option>
            <option value="team">Set team limit and warning</option>
          </select></div>
          <fieldset id="inactivityFields" disabled>
            <div class="row">
              <div><label for="inactivityLimit">Clock out after idle minutes</label><input id="inactivityLimit" type="number" min="1" max="1440" step="1" value="15" required /></div>
              <div><div class="ws-settings-label"><label for="inactivityWarning">Warn minutes before clock-out</label><span class="ws-settings-help"><button type="button" aria-label="About inactivity warnings" aria-describedby="inactivityHelp">?</button><span id="inactivityHelp" role="tooltip">Use 0 for no warning. The warning must be shorter than the idle limit.</span></span></div><input id="inactivityWarning" type="number" min="0" max="1439" step="1" value="2" required /></div>
            </div>
          </fieldset>
          <button id="saveInactivity" class="primary" type="button" disabled>Save inactivity policy</button>
          <div id="inactivityMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setMyHours">
        <summary><span>Working hours</span></summary>
        <div class="body"><p id="workingHoursSummary" class="hint" role="status"></p></div>
      </details>

      <details id="setDesktop">
        <summary><span>Desktop app and devices</span></summary>
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
          <div class="ws-settings-field"><div class="ws-settings-label"><span class="field-label" id="tokenLabel">Newly created token</span><span class="ws-settings-help"><button type="button" aria-label="About device tokens" aria-describedby="tokenHelp">?</button><span id="tokenHelp" role="tooltip">Copy a new token now. It is shown once and grants access to your account. Keep it private.</span></span></div>
          <div class="tokenbox">
            <div id="token" class="token" title="Your Bearer token" aria-labelledby="tokenLabel">&middot;&middot;&middot;&middot;&middot;&middot;&middot;&middot;</div>
            <button id="copyToken" type="button" disabled>Copy</button>
          </div>
          </div>
          <div class="token-create">
            <input id="tokenName" type="text" maxlength="64" placeholder="Device name, e.g. Personal laptop" autocomplete="off" aria-label="Device name" />
            <button id="mintToken" class="primary" type="button">Add device</button>
          </div>
          <div id="tokenList" class="token-list" aria-label="Connected devices"></div>
          <div id="tokenMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setPrivacy">
        <summary><span>Privacy</span></summary>
        <div class="body">
          <p class="hint">Deleting cloud data is permanent.</p>
          <div class="inline-actions">
            <button id="exportData" type="button">Export my data</button>
            <button id="deleteData" class="danger" type="button">Delete cloud data</button>
          </div>
          <div id="privacyMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setTeamCreate" class="hidden">
        <summary><span>Start a team</span></summary>
        <div class="body">
          <p class="hint">Up to 50 members, free.</p>
          <div class="ws-settings-field"><label for="teamCreateName">Team name</label>
          <input id="teamCreateName" type="text" placeholder="Acme Inc." autocomplete="organization" maxlength="80" /></div>
          <div class="ws-actions-row"><button type="button" id="teamCreateBtn" class="primary">Create team</button></div>
          <div id="teamCreateMsg" class="msg" role="status"></div>
        </div>
      </details>

      <details id="setOperator" class="hidden">
        <summary><span>Invitations</span></summary>
        <div class="body" id="operatorSlot"></div>
      </details>

      <div id="setPlan" class="ws-plan hidden"><span>Team plan</span><small id="planSummary"></small></div>
    </div>
  </dialog>
</div>`;
