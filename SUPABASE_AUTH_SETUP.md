# One-time setup: turn on phone + password login

Do this in your Supabase project dashboard before (or right after)
running `schema.sql`. This only needs to be done once.

**Note:** the app uses Supabase's *Email* login underneath, not its
Phone login — Supabase's Phone login requires a paid SMS provider
(Twilio or similar) just to switch it on, even if you never send a
text. To avoid that cost, the app quietly turns each person's phone
number into a fake internal email address (like
`256779477048@plu-army.local`) that Supabase uses as a login ID.
Nobody ever sees this, types it, or receives anything at it — people
still only ever enter a phone number and password.

## Step 1 — Make sure Email sign-ups are allowed

1. Open your project at supabase.com and log in.
2. In the left sidebar, go to **Authentication** → **Sign In / Providers**
   (or wherever the "User Signups" section lives in your dashboard).
3. Make sure **"Allow new users to sign up"** is **ON**.
4. Confirm **Email** is enabled as a sign-in method (it usually is by
   default — no changes needed here for most projects).

## Step 2 — Turn OFF email confirmation

This is the important part — without this, Supabase will try to send
a confirmation link to the fake email address, which will never
arrive, and people will never be able to log in.

1. Still under **Authentication** → **Sign In / Providers**, find
   **"Confirm email"** (you may have already seen this toggle).
2. Turn it **OFF**.

With this off, someone can sign up with a phone number and password
and be logged in immediately — no email, no SMS, nothing sent
anywhere.

## Step 3 — Set a minimum password length (optional but recommended)

1. Under **Authentication** → **Policies** (or **Settings**, depending
   on your dashboard version), look for **Minimum password length**.
2. Set it to at least **6**.

## Step 4 — Run schema.sql

Go to **SQL Editor** → **New Query**, paste the full contents of
`schema.sql`, and run it. This wipes the old tables and rebuilds
everything for the new login system.

## Step 5 — Make yourself an admin

1. Open the app and register your own account like any normal member
   (name, phone, password).
2. Go back to **SQL Editor** and run:
   ```sql
   update users set is_admin = true where phone = '2567XXXXXXXX';
   ```
   using the same phone number (in `256...` format) you just
   registered with.
3. Log into `admin.html` with that same phone + password.

That's it — no Twilio, no SMS provider, no cost per login. After
these five steps, `index.html` and `admin.html` are ready to use.

## About the 90-day message cleanup

`schema.sql` also sets up an automatic daily job that permanently
deletes any message older than 90 days — along with its likes,
replies, any reports filed against it, and its uploaded photo or
voice note file. This runs on its own once a day; there's nothing
to configure. It needs the **pg_cron** extension, which the schema
turns on automatically. If your project's SQL role doesn't allow
that (rare), enable **pg_cron** once from **Database** →
**Extensions** in the dashboard, then re-run `schema.sql`.

To change the 90-day window later, edit the two `interval '90 days'`
values inside the `delete_old_posts()` function in `schema.sql` and
re-run just that section.
