package com.operalibre.mobile;

import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

@CapacitorPlugin(name = "AppIcon")
public class AppIconPlugin extends Plugin {
    private static final List<String> ICONS = Arrays.asList(
        "Classic", "Midnight", "Fern", "Marigold", "Porcelain", "Plum", "Lagoon", "Graphite");

    private ComponentName alias(String name) {
        String pkg = getContext().getPackageName();
        return new ComponentName(pkg, pkg + ".Launcher" + name);
    }

    private boolean enabled(String name) {
        int state = getContext().getPackageManager().getComponentEnabledSetting(alias(name));
        return state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED
            || (state == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT && name.equals("Classic"));
    }

    private void resolve(PluginCall call, String name) {
        JSObject result = new JSObject();
        result.put("name", name);
        call.resolve(result);
    }

    @PluginMethod
    public void current(PluginCall call) {
        for (String name : ICONS) {
            if (enabled(name)) {
                resolve(call, name);
                return;
            }
        }
        call.reject("No launcher icon enabled");
    }

    @PluginMethod
    public void select(PluginCall call) {
        String selected = call.getString("name");
        if (!ICONS.contains(selected)) {
            call.reject("Unknown icon");
            return;
        }
        PackageManager pm = getContext().getPackageManager();
        int on = PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
        int off = PackageManager.COMPONENT_ENABLED_STATE_DISABLED;
        int flags = PackageManager.DONT_KILL_APP;
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                List<PackageManager.ComponentEnabledSetting> settings = new ArrayList<>();
                for (String name : ICONS) {
                    settings.add(new PackageManager.ComponentEnabledSetting(alias(name),
                        name.equals(selected) ? on : off, flags));
                }
                pm.setComponentEnabledSettings(settings);
            } else {
                pm.setComponentEnabledSetting(alias(selected), on, flags);
                for (String name : ICONS) {
                    if (!name.equals(selected) && enabled(name)) {
                        pm.setComponentEnabledSetting(alias(name), off, flags);
                    }
                }
            }
            resolve(call, selected);
        } catch (RuntimeException error) {
            call.reject("Could not change launcher icon", error);
        }
    }
}
