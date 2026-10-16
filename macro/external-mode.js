/**
 * External Mode macro
 * -------------------
 * Adds a PIN-protected "Room mode" button to the Navigator Control Panel
 * (swipe in from the right edge) that toggles between:
 *
 *   INTERNAL  – normal operation, nothing overlaid (MTR/RoomOS UI as usual)
 *   EXTERNAL  – the status web app is shown fullscreen on the Navigator,
 *               overlaying the MTR controls; users are told to use USB only.
 *
 * Also adds a "Request service" panel and a "Feedback" panel. Services,
 * feedback URL and all UI text are read from the web app's config.json,
 * so the same file drives the web page, the Worker and this macro.
 *
 * The mode survives reboots (state is kept in a helper macro) and the web
 * view is re-opened automatically if someone manages to dismiss it.
 * INITIAL_EXTERNAL_MODE sets the mode for the very first start, before any
 * state has been saved; EXTERNAL_ON_BOOT forces external mode on every start.
 */
import xapi from 'xapi';

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

const PIN = '1234'; // change this!
const WEBAPP_URL = 'https://roomos-external-mode.<your-account>.workers.dev/';
// must match the HELP_TOKEN secret of the Worker
const HELP_TOKEN = 'change-me';
// mode on the very first start (no saved state yet): true → external
const INITIAL_EXTERNAL_MODE = false;
// true → always switch to external mode when the macro starts (device boot,
// but also after saving or restarting the macro)
const EXTERNAL_ON_BOOT = false;

const DEBUG = false; // verbose logging of the webview status stream / watchdog

const WEBVIEW_NAME = 'External Mode';
const BASE_URL = WEBAPP_URL.replace(/\/+$/, '') + '/';
// hostname of WEBAPP_URL (the macro runtime has no URL class)
const WEBAPP_HOST = WEBAPP_URL.replace(/^https?:\/\//, '').split('/')[0];
const CONFIG_URL = BASE_URL + 'config.json';
const HELP_ENDPOINT = BASE_URL + 'api/help';

const PANEL_ID = 'room_mode_toggle';
const SERVICE_PANEL_ID = 'service_requests';
const FORM_PANEL_ID = 'feedback_form';
const PIN_FEEDBACK_ID = 'room_mode_pin';
const OPTION_FEEDBACK_ID = 'svc_option_prompt';
const NAME_FEEDBACK_ID = 'svc_name_input';
const WIDGET_PREFIX = 'svc_';
const STORAGE_MACRO = 'ExternalModeState'; // helper macro used as storage, never activated
const WATCHDOG_INTERVAL_MS = 15 * 1000;
const CONFIG_RETRY_MS = 60 * 1000;

// Used until config.json has been fetched (e.g. network not up yet after boot)
const DEFAULT_TEXT = {
  modePanel: 'Room mode',
  modeInternal: 'Room mode: internal',
  modeExternal: 'Room mode: external 🔒',
  switchedExternal: 'External mode active.',
  switchedInternal: 'Internal mode active.',
  pinPrompt: 'Enter the PIN to switch the room to {target}',
  pinTargetExternal: 'EXTERNAL',
  pinTargetInternal: 'INTERNAL',
  pinSubmit: 'Switch',
  pinWrong: 'Wrong PIN',
  servicePanel: 'Request service',
  serviceSent: '{service}{issue_suffix} has been requested.',
  serviceFailed: 'The request could not be sent.',
  nameText: '{issue} – your name (optional)',
};

let config = { services: [], text: {}, macro: {} };
let M = DEFAULT_TEXT;

function fill(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

async function loadConfig() {
  const res = await xapi.Command.HttpClient.Get({ Url: CONFIG_URL, ResultBody: 'PlainText' });
  config = JSON.parse(res.Body);
  M = Object.assign({}, DEFAULT_TEXT, config.macro || {});
}

/* ------------------------------------------------------------------ */
/* State persistence (stored as a comment in an inactive helper macro)  */
/* ------------------------------------------------------------------ */

// null if nothing has been saved yet (first start)
async function loadState() {
  try {
    const result = await xapi.Command.Macros.Macro.Get({ Name: STORAGE_MACRO, Content: 'True' });
    return JSON.parse(result.Macro[0].Content.replace(/^\/\/\s*/, ''));
  } catch (e) {
    return null;
  }
}

async function saveState(state) {
  await xapi.Command.Macros.Macro.Save(
    { Name: STORAGE_MACRO, Overwrite: 'True', Transpile: 'False' },
    '// ' + JSON.stringify(state)
  );
}

/* ------------------------------------------------------------------ */
/* UI panels                                                           */
/* ------------------------------------------------------------------ */

async function updatePanel(external) {
  const name = external ? M.modeExternal : M.modeInternal;
  const color = external ? '#D97706' : '#1F87E8';
  const panelXml = `<Extensions>
  <Panel>
    <PanelId>${PANEL_ID}</PanelId>
    <Location>ControlPanel</Location>
    <Origin>local</Origin>
    <Type>Home</Type>
    <Icon>Sliders</Icon>
    <Color>${color}</Color>
    <Name>${xmlEscape(name)}</Name>
    <ActivityType>Custom</ActivityType>
  </Panel>
</Extensions>`;
  await xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: PANEL_ID }, panelXml);
}

