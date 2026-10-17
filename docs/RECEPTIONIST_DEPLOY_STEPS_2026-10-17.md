# Receptionist repairs: merge and deploy steps (for approval; nothing has been run)

**Branch:** `receptionist-audit-repairs` (the latest commit at the end of this branch: the re-run fixes, de67593, plus this document).

**What changes for customers:** only the automatic receptionist and "Suggest reply":
- the four owner-approved lines;
- no dead-end replies;
- the repaired scheduling, consent and checker;
- durable alerts to your phone.

**No screen change, no database rule change, no new settings.** The Knowledge Centre shows the four new lines by itself, because the screen reads the list from the server.

**Time:** about 20 minutes. **Cost:** nothing beyond normal AI use.

## Step 1: merge and publish the code (on this PC; Claude can do it once you approve)

```bash
cd "C:/Users/ekitc/Documents/ChatGPT/ELITE OS/elite-kitchens-lead-os"
git checkout main
git pull --ff-only
git -c user.name="Elite OS" -c user.email="tomekemail2000@gmail.com" merge --no-ff receptionist-audit-repairs -m "Merge receptionist-audit-repairs: both 200-conversation audits fixed (owner alerts, scheduling and consent, checker, silent hand-overs), owner-approved lines, re-run fixes"
git push origin main
```

- `main` on GitHub is at 69621b8, the commit this branch starts from, so the merge has no conflicts. The merged code is the same code that was tested (AI suites 308/308, full regression, paid re-run).
- The repository is **public**: the push publishes the code and the docs. No key or customer data is in them; the local `tools/` folder, with the test key and transcripts, is not in git.

## Step 2: deploy (you run these in Cloud Shell, one at a time; each one asks you to type yes)

```bash
cd ~/elite-kitchens-lead-os
git checkout main && git pull --ff-only
git log --oneline -1
./scripts/deploy-quote-sending.sh routing
./scripts/deploy-quote-sending.sh check
```

- `git log` should show the "Merge receptionist-audit-repairs…" line.
- `routing` and `check` only read; they change nothing. Stop and tell me if either shows a warning.

```bash
./scripts/deploy-quote-sending.sh staffsend
./scripts/deploy-quote-sending.sh ai
./scripts/deploy-quote-sending.sh receptionist
```

1. **`staffsend`** (6 functions through which a person writes to a customer). They note "a person is writing" before WhatsApp is contacted, so the receptionist never talks over you.
   - This came with the 16 Oct merge. Skip it if you already ran it after 16 Oct.
   - What they send is unchanged.
2. **`ai`** (the assistant, Suggest reply and Knowledge Centre functions): the new wording, the checker and the scheduling rules.
3. **`receptionist`** (the automatic replies and the 5-minute backup check): all the repairs, including the alert retry.

**Optional, separate decision: `./scripts/deploy-quote-sending.sh webhook`.** This redeploys the live WhatsApp webhook so that two messages in the same second are told apart.
- The receptionist works without it, falling back to message times.
- It touches the live webhook, so only run it if you want it.

**Not needed:** `live` (no screen change), `rules`, `older`, `push`.

You do **not** need to switch the automatic receptionist off for the deploy. Switching it off and on again resets which new leads it handles: leads that arrived before you switch it back on are never handled automatically.

## Step 3: check it worked (about 5 minutes; between 07:00 and midnight)

1. **Elite OS:**
   - Assistant > Settings: "Automatic receptionist" is still on.
   - Knowledge Centre > lines: the four new lines show the approved wording:
     - "Are you still looking at a new kitchen?"
     - "Thanks, I'll pass your request on to the team and they'll get back to you."
     - "No problem at all, thanks for letting us know. I'll tell the team."
     - "Sorry, we can't share other customers' details."
2. **A real test from your own phone** (your own test chat, with its Receptionist button switched on). Wait about 40 seconds after each message.
   - Send **"Hi"**. You should get "Hi [name], thanks for getting back to us. Are you still looking at a new kitchen?"
   - Send **"Can someone come out tomorrow?"**. You should get "Thanks, I'll pass your request on to the team and they'll get back to you." Also:
     - **a push on your phone** ("A chat is waiting for you");
     - the chat shows **Needs booking** with tomorrow's date.
3. **Logs (read-only):**

   ```bash
   gcloud functions logs read receptionistOnMessage --region europe-west1 --project elite-kitchens-lead-os --limit 30
   ```

   There should be no "receptionist chat failed" or "handover push failed" lines.
4. **If all is well:** I tag the release, for example `receptionist-audit-repairs-complete`, once you approve.

## If something goes wrong

- **Stop it at once:** Assistant > Settings, switch "Automatic receptionist" off (or the AI switch). It takes effect from the next message.
- **Put the previous code back** (in Cloud Shell). These commands return the functions to `main` 69621b8 and leave your checkout as it was:

  ```bash
  git checkout 69621b8 -- functions
  ./scripts/deploy-quote-sending.sh ai
  ./scripts/deploy-quote-sending.sh receptionist
  git checkout main -- functions
  ```

  Then tell me what you saw.

## After the deploy

- Two weeks of supervision: check the receptionist's chats once a day. Also look out for a chat marked as an alert that could not be delivered. It isn't shown on screen yet; see the repair plan, N4.
- Still open, from the repair plan and the re-run report:
  - whether your fitters are your own employees (add it to the knowledge);
  - "You're Tomasz, right?";
  - no on-screen badge for a failed alert;
  - an email fallback for alerts;
  - a do-not-contact flag;
  - small wording points.
