package com.sidtech366.verifier;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import org.json.JSONObject;

/**
 * Reads "You've received Rs X from NAME via PhonePe for txn T..." notifications
 * from PhonePe apps and forwards them to the SidPay server.
 * Android keeps this service running while notification access is allowed.
 */
public class PaymentListenerService extends NotificationListenerService {

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        Store.log(this, "Listening for PhonePe Business payments");
        Sender.startSchedule(this);
        Sender.flush(this);
    }

    @Override
    public void onListenerDisconnected() {
        super.onListenerDisconnected();
        // Ask Android to connect us again (it can disconnect after updates / low memory)
        requestRebind(new ComponentName(this, PaymentListenerService.class));
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            String pkg = sbn.getPackageName();
            if (pkg == null || !pkg.toLowerCase().contains("phonepe")) return;

            Notification n = sbn.getNotification();
            if (n == null) return;
            Bundle ex = n.extras;
            if (ex == null) return;
            String title = str(ex.getCharSequence(Notification.EXTRA_TITLE));
            String text = str(ex.getCharSequence(Notification.EXTRA_BIG_TEXT));
            if (text.isEmpty()) text = str(ex.getCharSequence(Notification.EXTRA_TEXT));

            String all = (title + " " + text).toLowerCase();
            if (!all.contains("received")) return;            // only money received
            if (!Store.isConfigured(this)) {
                Store.log(this, "Payment seen but app not set up (secret missing)");
                return;
            }
            // The same notification can be posted again when it updates
            if (!Store.markSeen(this, pkg + "|" + text)) return;

            JSONObject item = new JSONObject();
            item.put("id", pkg + "-" + sbn.getPostTime() + "-" + Math.abs(text.hashCode()));
            item.put("app", appLabel(this, pkg));
            item.put("package", pkg);
            item.put("title", title);
            item.put("text", text);
            item.put("time", sbn.getPostTime());
            Store.enqueue(this, item);
            Store.log(this, "Payment seen: ₹" + Sender.amountOf(text) + ". Sending…");
            Sender.flush(this);
        } catch (Exception e) {
            Store.log(this, "Could not read a notification: " + e.getClass().getSimpleName());
        }
    }

    private static String str(CharSequence cs) {
        return cs == null ? "" : cs.toString().trim();
    }

    static String appLabel(Context c, String pkg) {
        try {
            PackageManager pm = c.getPackageManager();
            ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
            CharSequence label = pm.getApplicationLabel(ai);
            return label == null ? pkg : label.toString();
        } catch (Exception e) {
            return pkg;
        }
    }
}
