package com.sidtech366.verifier;

import android.content.Context;
import android.content.pm.PackageInfo;

final class BuildInfo {
    private BuildInfo() {}

    static String versionName(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return pi.versionName == null ? "" : pi.versionName;
        } catch (Exception e) {
            return "";
        }
    }
}
