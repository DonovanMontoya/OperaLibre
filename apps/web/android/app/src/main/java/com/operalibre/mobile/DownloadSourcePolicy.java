package com.operalibre.mobile;

import java.net.URI;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The single server a download job may fetch from: the origin of the server
 * address the app is connected to, plus any base path that address carries
 * (a server behind a reverse-proxy subpath). Media URLs carry the access token
 * in their query string, so both the source and every redirect hop must stay
 * inside it. Matches the origin and base-path rule of
 * BackgroundDownloadAllowlist on iOS.
 */
final class DownloadSourcePolicy {
    private final String origin;
    private final List<String> basePath;

    private DownloadSourcePolicy(String origin, List<String> basePath) {
        this.origin = origin;
        this.basePath = basePath;
    }

    /** @return null when the address is not a usable http(s) server address. */
    static DownloadSourcePolicy forServer(String serverAddress) {
        if (serverAddress == null) return null;
        try {
            URL url = new URL(serverAddress);
            String origin = origin(url);
            List<String> path = pathSegments(url);
            return origin == null || path == null ? null : new DownloadSourcePolicy(origin, path);
        } catch (Exception invalid) {
            return null;
        }
    }

    /** The policy jobs saved before the server address was stored fell back to. */
    static DownloadSourcePolicy forSourceOrigin(URL source) {
        String origin = origin(source);
        return origin == null ? null : new DownloadSourcePolicy(origin, new ArrayList<>());
    }

    String serverAddress() {
        StringBuilder address = new StringBuilder(origin);
        for (String segment : basePath) address.append('/').append(segment);
        return address.toString();
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

    /**
     * Decoded, non-empty path segments, or null when any segment is a dot
     * segment: a server resolves {@code /base/../other} outside the base path.
     */
    private static List<String> pathSegments(URL url) {
        String path;
        try {
            // URI decodes percent escapes, so %2e%2e is caught as a dot segment.
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
