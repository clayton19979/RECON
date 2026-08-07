# RECON as an Android app

Read `CLAUDE.md` first, then `MOBILE-APP-PLAN.md`. This directory is a wrapper,
and understanding what it wraps matters more than understanding the wrapper.

## What this is

`dist/RECON.apk` is roughly 200 lines of Java around a WebView. It holds **no
records, no screens and no logic**. Every pixel it shows is served by the shop
PC at `/m/`, which means it cannot drift from what the desk shows — the same
reason the phone app was built as a second front end over the same API instead
of a second store of records.

If you deleted this whole directory, the phone app would still work. You would
open `http://<shop-pc>:8787/m/` in Chrome and use it. That is worth knowing
before spending any time in here.

## What it earns over a browser bookmark

One thing, and it is the reason it exists: **it knows two addresses and picks
the one that answers.**

- **At the shop** — the LAN address, e.g. `http://192.168.1.50:8787`.
- **Away** — the Tailscale address, over mobile data.

It tries the shop address first with a two-second timeout, falls back to the
away address, and loads whichever answered. Nobody has to notice which network
they are on. A bookmark cannot do that; you would keep two of them and pick
wrong while holding a torch.

Secondarily: a real launcher icon, no browser chrome, and back stepping through
the app's own screens rather than leaving it.

## What it does not do

**It does not work offline.** It is a window onto the shop PC; with no route to
the shop PC there is nothing to show, and it says so plainly instead of
displaying a stale screen. Offline reading, and queued writes that sync when
the phone gets back in range, are real work that belongs in the web app — not
here. Wrapping a web app in an APK does not make it offline-capable, and if
someone asks for offline and is handed this, they have not been given it.

## Building it

```bash
powershell -File android\build_apk.ps1
```

Output is `dist\RECON.apk`. Copy it to the phone and tap it; Android asks once
for permission to install from that source.

Needs, one time:

- **A JDK** — `winget install EclipseAdoptium.Temurin.21.JDK`
- **The Android SDK**, at `C:\Android\sdk` or wherever `ANDROID_HOME` points:
  `platforms;android-34` and `build-tools;35.0.0`, installed with `sdkmanager`.

The build is aapt2 → javac → d8 → apksigner, run directly. There is no Gradle
and nothing is downloaded at build time, because the app depends on the Android
framework alone — no AndroidX, no libraries. That is a deliberate constraint on
the code: keep it dependency-free and the build stays four commands that work
on a shop PC with no internet.

### Traps already solved

- **build-tools 35, not 34.** The `d8` in build-tools 34 (R8 8.2.2) dies with
  an internal `NullPointerException` — *"Cannot invoke String.length()"* — on
  the first anonymous inner class it meets, which for this app is the
  `WebViewClient`. 35's `d8` handles the same input, and when something really
  is wrong it names the missing class instead of throwing a null pointer.
- **`-bootclasspath` is not passed to javac.** JDK 9+ refuses it alongside
  `-target`. `android.jar` on the classpath resolves every `android.*` symbol,
  and `d8` desugars what the min API cannot take.
- **`JAVA_HOME` is set inside the script.** `d8.bat` and `apksigner.bat` look
  up java themselves; winget installs Temurin without touching `PATH`, so
  without this the build fails at step 4 on a machine where everything is
  correctly installed.
- **`apksigner verify` output is captured, not piped into `Select-Object`.**
  Closing the pipe early kills apksigner mid-write, and it exits `-1` — which
  reads exactly like a signature that failed to verify.
- **The keystore is generated once and is gitignored.** Android refuses to
  update an app signed with a different key. Losing it costs an uninstall and
  re-typing the two addresses on each phone, which is why it is ignored rather
  than committed.

## The cleartext question

RECON is served over plain `http`, and Android blocks cleartext by default.
`res/xml/network_security_config.xml` permits it.

It permits it *everywhere*, which deserves the explanation it gets in that
file: Android matches `<domain>` entries as literal hosts or DNS suffixes and
has no syntax for an IP range, and the shop PC's address is typed in at runtime
— DHCP today, a Tailscale address tomorrow — so there is no host to name at
build time.

The check that config cannot do lives in `MainActivity.isPrivateAddress()`,
which refuses to save an address outside the RFC1918 ranges, the 100.64/10
CGNAT block Tailscale uses, loopback, or a `.ts.net` name. RECON has no login:
anything that reaches it reads and writes everything. An address typed wrong
should fail, not quietly ship the shop's records to a stranger over plain http.

## Versioning

`versionName` in `AndroidManifest.xml` tracks the RECON release the app was
built alongside. Nothing enforces that they agree — unlike the four files
`scripts/bump_version.ps1` keeps in step — because this APK is not part of the
update flow that `available_update()` drives. It is sideloaded by hand, and the
server it talks to is the thing that actually needs to be current.

`MainActivity.reachable()` probes `/api/version`, which is unauthenticated and
cheap. A 404 there is exactly what a shop PC older than 1.9.0 returns, so the
app treats it as "not there" rather than loading a `/m/` that does not exist.
