plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.local.hive.mobile.playback"
    compileSdk = 37
    defaultConfig { minSdk = 29 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions { unitTests.all { it.testLogging { exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL } } }
}

dependencies {
    implementation(project(":core"))
    // :playback no longer depends on :streaming — it names the streaming world only through the :core
    // ports (YouTubeMusicPort/ScrobblerPort/PodcastStorePort), so Hive Clean can build without :streaming.
    implementation(project(":widget"))
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.session)
    implementation(libs.media3.common)
    implementation(libs.coil.core)
    implementation(libs.coil.network)
    implementation(libs.androidx.core.ktx)
    implementation(libs.serialization.json)
    implementation(libs.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}
