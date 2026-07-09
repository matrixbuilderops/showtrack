# ShowTrack Scrobbler (browser extension)

Auto-marks episodes you watch on streaming sites into your ShowTrack app, and
tags them with the platform you watched on. Works on Netflix and Crunchyroll
with tailored detection, and best-effort on Hulu, Disney+, Max, and Prime Video.

**It only sees what you watch in this browser on this computer** — phone apps and
TVs can't be tracked (no service exposes that). Use it on the desktop where you
watch in a browser; everything syncs to your phone through your ShowTrack server.

## Install (Chrome / Edge / Brave — unpacked)

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top-right)
3. Click **Load unpacked** and pick this `extension/` folder
4. Click the ShowTrack icon in the toolbar → sign in with the **same username and
   password** as your ShowTrack app, and the **server address** (your Tailscale
   `https://…ts.net` URL). Approve the permission prompt for your server.

Firefox: use `about:debugging` → This Firefox → Load Temporary Add-on → pick
`manifest.json` (temporary add-ons clear on restart; Chrome is stickier).

## How it works

While a video plays, the extension reads the show/episode from the page. When
you pass ~92% of the episode, it sends it to your server, which matches it on
TVmaze and marks it watched (platform set to the site you watched on). Open the
ShowTrack app and it's there after the next sync. A green ✓ badge on the icon
means a scrobble just landed.

## Tuning

If a site changes its layout and detection stops working, the selectors live in
`content.js` (`parseNetflix`, `parseCrunchyroll`, `parseGeneric`). The generic
parser reads the page title, so most sites work without site-specific code.
