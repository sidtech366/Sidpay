package com.sidtech366.verifier;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.service.notification.NotificationListenerService;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/** One screen: setup checklist, server settings, and recent activity. */
public class MainActivity extends Activity {

    private static final int INK = Color.parseColor("#172033");
    private static final int MUTED = Color.parseColor("#5B6478");
    private static final int LINE = Color.parseColor("#DFE3EC");
    private static final int WASH = Color.parseColor("#F3F5FA");
    private static final int BLUE = Color.parseColor("#1D3FAF");
    private static final int GREEN = Color.parseColor("#0F7A55");
    private static final int RED = Color.parseColor("#B42318");

    private final Handler ui = new Handler(Looper.getMainLooper());
    private TextView accessState, batteryState, serverState, logView;
    private Button accessBtn, batteryBtn;
    private EditText urlInput, secretInput;

    private final Runnable refresher = new Runnable() {
        @Override public void run() {
            refresh();
            ui.postDelayed(this, 3000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(WASH);
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        setContentView(buildUi());
        handleSetupLink(getIntent());
        Sender.startSchedule(this);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleSetupLink(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (Sender.hasNotificationAccess(this)) {
            NotificationListenerService.requestRebind(new ComponentName(this, PaymentListenerService.class));
        }
        ui.post(refresher);
    }

    @Override
    protected void onPause() {
        super.onPause();
        ui.removeCallbacks(refresher);
    }

    /** sidpay-verifier://setup?url=...&secret=... from the SidPay "Payment requests" page */
    private void handleSetupLink(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri d = intent.getData();
        if (!"sidpay-verifier".equals(d.getScheme())) return;
        String url = d.getQueryParameter("url");
        String secret = d.getQueryParameter("secret");
        if (url == null || secret == null || !url.startsWith("https://")) {
            toast("Setup link is not valid");
            return;
        }
        Store.saveSettings(this, url, secret);
        urlInput.setText(Store.serverUrl(this));
        secretInput.setText(Store.secret(this));
        toast("Settings filled from SidPay. Checking connection…");
        testConnection();
    }

    // ---------------- UI ----------------

    private View buildUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(WASH);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(18), dp(22), dp(18), dp(28));
        scroll.addView(root);

        TextView title = text("SidPay Verifier", 24, INK, true);
        root.addView(title);
        TextView sub = text("Confirms PhonePe Business payments for SidTech 366 automatically. Keep this phone on and connected.", 14, MUTED, false);
        sub.setPadding(0, dp(4), 0, dp(16));
        root.addView(sub);

        // Checklist card
        LinearLayout check = card();
        root.addView(check);
        check.addView(text("Setup", 16, INK, true));

        accessState = text("", 15, INK, false);
        accessState.setPadding(0, dp(10), 0, dp(6));
        check.addView(accessState);
        accessBtn = button("Allow notification access", true);
        accessBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
                toast("Find \"SidPay Verifier\" and turn it ON");
            }
        });
        check.addView(accessBtn);

        batteryState = text("", 15, INK, false);
        batteryState.setPadding(0, dp(14), 0, dp(6));
        check.addView(batteryState);
        batteryBtn = button("Let it run in background", true);
        batteryBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { askBatteryExemption(); }
        });
        check.addView(batteryBtn);

        serverState = text("", 15, INK, false);
        serverState.setPadding(0, dp(14), 0, dp(6));
        check.addView(serverState);
        Button test = button("Check connection now", false);
        test.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { testConnection(); }
        });
        check.addView(test);

        // Settings card
        LinearLayout settings = card();
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) settings.getLayoutParams();
        lp.topMargin = dp(14);
        root.addView(settings);
        settings.addView(text("Server", 16, INK, true));
        TextView hint = text("Easiest: open sidpay.onrender.com/claims on this phone and tap \"Set up this phone\". Or fill in below.", 13, MUTED, false);
        hint.setPadding(0, dp(4), 0, dp(10));
        settings.addView(hint);

        settings.addView(label("Server address"));
        urlInput = input(Store.serverUrl(this), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        settings.addView(urlInput);
        settings.addView(label("Secret (SMS_WEBHOOK_SECRET from Render)"));
        secretInput = input(Store.secret(this), InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        settings.addView(secretInput);

        Button save = button("Save", true);
        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String url = urlInput.getText().toString().trim();
                String secret = secretInput.getText().toString().trim();
                if (!url.startsWith("https://")) { toast("Server address must start with https://"); return; }
                if (secret.length() < 16) { toast("Secret must be at least 16 characters"); return; }
                Store.saveSettings(MainActivity.this, url, secret);
                toast("Saved. Checking connection…");
                testConnection();
            }
        });
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        slp.topMargin = dp(12);
        save.setLayoutParams(slp);
        settings.addView(save);

        // Activity card
        LinearLayout act = card();
        ((LinearLayout.LayoutParams) act.getLayoutParams()).topMargin = dp(14);
        root.addView(act);
        act.addView(text("Recent activity", 16, INK, true));
        logView = text("", 14, MUTED, false);
        logView.setPadding(0, dp(8), 0, 0);
        logView.setLineSpacing(dp(2), 1f);
        act.addView(logView);

        TextView foot = text("SidTech 366 · 70694 92135", 12, MUTED, false);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, dp(18), 0, 0);
        root.addView(foot);
        return scroll;
    }

    private void refresh() {
        boolean access = Sender.hasNotificationAccess(this);
        accessState.setText(access ? "✓ Notification access is ON" : "✗ Notification access is OFF");
        accessState.setTextColor(access ? GREEN : RED);
        accessBtn.setVisibility(access ? View.GONE : View.VISIBLE);

        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        boolean battery = pm != null && pm.isIgnoringBatteryOptimizations(getPackageName());
        batteryState.setText(battery ? "✓ Allowed to run in background" : "✗ Battery saver may stop this app");
        batteryState.setTextColor(battery ? GREEN : RED);
        batteryBtn.setVisibility(battery ? View.GONE : View.VISIBLE);

        if (!Store.isConfigured(this)) {
            serverState.setText("✗ Server not set up yet");
            serverState.setTextColor(RED);
        } else {
            long t = Store.heartbeatTime(this);
            boolean ok = Store.heartbeatOk(this);
            String when = t == 0 ? "not checked yet" : ago(t);
            int queued = Store.queue(this).length();
            serverState.setText((ok ? "✓ Server connected" : "✗ " + Store.heartbeatMessage(this))
                    + " (" + when + ")" + (queued > 0 ? "\n" + queued + " payment(s) waiting to send" : ""));
            serverState.setTextColor(ok ? GREEN : RED);
        }

        JSONArray log = Store.logEntries(this);
        StringBuilder sb = new StringBuilder();
        SimpleDateFormat f = new SimpleDateFormat("d MMM, h:mm a", Locale.ENGLISH);
        for (int i = log.length() - 1; i >= 0 && i >= log.length() - 15; i--) {
            JSONObject o = log.optJSONObject(i);
            if (o == null) continue;
            sb.append(f.format(new Date(o.optLong("t")))).append("  ").append(o.optString("m")).append('\n');
        }
        logView.setText(sb.length() == 0 ? "Nothing yet. Payments will appear here." : sb.toString().trim());
    }

    private void testConnection() {
        serverState.setText("Checking… (a sleeping server can take up to a minute)");
        serverState.setTextColor(MUTED);
        Sender.heartbeat(this, new Runnable() {
            @Override public void run() { ui.post(new Runnable() { @Override public void run() { refresh(); } }); }
        });
    }

    private void askBatteryExemption() {
        try {
            Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }

    // ---------------- small helpers ----------------

    private String ago(long t) {
        long mins = (System.currentTimeMillis() - t) / 60000;
        if (mins < 1) return "just now";
        if (mins < 60) return mins + " min ago";
        return (mins / 60) + " h ago";
    }

    private LinearLayout card() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(16), dp(16), dp(16), dp(16));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(1), LINE);
        l.setBackground(bg);
        l.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return l;
    }

    private TextView text(String s, int sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        return t;
    }

    private TextView label(String s) {
        TextView t = text(s, 13, MUTED, false);
        t.setPadding(0, dp(8), 0, dp(4));
        return t;
    }

    private EditText input(String value, int type) {
        EditText e = new EditText(this);
        e.setText(value);
        e.setInputType(type);
        e.setSingleLine(true);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        e.setTextColor(INK);
        e.setPadding(dp(12), dp(10), dp(12), dp(10));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.WHITE);
        bg.setCornerRadius(dp(12));
        bg.setStroke(dp(1), LINE);
        e.setBackground(bg);
        return e;
    }

    private Button button(String s, boolean primary) {
        Button b = new Button(this);
        b.setText(s);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        b.setTextColor(primary ? Color.WHITE : INK);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(primary ? BLUE : Color.WHITE);
        bg.setCornerRadius(dp(12));
        if (!primary) bg.setStroke(dp(1), LINE);
        b.setBackground(bg);
        b.setStateListAnimator(null);
        b.setMinHeight(dp(46));
        return b;
    }

    private int dp(int v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private void toast(String s) {
        Toast.makeText(this, s, Toast.LENGTH_LONG).show();
    }
}
