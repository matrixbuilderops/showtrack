# ShowTrack

Personal TV show tracker (PWA). Your watch data lives on your device (in the browser) and stays in sync across your desktop and phone via your self-hosted sync server. 

This guide explains how to set up your desktop computer, install the browser extension, and connect your phone.

---

## Part 1: Desktop Setup (Server & Extension)

### 1. Run the Sync Server
The server stores a secure, encrypted copy of your data so your devices stay in sync, and performs background checks for shows leaving streaming services.

1. Clone this repository on your desktop/server machine:
   ```bash
   git clone https://github.com/matrixbuilderops/showtrack.git
   cd showtrack/server
   ```
2. Run the server (requires Node.js 18+):
   ```bash
   node server.js
   ```
   *The server runs on port `8570` and uses the `server/data` directory to store sync data.*

### 2. Install the Chrome/Firefox Web Extension
The browser extension detects what you watch on Netflix and Crunchyroll and scrobbles your progress to your ShowTrack account.

1. Open Chrome (or any Chromium browser like Edge/Brave) and go to `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** (top-left) and select the `extension/` folder in the cloned project.
4. Click the extension icon in your browser toolbar, enter your Server URL (e.g., `http://localhost:8570`), and log in.

---

## Part 2: Phone Setup (iPhone or Android PWA)

ShowTrack is a Progressive Web App (PWA) and is installed directly from your browser without using the App Store.

### Option A: Home Wi-Fi Only (Simple & Local)
1. Find your computer's local IP address (e.g., `192.168.1.135`).
2. Make sure your phone is on the same home Wi-Fi network.
3. Open **`http://<your-computer-ip>:8570`** in Safari (iPhone) or Chrome (Android).
4. Tap **Share** (Safari) or the **Menu** (Chrome) and select **Add to Home Screen**.
5. *Note: Data will save offline while you are out, and will sync back up when you return home.*

### Option B: Tailscale (Access Anywhere)
If you want to use the app when you are away from home, Tailscale creates a secure, encrypted private connection:
1. Install **Tailscale** on your computer and phone (sign both into the same account).
2. On your computer, run this command to expose the local server safely over HTTPS:
   ```bash
   sudo tailscale serve --bg 8570
   ```
3. Open the secure address Tailscale gives you (e.g., `https://your-computer.tailxxxx.ts.net`) in Safari/Chrome on your phone.
4. Tap **Share** and select **Add to Home Screen**.

---

## Part 3: Importing Your Existing History

You can import TV Time GDPR exports or Netflix Viewing History directly in the web app:
1. Open the app, go to the **More** tab, and click **Import TV Time export**.
2. Select your TV Time GDPR `.zip` file or a Netflix viewing history `.csv` file.
3. The app will parse and import your history. If you are importing to the sync server, changes will automatically sync to all devices.

