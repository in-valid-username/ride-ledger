plugins {
    id("com.android.application")
}

android {
    namespace = "com.rideledger"
    compileSdk {
        version = release(36) {
            minorApiLevel = 1
        }
    }
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "com.rideledger"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        create("testing") {
            storeFile = rootProject.file("signing/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        getByName("debug") {
            // Reuse the script's key when present; otherwise let AGP create its default debug key.
            if (rootProject.file("signing/debug.keystore").isFile) {
                signingConfig = signingConfigs.getByName("testing")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

