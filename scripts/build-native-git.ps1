param(
  [string]$SdkRoot = $env:ANDROID_HOME,
  [string]$NdkVersion = '27.1.12297006',
  [string]$CmakeVersion = '3.22.1',
  [int]$Jobs = 6
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (!$SdkRoot) { throw 'Set ANDROID_HOME or pass -SdkRoot with your Android SDK directory.' }
$buildRoot = Join-Path $projectRoot 'build/native-git'
$downloadRoot = Join-Path $buildRoot 'downloads'
$sourceRoot = Join-Path $buildRoot 'source'
$installRoot = Join-Path $buildRoot 'install'
$ndkRoot = Join-Path $SdkRoot "ndk/$NdkVersion"
$cmake = Join-Path $SdkRoot "cmake/$CmakeVersion/bin/cmake.exe"
$ninja = Join-Path $SdkRoot "cmake/$CmakeVersion/bin/ninja.exe"
$toolchain = Join-Path $ndkRoot 'build/cmake/android.toolchain.cmake'
$toolBin = Join-Path $ndkRoot 'toolchains/llvm/prebuilt/windows-x86_64/bin'
foreach ($required in @($cmake, $ninja, $toolchain)) {
  if (!(Test-Path -LiteralPath $required)) { throw "Missing Android build tool: $required" }
}
New-Item -ItemType Directory -Force $downloadRoot, $sourceRoot | Out-Null

function Invoke-Checked([string]$program, [string[]]$arguments) {
  & $program @arguments
  if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
}
function Get-Source([string]$name, [string]$url, [string]$sha256, [string]$directory) {
  $archive = Join-Path $downloadRoot $name
  if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -Uri $url -OutFile $archive }
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $sha256) { throw "Source checksum mismatch: $name" }
  $destination = Join-Path $sourceRoot $directory
  if (!(Test-Path -LiteralPath (Join-Path $destination '.karin-source-ready'))) {
    # The libgit2 test fixtures contain filenames/links Windows cannot extract.
    # Tests are disabled in this cross build; Mbed TLS's framework is retained.
    $tarArgs = @('-xf', $archive, '-C', $sourceRoot)
    if ($directory.StartsWith('libgit2-')) {
      $tarArgs += @("$directory/CMakeLists.txt", "$directory/COPYING", "$directory/include", "$directory/src", "$directory/cmake", "$directory/deps")
    }
    Invoke-Checked 'tar.exe' $tarArgs
    [IO.File]::WriteAllText((Join-Path $destination '.karin-source-ready'), $sha256)
  }
  return $destination
}

$gitSource = Get-Source 'libgit2-v1.9.1.tar.gz' 'https://github.com/libgit2/libgit2/archive/refs/tags/v1.9.1.tar.gz' '14CAB3014B2B7AD75970FF4548E83615F74D719AFE00AA479B4A889C1E13FC00' 'libgit2-1.9.1'
$tlsSource = Get-Source 'mbedtls-3.6.4.tar.bz2' 'https://github.com/Mbed-TLS/mbedtls/releases/download/mbedtls-3.6.4/mbedtls-3.6.4.tar.bz2' 'EC35B18A6C593CF98C3E30DB8B98FF93E8940A8C4E690E66B41DFC011D678110' 'mbedtls-3.6.4'
$common = @('-G', 'Ninja', "-DCMAKE_MAKE_PROGRAM=$ninja", "-DCMAKE_TOOLCHAIN_FILE=$toolchain",
  '-DANDROID_ABI=arm64-v8a', '-DANDROID_PLATFORM=android-24', '-DCMAKE_BUILD_TYPE=MinSizeRel',
  '-DCMAKE_POSITION_INDEPENDENT_CODE=ON', '-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384',
  "-DCMAKE_INSTALL_PREFIX=$installRoot")
$tlsBuild = Join-Path $buildRoot 'mbedtls-arm64'
Invoke-Checked $cmake (@('-S', $tlsSource, '-B', $tlsBuild) + $common + @(
  '-DENABLE_TESTING=OFF', '-DENABLE_PROGRAMS=OFF', '-DUSE_SHARED_MBEDTLS_LIBRARY=OFF', '-DUSE_STATIC_MBEDTLS_LIBRARY=ON'))
Invoke-Checked $cmake @('--build', $tlsBuild, '--target', 'install', '-j', "$Jobs")

