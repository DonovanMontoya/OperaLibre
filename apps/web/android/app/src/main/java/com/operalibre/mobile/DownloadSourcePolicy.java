package com.operalibre.mobile;

import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

final class DownloadSourcePolicy {
    private final String origin;
    private final List<String> basePath;
    private final String rawBasePath;

    private DownloadSourcePolicy(String origin, List<String> basePath, String rawBasePath) {
        this.origin = origin;
        this.basePath = basePath;
        this.rawBasePath = rawBasePath;
    }

    static DownloadSourcePolicy forServer(String serverAddress) {
        if (serverAddress == null) return null;
        try {
            URL url = new URL(serverAddress);
            String origin = origin(url);
            List<String> path = pathSegments(url);
            if (origin == null || path == null) return null;
            String rawPath = new URI(url.toString()).getRawPath();
            rawPath = rawPath == null ? "" : rawPath.replaceAll("/+$", "");
            return new DownloadSourcePolicy(origin, path, rawPath);
        } catch (Exception invalid) {
            return null;
        }
    }

    static DownloadSourcePolicy forSourceOrigin(URL source) {
        String origin = origin(source);
        return origin == null ? null : new DownloadSourcePolicy(origin, new ArrayList<>(), "");
    }

    String serverAddress() {
        return origin + rawBasePath;
    }

    boolean allows(URL url) {
        if (url == null || !origin.equals(origin(url))) return false;
        List<String> path = pathSegments(url);
        return path != null
            && path.size() >= basePath.size()
            && path.subList(0, basePath.size()).equals(basePath);
    }

    private static String origin(URL url) {
        String scheme = url.getProtocol() == null ? "" : url.getProtocol().toLowerCase(Locale.ROOT);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        String host = url.getHost() == null ? "" : url.getHost().toLowerCase(Locale.ROOT);
        if (host.isEmpty() || url.getUserInfo() != null) return null;
        int port = url.getPort() == -1 ? url.getDefaultPort() : url.getPort();
        return scheme + "://" + host + ":" + port;
    }

    private static List<String> pathSegments(URL url) {
        String path;
        try {
            path = new URI(url.toString()).getPath();
        } catch (Exception invalid) {
            return null;
        }
        List<String> segments = new ArrayList<>();
        if (path == null) return segments;
        for (String segment : path.split("/")) {
            if (segment.isEmpty()) continue;
            if (".".equals(segment) || "..".equals(segment)) return null;
            segments.add(segment);
        }
        return segments;
    }
}
