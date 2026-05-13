# Workday Autofill Agent

**Apply to Workday jobs without filling the same form twice.**

NVIDIA, Salesforce, Netflix, Workday itself — most Fortune 500s run their applications on Workday. The fields are nearly identical across every company. You've still typed your address fifty times this year.

This Chrome extension fills them in for you.

See [JOURNAL.md](./JOURNAL.md) for the running build log.

## How it's different

**No profile to set up first.** Other autofill tools make you fill out *their* form before you can skip filling out *theirs*. This one reads your profile straight from a Workday application you've already completed. Apply once manually, click **Save as Profile**, and the next Workday app fills itself.

**Workday-only, on purpose.** Generic autofill tools work badly everywhere. This one works on Workday — the React quirks, the hidden inputs, the comboboxes that don't fire on real DOM clicks. Narrow scope, sharp tool.

**Local-only.** Profile and resume live in browser storage. No account, no cloud, no telemetry. Uninstall the extension and it's gone.

## What it gets right

- **It won't guess on the questions that matter.** If your profile says "Mobile" and the company's dropdown only offers "Home Cellular," it leaves the field blank rather than picking something close. Same for legal questions — work authorization, sponsorship, disability disclosure. If we don't know, we don't make one up.
- **It respects what you've already typed.** Pre-picked a value before running the agent? It stays.
- **It fills the voluntary disclosures too.** Gender, race, veteran, disability — capture once, never see those questions again. Spot-check on Submit; it's your application.

## What it doesn't do (yet)

- Doesn't work outside Workday. By design.
- Doesn't auto-click "Add Another" for multi-job work history on fresh-start applications. v2.
- Doesn't fill values that don't exist in a given company's specific dropdown options. (Tenants are configured differently; we skip rather than approximate.)

## Install

Not on the Chrome Web Store yet. To run from source:

```bash
git clone https://github.com/BenDay123/workday-autofill-agent.git
cd workday-autofill-agent
npm install
npm run build
```

Then load it into Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked**
4. Select the `dist` folder inside the cloned repo

The extension icon appears in your toolbar. Pin it.

## Use it

1. Open a Workday application. Fill it out manually the first time.
2. Click the extension icon → **Save as Profile**.
3. On the next Workday application, click the extension icon → **Fill from Profile**.
4. Repeat **Save as Profile** on each step you visit — the profile builds up as you go.

Profile lives at `chrome.storage.local`. Clear it from the popup or by removing the extension.
