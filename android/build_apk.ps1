# Builds RECON.apk -- the Android wrapper around the phone app at /m/.
#
#   powershell -File android\build_apk.ps1
#
# Deliberately does NOT use Gradle. The app is a single Activity against the
# Android framework only -- no AndroidX, no libraries -- so it builds with the
# four SDK tools directly (aapt2, javac, d8, apksigner) and needs nothing
# downloaded at build time. A Gradle project here would mean a wrapper, a
# daemon, and a dependency resolution step that fails on a shop PC with no
# internet, to compile one file.
#
# This is the ONLY part of RECON that needs a toolchain to build, and nothing
# else depends on it. The web app it wraps still needs no build step, still
# edits live on refresh, and still works from any browser without this APK
# existing. If this script rots, delete it -- nothing breaks.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "C:\Android\sdk" }
# 35, not 34. The d8 in build-tools 34 (R8 8.2.2) dies with an internal
# NullPointerException -- "Cannot invoke String.length()" -- on the first
# anonymous inner class it meets, which for this app is the WebViewClient and
# so is unavoidable. 35's d8 dexes the same input without complaint, and when
# something IS wrong it says what, rather than throwing a null pointer from
# inside the dexer. Do not drop back to 34 to match the platform number; the
# build-tools version and the compile platform do not have to agree.
$buildToolsVersion = "35.0.0"
$platform = "android-34"

$aapt2    = Join-Path $sdk "build-tools\$buildToolsVersion\aapt2.exe"
$d8       = Join-Path $sdk "build-tools\$buildToolsVersion\d8.bat"
$zipalign = Join-Path $sdk "build-tools\$buildToolsVersion\zipalign.exe"
$apksigner= Join-Path $sdk "build-tools\$buildToolsVersion\apksigner.bat"
$androidJar = Join-Path $sdk "platforms\$platform\android.jar"

foreach ($tool in @($aapt2, $d8, $zipalign, $apksigner, $androidJar)) {
    if (-not (Test-Path $tool)) {
        throw "Missing $tool -- install the Android SDK (build-tools $buildToolsVersion, $platform) or set ANDROID_HOME."
    }
}

$jdk = Get-ChildItem "$env:ProgramFiles\Eclipse Adoptium" -Filter "jdk-*" -Directory -ErrorAction SilentlyContinue |
       Sort-Object Name -Descending | Select-Object -First 1
if (-not $jdk) { throw "No JDK found under $env:ProgramFiles\Eclipse Adoptium. Install one:  winget install EclipseAdoptium.Temurin.21.JDK" }
$javac  = Join-Path $jdk.FullName "bin\javac.exe"
$keytool= Join-Path $jdk.FullName "bin\keytool.exe"
$jar    = Join-Path $jdk.FullName "bin\jar.exe"
# d8 and apksigner are .bat wrappers that look up java themselves and fail with
# "JAVA_HOME is not set" if the JDK is not on PATH. It usually is not: winget
# installs Temurin without touching PATH, so this is the normal case, not an
# edge one.
$env:JAVA_HOME = $jdk.FullName

$out = "build\android"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$out\compiled", "$out\classes", "$out\gen", "$out\dex" | Out-Null

Write-Host "1/6  compiling resources"
& $aapt2 compile --dir android\res -o "$out\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile failed ($LASTEXITCODE)" }

Write-Host "2/6  linking resources"
& $aapt2 link -o "$out\base.apk" -I $androidJar `
    --manifest android\AndroidManifest.xml `
    --java "$out\gen" `
    --min-sdk-version 26 --target-sdk-version 34 `
    --auto-add-overlay "$out\res.zip"
if ($LASTEXITCODE -ne 0) { throw "aapt2 link failed ($LASTEXITCODE)" }

Write-Host "3/6  compiling java"
$sources = @(Get-ChildItem -Recurse -Filter *.java android\src | ForEach-Object { $_.FullName }) +
           @(Get-ChildItem -Recurse -Filter R.java "$out\gen" | ForEach-Object { $_.FullName })
