# Native Git bridge

Karin's Git operations run in the Android process through libgit2.  The
React Native module is `NativeModules.KarinGit`; it maps container paths such
as `/root/karin/plugins/example` into the app's private
`files/debian-rootfs/root/karin/plugins/example` before calling JNI.  No Git
binary is installed in the Debian rootfs and no Git command is sent through
`KarinProot`.

## Native artifact

The APK must contain an arm64-v8a `libkarin_git.so` with the following
dependencies in the same ABI directory (or statically linked):

- libgit2 1.8 or newer, built with HTTPS support (the script uses mbedTLS);
- libssh2 only when SSH remotes are intentionally supported;
- OpenSSL/BoringSSL-compatible TLS, zlib and pcre2 as selected by libgit2.

The artifact must be named `libgit2.so`.  libgit2 records its SONAME as its own
file name and the Android loader resolves `DT_NEEDED` by that name, so a renamed
or versioned library cannot be found at runtime.

The JNI library exports three entry points for `KarinGitNative`:

```text
Java_com_karinjs_karin_KarinGitNative_configure
Java_com_karinjs_karin_KarinGitNative_execute
Java_com_karinjs_karin_KarinGitNative_cancel
```

Build libgit2 for `aarch64-linux-android24` with position-independent code and
without command-line tools/tests.  A typical CMake configuration is:

```text
-DBUILD_CLI=OFF -DBUILD_TESTS=OFF -DBUILD_EXAMPLES=OFF
-DUSE_SSH=OFF -DUSE_NTLMCLIENT=OFF -DUSE_GSSAPI=OFF -DUSE_HTTPS=mbedTLS
-DBUILD_SHARED_LIBS=ON -DSONAME=OFF
-DCMAKE_ANDROID_ABI=arm64-v8a -DCMAKE_ANDROID_PLATFORM=android-24
```

`scripts/build-native-git.ps1` runs this configuration, keeps the unversioned
`libgit2.so` name for the `SONAME=OFF` build, links mbedTLS statically and
copies both libraries into `android/app/src/main/jniLibs/arm64-v8a/`.

If the build uses shared dependencies, place each `.so` under
`android/app/src/main/jniLibs/arm64-v8a/`.  `libgit2.so` alone is not enough:
the JNI bridge is the library loaded by Kotlin (`libkarin_git.so`), and its
transitive TLS/zlib libraries must also be packaged or linked statically.

## JSON return values

`execute` dispatches on its `action` argument (`clone`, `update`, `restore`,
`fetch`, `checkout`, `status`, `log`, `head`, `remoteUrl`, `setRemoteUrl`,
`isShallow`, `isRepository`, `pathState`, `listRepositories`) and returns UTF-8
JSON so the bridge can evolve without a new Java method for every field.
`status` returns `{ "dirty": bool, "output": string }`, `log` returns an array
of `hash`, `subject`, `author`, `date` records, and mutating operations either
return `{ "ok": true }` or throw a descriptive error.  `cancel(operationId)`
sets a flag that libgit2 transfer callbacks observe; the operation only settles
after its cleanup finished.

The current Kotlin module loads the library lazily and reports
`isAvailable=false` when the artifact has not been installed, so development
builds remain launchable before the native artifact is supplied.
