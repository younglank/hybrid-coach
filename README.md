# Hybrid Coach — your app, on your iPhone

This is your full Daily Coach app, packaged so it can live on your iPhone home screen
like a normal app — its own icon, full screen, works offline, no App Store needed.

You do **not** need a Mac, Xcode, or to learn Swift. Swift is for hand-built native apps;
this is the fast path that reuses everything we already built.

---

## The easiest way to get it on your phone (≈10 min, free, no coding)

### 1. Put the project on GitHub
1. Make a free account at https://github.com → click **New repository** → name it
   `hybrid-coach` → **Create**.
2. On the new repo page click **uploading an existing file**.
3. Drag in **all** the files from this folder (keep the `src` and `public` folders).
   Click **Commit changes**.

### 2. Deploy it with Vercel (this turns the code into a live website)
1. Make a free account at https://vercel.com → sign in **with GitHub**.
2. Click **Add New → Project**, pick your `hybrid-coach` repo, click **Import**.
3. Vercel auto-detects everything (it's a Vite app). Just click **Deploy**.
4. ~30 seconds later you get a URL like `https://hybrid-coach.vercel.app`.

### 3. Add it to your iPhone home screen
1. Open that URL in **Safari** on your iPhone.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Done. Tap the icon — it opens full screen, like an app, and works offline.

That's it. You now have your app. 🎉

---

## Want to just test it on your laptop first?
If you have Node installed (https://nodejs.org, the "LTS" button), in this folder run:

    npm install
    npm run dev

…and open the link it prints. To make a shippable build instead:

    npm run build

That creates a `dist` folder you can drag onto https://app.netlify.com/drop for an
instant free deploy (no account needed for a quick test).

---

## How to keep editing it as you use it

There are two kinds of changes, and most of what you'll want is the easy kind:

**A) Day-to-day stuff — already editable inside the app, nothing to redeploy:**
- Protein/carb/fat/water targets, bar weight, sleep need, wake time → the **⚙ Settings** button.
- Your quick-add foods and their macros → the **✎ Edit** button in the Fuel tab.
- Everything you log (sleep, lifts, cardio, food, water) saves automatically on your phone.

**B) New features or behavior changes (new screens, tweaks to the logic):**
- Come back to me (Claude) and describe the change. I'll hand you an updated `App.jsx`.
- On GitHub, open `src/App.jsx` → click the pencil ✏️ → delete all → paste the new version →
  **Commit**. Vercel automatically rebuilds in ~30 sec. Refresh the app on your phone. Done.
- No Mac, no Xcode, no local setup — you edit in the browser.

---

## One honest heads-up about the "Coach" AI features

Two features use an AI server: the open-ended **Coach chat** ("how do I fix squat depth?")
and **auto-reading WHOOP/Garmin screenshots**. Those worked inside Claude because Claude
provided the AI behind the scenes.

When the app is hosted on your own URL, those two features won't have a server to call, so
they'll **gracefully say they're unavailable** — but **everything else works fully and offline**:
your daily plan generation, recovery logic, set/cardio/food/water logging, macros, weekly
trends, PRs, sleep target, streaks. The bulk of the app is 100% local.

If you later want the AI features live too, that needs a tiny backend with your own Anthropic
API key (a small serverless function). **I can build that for you when you're ready** — just ask.

---

## Going further (optional, later)
- **Real App Store listing / deeper native features (notifications, HealthKit):** wrap this same
  code with **Capacitor**. That step needs a Mac + Xcode + an Apple Developer account ($99/yr).
  Because the app stays React underneath, you'd still edit it the same easy way. Ask me when ready.