# Android does not have a PEM bundle at a fixed pathname. KarinGitService exports
# its default TrustManager anchors and calls SET_SSL_CERT_LOCATIONS before use.
$httpsSelection = Join-Path $gitSource 'cmake/SelectHTTPSBackend.cmake'
$httpsText = [IO.File]::ReadAllText($httpsSelection)
$httpsText = $httpsText.Replace('if(NOT CERT_LOCATION)', 'if(NOT CERT_LOCATION AND NOT ANDROID)')
[IO.File]::WriteAllText($httpsSelection, $httpsText)
# Android packages one file name per library and libgit2 records its SONAME as
# the DT_NEEDED entry, so the unversioned build must still produce libgit2.so.
# libgit2 only applies OUTPUT_NAME together with versioned SONAMEs, hence the
# extra property for the SONAME=OFF configuration used below.
$libraryList = Join-Path $gitSource 'src/libgit2/CMakeLists.txt'
$namePatch = @"

# Karin: name the unversioned Android artifact libgit2.so.
if(NOT SONAME)
	set_target_properties(libgit2package PROPERTIES OUTPUT_NAME `${LIBGIT2_FILENAME})
endif()
"@
if (!([IO.File]::ReadAllText($libraryList)).Contains('Karin: name the unversioned Android artifact')) {
  [IO.File]::AppendAllText($libraryList, $namePatch)
}
$gitBuild = Join-Path $buildRoot 'libgit2-arm64'
Invoke-Checked $cmake (@('-S', $gitSource, '-B', $gitBuild) + $common + @(
  '-DBUILD_SHARED_LIBS=ON', '-DBUILD_TESTS=OFF', '-DBUILD_CLI=OFF', '-DBUILD_EXAMPLES=OFF',
  '-DUSE_HTTPS=mbedTLS', '-DUSE_SSH=OFF', '-DUSE_NTLMCLIENT=OFF', '-DUSE_GSSAPI=OFF',
  '-DREGEX_BACKEND=builtin', '-DUSE_BUNDLED_ZLIB=OFF', '-DSONAME=OFF',
  "-DMBEDTLS_INCLUDE_DIR=$installRoot/include", "-DMBEDTLS_LIBRARY=$installRoot/lib/libmbedtls.a",
  "-DMBEDX509_LIBRARY=$installRoot/lib/libmbedx509.a", "-DMBEDCRYPTO_LIBRARY=$installRoot/lib/libmbedcrypto.a"))
Invoke-Checked $cmake @('--build', $gitBuild, '-j', "$Jobs")

$nativeDir = Join-Path $projectRoot 'android/app/src/main/jniLibs/arm64-v8a'
$nativeCpp = Join-Path $projectRoot 'android/app/src/main/cpp'
New-Item -ItemType Directory -Force $nativeDir | Out-Null
$builtLibrary = Join-Path $gitBuild 'libgit2.so'
if (!(Test-Path -LiteralPath $builtLibrary)) { throw "libgit2 构建产物缺失: $builtLibrary" }
Copy-Item -LiteralPath $builtLibrary -Destination (Join-Path $nativeDir 'libgit2.so') -Force
Invoke-Checked (Join-Path $toolBin 'llvm-strip.exe') @('--strip-unneeded', (Join-Path $nativeDir 'libgit2.so'))
$bridge = Join-Path $nativeDir 'libkarin_git.so'
Invoke-Checked (Join-Path $toolBin 'aarch64-linux-android24-clang++.cmd') @(
  '-shared', '-fPIC', '-std=c++17', '-Os', '-Wall', '-Wextra', '-Werror', '-fvisibility=hidden',
  '-static-libstdc++', '-ffunction-sections', '-fdata-sections', '-Wl,--gc-sections', '-Wl,--exclude-libs,ALL',
  '-Wl,--no-undefined', '-Wl,-z,max-page-size=16384', '-Wl,-soname,libkarin_git.so',
  "-I$nativeCpp/libgit2/include", (Join-Path $nativeCpp 'karin-git.cpp'), "-L$nativeDir", '-lgit2', '-o', $bridge)
Invoke-Checked (Join-Path $toolBin 'llvm-strip.exe') @('--strip-unneeded', $bridge)
Get-Item -LiteralPath (Join-Path $nativeDir 'libgit2.so'), $bridge | Select-Object Name, Length
