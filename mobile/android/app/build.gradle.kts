plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.local.hive.mobile"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.local.hive.mobile"
        minSdk = 29
        targetSdk = 36
        versionCode = 122
        versionName = "2.19.16"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // Hive Mobile has one key, so every build updates every install: the keystore in HIVE_KEYSTORE
    // when it's set (GitHub's build, from the HIVE_MOBILE_KEYSTORE secret), else the debug keystore of
    // the PC building it, which is the same key.
    signingConfigs {
        System.getenv("HIVE_KEYSTORE")?.takeIf { it.isNotBlank() }?.let { path ->
            create("hive") { storeFile = file(path); storePassword = "android"; keyAlias = "androiddebugkey"; keyPassword = "android" }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("hive") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { compose = true }
    // A failing unit test prints its whole stack trace (GitHub's log is all there is to go on).
    testOptions { unitTests.all { it.testLogging { exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL } } }
}

ksp { arg("room.schemaLocation", "$projectDir/schemas") }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons)
    implementation(libs.activity.compose)
    implementation(libs.navigation.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.work.runtime)
    implementation(libs.okhttp)
    // Writes tags and covers into the song files (the tag editor, Change cover, Auto-tag).
    implementation(libs.jaudiotagger)
    implementation(libs.okhttp.sse)
    implementation(libs.coil.compose)
    // Covers from Apple Music and Spotify.
    implementation(libs.coil.network)
    // The home-screen widget.
    implementation(libs.glance.appwidget)
    implementation(libs.glance.material3)
    implementation(libs.haze)
    implementation(libs.palette)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)
    // Installs the startup and scrolling profiles Compose and the other
    // libraries ship, so release builds start and scroll compiled, not interpreted.
    implementation(libs.profileinstaller)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.ext.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
