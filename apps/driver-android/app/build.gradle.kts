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
    versionCode = 1
    versionName = "1.0"
    // The app ships pointed at the production server; the pairing screen
    // lets the warehouse worker change it (domain move, test server).
    buildConfigField("String", "DEFAULT_SERVER", "\"https://169-58-65-23.sslip.io\"")
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
