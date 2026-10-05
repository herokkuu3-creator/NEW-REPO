# Phone verification for Codeforces

The GitHub cloud runner can pause a challenged account and show its existing
browser on your phone. Accounts that open and submit normally keep the same
automatic path. No additional secrets, proxy changes, or phone apps are needed.

## Use it

1. Deploy this commit to both Render services and push the workflow to GitHub.
2. Run `/submitnextsolution`, or let the daily schedule start.
3. If Cloudflare blocks the browser, Telegram sends **Codeforces verification
   needed**, the account label, and **Open the live cloud browser**.
4. Open that private link on your phone. Tap the verification shown in the live
   image. Use **Scroll up** or **Scroll down** if needed.
5. The bot resumes when the same browser receives the site's native verification
   response. It submits once and reports the judge verdict through the usual flow.

Each link lasts four minutes and is removed when verification completes, is
cancelled, or the job finishes. A page-level challenge and a form widget can each
request a handoff, up to two per browser job. If you cancel or do not finish in
time, no pre-submission retry is made. That source remains pending for a future
attempt. A POST already sent to Codeforces is never repeated automatically.

## Privacy and limits

The link is access to this account's live verification view. Keep it private.
It contains a random capability in the URL fragment, not your account cookies or
the service token. Images remain in Render memory, are marked `no-store`, and are
not written to files, logs, or GitHub artifacts. Interactions allow scrolling and
clicks inside verification widgets only; source editing, keyboard entry, arbitrary
navigation, and the Codeforces Submit button are unavailable.

This relays your real taps to the existing browser; it does not solve challenges
automatically. If Cloudflare offers no interactive control or keeps rejecting the
browser, the handoff may still expire. A Render restart or runner failure ends the
session. Existing successful accounts do not create a link or upload images.