async function createServicePanel() {
  const services = config.services || [];
  if (!services.length) {
    await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: SERVICE_PANEL_ID }).catch(() => {});
    return;
  }
  const rows = services.map((s) => `
      <Row>
        <Widget>
          <WidgetId>${WIDGET_PREFIX}${xmlEscape(s.id)}</WidgetId>
          <Name>${xmlEscape(s.label)}</Name>
          <Type>Button</Type>
          <Options>size=4</Options>
        </Widget>
      </Row>`).join('');
  const panelXml = `<Extensions>
  <Panel>
    <PanelId>${SERVICE_PANEL_ID}</PanelId>
    <Location>ControlPanel</Location>
    <Origin>local</Origin>
    <Type>Home</Type>
    <Icon>Concierge</Icon>
    <Color>#07C1E4</Color>
    <Name>${xmlEscape(M.servicePanel)}</Name>
    <ActivityType>Custom</ActivityType>
    <Page>
      <Name>${xmlEscape(M.servicePanel)}</Name>${rows}
      <PageId>service_page</PageId>
      <Options/>
    </Page>
  </Panel>
</Extensions>`;
  await xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: SERVICE_PANEL_ID }, panelXml);
}

async function createFormPanel() {
  const f = config.feedback;
  if (!f || !f.url) {
    await xapi.Command.UserInterface.Extensions.Panel.Remove({ PanelId: FORM_PANEL_ID }).catch(() => {});
    return;
  }
  const panelXml = `<Extensions>
  <Panel>
    <PanelId>${FORM_PANEL_ID}</PanelId>
    <Location>ControlPanel</Location>
    <Origin>local</Origin>
    <Type>Home</Type>
    <Icon>Info</Icon>
    <Color>#7C6BD2</Color>
    <Name>${xmlEscape(f.label || 'Feedback')}</Name>
    <ActivityType>Custom</ActivityType>
  </Panel>
</Extensions>`;
  await xapi.Command.UserInterface.Extensions.Panel.Save({ PanelId: FORM_PANEL_ID }, panelXml);
}

async function openFeedbackForm() {
  const f = config.feedback || {};
  if (!f.url) return;
  await xapi.Command.UserInterface.WebView.Display({
    Url: f.url,
    Target: 'Controller',
    Mode: 'Modal',
    Title: f.label || 'Feedback',
  }).catch((e) => console.error('feedback form failed:', e.message));
}

/* ------------------------------------------------------------------ */
/* Mode switching                                                      */
/* ------------------------------------------------------------------ */

