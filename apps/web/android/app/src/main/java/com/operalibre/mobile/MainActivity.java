package com.operalibre.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BackgroundDownloadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
