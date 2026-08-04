plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "uz.gsr.driver"
  compileSdk = 35

  defaultConfig {
    applicationId = "uz.gsr.driver"
    minSdk = 24
    targetSdk = 35
    versionCode = 4
    versionName = "1.3"
    /**
     * The app ships pointed at the production server; the pairing screen lets
     * the warehouse worker change it (domain move, test server).
     *
     * This is a COMPILE-TIME constant living on phones we do not control, and
     * on 2026-07-27 that cost a fleet: the server moved to its own domain, the
     * old `sslip.io` host stopped being served, and every already-paired phone
     * went silent at once with nothing to tell the driver. A domain move now
     * means all three of — keep serving the OLD name for a transition period,
     * publish a new APK, and only then retire the old name.
     */
    buildConfigField("String", "DEFAULT_SERVER", "\"https://gsrwms.uz\"")
    // Shown on the app's own screen. Two builds look identical on a phone,
    // and "did the new APK actually install?" has to be answerable without
    // guessing — CI passes the commit, a local build says "dev".
    buildConfigField(
      "String",
      "BUILD_ID",
      "\"${(System.getenv("GSR_BUILD_ID") ?: "dev").take(7)}\"",
    )
  }

  buildFeatures {
    buildConfig = true
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      // Debug-signed release is fine: the APK is handed out directly, not
      // published to a store (owner's decision).
      signingConfig = signingConfigs.getByName("debug")
    }
  }

  lint {
    // The APK is handed out directly; a lint nit must never block the build
    // that the warehouse is waiting for.
    abortOnError = false
    checkReleaseBuilds = false
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.appcompat:appcompat:1.7.0")
}
