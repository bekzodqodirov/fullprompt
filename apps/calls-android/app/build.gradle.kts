plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "uz.gsr.calls"
  compileSdk = 35

  defaultConfig {
    applicationId = "uz.gsr.calls"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "1.0"
    /**
     * Ships pointed at production; the pairing screen lets the person change
     * it. A compile-time host cost the driver fleet once (2026-07-27) — a
     * domain move means: keep serving the old name, publish a new APK, only
     * then retire the old name.
     */
    buildConfigField("String", "DEFAULT_SERVER", "\"https://gsrwms.uz\"")
    // Shown on the app's own screen: "did the new APK actually install?"
    // has to be answerable without guessing.
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
      // Debug-signed release is fine: the APK is handed out from the admin
      // screen, not published to a store (the driver app's precedent).
      signingConfig = signingConfigs.getByName("debug")
    }
  }

  lint {
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