let externalMode = false;

async function getRoomName() {
  try {
    const name = await xapi.Status.UserInterface.ContactInfo.Name.get();
    if (name) return name;
  } catch (e) { /* fall through */ }
  return config.roomFallback || 'Unknown room';
}

async function showWebApp() {
  const room = await getRoomName();
  await xapi.Command.UserInterface.WebView.Display({
    Url: `${BASE_URL}?room=${encodeURIComponent(room)}&k=${encodeURIComponent(HELP_TOKEN)}`,
    Target: 'Controller',
    Mode: 'Fullscreen',
    Title: WEBVIEW_NAME,
  });
}

async function setMode(external) {
  externalMode = external;
  await saveState({ external });
  await updatePanel(external);

  if (external) {
    await showWebApp();
  } else {
    await xapi.Command.UserInterface.WebView.Clear({ Target: 'Controller' }).catch(() => {});
  }

  await xapi.Command.UserInterface.Message.Alert.Display({
    Title: M.modePanel,
    Text: external ? M.switchedExternal : M.switchedInternal,
    Duration: 5,
  });
}

/* ------------------------------------------------------------------ */
/* Service requests (sidebar panel, works in internal mode too)        */
/*   options + askName → option prompt, then name input, then send     */
/*   options only      → option prompt, then send                      */
/*   askName only      → name input, then send                         */
/*   neither           → send right away                               */
/* ------------------------------------------------------------------ */

let pending = null; // { service, issue }

async function requestService(service, extra = {}) {
  const room = await getRoomName();
  const vars = { service: service.label, issue: extra.issue || '', issue_suffix: extra.issue ? ' – ' + extra.issue : '' };
  try {
    await xapi.Command.HttpClient.Post(
      {
        Url: HELP_ENDPOINT,
        Header: ['Content-Type: application/json', `X-Room-Token: ${HELP_TOKEN}`],
        ResultBody: 'PlainText',
      },
      JSON.stringify({ room, type: service.id, issue: extra.issue || '', name: extra.name || '' })
    );
    await xapi.Command.UserInterface.Message.Alert.Display({
      Title: M.servicePanel,
      Text: fill(M.serviceSent, vars),
      Duration: 5,
    });
  } catch (e) {
    console.error('service request failed:', e.message);
    await xapi.Command.UserInterface.Message.Alert.Display({
      Title: M.servicePanel,
      Text: M.serviceFailed,
      Duration: 5,
    });
  }
}

function askName(service, issue) {
  pending = { service, issue };
  xapi.Command.UserInterface.Message.TextInput.Display({
    FeedbackId: NAME_FEEDBACK_ID,
    InputType: 'SingleLine',
    Title: service.label,
    Text: fill(M.nameText, { issue: issue || service.label }),
    Placeholder: (config.text && config.text.namePlaceholder) || '',
    SubmitText: (config.text && config.text.send) || 'OK',
    Duration: 60,
  });
}

function startService(service) {
  const options = service.options || [];
  if (options.length) {
    pending = { service, issue: '' };
    xapi.Command.UserInterface.Message.Prompt.Display({
      FeedbackId: OPTION_FEEDBACK_ID,
      Title: service.label,
      Text: service.prompt || '',
      // RoomOS prompts support at most 5 options
      Option: options.slice(0, 5),
      Duration: 60,
    });
  } else if (service.askName) {
    askName(service, '');
  } else {
    requestService(service);
  }
}

xapi.Event.UserInterface.Extensions.Widget.Action.on((event) => {
  if (event.Type !== 'clicked' || !event.WidgetId.startsWith(WIDGET_PREFIX)) return;
  const id = event.WidgetId.slice(WIDGET_PREFIX.length);
  const service = (config.services || []).find((s) => s.id === id);
  if (service) startService(service);
});

