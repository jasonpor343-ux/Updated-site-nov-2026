# Cartel site

The whole site is private. Visitors see only a Connect Discord screen. After they sign in with Discord, your bot checks that they are in your server and have your role. Only then are the real pages and video links sent to them.

## Setup
1. discord.com/developers/applications > New Application.
2. OAuth2: copy the Client ID and Client Secret. Add the redirect `https://YOUR-SITE/auth/callback`.
3. Bot tab: copy the bot token. No privileged intents are needed.
4. OAuth2 > URL Generator: scope `bot`, no permissions. Open the link and add the bot to your server.
5. Turn on Developer Mode in Discord. Copy the server ID (`GUILD_ID`), the role ID (`REQUIRED_ROLE_ID`, from Server Settings > Roles) and your user ID (`OWNER_IDS`).
6. Put this folder on GitHub. On render.com choose New > Blueprint, pick the repo and fill in the values from `.env.example`. Set `BASE_URL` to the URL Render gives you, then add that redirect in step 2.

Run locally: copy `.env.example` to `.env`, `npm install`, `npm start`.

## 1-1 bookings
Members book 30-minute slots on Friday to Sunday, between 8 pm and 11 pm Melbourne time. Bookings are saved as messages from your bot in a private Discord channel, so they survive restarts.
1. Create a private channel, for example #bookings. Give your bot View Channel, Send Messages and Read Message History there.
2. Right-click the channel, Copy Channel ID, and set it as `BOOKINGS_CHANNEL_ID` on Render.
3. Members must say what each 1-1 is for. Your Book a 1-1 tab lists every booking with the member's Discord name and their topic, and the topic is saved in the Discord message too. Cancelling a booking deletes its message.

## PA Recap
Only users listed in `OWNER_IDS` can post or delete recaps. Members can only watch them. Paste a YouTube, Vimeo or direct .mp4 link; unlisted YouTube or Vimeo videos work well. Posts are stored as bot messages in `PA_CHANNEL_ID` (or the bookings channel if that is not set).

## Video watermark and sign-in confirmation
- Every video (lectures and PA Recap) is overlaid with the viewer's Discord name and IP address. This deters leaking, but a technical person can remove an on-page overlay, so treat it as a deterrent rather than a lock. Native fullscreen is disabled so the watermark stays visible; use the Fullscreen button under the player.
- After Discord sign-in, members must press "Authorise and verify" on the site before the bot check runs.

## Lecture videos
Sign in as the owner and open any lecture. A "Lecture video link" box appears above the notes, visible only to you. Paste a YouTube, Vimeo or .mp4 link and press Save. Members see it immediately. Links are stored as bot messages in `PA_CHANNEL_ID` (or the bookings channel), so they survive restarts. A link set this way overrides the `video` field in `private/index.html`.

## Homework review
Members submit notes and homework (text and files). Each submission is posted by the bot to a private channel (`SUBMISSIONS_CHANNEL_ID`) as a message with a notes.txt file and their attachments. Open the Review tab on the site to read the work, then Approve it or Request changes with feedback. The next lecture unlocks only after approval. The bot needs View Channel, Send Messages, Attach Files and Read Message History in that channel.

## Notifications
- When a member submits homework, or books or cancels a 1-1, the bot sends you a direct message. If it cannot DM you and `ALERTS_CHANNEL_ID` is set, it pings you in that private channel instead.
- A member gets a direct message with their booking time (Melbourne time). They must allow direct messages from server members in their Discord privacy settings.
- When you approve homework or request changes, the bot posts the outcome in `OUTCOMES_CHANNEL_ID`, pings the member and includes your notes. If that channel is not set, it sends the member a DM instead.

## Videos (optional, in code)
Edit the `video` field of each lecture in `private/index.html`.

## Known limits
- Access is re-checked every minute, so removing a role removes access.
- Notes, homework and your approvals are stored in each visitor's browser, so you can't review other people's work from your device.
