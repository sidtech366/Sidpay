package com.sidtech366.verifier;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/** Saved settings, the queue of payments still to send, and a short activity log. */
final class Store {
    private static final String PREFS = "sidpay_verifier";
    static final String DEFAULT_URL = "https://sidpay.onrender.com";
    private static final int MAX_LOG = 40;
    private static final int MAX_SEEN = 60;

    private Store() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String serverUrl(Context c) {
        String u = prefs(c).getString("url", DEFAULT_URL);
        if (u == null || u.trim().isEmpty()) u = DEFAULT_URL;
        u = u.trim();
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    static String secret(Context c) {
        String s = prefs(c).getString("secret", "");
        return s == null ? "" : s.trim();
    }

    static void saveSettings(Context c, String url, String secret) {
        prefs(c).edit().putString("url", url == null ? "" : url.trim())
                .putString("secret", secret == null ? "" : secret.trim()).apply();
    }

    static boolean isConfigured(Context c) {
        return secret(c).length() >= 16;
    }

    // ---------------- queue ----------------

    static synchronized JSONArray queue(Context c) {
        try {
            return new JSONArray(prefs(c).getString("queue", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    static synchronized void saveQueue(Context c, JSONArray q) {
        prefs(c).edit().putString("queue", q.toString()).apply();
    }

    static synchronized void enqueue(Context c, JSONObject item) {
        JSONArray q = queue(c);
        q.put(item);
        // Never keep more than 200 waiting items
        while (q.length() > 200) q.remove(0);
        saveQueue(c, q);
    }

    static synchronized void removeFromQueue(Context c, String id) {
        JSONArray q = queue(c);
        JSONArray out = new JSONArray();
        for (int i = 0; i < q.length(); i++) {
            JSONObject o = q.optJSONObject(i);
            if (o != null && !id.equals(o.optString("id"))) out.put(o);
        }
        saveQueue(c, out);
    }

    /** Returns true the first time a notification text is seen (avoids double sending). */
    static synchronized boolean markSeen(Context c, String key) {
        JSONArray seen;
        try {
            seen = new JSONArray(prefs(c).getString("seen", "[]"));
        } catch (JSONException e) {
            seen = new JSONArray();
        }
        for (int i = 0; i < seen.length(); i++) {
            if (key.equals(seen.optString(i))) return false;
        }
        seen.put(key);
        while (seen.length() > MAX_SEEN) seen.remove(0);
        prefs(c).edit().putString("seen", seen.toString()).apply();
        return true;
    }

    // ---------------- activity log ----------------

    static synchronized void log(Context c, String line) {
        JSONArray l;
        try {
            l = new JSONArray(prefs(c).getString("log", "[]"));
        } catch (JSONException e) {
            l = new JSONArray();
        }
        JSONObject o = new JSONObject();
        try {
            o.put("t", System.currentTimeMillis());
            o.put("m", line);
        } catch (JSONException ignored) {
        }
        l.put(o);
        while (l.length() > MAX_LOG) l.remove(0);
        prefs(c).edit().putString("log", l.toString()).apply();
    }

    static synchronized JSONArray logEntries(Context c) {
        try {
            return new JSONArray(prefs(c).getString("log", "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    // ---------------- heartbeat ----------------

    static void setHeartbeat(Context c, boolean ok, String message) {
        prefs(c).edit().putLong("hb_time", System.currentTimeMillis())
                .putBoolean("hb_ok", ok).putString("hb_msg", message).apply();
    }

    static long heartbeatTime(Context c) {
        return prefs(c).getLong("hb_time", 0);
    }

    static boolean heartbeatOk(Context c) {
        return prefs(c).getBoolean("hb_ok", false);
    }

    static String heartbeatMessage(Context c) {
        return prefs(c).getString("hb_msg", "");
    }
}