xapi.Event.UserInterface.Message.Prompt.Response.on((event) => {
  if (event.FeedbackId !== OPTION_FEEDBACK_ID || !pending) return;
  const { service } = pending;
  const issue = (service.options || [])[Number(event.OptionId) - 1];
  if (!issue) return;
  if (service.askName) askName(service, issue);
  else requestService(service, { issue });
});

/* ------------------------------------------------------------------ */
/* PIN prompt                                                          */
/* ------------------------------------------------------------------ */

function askForPin() {
  const target = externalMode ? M.pinTargetInternal : M.pinTargetExternal;
  xapi.Command.UserInterface.Message.TextInput.Display({
    FeedbackId: PIN_FEEDBACK_ID,
    InputType: 'PIN',
    Title: M.modePanel,
    Text: fill(M.pinPrompt, { target }),
    Placeholder: 'PIN',
    SubmitText: M.pinSubmit,
    Duration: 60,
  }).catch((e) => console.error('PIN prompt failed:', e.message));
}

xapi.Event.UserInterface.Extensions.Panel.Clicked.on((event) => {
  if (event.PanelId === PANEL_ID) askForPin();
  if (event.PanelId === FORM_PANEL_ID) openFeedbackForm();
});

// A web page can request the unlock via `xapi.Command.Message.Send`
// (the sidebar is unreachable while the fullscreen webview is up);
// the PIN is still enforced by askForPin.
xapi.Event.Message.Send.on((event) => {
  if (event.Text === 'external-mode:unlock') {
    dbg('unlock requested from web app');
    askForPin();
  }
});

xapi.Event.UserInterface.Message.TextInput.Response.on(async (event) => {
  if (event.FeedbackId === NAME_FEEDBACK_ID) {
    if (pending) requestService(pending.service, { issue: pending.issue, name: event.Text });
    pending = null;
    return;
  }
  if (event.FeedbackId !== PIN_FEEDBACK_ID) return;
  try {
    if (event.Text === PIN) {
      await setMode(!externalMode);
    } else {
      await xapi.Command.UserInterface.Message.Alert.Display({
        Title: M.modePanel,
        Text: M.pinWrong,
        Duration: 5,
      });
    }
  } catch (e) {
    console.error('mode switch failed:', e.message);
  }
});

/* ------------------------------------------------------------------ */
/* Watchdog: keep the web app up while in external mode                */
/* ------------------------------------------------------------------ */

function dbg(...args) {
  if (DEBUG) console.log('[watchdog]', ...args);
}

async function webAppVisible() {
  try {
    const views = await xapi.Status.UserInterface.WebView.get();
    const list = Array.isArray(views) ? views : [views].filter(Boolean);
    dbg('webview status:', JSON.stringify(list.map((v) => ({
      id: v.id, URL: v.URL, Status: v.Status, Type: v.Type,
    }))));
    list.forEach((v) => { if (v.URL && v.URL.includes(WEBAPP_HOST)) ourViewIds.add(v.id); });
    const visible = list.some((v) => v.URL && v.URL.includes(WEBAPP_HOST) && v.Status !== 'NotVisible');
    dbg(`our app (${WEBAPP_HOST}) visible:`, visible);
    return visible;
  } catch (e) {
    dbg('could not read webview status:', e.message);
    return true; // cannot tell — do not flap the view
  }
}

// Webview ids showing our app. With several touch panels (native RoomOS),
// one Display call opens one webview per panel, so "visible somewhere" is
// not enough: closing it on any panel must bring it back.
const ourViewIds = new Set();

let redisplayTimer = null;
let redisplayDelay = 0;
// Closing the webview doubles as the unlock request: when the user closes
// it, we bring it back AND show the PIN dialog on top.
let pinAfterRedisplay = false;
// set when one of our webviews closed — re-display without the visibility check
let forceRedisplay = false;

