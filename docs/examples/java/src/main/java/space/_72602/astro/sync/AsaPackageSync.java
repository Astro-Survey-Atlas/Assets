package space._72602.astro.sync;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Iterator;

/**
 * Astro Survey Atlas Assets — Resource Package sync client (Java 17+).
 *
 * Downloads a release collection ZIP or a pinned package version with
 * Content-Length + SHA-256 verification and an atomic temp-file move.
 *
 * Usage:
 *   mvn -q package exec:java -Dexec.args="--base https://astro.assets.dev.72602.space --list"
 *   mvn -q package exec:java -Dexec.args="--base https://astro.assets.dev.72602.space --out ./downloads"
 *   mvn -q package exec:java -Dexec.args="--base ... --package public-desi-footprints@3.0.0"
 */
public final class AsaPackageSync {

    private final HttpClient http = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL).build();
    private final ObjectMapper json = new ObjectMapper();

    public static void main(String[] args) throws Exception {
        String base = null;
        String release = "latest";
        String pkg = null;
        String out = ".";
        boolean list = false;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--base" -> base = require(args, ++i, "--base");
                case "--release" -> release = require(args, ++i, "--release");
                case "--package" -> pkg = require(args, ++i, "--package");
                case "--out" -> out = require(args, ++i, "--out");
                case "--list" -> list = true;
                default -> fail("unknown argument: " + args[i]);
            }
        }
        if (base == null) {
            fail("--base is required, e.g. --base https://astro.assets.dev.72602.online");
        }
        new AsaPackageSync().run(base, release, pkg, Path.of(out), list);
    }

    private static String require(String[] args, int index, String name) {
        if (index >= args.length) {
            fail(name + " requires a value");
        }
        return args[index];
    }

    private static void fail(String message) {
        System.err.println("error: " + message);
        System.exit(1);
    }

    private void run(String base, String releaseArg, String pkgArg, Path outDir, boolean list) throws Exception {
        JsonNode history = getJson(base, "/api/v1/releases");
        if (list) {
            listReleases(history);
            return;
        }
        JsonNode release = pickRelease(history, releaseArg);
        Files.createDirectories(outDir);
        if (pkgArg != null) {
            JsonNode pkg = pickPackage(release, pkgArg);
            downloadVerified(base, pkg.path("downloadUrl").asText(), pkg.path("sizeBytes").asLong(),
                    pkg.path("sha256").asText(), outDir);
            return;
        }
        JsonNode collection = release.path("collection");
        if (collection.isMissingNode()) {
            fail("release " + release.path("releaseId").asText() + " has no collection archive; use --package <id>");
        }
        downloadVerified(base, collection.path("downloadUrl").asText(), collection.path("sizeBytes").asLong(),
                collection.path("sha256").asText(), outDir);
    }

    private JsonNode getJson(String base, String path) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(trim(base) + path))
                .timeout(Duration.ofSeconds(60))
                .header("accept", "application/json")
                .GET()
                .build();
        HttpResponse<String> response = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        if (response.statusCode() != 200) {
            fail("GET " + path + " failed: HTTP " + response.statusCode());
        }
        return json.readTree(response.body());
    }

    private JsonNode pickRelease(JsonNode history, String releaseArg) {
        JsonNode releases = history.path("releases");
        if (!releases.isArray() || releases.isEmpty()) {
            fail("server returned no releases");
        }
        if ("latest".equals(releaseArg)) {
            String latestId = history.path("latestReleaseId").asText(null);
            if (latestId != null) {
                for (JsonNode entry : releases) {
                    if (latestId.equals(entry.path("releaseId").asText())) {
                        return entry;
                    }
                }
            }
            JsonNode best = releases.get(0);
            for (JsonNode entry : releases) {
                if (entry.path("sequence").asLong(0) > best.path("sequence").asLong(0)) {
                    best = entry;
                }
            }
            return best;
        }
        for (JsonNode entry : releases) {
            if (releaseArg.equals(entry.path("releaseId").asText())) {
                return entry;
            }
        }
        fail("release not found: " + releaseArg);
        throw new AssertionError("unreachable");
    }

    private JsonNode pickPackage(JsonNode release, String pkgArg) {
        String id = pkgArg;
        String version = null;
        int at = pkgArg.indexOf('@');
        if (at >= 0) {
            id = pkgArg.substring(0, at);
            version = pkgArg.substring(at + 1);
        }
        JsonNode best = null;
        for (Iterator<JsonNode> it = release.path("packages").elements(); it.hasNext(); ) {
            JsonNode pkg = it.next();
            if (!id.equals(pkg.path("id").asText())) {
                continue;
            }
            if (version == null || version.equals(pkg.path("version").asText())) {
                if (best == null || pkg.path("version").asText().compareTo(best.path("version").asText()) > 0) {
                    best = pkg;
                }
            }
        }
        if (best == null) {
            fail("package " + pkgArg + " not in release " + release.path("releaseId").asText());
        }
        return best;
    }

    private void downloadVerified(String base, String path, long expectedSize, String expectedSha, Path outDir)
            throws IOException, InterruptedException, NoSuchAlgorithmException {
        String url = trim(base) + path;
        String fileName = path.substring(path.lastIndexOf('/') + 1);
        Path finalPath = outDir.resolve(fileName);
        Path temp = Files.createTempFile(outDir, ".part-", null);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long received = 0;
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(300)).GET().build();
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            if (response.statusCode() != 200) {
                fail("download failed: HTTP " + response.statusCode() + " for " + url);
            }
            try (InputStream body = response.body(); var out = Files.newOutputStream(temp)) {
                byte[] buffer = new byte[1 << 16];
                int read;
                while ((read = body.read(buffer)) >= 0) {
                    out.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                    received += read;
                }
            }
        } catch (IOException | InterruptedException error) {
            Files.deleteIfExists(temp);
            throw error;
        }
        String actual = HexFormat.of().formatHex(digest.digest());
        if (expectedSize > 0 && received != expectedSize) {
            Files.deleteIfExists(temp);
            fail("size mismatch for " + finalPath + ": expected " + expectedSize + " bytes, got " + received);
        }
        if (expectedSha != null && !expectedSha.isEmpty() && !expectedSha.equals(actual)) {
            Files.deleteIfExists(temp);
            fail("sha256 mismatch for " + finalPath + ": expected " + expectedSha + ", got " + actual);
        }
        try {
            Files.move(temp, finalPath, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.AtomicMoveNotSupportedException error) {
            Files.move(temp, finalPath, StandardCopyOption.REPLACE_EXISTING);
        }
        System.out.println("saved " + finalPath + " (" + received + " bytes, sha256 " + actual.substring(0, 16) + "… verified)");
    }

    private void listReleases(JsonNode history) {
        String latestId = history.path("latestReleaseId").asText(null);
        for (Iterator<JsonNode> it = history.path("releases").elements(); it.hasNext(); ) {
            JsonNode entry = it.next();
            String marker = entry.path("releaseId").asText().equals(latestId) ? " [latest]" : "";
            System.out.println(entry.path("releaseId").asText() + marker);
            System.out.println("  sequence " + entry.path("sequence").asLong() + " · published "
                    + entry.path("releasedAt").asText() + " · bundle " + entry.path("bundleId").asText());
            JsonNode collection = entry.path("collection");
            if (collection.isObject()) {
                System.out.println("  collection " + collection.path("sizeBytes").asLong() + " bytes sha256 "
                        + collection.path("sha256").asText().substring(0, 16) + "…");
            }
            for (Iterator<JsonNode> pkgs = entry.path("packages").elements(); pkgs.hasNext(); ) {
                JsonNode pkg = pkgs.next();
                System.out.println("  - " + pkg.path("id").asText() + "@" + pkg.path("version").asText() + "  "
                        + pkg.path("sizeBytes").asLong() + " bytes");
            }
        }
    }

    private static String trim(String base) {
        String result = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        return result;
    }
}
