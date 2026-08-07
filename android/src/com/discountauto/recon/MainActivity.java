package com.discountauto.recon;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * RECON in a WebView.
 *
 * This app holds nothing. Every screen it shows is served by the shop PC at
 * /m/, so it can never disagree with the desk about what a car needs -- the
 * same reason the web app was built as a second front end over the same API
 * rather than as a second store of records.
 *
 * The one thing it does that a browser bookmark cannot: it knows two addresses
 * and picks the one that answers. On the lot that is the shop's LAN address;
 * off the lot it is the Tailscale address, over mobile data. Nobody has to
 * notice which network they are on, which is the whole point -- the phone is
 * used while walking, and a screen that needs a decision before it loads is a
 * screen that gets abandoned.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "recon";
    private static final String KEY_SHOP = "shop_url";
    private static final String KEY_AWAY = "away_url";

    /**
     * How long to wait on the shop address before trying the away one.
     *
     * Short on purpose. On shop wifi the PC answers in single-digit
     * milliseconds; if it has not answered in two seconds it is not there, and
     * the phone is better off failing over than making somebody stand next to
     * a car watching a blank screen. Off the network entirely, a closed port
     * refuses immediately and this never runs down.
     */
    private static final int SHOP_TIMEOUT_MS = 2000;
    /** More slack for the VPN: it may need a moment to wake and route. */
    private static final int AWAY_TIMEOUT_MS = 6000;

    private WebView web;
    private LinearLayout status;
    private TextView statusText;
    private Button statusRetry;
    private Button statusSettings;

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService probes = Executors.newSingleThreadExecutor();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0c1118"));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        // RECON's phone app is ES modules and fetch() from first paint; without
        // JavaScript there is no app at all, only an empty shell.
        s.setJavaScriptEnabled(true);
        // localStorage: the app reads the theme Clayton picked at the desk from
        // "dao-theme", and remembers who is holding the phone. Without DOM
        // storage both reset on every launch.
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        // The page is built for a phone and sets its own viewport; letting the
        // WebView add zoom controls on top puts buttons over the tab bar.
        s.setBuiltInZoomControls(false);
        s.setSupportZoom(false);
        // The shop PC is the one true copy. Caching the app code here would put
        // a phone on last week's RECON against this week's database -- the same
        // reason static/m/sw.js caches nothing.
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        web.setBackgroundColor(Color.parseColor("#0c1118"));

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Everything RECON serves is same-origin; keep it in the app.
                return false;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // Only the main document matters. A failed icon should not
                // replace a working screen with an error page.
                if (request != null && request.isForMainFrame()) {
                    showStatus("Lost the shop PC.\n\nCheck you are on the shop's wifi, or that RECON is running on the shop PC.", true);
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                hideStatus();
            }
        });

        // A way back to the settings that does not cost a button in a UI built
        // for gloved hands. A long press on empty chrome opens them; a long
        // press on a link or a field is left to the page.
        web.setOnLongClickListener(new View.OnLongClickListener() {
            @Override
            public boolean onLongClick(View v) {
                WebView.HitTestResult hit = web.getHitTestResult();
                if (hit == null || hit.getType() == WebView.HitTestResult.UNKNOWN_TYPE) {
                    showSettings(false);
                    return true;
                }
                return false;
            }
        });

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(buildStatusPanel(), new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);

        if (shopUrl().isEmpty()) {
            showSettings(true);
        } else {
            connect();
        }
    }

    private LinearLayout buildStatusPanel() {
        status = new LinearLayout(this);
        status.setOrientation(LinearLayout.VERTICAL);
        status.setGravity(Gravity.CENTER);
        status.setBackgroundColor(Color.parseColor("#0c1118"));
        int pad = dp(28);
        status.setPadding(pad, pad, pad, pad);

        statusText = new TextView(this);
        statusText.setTextColor(Color.parseColor("#e6edf6"));
        statusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        statusText.setGravity(Gravity.CENTER);
        status.addView(statusText);

        statusRetry = new Button(this);
        statusRetry.setText("Try again");
        statusRetry.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                connect();
            }
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(20);
        status.addView(statusRetry, lp);

        statusSettings = new Button(this);
        statusSettings.setText("Change the address");
        statusSettings.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                showSettings(false);
            }
        });
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp2.topMargin = dp(8);
        status.addView(statusSettings, lp2);

        return status;
    }

    /** Finds whichever address answers, then loads the phone app from it. */
    private void connect() {
        final String shop = shopUrl();
        final String away = awayUrl();
        showStatus("Looking for the shop PC…", false);

        probes.submit(new Runnable() {
            @Override
            public void run() {
                String found = null;
                if (!shop.isEmpty() && reachable(shop, SHOP_TIMEOUT_MS)) {
                    found = shop;
                } else if (!away.isEmpty() && reachable(away, AWAY_TIMEOUT_MS)) {
                    found = away;
                }
                final String target = found;
                ui.post(new Runnable() {
                    @Override
                    public void run() {
                        if (target == null) {
                            String msg = away.isEmpty()
                                    ? "Cannot reach the shop PC.\n\nYou need to be on the shop's wifi. To use RECON on mobile data, add an away address."
                                    : "Cannot reach the shop PC on the shop's wifi or on the away address.\n\nCheck that RECON is running on the shop PC.";
                            showStatus(msg, true);
                        } else {
                            web.loadUrl(target + "/m/");
                        }
                    }
                });
            }
        });
    }

    /**
     * Whether RECON is answering at this address.
     *
     * /api/version is the right probe: it needs no API key, it is cheap, and a
     * 200 from it means the server is up AND new enough to be worth loading --
     * the phone app only exists from 1.9.0, and a 404 here is exactly what an
     * older shop PC returns.
     */
    private boolean reachable(String base, int timeoutMs) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(base + "/api/version");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(timeoutMs);
            conn.setReadTimeout(timeoutMs);
            conn.setRequestMethod("GET");
            conn.setUseCaches(false);
            return conn.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private void showStatus(String message, boolean actionable) {
        statusText.setText(message);
        statusRetry.setVisibility(actionable ? View.VISIBLE : View.GONE);
        statusSettings.setVisibility(actionable ? View.VISIBLE : View.GONE);
        status.setVisibility(View.VISIBLE);
    }

    private void hideStatus() {
        status.setVisibility(View.GONE);
    }

    /** The two addresses, with the shop one required and the away one not. */
    private void showSettings(final boolean firstRun) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, pad, pad, 0);

        final EditText shopField = new EditText(this);
        shopField.setHint("http://192.168.1.50:8787");
        shopField.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        shopField.setSingleLine(true);
        shopField.setText(shopUrl());
        box.addView(label("At the shop (wifi)"));
        box.addView(shopField);

        final EditText awayField = new EditText(this);
        awayField.setHint("http://100.x.y.z:8787  — optional");
        awayField.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        awayField.setSingleLine(true);
        awayField.setText(awayUrl());
        box.addView(label("Away (mobile data, over Tailscale)"));
        box.addView(awayField);

        TextView note = new TextView(this);
        note.setText("RECON tries the shop address first and falls back to the away one, so you do not have to think about which network you are on.");
        note.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        np.topMargin = dp(14);
        box.addView(note, np);

        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle("Where is the shop PC?")
                .setView(box)
                .setCancelable(!firstRun)
                .setPositiveButton("Save", null);
        if (!firstRun) {
            b.setNegativeButton("Cancel", null);
        }
        final AlertDialog dialog = b.create();
        dialog.show();

        // Wired after show() so a rejected address can keep the dialog open --
        // the default positive-button handler dismisses before it can be told
        // not to, which would drop what was typed.
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String shop = normalise(shopField.getText().toString());
                String away = normalise(awayField.getText().toString());

                if (shop.isEmpty()) {
                    shopField.setError("Needed — this is the shop PC's address");
                    return;
                }
                if (!isPrivateAddress(shop)) {
                    shopField.setError("Must be an address on your own network");
                    return;
                }
                if (!away.isEmpty() && !isPrivateAddress(away)) {
                    awayField.setError("Must be an address on your own network");
                    return;
                }

                prefs().edit().putString(KEY_SHOP, shop).putString(KEY_AWAY, away).apply();
                dialog.dismiss();
                connect();
            }
        });
    }

    private TextView label(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(14);
        t.setLayoutParams(lp);
        return t;
    }

    /** "192.168.1.50" and "192.168.1.50:8787/" both become "http://192.168.1.50:8787". */
    private String normalise(String raw) {
        String v = raw == null ? "" : raw.trim();
        if (v.isEmpty()) {
            return "";
        }
        if (!v.startsWith("http://") && !v.startsWith("https://")) {
            v = "http://" + v;
        }
        while (v.endsWith("/")) {
            v = v.substring(0, v.length() - 1);
        }
        // Typing a port on a phone keyboard is four extra taps every time, and
        // 8787 is the only port RECON has ever listened on.
        try {
            URL u = new URL(v);
            if (u.getPort() == -1 && "http".equals(u.getProtocol())) {
                v = v + ":8787";
            }
        } catch (Exception e) {
            return v;
        }
        return v;
    }

    /**
     * Whether this address is on a network the shop controls.
     *
     * RECON has no login. Anything that can reach it can read and write every
     * record, so an address typed wrong -- a digit dropped, landing on some
     * stranger's host -- must not be dialled over plain http. The manifest
     * cannot express this (Android's network security config matches literal
     * hosts and DNS suffixes, not IP ranges, and the address is not known until
     * it is typed), so the check lives here.
     *
     * Allowed: RFC1918 private ranges, the 100.64/10 CGNAT block Tailscale
     * hands out from, loopback, and Tailscale's MagicDNS names.
     */
    private boolean isPrivateAddress(String base) {
        String host;
        try {
            host = new URL(base).getHost();
        } catch (Exception e) {
            return false;
        }
        if (host == null || host.isEmpty()) {
            return false;
        }
        host = host.toLowerCase(Locale.US);

        if (host.equals("localhost") || host.endsWith(".ts.net")) {
            return true;
        }

        String[] parts = host.split("\\.");
        if (parts.length != 4) {
            // Not an IPv4 literal. A bare name could be anything, and the shop
            // has no DNS of its own, so it is refused rather than guessed at.
            return false;
        }
        int[] o = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                o[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException e) {
                return false;
            }
            if (o[i] < 0 || o[i] > 255) {
                return false;
            }
        }
        if (o[0] == 127) {
            return true;                                  // loopback
        }
        if (o[0] == 10) {
            return true;                                  // 10.0.0.0/8
        }
        if (o[0] == 192 && o[1] == 168) {
            return true;                                  // 192.168.0.0/16
        }
        if (o[0] == 172 && o[1] >= 16 && o[1] <= 31) {
            return true;                                  // 172.16.0.0/12
        }
        if (o[0] == 169 && o[1] == 254) {
            return true;                                  // link-local
        }
        if (o[0] == 100 && o[1] >= 64 && o[1] <= 127) {
            return true;                                  // 100.64.0.0/10, Tailscale
        }
        return false;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String shopUrl() {
        return prefs().getString(KEY_SHOP, "");
    }

    private String awayUrl() {
        return prefs().getString(KEY_AWAY, "");
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    @Override
    public void onBackPressed() {
        // Back means back through the app's own screens -- car to lot -- not
        // out of the app. Only a back press with nowhere left to go exits.
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        probes.shutdownNow();
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