function scheduleRedisplayCheck(delayMs, reason, force = false) {
  if (!externalMode) return;
  if (force) forceRedisplay = true;
  if (redisplayTimer) {
    if (delayMs >= redisplayDelay) {
      dbg(`check already pending, ignoring trigger (${reason})`);
      return;
    }
    // a faster trigger preempts the pending slower one
    clearTimeout(redisplayTimer);
    redisplayTimer = null;
  }
  dbg(`check in ${delayMs} ms (trigger: ${reason})`);
  redisplayDelay = delayMs;
  redisplayTimer = setTimeout(async () => {
    redisplayTimer = null;
    const force = forceRedisplay;
    forceRedisplay = false;
    if (externalMode && (force || !(await webAppVisible()))) {
      console.log(`External mode: web app ${force ? 'closed on a panel' : 'not visible'}, re-displaying`);
      if (force) {
        // clear first so panels that still show it don't stack a second copy
        await xapi.Command.UserInterface.WebView.Clear({ Target: 'Controller' }).catch(() => {});
        ourViewIds.clear();
      }
      await showWebApp().catch((e) => console.error('re-display failed', e));
      if (pinAfterRedisplay) {
        pinAfterRedisplay = false;
        // small delay so the PIN dialog lands on top of the fresh webview
        setTimeout(askForPin, 800);
      }
    } else {
      pinAfterRedisplay = false;
    }
  }, delayMs);
}

// React immediately when the webview state changes (user closed it) …
xapi.Status.UserInterface.WebView.on((change) => {
  dbg('status stream event:', JSON.stringify(change));
  if (!change) return;
  if (change.URL && change.URL.includes(WEBAPP_HOST)) ourViewIds.add(change.id);
  if (change.ghost) {
    ourViewIds.delete(change.id);
    return;
  }
  if (change.Status === 'NotVisible') {
    // a webview just closed — re-display and offer the PIN unlock
    pinAfterRedisplay = true;
    scheduleRedisplayCheck(0, 'webview closed', ourViewIds.has(change.id));
  } else {
    scheduleRedisplayCheck(1500, 'status change');
  }
});
// … and keep a slow poll as a safety net (e.g. right after boot/pairing).
setInterval(() => scheduleRedisplayCheck(0, 'periodic poll'), WATCHDOG_INTERVAL_MS);

/* ------------------------------------------------------------------ */
/* Startup: restore last mode, then load config.json                   */
/* ------------------------------------------------------------------ */

async function applyConfig() {
  try {
    await loadConfig();
  } catch (e) {
    console.error(`could not load ${CONFIG_URL} (${e.message}), retrying in ${CONFIG_RETRY_MS / 1000} s`);
    setTimeout(applyConfig, CONFIG_RETRY_MS);
    return;
  }
  await updatePanel(externalMode).catch(() => {});
  await createServicePanel().catch((e) => console.error('service panel failed:', e.message));
  await createFormPanel().catch((e) => console.error('form panel failed:', e.message));
}

async function init() {
  let state = await loadState();
  if (!state) {
    state = { external: INITIAL_EXTERNAL_MODE };
    await saveState(state).catch((e) => console.error('saving state failed:', e.message));
  }
  if (EXTERNAL_ON_BOOT && !state.external) {
    console.log('Starting in external mode (EXTERNAL_ON_BOOT)');
    state = { external: true };
    await saveState(state).catch((e) => console.error('saving state failed:', e.message));
  }
  externalMode = !!state.external;
  // UI may not be ready right after boot; applyConfig updates the panel again
  await updatePanel(externalMode).catch((e) => console.error('mode panel failed:', e.message));
  // required for config.json and the service-request HTTP calls
  await xapi.Config.HttpClient.Mode.set('On').catch(() => {});
  if (externalMode) {
    // Navigator may still be pairing right after boot; the watchdog will
    // retry if this first attempt is too early.
    await showWebApp().catch(() => {});
  }
  await applyConfig();
  console.log(`External Mode macro started (mode: ${externalMode ? 'external' : 'internal'})`);
}

init();