# No -bootclasspath: JDK 9 and later refuse it alongside -target, and it is not
# needed. android.jar on the classpath resolves every android.* symbol, the JDK
# supplies java.*, and d8 below desugars whatever the min API cannot take.
& $javac --release 17 -nowarn -classpath $androidJar -d "$out\classes" $sources
if ($LASTEXITCODE -ne 0) { throw "javac failed ($LASTEXITCODE)" }

Write-Host "4/6  dexing"
# Jar the classes rather than handing d8 the loose .class files. Given them
# individually, d8 8.2 dies with an internal NullPointerException on the first
# anonymous inner class (MainActivity$1) because it cannot work out the class's
# origin without the archive around it. A jar is the input it expects.
& $jar --create --file "$out\classes.jar" -C "$out\classes" .
if ($LASTEXITCODE -ne 0) { throw "jar failed ($LASTEXITCODE)" }

& $d8 --lib $androidJar --min-api 26 --output "$out\dex" "$out\classes.jar"
if ($LASTEXITCODE -ne 0) { throw "d8 failed ($LASTEXITCODE)" }

Write-Host "5/6  packaging"
# The linked apk is a zip; classes.dex goes in at the root beside resources.
Copy-Item "$out\base.apk" "$out\unaligned.apk" -Force
Push-Location "$out\dex"
try {
    & $env:SystemRoot\System32\tar.exe --version > $null 2>&1
} catch {}
Pop-Location
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open((Resolve-Path "$out\unaligned.apk"), 'Update')
try {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip, (Resolve-Path "$out\dex\classes.dex"), "classes.dex") | Out-Null
} finally {
    $zip.Dispose()
}

& $zipalign -f -p 4 "$out\unaligned.apk" "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "zipalign failed ($LASTEXITCODE)" }

Write-Host "6/6  signing"
# A local keystore, generated once and kept out of the repo. It is not a
# Play Store identity -- it exists because Android refuses to install an
# unsigned APK. Keep the file: Android will refuse to UPDATE an installed
# app whose new build was signed with a different key, and the only fix at
# that point is uninstalling and losing the saved shop address.
$keystore = "android\recon-release.keystore"
if (-not (Test-Path $keystore)) {
    Write-Host "     creating $keystore (first build only -- do not delete it)"
    & $keytool -genkeypair -v -keystore $keystore -alias recon `
        -keyalg RSA -keysize 2048 -validity 10000 `
        -storepass reconshop -keypass reconshop `
        -dname "CN=Discount Auto Repair, OU=Shop, O=Discount Auto Repair, L=Merrillville, ST=Indiana, C=US"
    if ($LASTEXITCODE -ne 0) { throw "keytool failed ($LASTEXITCODE)" }
}

New-Item -ItemType Directory -Force -Path dist | Out-Null
& $apksigner sign --ks $keystore --ks-key-alias recon `
    --ks-pass pass:reconshop --key-pass pass:reconshop `
    --out dist\RECON.apk "$out\aligned.apk"
if ($LASTEXITCODE -ne 0) { throw "apksigner failed ($LASTEXITCODE)" }

# Collected into a variable, NOT piped into Select-Object: closing the pipe
# early kills apksigner mid-write and it exits -1, which looks exactly like a
# signature that did not verify.
$verify = & $apksigner verify --print-certs dist\RECON.apk 2>&1
if ($LASTEXITCODE -ne 0) { throw "apksigner verify failed ($LASTEXITCODE):`n$verify" }
$verify | Select-Object -First 2

$size = (Get-Item dist\RECON.apk).Length / 1KB
Write-Host ""
Write-Host ("Built: dist\RECON.apk  ({0:N0} KB)" -f $size)
Write-Host "Copy it to the phone and tap it. Android will ask once for permission to install from this source."
