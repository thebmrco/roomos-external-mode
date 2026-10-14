# RoomOS External Mode

Lock a Cisco Room Navigator (MTR or RoomOS) into an **external / BYOD mode**:
the Navigator shows a fullscreen "connect via USB" page with service-request
buttons (tech support, catering, cleaning, …), a Wi-Fi QR code and a feedback
form. A PIN-protected button in the Navigator Control Panel toggles the mode.

```
webapp/index.html        → the page shown on the Navigator (static asset)
webapp/config.json       → ALL texts, services, Wi-Fi, feedback form, email wording
webapp/bg.svg            → generic wallpaper (replace with your own)
src/worker.js            → Cloudflare Worker: serves the assets + sends request emails
wrangler.jsonc           → Worker config (email binding, recipient addresses)
macro/external-mode.js   → RoomOS macro (panel buttons, PIN, mode switching)
examples/config.de.json  → German version of config.json
```

## How it works

- **Internal mode** — nothing overlaid; normal MTR / RoomOS operation.
- **External mode** — the macro opens the web app fullscreen on the Navigator
  (`UserInterface WebView Display Target: Controller`). A watchdog re-opens it
  if it gets dismissed (closing it also brings up the PIN prompt), and the
  mode survives reboots (state is persisted in a helper macro named
  `ExternalModeState`).
- **Service requests** — each service tile POSTs to `/api/help`; the Worker
  sends an email through **Cloudflare Email Routing** (`send_email` binding —
  no third-party mail service, no API keys). Tiles lock for 60 s after each
  request. The same services are also available in the Control Panel via a
  "Request service" panel, so they work in internal mode too.
- **One config file** — `webapp/config.json` drives the web page, the email
  text in the Worker, and the macro's panels and prompts (the macro downloads
  it from the deployed app at startup).

## 1. Configure

### `webapp/config.json`

| Key | What it does |
| --- | --- |
| `locale`, `timeZone` | Clock format on the page, timestamp in the emails |
| `background` | Wallpaper path or URL (put your image into `webapp/`) |
| `roomFallback` | Room name if the device has none |
| `text.*` | All texts on the page (`subtitle` may contain HTML) |
| `services[]` | Service tiles — see below |
| `wifi` | `ssid`, `password`, `security` (`WPA`/`WEP`/`nopass`) → Wi-Fi tile + QR code. Remove the block to hide it. |
| `feedback` | `url` → QR code + tap-to-open form. `embedUrl` optionally overrides the URL used in the on-screen iframe (e.g. Microsoft Forms: append `&embed=true`). Remove the block to hide it. |
| `email.*` | Subject/body templates. Placeholders: `{service}`, `{room}`, `{issue}`, `{name}`, `{time}`, `{issue_suffix}`, `{issue_line}`, `{name_line}` |
| `macro.*` | Texts used by the macro (panel names, PIN prompt, alerts) |

Each service:

```json
{ "id": "tech", "label": "Technical support", "icon": "wrench",
  "prompt": "What can we help with?",
  "options": ["Display", "Audio", "USB / connection", "Other"],
  "askName": true }
```

- `options` + `askName` → pick an option, optionally enter a name, send
- `options` only → picking an option sends the request
- `askName` only → enter a name, send
- neither → tapping the tile sends right away
- `icon`: `wrench`, `coffee`, `broom`, `bell`, `help`
- RoomOS prompts in the macro's Control Panel version show at most 5 options.

QR codes (Wi-Fi and feedback) are generated in the browser — no image files
to regenerate when you change the SSID or the form.

> `config.json` is publicly served. Don't put email addresses or secrets in it.
> The Wi-Fi password is in it by design (it's shown as a QR code anyway).

For German texts, copy `examples/config.de.json` over `webapp/config.json`.

### `wrangler.jsonc` — email recipients

- `HELP_FROM` — sender, any address on the zone with Email Routing enabled
- `HELP_TO` — fallback recipient
- `HELP_TO_<SERVICE_ID>` — optional per-service recipient, e.g.
  `HELP_TO_TECH`, `HELP_TO_CATERING`, `HELP_TO_FRONT_DESK` for id `front-desk`

Every recipient must be listed in `allowed_destination_addresses` **and** be a
verified destination address in Email Routing.

To keep real addresses out of a public fork, copy `wrangler.jsonc` to
`wrangler.local.jsonc` (gitignored), fill it in, and pass `-c wrangler.local.jsonc`
to the `wrangler` commands below.

## 2. Deploy to Cloudflare (Worker + static assets)

One-time email setup in the Cloudflare dashboard:

1. On your zone: **Email → Email Routing → enable** (adds the MX/SPF records).
2. Under **Destination addresses**, add every recipient and confirm the
   verification mail.

Then set the shared token and deploy:

```sh
openssl rand -hex 16                 # generate a token
npx wrangler secret put HELP_TOKEN   # paste it
npx wrangler deploy
```

Note the resulting URL, e.g. `https://roomos-external-mode.<account>.workers.dev/`
(or attach a custom domain on the zone — recommended, since the sender and the
app then live on the same domain).

If email isn't set up yet, the tiles show "Could not send" but the rest of
the page is unaffected.

## 3. Configure the device

Run these on the codec (Control Hub → device → xAPI, or the local web admin):

```
xConfiguration WebEngine Mode: On
xConfiguration HttpClient Mode: On
xConfiguration Macros Mode: On
```

`HttpClient Mode` is needed for the macro to load `config.json` and send
service requests from the Control Panel (the macro also tries to enable it).

## 4. Install the macro

1. Open the Macro Editor (device web admin → Customization → Macro Editor).
2. Create a macro named e.g. `external-mode`, paste `macro/external-mode.js`.
3. Edit the constants at the top:
   - `PIN` — the manager's PIN (default `1234`, change it).
   - `WEBAPP_URL` — your Worker URL.
   - `HELP_TOKEN` — the token from step 2.
4. Save and enable the macro.

A "Room mode" button appears in the Navigator **Control Panel** (swipe from
the right edge — on MTR devices custom panels can only live there, Microsoft
does not allow buttons inside the MTR UI itself). Tapping it prompts for the
PIN, then toggles the mode. The button label/color reflects the current mode.

After changing `config.json`, redeploy and restart the macro so it picks up
the new services and texts.

## Local development

```sh
npx wrangler dev
```

Open `http://localhost:8787/?room=Test%20Room` in a browser. Email sending
only works when deployed.

## Notes / limitations

- MTR mode: macros, custom panels and webviews on the Navigator are supported
  by RoomOS, but the MTR call itself is a black box — the page targets the
  RoomOS/BYOD path (USB-C/HDMI input), which is exactly the external-use case.
- Many sites refuse to be shown in an iframe; if the feedback form stays blank
  in the modal, use a form provider that allows embedding (or rely on the QR
  code).
- The `ExternalModeState` macro that appears in the editor is just storage;
  leave it disabled.
- The shared token only keeps casual abuse out (it is in the page URL on the
  Navigator); it is not strong authentication.

## License

MIT — see [LICENSE](LICENSE). Bundles
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT) in
`webapp/vendor/`.
