package com.sidtech366.verifier;

import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.provider.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** Sends queued payment notifications and heartbeats to the SidPay server. */
final class Sender {
    private static final ScheduledExecutorService EXEC = Executors.newSingleThreadScheduledExecutor();
    private static boolean scheduled = false;

    private Sender() {}

    /** Heartbeat every 9 minutes (keeps the free server awake) and retry the queue every minute. */
    static synchronized void startSchedule(final Context ctx) {
        if (scheduled) return;
        scheduled = true;
        final Context c = ctx.getApplicationContext();
        EXEC.scheduleWithFixedDelay(new Runnable() {
            @Override public void run() { heartbeatNow(c); }
        }, 0, 9, TimeUnit.MINUTES);
        EXEC.scheduleWithFixedDelay(new Runnable() {
            @Override public void run() { flushNow(c); }
        }, 30, 60, TimeUnit.SECONDS);
    }

    static void flush(final Context ctx) {
        final Context c = ctx.getApplicationContext();
        EXEC.execute(new Runnable() {
            @Override public void run() { flushNow(c); }
        });
    }

    static void heartbeat(final Context ctx, final Runnable done) {
        final Context c = ctx.getApplicationContext();
        EXEC.execute(new Runnable() {
            @Override public void run() {
                heartbeatNow(c);
                if (done != null) done.run();
            }
        });
    }

    // ---------------- worker-thread methods ----------------

    private static void flushNow(Context c) {
        if (!Store.isConfigured(c)) return;
        JSONArray q = Store.queue(c);
        for (int i = 0; i < q.length(); i++) {
            JSONObject item = q.optJSONObject(i);
            if (item == null) continue;
            try {
                JSONObject body = new JSONObject();
                body.put("app", item.optString("app"));
                body.put("package", item.optString("package"));
                body.put("title", item.optString("title"));
                body.put("text", item.optString("text"));
                body.put("time", item.optLong("time"));
                Result r = request(c, "POST", "/api/v1/notify-webhook", body.toString());
                if (r.code >= 200 && r.code < 300) {
                    Store.removeFromQueue(c, item.optString("id"));
                    JSONObject resp = safeJson(r.body);
                    String what;
                    if (resp.optBoolean("ignored")) {
                        what = "Server ignored it: " + resp.optString("reason");
                    } else if (!resp.optString("matchedOrder").isEmpty() && !"null".equals(resp.optString("matchedOrder"))) {
                        what = "Order " + resp.optString("matchedOrder") + " marked PAID";
                    } else {
                        what = "Sent. No open order of this amount right now";
                    }
                    Store.log(c, "₹" + amountOf(item.optString("text")) + " " + what);
                } else if (r.code == 401) {
                    Store.log(c, "Wrong secret. Check the secret in this app.");
                    return;
                } else if (r.code >= 400 && r.code < 500) {
                    Store.removeFromQueue(c, item.optString("id"));
                    Store.log(c, "Server refused (" + r.code + "): " + shorten(r.body));
                } else {
                    Store.log(c, "Server not reachable (" + r.code + "). Will retry.");
                    return;
                }
            } catch (Exception e) {
                Store.log(c, "No internet or server sleeping. Will retry in 1 min.");
                return;
            }
        }
    }

    private static void heartbeatNow(Context c) {
        if (!Store.isConfigured(c)) return;
        try {
            String q = "?device=" + enc(Build.MANUFACTURER + " " + Build.MODEL)
                    + "&version=" + enc(BuildInfo.versionName(c))
                    + "&queued=" + Store.queue(c).length()
                    + "&access=" + hasNotificationAccess(c);
            Result r = request(c, "GET", "/api/v1/verifier/heartbeat" + q, null);
            if (r.code >= 200 && r.code < 300) {
                Store.setHeartbeat(c, true, "Connected");
                if (Store.queue(c).length() > 0) flushNow(c);
            } else if (r.code == 401) {
                Store.setHeartbeat(c, false, "Wrong secret");
            } else {
                Store.setHeartbeat(c, false, "Server error " + r.code);
            }
        } catch (Exception e) {
            Store.setHeartbeat(c, false, "Server not reachable");
        }
    }

    static boolean hasNotificationAccess(Context c) {
        String flat = Settings.Secure.getString(c.getContentResolver(), "enabled_notification_listeners");
        if (flat == null) return false;
        ComponentName me = new ComponentName(c, PaymentListenerService.class);
        return flat.contains(me.flattenToString()) || flat.contains(c.getPackageName() + "/");
    }

    // ---------------- http ----------------

    private static final class Result {
        int code;
        String body = "";
    }

    private static Result request(Context c, String method, String path, String jsonBody) throws Exception {
        URL url = new URL(Store.serverUrl(c) + path);
        HttpURLConnection con = (HttpURLConnection) url.openConnection();
        con.setRequestMethod(method);
        con.setConnectTimeout(20000);
        con.setReadTimeout(75000); // free server can take ~60s to wake up
        con.setRequestProperty("x-sms-secret", Store.secret(c));
        con.setRequestProperty("User-Agent", "SidPayVerifier/" + BuildInfo.versionName(c));
        if (jsonBody != null) {
            con.setDoOutput(true);
            con.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
            con.setFixedLengthStreamingMode(bytes.length);
            OutputStream os = con.getOutputStream();
            try {
                os.write(bytes);
            } finally {
                os.close();
            }
        }
        Result r = new Result();
        r.code = con.getResponseCode();
        InputStream in = r.code >= 400 ? con.getErrorStream() : con.getInputStream();
        if (in != null) {
            StringBuilder sb = new StringBuilder();
            BufferedReader br = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            try {
                String line;
                while ((line = br.readLine()) != null && sb.length() < 4000) sb.append(line);
            } finally {
                br.close();
            }
            r.body = sb.toString();
        }
        con.disconnect();
        return r;
    }

    private static JSONObject safeJson(String s) {
        try {
            return new JSONObject(s);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static String enc(String s) throws Exception {
        return URLEncoder.encode(s == null ? "" : s, "UTF-8");
    }

    private static String shorten(String s) {
        if (s == null) return "";
        return s.length() > 80 ? s.substring(0, 80) : s;
    }

    /** Pulls "1.02" out of "You've received Rs 1.02 from ..." for the activity log. */
    static String amountOf(String text) {
        if (text == null) return "?";
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("(?:Rs\\.?|₹|INR)\\s*([\\d,]+(?:\\.\\d{1,2})?)", java.util.regex.Pattern.CASE_INSENSITIVE)
                .matcher(text);
        return m.find() ? m.group(1) : "?";
    }
}
